"""The governed MCP catalogue: one schema, one lifecycle, three client renderings.

Everything FDE knows about an MCP server lives in `mcp/mcp-servers.json`. This
module is the only thing that reads it. `fde`, `mcp-sync` and `fde-doctor` all
import from here so that "is this server usable, for whom, with which tools" has
exactly one answer regardless of which command asked.

Four ideas carry the whole design:

  1. A catalogue entry is a *description*, never a grant. Being in the file
     means FDE knows how to run the server; it does not mean anyone may.
  2. Activation is computed, not stored by hand. A server becomes part of a run
     because that run's approved stages, roles and profile ask for it, and
     because the server is actually ready on this machine.
  3. Read-only is enforced or it is not claimed. If a client cannot be told
     which tools of a server to expose, a mutation-capable server is `blocked`
     and says why, rather than being described as safe in a prompt.
  4. Secrets are referenced, never written. The catalogue names an environment
     variable; the value is read from an owner-only file and injected into the
     one child process that needs it.

Python 3, standard library only.
"""
from __future__ import annotations

import base64
import contextlib
import errno
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request

SCHEMA_VERSION = 2
SUPPORTED_SCHEMA_VERSIONS = (1, 2)

# ------------------------------------------------------------------ vocabulary --

GLOBAL_TARGETS = ("claude", "gemini", "codex")
TRANSPORTS = ("stdio", "http", "sse")
AUTH_MODES = ("none", "oauth", "bearer", "header", "basic", "local-credential-chain")
MUTATION_CLASSES = ("read-only", "mutation-capable")

# What a caller may ask a server to do, from narrowest to broadest. A scope is a
# CEILING, never a grant: it can only narrow the enforceable tool set that
# `enforceable_tools` already proved safe. Granting `delete` on a server whose
# delete tools are withheld by its allowlist changes nothing, and says so.
SCOPES = ("read", "search", "create", "update", "delete", "deploy", "administer")
READ_ONLY_SCOPES = ("read", "search")

# The fallback classifier, consulted only when the catalogue declares nothing
# and the server's own annotations say nothing. Ordered broadest first, because
# a tool that looks like two things is treated as the more dangerous one.
_SCOPE_PATTERNS = (
    ("administer", (r"admin", r"grant", r"revoke", r"permission", r"policy",
                    r"^execute", r"shell", r"^eval", r"credential", r"token")),
    ("deploy", (r"deploy", r"publish", r"release", r"rollout", r"rollback",
                r"restart", r"scale", r"provision", r"terminate")),
    ("delete", (r"^delete", r"^remove", r"^drop", r"^destroy", r"^purge",
                r"^uninstall", r"^clear", r"^close")),
    ("update", (r"^update", r"^edit", r"^replace", r"^set", r"^write", r"^rename",
                r"^move", r"^patch", r"^put", r"^modify", r"^apply", r"^fill",
                r"^click", r"^type", r"^press", r"^hover", r"^drag", r"^select",
                r"^navigate", r"^resize", r"^emulate", r"^activate", r"^handle")),
    ("create", (r"^create", r"^add", r"^new", r"^insert", r"^upload", r"^post")),
    ("search", (r"search", r"^find", r"^query", r"^grep", r"^lookup")),
    ("read", (r"^get", r"^read", r"^list", r"^describe", r"^show", r"^fetch",
              r"^inspect", r"^snapshot", r"^take_", r"^status", r"^check",
              r"^think", r"^dump", r"^wait", r"^performance_", r"^lighthouse",
              r"^browser_snapshot", r"^browser_console", r"^browser_network",
              r"^browser_tabs", r"^browser_take")),
)

# How a server's read-only subset can actually be *proved*, not asserted:
#
#   none         nothing constrains the tool set — a mutation-capable server
#                with this policy can never be activated.
#   server-flag  the server itself is started in a read-only mode (a flag we
#                render); the client needs no filtering.
#   patterns     the catalogue names allow/deny tool patterns, and the client
#                is given a concrete allowlist derived from a verified tool list.
#   annotations  the enforceable subset is whatever `tools/list` reported with
#                readOnlyHint=true, recorded at verification time.
#   client-credential
#                the server's credential belongs to the MCP client, not to FDE
#                (Atlassian Rovo and Figma sign in inside a Claude or Codex
#                session), so FDE cannot ask it for a tool list and cannot build
#                an allowlist from one. Such a server runs UNFILTERED, and every
#                surface that mentions it says so: its writes are governed by
#                `fde approve-publish` alone, which is a gate at the point of
#                publication rather than at the point of the tool call. An
#                operator who knows the provider's read tools can close that gap
#                with `fde mcp configure <server> --set allowTools=a,b,c`, which
#                turns this into a real, enforced allowlist.
READ_ONLY_POLICIES = ("none", "server-flag", "patterns", "annotations",
                      "client-credential")

# Lifecycle. A catalogue entry moves left to right; anything short of `ready`
# never reaches a generated configuration.
UNAVAILABLE = "unavailable"
NOT_CONFIGURED = "not_configured"
AUTHENTICATION_REQUIRED = "authentication_required"
READY = "ready"
ACTIVE = "active"
UNHEALTHY = "unhealthy"
BLOCKED = "blocked"
LIFECYCLE_STATES = (UNAVAILABLE, NOT_CONFIGURED, AUTHENTICATION_REQUIRED,
                    READY, ACTIVE, UNHEALTHY, BLOCKED)

# Mirrors of the controller's vocabulary. They are restated here so this module
# has no import cycle with `fde`; tests assert the two lists stay identical.
KNOWN_ROLES = (
    "orchestrator", "productManagement", "research", "solutioning",
    "uiUxDesign", "designSystem", "review", "prReview", "standardsReview",
    "securityReview", "deliveryPlanning", "presentation", "implementation",
    "testEngineering", "ciInvestigation", "releaseManagement",
    "observability", "microsoftContext",
)
KNOWN_STAGES = (
    "intake", "research", "solutioning", "review", "reconciliation",
    "presentation", "planning", "implementation", "verification",
    "deployment", "observability", "publication",
)

# What counts as an external mutation anywhere in FDE. A server that can perform
# one of these names the publication target its writes belong to, and that target
# is what `fde approve-publish` must have granted.
PUBLICATION_TARGETS = (
    "jira", "confluence", "sharepoint", "bitbucket", "github", "deployment",
    "email", "teams", "figma",
)

# Which existing FDE gate a server's writes belong behind. Not every mutation is
# a publication: Serena's editing tools would change files in the repository, and
# that is already the Codex write approval's job.
#
#   publication            fde approve-publish <run-id> <target>
#   implementation-write   the run's existing one-time Codex write approval
#   denied                 the mutation tools are never enabled in this phase,
#                          by any approval — they are denied outright
MUTATION_GATES = ("publication", "implementation-write", "denied")

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
COMMAND_RE = re.compile(r"^(?:/[^\s;|&$`<>()\\\"']*|[A-Za-z0-9_][A-Za-z0-9_.+-]*)$")
FIELD_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,39}$")
PLACEHOLDER_RE = re.compile(r"\{\{\s*config\.([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}")
ENV_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")

# A value that looks like a credential must never sit in the catalogue or in a
# generated file. This is deliberately blunt: the fix is always "declare a
# userConfig field with secret:true", never "make the pattern narrower".
SECRET_LITERAL_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[opsu]_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bpk-lf-[0-9a-f-]{8,}\b"),
    re.compile(r"\bsk-lf-[0-9a-f-]{8,}\b"),
    re.compile(r"(?i)://[^/\s:@]+:[^/\s@]+@"),          # credentials inside a URL
    re.compile(r"(?i)\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S{6,}"),
)

# Redaction for anything that leaves this process: events, API responses,
# generated READMEs, error text.
REDACTIONS = (
    (re.compile(r"(?i)(authorization\s*[:=]\s*)([^\r\n]+)"), r"\1[redacted]"),
    (re.compile(r"(?i)(cookie\s*[:=]\s*)([^\r\n]+)"), r"\1[redacted]"),
    (re.compile(r"(?i)\b((?:postgres|postgresql|mysql|mariadb|mongodb|sqlserver)://)"
                r"[^/\s]*@"), r"\1[redacted]@"),
    (re.compile(r"(?i)://[^/\s:@]+:[^/\s@]+@"), "://[redacted]@"),
    (re.compile(r"\bpk-lf-[0-9a-fA-F-]{6,}\b"), "[redacted]"),
    (re.compile(r"\bsk-lf-[0-9a-fA-F-]{6,}\b"), "[redacted]"),
    (re.compile(r"\bgh[opsu]_[A-Za-z0-9_]{20,}\b"), "[redacted]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "[redacted]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[redacted]"),
    (re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+"),
     r"\1\2[redacted]"),
)


def redact(value):
    """Best-effort scrub of credential-shaped text. Applied on every exit path."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    if not isinstance(value, str):
        return value
    out = value
    for pattern, replacement in REDACTIONS:
        out = pattern.sub(replacement, out)
    return out


class CatalogError(Exception):
    """The catalogue, or a user's configuration of it, cannot be trusted."""

    def __init__(self, code, message, problems=()):
        super().__init__(message)
        self.code = code
        self.message = message
        self.problems = list(problems)


# ------------------------------------------------------------------ locations --

def _env_path(name, default):
    value = os.environ.get(name)
    return pathlib.Path(value) if value else default


def shared_root():
    home = pathlib.Path(os.environ.get("HOME", pathlib.Path.home()))
    return _env_path("CLAUDE_SHARED", home / ".claude-shared")


def catalog_path():
    return _env_path("FDE_MCP_CATALOG", shared_root() / "mcp" / "mcp-servers.json")


def user_config_path():
    return _env_path("FDE_MCP_USER_CONFIG",
                     shared_root() / "config" / "mcp-user-config.json")


def secrets_root():
    return _env_path("FDE_MCP_SECRETS_DIR", shared_root() / "secrets" / "mcp")


def generated_root():
    return _env_path("FDE_MCP_GENERATED_DIR", shared_root() / "mcp" / "generated")


def health_path():
    return _env_path("FDE_MCP_HEALTH_FILE", shared_root() / "mcp" / "health.json")


# --------------------------------------------------------------------- io ----

def read_json(path, default=None):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, NotADirectoryError, json.JSONDecodeError, UnicodeDecodeError):
        return {} if default is None else default


def write_private(path: pathlib.Path, text: str, mode: int = 0o600):
    """Write owner-only, atomically, creating the parent owner-only too."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(path.parent, 0o700)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    handle = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        os.write(handle, text.encode("utf-8"))
    finally:
        os.close(handle)
    os.replace(tmp, path)
    with contextlib.suppress(OSError):
        os.chmod(path, mode)
    return path


# ------------------------------------------------------------------ defaults --

_DEFAULTS = {
    "enabled": True,
    "transport": "stdio",
    "targets": (),
    "stages": (),
    "profiles": (),
    "clients": {},
    "requires": {},
    "userConfig": (),
    "auth": "none",
    "classification": "unclassified",
    "mutation": "mutation-capable",
    "readOnlyPolicy": "none",
    "allowTools": (),
    "denyTools": (),
    # {scope: [patterns]}. Declared where an operator knows this provider's
    # tools; derived from annotations and names where they do not.
    "scopes": {},
    "mutationApproval": None,
    "useWhen": "",
    "preferOver": (),
    "doNotUseWhen": "",
    "verify": {"method": "tools/list", "timeoutSeconds": 30},
    "generatedFiles": (),
    "gateway": {},
    "package": {},
    "httpHeaders": {},
    "mutationRemovesArgs": (),
    # Arguments that exist only when the operator has actually chosen something:
    # {"field": "allowedOrigins", "args": ["--allowed-origins", "{{config.allowedOrigins}}"]}
    # is appended when the field is non-empty, and {"field": "headless",
    # "equals": "true", "args": ["--headless"]} when it equals that value. A flag
    # is never emitted with an empty value.
    "optionalArgs": (),
    "note": "",
}

# A v1 catalogue described three hosted, read-only-by-policy servers and nothing
# else. Migration fills in what v1 could not say, and says it conservatively:
# an HTTP server with no declared mutation class is treated as mutation-capable
# unless the migration table below knows better.
_V1_MIGRATION = {
    "context7": {
        "mutation": "read-only",
        "readOnlyPolicy": "server-flag",
        "classification": "public-documentation",
        "auth": "none",
    },
    "atlassian": {
        "mutation": "mutation-capable",
        "readOnlyPolicy": "client-credential",
        "classification": "tenant-data",
        "auth": "oauth",
        "mutationApproval": {"targets": ["jira", "confluence"]},
    },
    "figma": {
        "mutation": "mutation-capable",
        "readOnlyPolicy": "client-credential",
        "classification": "tenant-data",
        "auth": "oauth",
        "mutationApproval": {"targets": ["figma"]},
    },
}


def migrate(raw):
    """Return a v2 catalogue document from any supported schema version.

    v1 had `servers` with transport/url/targets/note and nothing else. The
    result is byte-for-byte irrelevant; what matters is that rendering a
    migrated v1 catalogue produces the same client configuration it always did.
    """
    if not isinstance(raw, dict):
        raise CatalogError("catalog_invalid", "the MCP catalogue is not a JSON object")
    version = raw.get("schemaVersion", 1)
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise CatalogError(
            "catalog_version",
            f"MCP catalogue schema version {version!r} is not supported "
            f"(this build reads {', '.join(str(v) for v in SUPPORTED_SCHEMA_VERSIONS)})")
    servers = raw.get("servers")
    if not isinstance(servers, dict):
        raise CatalogError("catalog_invalid", "the MCP catalogue declares no servers object")
    if version == SCHEMA_VERSION:
        doc = dict(raw)
        doc.setdefault("profiles", {})
        return doc

    migrated = {}
    for name, server in servers.items():
        if not isinstance(server, dict):
            raise CatalogError("catalog_invalid", f"server {name!r} is not an object")
        entry = dict(server)
        entry.setdefault("targets", list(GLOBAL_TARGETS))
        entry.setdefault("transport", "stdio")
        entry.update({k: v for k, v in _V1_MIGRATION.get(name, {}).items()
                      if k not in entry})
        entry.setdefault("mutation", "mutation-capable")
        entry.setdefault("readOnlyPolicy", "none")
        if entry["mutation"] == "mutation-capable":
            # A v1 file could not say what a server's writes were, so migration
            # will not guess. An entry the table above does not recognise keeps
            # its tools denied — and therefore reports `blocked`, with a reason —
            # rather than being carried forward as though it had been reviewed.
            entry.setdefault("mutationApproval", {
                "gate": "denied",
                "note": "migrated from schema version 1, which carried no read/write "
                        "classification. Classify it in the catalogue before use.",
            })
        entry.setdefault("migratedFromSchemaVersion", 1)
        migrated[name] = entry
    return {"schemaVersion": SCHEMA_VERSION,
            "_comment": raw.get("_comment", ""),
            "profiles": raw.get("profiles", {}),
            "servers": migrated}


# ----------------------------------------------------------------- validation --

def _reject_secret_literal(problems, where, value):
    if not isinstance(value, str):
        return
    for pattern in SECRET_LITERAL_PATTERNS:
        if pattern.search(value):
            problems.append(
                f"{where}: this looks like a literal credential. Declare a "
                f"userConfig field with \"secret\": true and reference its "
                f"environment variable instead.")
            return


WHOLE_PLACEHOLDER_RE = re.compile(r"^\{\{\s*config\.[a-zA-Z][a-zA-Z0-9_]{0,39}\s*\}\}$")


def _validate_url(problems, where, value, *, fields=()):
    if not isinstance(value, str) or not value:
        problems.append(f"{where}: a URL is required")
        return
    if len(value) > 2048:
        problems.append(f"{where}: URL is too long")
        return
    if WHOLE_PLACEHOLDER_RE.match(value):
        # The whole endpoint is operator-supplied — Langfuse's region choice, for
        # instance. Then the *field* must exist and be a required URL, and the
        # value is validated when it is set, not when the catalogue is read.
        field_name = PLACEHOLDER_RE.search(value).group(1)
        field = next((f for f in fields if isinstance(f, dict) and f.get("name") == field_name), None)
        if field is None:
            problems.append(f"{where}: refers to userConfig field {field_name!r}, which is "
                            f"not declared")
        elif field.get("type") != "url" or not field.get("required"):
            problems.append(f"{where}: userConfig field {field_name!r} must be a required "
                            f"field of type 'url'")
        return
    # A URL may also carry a placeholder inside it; validate the shape once the
    # placeholder is replaced by a harmless token.
    probe = PLACEHOLDER_RE.sub("placeholder", value)
    parsed = urllib.parse.urlparse(probe)
    loopback = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    allowed = ("http", "https") if loopback else ("https",)
    if parsed.scheme not in allowed or not parsed.hostname:
        problems.append(f"{where}: must be an HTTPS URL "
                        f"(HTTP is allowed only for localhost)")
    if parsed.username or parsed.password:
        problems.append(f"{where}: a URL may not carry credentials")
    if parsed.fragment:
        problems.append(f"{where}: a URL may not carry a fragment")


def _validate_argv(problems, where, command, args):
    if not isinstance(command, str) or not COMMAND_RE.match(command):
        problems.append(f"{where}: command must be a bare executable name or an "
                        f"absolute path, with no shell metacharacters")
    if not isinstance(args, (list, tuple)):
        problems.append(f"{where}: args must be a list")
        return
    for index, arg in enumerate(args):
        if not isinstance(arg, str):
            problems.append(f"{where}: args[{index}] must be a string")
            continue
        if "\0" in arg or "\n" in arg:
            problems.append(f"{where}: args[{index}] contains a control character")
        _reject_secret_literal(problems, f"{where}: args[{index}]", arg)


def _validate_env(problems, where, env):
    if not isinstance(env, dict):
        problems.append(f"{where}: env must be an object")
        return
    for key, value in env.items():
        if not ENV_NAME_RE.match(str(key)):
            problems.append(f"{where}: {key!r} is not a safe environment variable name")
        if not isinstance(value, str):
            problems.append(f"{where}: env[{key}] must be a string")
            continue
        _reject_secret_literal(problems, f"{where}: env[{key}]", value)


def _validate_user_config(problems, where, fields):
    if not isinstance(fields, (list, tuple)):
        problems.append(f"{where}: userConfig must be a list")
        return
    seen = set()
    for field in fields:
        if not isinstance(field, dict):
            problems.append(f"{where}: each userConfig entry must be an object")
            continue
        name = field.get("name")
        if not isinstance(name, str) or not FIELD_NAME_RE.match(name):
            problems.append(f"{where}: userConfig field name {name!r} is invalid")
            continue
        if name in seen:
            problems.append(f"{where}: userConfig field {name!r} is declared twice")
        seen.add(name)
        if field.get("secret"):
            env_var = field.get("envVar")
            if not isinstance(env_var, str) or not ENV_NAME_RE.match(env_var):
                problems.append(f"{where}: secret field {name!r} must declare a safe "
                                f"envVar; FDE never writes the value itself")
        for key in ("defaultValue", "placeholder"):
            if field.get(key) is not None and field.get("secret"):
                if key == "defaultValue":
                    problems.append(f"{where}: secret field {name!r} may not carry a "
                                    f"default value")
            _reject_secret_literal(problems, f"{where}: userConfig[{name}].{key}",
                                   field.get(key))
        options = field.get("options")
        if options is not None and not isinstance(options, (list, tuple)):
            problems.append(f"{where}: userConfig[{name}].options must be a list")


def _validate_patterns(problems, where, patterns):
    if not isinstance(patterns, (list, tuple)):
        problems.append(f"{where} must be a list of regular expressions")
        return
    for pattern in patterns:
        if not isinstance(pattern, str):
            problems.append(f"{where}: every entry must be a string")
            continue
        try:
            re.compile(pattern)
        except re.error as exc:
            problems.append(f"{where}: {pattern!r} is not a valid pattern ({exc})")


def validate(doc, *, known_roles=KNOWN_ROLES, known_stages=KNOWN_STAGES):
    """Every problem with a catalogue, in one pass. Empty list means usable."""
    problems = []
    profiles = doc.get("profiles") or {}
    if not isinstance(profiles, dict):
        problems.append("profiles must be an object")
        profiles = {}
    for profile_name, profile in profiles.items():
        if not NAME_RE.match(str(profile_name)):
            problems.append(f"profile name {profile_name!r} is invalid")
        if not isinstance(profile, dict):
            problems.append(f"profile {profile_name!r} must be an object")

    servers = doc.get("servers") or {}
    for name, raw in servers.items():
        where = f"server {name!r}"
        if not NAME_RE.match(str(name)):
            problems.append(f"{where}: name must be lower-case letters, digits and hyphens")
        if not isinstance(raw, dict):
            problems.append(f"{where}: must be an object")
            continue
        server = with_defaults(raw)

        transport = server["transport"]
        if transport not in TRANSPORTS:
            problems.append(f"{where}: transport {transport!r} is not one of "
                            f"{', '.join(TRANSPORTS)}")
        elif transport in ("http", "sse"):
            _validate_url(problems, f"{where}: url", server.get("url"),
                          fields=server.get("userConfig") or [])
            if server.get("command"):
                problems.append(f"{where}: an HTTP server may not also declare a command")
        else:
            _validate_argv(problems, where, server.get("command"), server.get("args", []))
        _validate_env(problems, where, server.get("env", {}))

        targets = server["targets"]
        if not isinstance(targets, (list, tuple)) or not targets:
            problems.append(f"{where}: targets must be a non-empty list")
            targets = []
        global_targets = [t for t in targets if t in GLOBAL_TARGETS]
        role_targets = [t for t in targets if isinstance(t, str) and t.startswith("role:")]
        unknown = [t for t in targets
                   if t not in GLOBAL_TARGETS and not (isinstance(t, str) and t.startswith("role:"))]
        for value in unknown:
            problems.append(f"{where}: unknown target {value!r}; use one of "
                            f"{', '.join(GLOBAL_TARGETS)} or role:<role>")
        for value in role_targets:
            role = value.split(":", 1)[1]
            if role not in known_roles:
                problems.append(f"{where}: unknown role in target {value!r}")
        if global_targets and role_targets:
            problems.append(f"{where}: a server is either global or role-scoped, never "
                            f"both — it declares {', '.join(sorted(targets))}")

        for stage in server["stages"]:
            if stage not in known_stages:
                problems.append(f"{where}: unknown stage {stage!r}")
        for profile_name in server["profiles"]:
            if profile_name not in profiles:
                problems.append(f"{where}: profile {profile_name!r} is not declared in "
                                f"the catalogue's profiles object")

        clients = server["clients"]
        if not isinstance(clients, dict):
            problems.append(f"{where}: clients must be an object")
        else:
            for client, override in clients.items():
                if client not in GLOBAL_TARGETS:
                    problems.append(f"{where}: client override {client!r} is not one of "
                                    f"{', '.join(GLOBAL_TARGETS)}")
                    continue
                if not isinstance(override, dict):
                    problems.append(f"{where}: client override {client!r} must be an object")
                    continue
                if "args" in override or "command" in override:
                    _validate_argv(problems, f"{where}: clients.{client}",
                                   override.get("command", server.get("command") or "x"),
                                   override.get("args", []))
                if "env" in override:
                    _validate_env(problems, f"{where}: clients.{client}", override["env"])
                if "url" in override:
                    _validate_url(problems, f"{where}: clients.{client}.url", override["url"])

        if server["auth"] not in AUTH_MODES:
            problems.append(f"{where}: auth {server['auth']!r} is not one of "
                            f"{', '.join(AUTH_MODES)}")
        if server["mutation"] not in MUTATION_CLASSES:
            problems.append(f"{where}: mutation must be one of {', '.join(MUTATION_CLASSES)}")
        if server["readOnlyPolicy"] not in READ_ONLY_POLICIES:
            problems.append(f"{where}: readOnlyPolicy must be one of "
                            f"{', '.join(READ_ONLY_POLICIES)}")
        _validate_patterns(problems, f"{where}: allowTools", server["allowTools"])
        _validate_patterns(problems, f"{where}: denyTools", server["denyTools"])
        scopes = server.get("scopes")
        if not isinstance(scopes, dict):
            problems.append(f"{where}: scopes must be an object of scope to patterns")
        else:
            for scope, patterns in scopes.items():
                if scope not in SCOPES:
                    problems.append(f"{where}: unknown scope {scope!r}; use one of "
                                    + ", ".join(SCOPES))
                    continue
                _validate_patterns(problems, f"{where}: scopes.{scope}", patterns)
        _validate_user_config(problems, where, server["userConfig"])

        approval = server["mutationApproval"]
        if approval is not None:
            if not isinstance(approval, dict):
                problems.append(f"{where}: mutationApproval must be an object")
            else:
                for target in approval.get("targets", []):
                    if target not in PUBLICATION_TARGETS:
                        problems.append(f"{where}: mutationApproval target {target!r} is "
                                        f"not an FDE publication target")
                if approval.get("gate") not in (None, *MUTATION_GATES):
                    problems.append(f"{where}: mutationApproval gate "
                                    f"{approval.get('gate')!r} is not one of "
                                    f"{', '.join(MUTATION_GATES)}")
                if not approval.get("targets") and not approval.get("gate"):
                    problems.append(f"{where}: mutationApproval must name publication "
                                    f"targets or a gate")
        if server["mutation"] == "mutation-capable" and approval is None:
            problems.append(f"{where}: a mutation-capable server must say which approval "
                            f"its writes need — add mutationApproval")

        for spec in server["generatedFiles"]:
            if not isinstance(spec, dict) or not isinstance(spec.get("path"), str):
                problems.append(f"{where}: each generatedFiles entry needs a path")
                continue
            relative = spec["path"]
            if relative.startswith("/") or ".." in pathlib.PurePosixPath(relative).parts:
                problems.append(f"{where}: generated file path {relative!r} must be relative "
                                f"and may not escape the generated directory")
            _reject_secret_literal(problems, f"{where}: generatedFiles[{relative}]",
                                   spec.get("template", ""))

        headers = server["httpHeaders"]
        if not isinstance(headers, dict):
            problems.append(f"{where}: httpHeaders must be an object")
        else:
            declared = {f["name"]: f for f in server["userConfig"] if isinstance(f, dict)}
            secret_vars = {f.get("envVar") for f in declared.values() if f.get("secret")}
            for header, spec in headers.items():
                if not re.match(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$", str(header)) or \
                        str(header).lower() in ("host", "content-length", "connection",
                                                "transfer-encoding"):
                    problems.append(f"{where}: {header!r} is not a safe HTTP header name")
                if not isinstance(spec, dict) or not ENV_NAME_RE.match(str(spec.get("envVar", ""))):
                    problems.append(f"{where}: httpHeaders[{header}] must name a safe envVar; "
                                    f"a header value is never written into the catalogue")
                elif spec["envVar"] not in secret_vars:
                    problems.append(f"{where}: httpHeaders[{header}] names {spec['envVar']!r}, "
                                    f"which no secret userConfig field provides")
        if not isinstance(server["mutationRemovesArgs"], (list, tuple)):
            problems.append(f"{where}: mutationRemovesArgs must be a list")
        declared_fields = {f.get("name") for f in server["userConfig"] if isinstance(f, dict)}
        for spec in server["optionalArgs"]:
            if not isinstance(spec, dict) or spec.get("field") not in declared_fields:
                problems.append(f"{where}: every optionalArgs entry must name a declared "
                                f"userConfig field")
                continue
            _validate_argv(problems, f"{where}: optionalArgs[{spec['field']}]",
                           server.get("command") or "x", spec.get("args", []))

        package = server["package"]
        if package and not isinstance(package, dict):
            problems.append(f"{where}: package must be an object")
        elif package:
            version = package.get("version")
            if version in ("latest", "*") or (isinstance(version, str) and version.endswith("@latest")):
                problems.append(f"{where}: package.version must be a tested, pinned version, "
                                f"never 'latest'")
        _reject_secret_literal(problems, f"{where}: note", server["note"])
    return problems


def with_defaults(raw):
    server = dict(_DEFAULTS)
    server.update({k: v for k, v in raw.items() if v is not None})
    for key, value in _DEFAULTS.items():
        if isinstance(value, tuple):
            server[key] = list(server.get(key) or [])
        elif isinstance(value, dict) and key != "verify":
            server[key] = dict(server.get(key) or {})
    verify = dict(_DEFAULTS["verify"])
    verify.update(raw.get("verify") or {})
    server["verify"] = verify
    return server


# -------------------------------------------------------------------- catalog --

class Catalog:
    """A validated v2 catalogue. Constructing one that is invalid raises."""

    def __init__(self, doc, *, path=None, known_roles=KNOWN_ROLES,
                 known_stages=KNOWN_STAGES, strict=True):
        self.path = pathlib.Path(path) if path else None
        self.doc = migrate(doc)
        self.problems = validate(self.doc, known_roles=known_roles,
                                 known_stages=known_stages)
        if strict and self.problems:
            raise CatalogError("catalog_invalid",
                               f"{len(self.problems)} problem(s) in the MCP catalogue",
                               self.problems)
        self.profiles = self.doc.get("profiles") or {}
        self.servers = {name: with_defaults(raw)
                        for name, raw in (self.doc.get("servers") or {}).items()}
        self.migrated = self.doc.get("servers") and any(
            s.get("migratedFromSchemaVersion") for s in self.doc["servers"].values())

    # -- selection -------------------------------------------------------

    def names(self):
        return sorted(self.servers)

    def get(self, name):
        server = self.servers.get(name)
        if server is None:
            raise CatalogError("unknown_server", f"no MCP server {name!r} in the catalogue")
        return server

    def enabled(self):
        return {n: s for n, s in self.servers.items() if s["enabled"]}

    def global_servers(self):
        return {n: s for n, s in self.enabled().items()
                if any(t in GLOBAL_TARGETS for t in s["targets"])}

    def role_servers(self):
        """{name: (server, [roles])} for every role-scoped entry."""
        out = {}
        for name, server in self.enabled().items():
            roles = [t.split(":", 1)[1] for t in server["targets"] if t.startswith("role:")]
            if roles:
                out[name] = (server, roles)
        return out

    def for_profile(self, profile):
        if profile is None:
            return dict(self.enabled())
        declared = (self.profiles.get(profile) or {}).get("servers")
        if declared is not None:
            return {n: s for n, s in self.enabled().items() if n in set(declared)}
        return {n: s for n, s in self.enabled().items() if profile in s["profiles"]}

    @classmethod
    def load(cls, path=None, **kwargs):
        target = pathlib.Path(path or catalog_path())
        if not target.exists():
            raise CatalogError("catalog_missing", f"no MCP catalogue at {target}")
        raw = read_json(target, None)
        if not raw:
            raise CatalogError("catalog_invalid", f"{target} is not readable JSON")
        return cls(raw, path=target, **kwargs)


# -------------------------------------------------- user configuration store --

def load_user_config(path=None):
    doc = read_json(path or user_config_path(),
                    {"schemaVersion": SCHEMA_VERSION, "servers": {}})
    if not isinstance(doc, dict) or not isinstance(doc.get("servers"), dict):
        raise CatalogError("user_config_invalid",
                           "the MCP user configuration file is not usable")
    return doc


def save_user_config(doc, path=None):
    target = pathlib.Path(path or user_config_path())
    write_private(target, json.dumps(doc, indent=2, sort_keys=True) + "\n")
    return target


def server_settings(user_doc, name):
    entry = (user_doc.get("servers") or {}).get(name) or {}
    return {
        "enabled": bool(entry.get("enabled", False)),
        "values": dict(entry.get("values") or {}),
        "tools": dict(entry.get("tools") or {}),
        "acknowledgedRisks": list(entry.get("acknowledgedRisks") or []),
    }


def set_server_settings(user_doc, name, **changes):
    servers = user_doc.setdefault("servers", {})
    entry = servers.setdefault(name, {})
    for key, value in changes.items():
        if value is None:
            entry.pop(key, None)
        else:
            entry[key] = value
    return user_doc


# ------------------------------------------------------------------- secrets --

def secret_file(name, field, root=None):
    base = pathlib.Path(root or secrets_root())
    if not NAME_RE.match(name) or not FIELD_NAME_RE.match(field):
        raise CatalogError("bad_secret_ref", "unsafe secret reference")
    return base / name / field


def secret_exists(name, field, root=None):
    path = secret_file(name, field, root)
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def store_secret(name, field, value, root=None):
    path = secret_file(name, field, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(path.parent.parent, 0o700)
        os.chmod(path.parent, 0o700)
    write_private(path, value)
    return path


def read_secret(name, field, root=None):
    path = secret_file(name, field, root)
    try:
        return path.read_text(encoding="utf-8").rstrip("\r\n")
    except OSError:
        return ""


def delete_secret(name, field, root=None):
    with contextlib.suppress(OSError):
        secret_file(name, field, root).unlink()


def effective_values(name, server, settings, *, generated_dir=None):
    """What the server actually sees: catalogue defaults, then the operator's
    choices, then paths of files FDE generates for it.

    A `generated` field is never something the operator types — it is where FDE
    put the file it wrote, so the catalogue can reference it in argv without
    hard-coding a machine path."""
    values = {}
    for field in server.get("userConfig") or []:
        if not isinstance(field, dict):
            continue
        if field.get("generatedFrom"):
            values[field["name"]] = generated_path(name, field["generatedFrom"], generated_dir)
        elif field.get("defaultValue") is not None:
            values[field["name"]] = field["defaultValue"]
    values.update({k: v for k, v in ((settings or {}).get("values") or {}).items()
                   if str(v).strip() != ""})
    return values


def field_visible(field, values):
    condition = field.get("showWhen")
    return not condition or values.get(condition["field"]) == condition.get("equals")


def secret_fields(server):
    return [f for f in server["userConfig"] if f.get("secret")]


def public_fields(server):
    return [f for f in server["userConfig"] if not f.get("secret")]


def child_environment(name, server, *, settings=None, secrets_dir=None):
    """The environment variables this server's child process needs, and nothing
    else.

    Composed at launch and never persisted: a Basic credential and a database
    DSN are built here and live only in the argv-free environment of one child.
    Nothing composed here is written back to the user configuration, the health
    record, an event or a generated file."""
    values = effective_values(name, server, settings)
    env = {}
    for field in secret_fields(server):
        value = read_secret(name, field["name"], secrets_dir)
        if not value:
            continue
        compose = field.get("compose")
        if compose == "basic":
            partner = field.get("composeWith")
            other = read_secret(name, partner, secrets_dir) if partner else ""
            if not other:
                continue
            token = base64.b64encode(f"{other}:{value}".encode()).decode()
            env[field["envVar"]] = f"Basic {token}"
        elif compose == "bearer":
            env[field["envVar"]] = f"Bearer {value}"
        elif compose == "postgres-dsn":
            parts = field.get("composeFrom") or {}
            host = str(values.get(parts.get("host", "host"), "")).strip()
            database = str(values.get(parts.get("database", "database"), "")).strip()
            user = str(values.get(parts.get("username", "username"), "")).strip()
            if not (host and database and user):
                continue
            port = str(values.get(parts.get("port", "port"), "") or "5432").strip()
            ssl = str(values.get(parts.get("sslMode", "sslMode"), "") or "require").strip()
            env[field["envVar"]] = (
                f"postgres://{urllib.parse.quote(user, safe='')}:"
                f"{urllib.parse.quote(value, safe='')}@{host}:{port}/"
                f"{urllib.parse.quote(database, safe='')}?sslmode={ssl}")
        else:
            env[field["envVar"]] = value
    return env


# ------------------------------------------------------- dependency detection --

def _which(binary):
    return shutil.which(binary)


def missing_dependencies(server):
    """Executables the catalogue says this server needs and this machine lacks.

    Detection only. Nothing here installs, downloads or starts anything: opening
    a Configuration page must never cause an npx or uvx fetch.
    """
    requires = server.get("requires") or {}
    missing = []
    for binary in requires.get("executables", []):
        if not _which(str(binary)):
            missing.append(str(binary))
    any_of = requires.get("anyOf") or []
    if any_of and not any(_which(str(b)) for b in any_of):
        missing.append(" or ".join(str(b) for b in any_of))
    return missing


def resolved_version(server):
    """The pinned version this configuration would run, without resolving it
    over the network. `None` means the entry names no package."""
    package = server.get("package") or {}
    version = package.get("version")
    return f"{package.get('name')}@{version}" if package.get("name") and version else None


# ----------------------------------------------------------- readiness / state --

def missing_configuration(name, server, settings, *, secrets_dir=None, generated_dir=None):
    """Required user settings and credentials that are not present.

    Defaults count as present; a field the operator has not been shown (because
    its `showWhen` condition does not hold) is not demanded."""
    values = effective_values(name, server, settings, generated_dir=generated_dir)
    missing = []
    for field in server["userConfig"]:
        if not field.get("required") or not field_visible(field, values):
            continue
        if field.get("secret"):
            if not secret_exists(name, field["name"], secrets_dir):
                missing.append(field.get("label") or field["name"])
        elif not str(values.get(field["name"], "")).strip():
            missing.append(field.get("label") or field["name"])
    return missing


def enforceable_tools(name, server, settings, health):
    """The exact tool names a client may be given, or None when the whole tool
    set is safe, or an empty list when nothing can be proved safe.

    Returning `[]` for a mutation-capable server is what produces `blocked`. It
    is deliberately not the same as `None`: "no filtering needed" and "filtering
    impossible" must never collapse into one value."""
    policy = server["readOnlyPolicy"]
    if server["mutation"] == "read-only" or policy == "server-flag":
        return None
    record = (health or {}).get(name) or {}
    discovered = record.get("tools") or []
    if policy == "client-credential":
        # An operator who knows this provider's read tools can pin them, and
        # that pin is enforced exactly like any other allowlist. Absent one,
        # nothing filters the server — which is a limitation to state loudly,
        # not a subset to invent.
        pinned = [t.strip() for t in
                  str((settings or {}).get("values", {}).get("allowTools", "")).split(",")
                  if t.strip()]
        if pinned:
            return sorted(set(pinned))
        return None if not discovered else sorted(
            {t["name"] for t in discovered if isinstance(t, dict) and t.get("readOnlyHint")})
    if policy == "annotations":
        if not discovered:
            return []
        return sorted({t["name"] for t in discovered
                       if isinstance(t, dict) and t.get("name") and t.get("readOnlyHint")})
    if policy == "patterns":
        allow = [re.compile(p) for p in server["allowTools"]]
        deny = [re.compile(p) for p in server["denyTools"]]
        if not allow:
            return []
        if not discovered:
            # The patterns are known but the concrete tool names are not. A
            # pattern is not an allowlist any client can enforce, so the server
            # stays unproven until `fde mcp verify` has listed its tools.
            return []
        names = [t.get("name") for t in discovered if isinstance(t, dict) and t.get("name")]
        return sorted({n for n in names
                       if any(p.search(n) for p in allow)
                       and not any(p.search(n) for p in deny)})
    return []


def server_state(name, server, settings, health, *, secrets_dir=None):
    """(state, reason). `active` is never decided here — it belongs to a run."""
    if not server["enabled"]:
        return BLOCKED, "disabled in the catalogue"
    missing_bin = missing_dependencies(server)
    if missing_bin:
        setup = (server.get("requires") or {}).get("setup")
        detail = f"missing on this machine: {', '.join(missing_bin)}"
        return UNAVAILABLE, f"{detail}. {setup}" if setup else detail

    missing_cfg = missing_configuration(name, server, settings, secrets_dir=secrets_dir)
    if missing_cfg:
        return NOT_CONFIGURED, "not configured: " + ", ".join(missing_cfg)

    record = (health or {}).get(name) or {}
    # An OAuth server's token lives in the MCP client, not here, so FDE cannot
    # confirm a sign-in and must not pretend the absence of one is a fault. The
    # binding has to exist before the user can sign in through it. What FDE can
    # report is a refusal it actually saw.
    if record.get("outcome") == "authentication_required":
        return AUTHENTICATION_REQUIRED, redact(
            str(record.get("detail") or "the provider refused the stored credential"))[:240]

    # A server that would not start is unhealthy, and saying "blocked" instead
    # would send the operator looking for a policy problem they do not have.
    if record.get("outcome") == "failed":
        return UNHEALTHY, redact(str(record.get("detail") or "initialization failed"))[:240]

    tools = enforceable_tools(name, server, settings, health)
    if server["mutation"] == "mutation-capable" and tools == []:
        if server["readOnlyPolicy"] == "none":
            return BLOCKED, ("mutation tools cannot be governed for this provider — "
                             "no verified read-only tool subset is available")
        if not record:
            return NOT_CONFIGURED, ("its tool list has not been verified yet — run "
                                    f"fde mcp verify {name}")
        return BLOCKED, ("mutation tools cannot be governed: the verified tool list "
                         "exposes no enforceable read-only subset")

    if server["readOnlyPolicy"] == "client-credential" and tools is None:
        gate = ", ".join(mutation_targets(server)) or "the run's publication gate"
        return READY, (f"sign in inside its MCP client (/mcp); FDE holds no token for it. "
                       f"It runs with every tool it offers — this provider's tools cannot "
                       f"be scoped from here, so its writes are governed by "
                       f"fde approve-publish {gate} alone. Pin a read-only set with: "
                       f"fde mcp configure {name} --set allowTools=<comma-separated>")
    return READY, record.get("detail") or "available, configured and verifiable"


def status_record(name, server, settings, health, *, secrets_dir=None, active=False):
    """One safe, machine-readable row per server. No secret ever reaches it."""
    state, reason = server_state(name, server, settings, health, secrets_dir=secrets_dir)
    if active and state == READY:
        state, reason = ACTIVE, "included in the current effective set"
    record = (health or {}).get(name) or {}
    tools = enforceable_tools(name, server, settings, health)
    return {
        "name": name,
        "state": state,
        "reason": redact(reason),
        "enabled": server["enabled"],
        "transport": server["transport"],
        "auth": server["auth"],
        "classification": server["classification"],
        "mutation": server["mutation"],
        "readOnlyPolicy": server["readOnlyPolicy"],
        "targets": list(server["targets"]),
        "stages": list(server["stages"]),
        "profiles": list(server["profiles"]),
        "package": resolved_version(server),
        "missingDependencies": missing_dependencies(server),
        "missingConfiguration": missing_configuration(name, server, settings,
                                                      secrets_dir=secrets_dir),
        "requiredFields": [{"name": f["name"], "label": f.get("label") or f["name"],
                            "required": bool(f.get("required")), "secret": bool(f.get("secret")),
                            "type": f.get("type", "text"),
                            "options": list(f.get("options") or []),
                            "placeholder": f.get("placeholder"),
                            "showWhen": f.get("showWhen")}
                           for f in server["userConfig"]],
        "credentialsPresent": {f["name"]: secret_exists(name, f["name"], secrets_dir)
                               for f in secret_fields(server)},
        "enforceableTools": None if tools is None else list(tools),
        # True when this server reaches a session with its write tools intact,
        # because the provider's credential is the client's and FDE cannot scope
        # it. Every surface that shows a server has to be able to say this.
        "unscopedWrites": bool(server["mutation"] == "mutation-capable" and tools is None
                               and server["readOnlyPolicy"] == "client-credential"),
        "verification": {
            "at": record.get("at"),
            "initialize": record.get("initialize"),
            "toolCount": len(record.get("tools") or []) or None,
            "outcome": record.get("outcome"),
            "detail": redact(record.get("detail")),
        },
        "gateway": dict(server.get("gateway") or {}),
        "useWhen": server["useWhen"],
        "preferOver": list(server["preferOver"]),
        "doNotUseWhen": server["doNotUseWhen"],
        "setup": (server.get("requires") or {}).get("setup"),
        "docsUrl": (server.get("requires") or {}).get("docsUrl"),
        "note": server["note"],
    }


# ---------------------------------------------------------------- health store --

def load_health(path=None):
    doc = read_json(path or health_path(), {"schemaVersion": SCHEMA_VERSION, "servers": {}})
    return doc.get("servers") if isinstance(doc.get("servers"), dict) else {}


def save_health(servers, path=None):
    return write_private(pathlib.Path(path or health_path()),
                         json.dumps({"schemaVersion": SCHEMA_VERSION,
                                     "servers": servers}, indent=2, sort_keys=True) + "\n")


# ------------------------------------------------------------ effective sets --

def effective_servers(catalog, *, roles=(), stages=(), profile=None, targets=(),
                      user_doc=None, health=None, secrets_dir=None,
                      selected=None, include_global=True):
    """Which servers this run/chat may actually see, and why each other one may not.

    Returns (chosen, rejected) where chosen is {name: server} and rejected is
    {name: (state, reason)}. Nothing short of `ready` is ever chosen: a catalogue
    entry is not a grant, and neither is a role.
    """
    user_doc = user_doc if user_doc is not None else load_user_config()
    health = health if health is not None else load_health()
    roles, stages = set(roles or ()), set(stages or ())
    targets = set(targets or ())
    chosen, rejected = {}, {}

    for name, server in catalog.servers.items():
        if selected is not None and name not in selected:
            continue
        if not server["enabled"]:
            rejected[name] = (BLOCKED, "disabled in the catalogue")
            continue
        server_roles = {t.split(":", 1)[1] for t in server["targets"] if t.startswith("role:")}
        server_global = {t for t in server["targets"] if t in GLOBAL_TARGETS}
        if server_roles:
            if not (roles & server_roles):
                rejected[name] = (BLOCKED, "no role in this run holds this connector")
                continue
        elif not include_global or (targets and not (targets & server_global)):
            rejected[name] = (BLOCKED, "not targeted at this client")
            continue
        if server["stages"] and stages and not (stages & set(server["stages"])):
            rejected[name] = (BLOCKED, "no approved stage in this plan uses it")
            continue
        if profile is not None and server["profiles"] and profile not in server["profiles"]:
            rejected[name] = (BLOCKED, f"outside the '{profile}' profile")
            continue
        settings = server_settings(user_doc, name)
        state, reason = server_state(name, server, settings, health, secrets_dir=secrets_dir)
        if state != READY:
            rejected[name] = (state, reason)
            continue
        chosen[name] = server
    return chosen, rejected


# ------------------------------------------------------------------ rendering --

def client_view(name, server, client, *, settings=None, health=None,
                approved_mutation=False):
    """One server as a specific client should see it: overrides applied,
    placeholders resolved, tool allowlist attached.

    This is where "one definition, client-specific behaviour" happens — Serena's
    `--context claude-code` and `--context codex` are the same entry.

    `approved_mutation` is the only thing that can drop a server's own read-only
    flag, and it is set from a live, target-specific FDE approval — never from a
    catalogue value, a prompt or a caller's convenience."""
    view = dict(server)
    override = (server.get("clients") or {}).get(client) or {}
    for key in ("command", "args", "url", "env", "startupTimeoutSeconds",
                "toolTimeoutSeconds", "transport"):
        if key in override:
            if key == "env":
                merged = dict(server.get("env") or {})
                merged.update(override["env"])
                view["env"] = merged
            else:
                view[key] = override[key]
    values = effective_values(name, server, settings)

    def resolve(text):
        return PLACEHOLDER_RE.sub(lambda m: str(values.get(m.group(1), "")), text)

    if isinstance(view.get("url"), str):
        view["url"] = resolve(view["url"])
    args = [resolve(a) if isinstance(a, str) else a for a in (view.get("args") or [])]
    for spec in server.get("optionalArgs") or []:
        current = str(values.get(spec.get("field"), "")).strip()
        wanted = spec.get("equals")
        if (wanted is None and current) or (wanted is not None and current == str(wanted)):
            args += [resolve(a) if isinstance(a, str) else a for a in spec.get("args", [])]
    if approved_mutation and server.get("mutationRemovesArgs"):
        drop = set(server["mutationRemovesArgs"])
        args = [a for a in args if a not in drop]
    view["args"] = args
    view["env"] = {k: resolve(v) if isinstance(v, str) else v
                   for k, v in (view.get("env") or {}).items()}
    header_vars = {spec.get("envVar") for spec in (server.get("httpHeaders") or {}).values()
                   if isinstance(spec, dict)}
    if view["transport"] == "stdio":
        for field in secret_fields(server):
            # A secret is referenced by variable name, never by value, in every
            # generated artefact. The value reaches the child process only through
            # child_environment(). A credential carried as an HTTP header is not
            # also placed in a process environment.
            if field["envVar"] in header_vars:
                continue
            view["env"].setdefault(field["envVar"], "${%s}" % field["envVar"])
    view["httpHeaders"] = dict(server.get("httpHeaders") or {})
    view["allowedTools"] = enforceable_tools(name, server, settings or
                                             {"values": values, "tools": {}}, health)
    return view


def render_claude(servers, *, settings_by_name=None, health=None, approved=()):
    """Claude Code `.mcp.json` shape: {"mcpServers": {...}}.

    Credentials appear as `${VAR}` references; the variable is set only in the
    client process FDE launches for this run or chat."""
    out = {}
    for name, server in servers.items():
        view = client_view(name, server, "claude",
                           settings=(settings_by_name or {}).get(name), health=health,
                           approved_mutation=name in set(approved))
        if view["transport"] in ("http", "sse"):
            entry = {"type": view["transport"], "url": view["url"]}
        else:
            entry = {"command": view["command"], "args": list(view["args"])}
            if view.get("cwd"):
                entry["cwd"] = view["cwd"]
        if view["env"]:
            entry["env"] = dict(view["env"])
        if view["httpHeaders"]:
            entry["headers"] = {header: "${%s}" % spec["envVar"]
                                for header, spec in view["httpHeaders"].items()}
        out[name] = entry
    return out


def claude_launch_env(servers):
    """Claude Code takes its MCP startup ceiling from its own environment, not
    from `.mcp.json`. A slow server — Serena indexing a large repository on first
    start — therefore needs the launcher to raise it, so the value is returned
    here rather than written into a config file that would ignore it."""
    ceiling = 0
    for name, server in servers.items():
        view = client_view(name, server, "claude")
        ceiling = max(ceiling, int(view.get("startupTimeoutSeconds") or 0))
    return {"MCP_TIMEOUT": str(ceiling * 1000)} if ceiling else {}


def render_claude_permissions(servers, *, settings_by_name=None, health=None):
    """Claude Code enforces MCP tool scope through permission rules, not through
    `.mcp.json`. Wildcards are not accepted for MCP specifiers, so an allowlist
    is a list of exact `mcp__<server>__<tool>` names — which is precisely why a
    server whose tool list has not been verified cannot be allow-listed at all."""
    allow, deny = [], []
    for name, server in sorted(servers.items()):
        view = client_view(name, server, "claude",
                           settings=(settings_by_name or {}).get(name), health=health)
        tools = view["allowedTools"]
        if tools is None:
            allow.append(f"mcp__{name}")
            continue
        if not tools:
            deny.append(f"mcp__{name}")
            continue
        allow.extend(f"mcp__{name}__{tool}" for tool in tools)
        deny.append(f"mcp__{name}")
    # An exact allow rule is more specific than the server-wide deny, so the two
    # together mean "these tools and nothing else from this server".
    return {"permissions": {"allow": allow, "deny": deny}}


def render_gemini(servers, *, settings_by_name=None, health=None, approved=()):
    """Gemini CLI: streamable HTTP is `httpUrl`; `url` means SSE. Tool scope is
    `includeTools` / `excludeTools` on the server entry itself."""
    out = {}
    for name, server in servers.items():
        view = client_view(name, server, "gemini",
                           settings=(settings_by_name or {}).get(name), health=health,
                           approved_mutation=name in set(approved))
        entry = {}
        if view["transport"] == "http":
            entry["httpUrl"] = view["url"]
        elif view["transport"] == "sse":
            entry["url"] = view["url"]
        else:
            entry["command"] = view["command"]
            if view["args"]:
                entry["args"] = list(view["args"])
            if view["env"]:
                entry["env"] = dict(view["env"])
        if view["httpHeaders"]:
            entry["headers"] = {header: "${%s}" % spec["envVar"]
                                for header, spec in view["httpHeaders"].items()}
        if view.get("startupTimeoutSeconds"):
            entry["timeout"] = int(view["startupTimeoutSeconds"]) * 1000
        tools = view["allowedTools"]
        if tools is not None:
            entry["includeTools"] = list(tools)
        out[name] = entry
    return out


def toml_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    return json.dumps(str(value))


def render_codex_block(servers, *, settings_by_name=None, health=None, approved=(),
                       begin="# >>> fde-mcp (generated by mcp-sync)",
                       end="# <<< fde-mcp"):
    """Codex `~/.codex/config.toml`: `[mcp_servers.<name>]`, with `enabled_tools`
    as the enforceable allowlist and `env_http_headers` naming the variable that
    carries a credential rather than the credential itself."""
    lines = [begin]
    for name, server in servers.items():
        view = client_view(name, server, "codex",
                           settings=(settings_by_name or {}).get(name), health=health,
                           approved_mutation=name in set(approved))
        lines.append(f"[mcp_servers.{name}]")
        if view["transport"] in ("http", "sse"):
            lines.append(f"url = {toml_value(view['url'])}")
            if view.get("bearer_token_env_var"):
                lines.append(f"bearer_token_env_var = {toml_value(view['bearer_token_env_var'])}")
        else:
            lines.append(f"command = {toml_value(view['command'])}")
            if view["args"]:
                lines.append(f"args = {toml_value(list(view['args']))}")
        if view.get("startupTimeoutSeconds"):
            lines.append(f"startup_timeout_sec = {toml_value(int(view['startupTimeoutSeconds']))}")
        if view.get("toolTimeoutSeconds"):
            lines.append(f"tool_timeout_sec = {toml_value(int(view['toolTimeoutSeconds']))}")
        tools = view["allowedTools"]
        if tools is not None:
            lines.append(f"enabled_tools = {toml_value(list(tools))}")
        if view["env"]:
            lines.append(f"[mcp_servers.{name}.env]")
            for key, value in view["env"].items():
                lines.append(f"{key} = {toml_value(value)}")
        if view["httpHeaders"]:
            lines.append(f"[mcp_servers.{name}.env_http_headers]")
            for header, spec in view["httpHeaders"].items():
                lines.append(f"{toml_value(header)} = {toml_value(spec['envVar'])}")
        lines.append("")
    lines.append("# Anything you add below this marker joins the LAST table above,")
    lines.append("# because that is how TOML scoping works. Put your own keys above it.")
    lines.append(end)
    return "\n".join(lines)


RENDERERS = {"claude": render_claude, "gemini": render_gemini}


# ------------------------------------------------------------ generated files --

def generated_files(name, server, settings, *, root=None, dry_run=False):
    """Write a server's local support files (a DBHub TOML, say) owner-only.

    The template may reference `{{config.field}}` for non-secret settings and
    `${ENV_VAR}` for a secret — the latter is left verbatim so the value only
    ever exists in the child process's environment."""
    written = []
    values = effective_values(name, server, settings, generated_dir=root)
    base = pathlib.Path(root or generated_root()) / name
    for spec in server.get("generatedFiles") or []:
        body = PLACEHOLDER_RE.sub(lambda m: str(values.get(m.group(1), "")),
                                  str(spec.get("template", "")))
        for pattern in SECRET_LITERAL_PATTERNS:
            if pattern.search(body):
                raise CatalogError(
                    "generated_secret",
                    f"refusing to write {spec['path']} for {name}: the rendered file "
                    f"contains a literal credential")
        target = base / spec["path"]
        if not dry_run:
            write_private(target, body, int(str(spec.get("mode", "0600")), 8))
        written.append(str(target))
    return written


def generated_path(name, relative, root=None):
    return str(pathlib.Path(root or generated_root()) / name / relative)


# ------------------------------------------------------------- verification --

# A verification child gets a deliberately small environment: enough to find its
# runtime, reach the network the way this machine reaches it, and locate the local
# credential chain a cloud proxy is supposed to use — and nothing else. These are
# settings, not secrets: a proxy address, a CA bundle path, an AWS profile name.
# The actual credentials stay in the files those names point at, and the only
# secret values that ever enter this environment are the ones child_environment()
# composes for this specific server.
VERIFY_ENV_PASSTHROUGH = frozenset({
    "HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "USER", "SHELL", "LOGNAME",
    # How this machine reaches the network, including behind a corporate proxy.
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE", "NPM_CONFIG_REGISTRY", "npm_config_registry", "NODE_OPTIONS",
    # Where package managers cache, so a verification does not re-download.
    "XDG_CACHE_HOME", "UV_CACHE_DIR", "npm_config_cache",
    # The local credential chains the cloud proxies are designed to use. These
    # name a profile and a file; they are not the credential.
    "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE", "AZURE_CONFIG_DIR",
})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _http_rpc(url, payload, headers, timeout):
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={**headers, "Accept": "application/json, text/event-stream",
                 "Content-Type": "application/json",
                 "MCP-Protocol-Version": "2025-06-18", "User-Agent": "fde-local/1"},
        method="POST")
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(256 * 1024)
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        return 0, str(exc)[:240].encode()


def _sse_or_json(raw):
    text = raw.decode("utf-8", "replace")
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {}


def verify_server(name, server, settings, *, secrets_dir=None, timeout=None):
    """A bounded initialize + tools/list. Never a business operation.

    Returns a health record. For an stdio server this speaks the protocol over
    the child's stdin/stdout with a hard timeout, and the child is killed as soon
    as the tool list is in hand."""
    verify = server["verify"]
    timeout = timeout or int(verify.get("timeoutSeconds") or 30)
    method = verify.get("method", "tools/list")
    record = {"at": None, "initialize": None, "tools": [], "outcome": "skipped",
              "detail": None, "authenticated": False}
    if method == "none":
        record["outcome"] = "skipped"
        record["detail"] = "this server declares no bounded verification"
        return record

    env = child_environment(name, server, settings=settings, secrets_dir=secrets_dir)
    initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                             "clientInfo": {"name": "fde-local", "version": "1"}}}
    listing = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}

    if server["transport"] in ("http", "sse"):
        view = client_view(name, server, "claude", settings=settings)
        # Composed here and discarded with this function's frame: the header
        # value is never written to the health record, an event or a log.
        headers = {header: env[spec["envVar"]]
                   for header, spec in (view.get("httpHeaders") or {}).items()
                   if env.get(spec.get("envVar"))}
        status, raw = _http_rpc(view["url"], initialize, headers, timeout)
        record["initialize"] = status
        if status in (401, 403):
            record["outcome"] = "authentication_required"
            record["detail"] = f"provider returned HTTP {status}"
            return record
        if not 200 <= status < 300:
            record["outcome"] = "failed"
            record["detail"] = (f"provider returned HTTP {status}" if status
                                else redact(raw.decode("utf-8", "replace")))
            return record
        record["authenticated"] = True
        status, raw = _http_rpc(view["url"], listing, headers, timeout)
        tools = ((_sse_or_json(raw).get("result") or {}).get("tools") or []) \
            if 200 <= status < 300 else []
        record["tools"] = _tool_summaries(tools)
        record["outcome"] = "ok" if record["tools"] or method == "initialize" else "failed"
        if record["outcome"] == "failed":
            record["detail"] = "the server returned no tool list"
        return record

    return _verify_stdio(name, server, settings, env, initialize, listing,
                         timeout, record)


def _tool_summaries(tools):
    out = []
    for tool in tools or []:
        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
            continue
        annotations = tool.get("annotations") or {}
        out.append({"name": tool["name"][:120],
                    "readOnlyHint": bool(annotations.get("readOnlyHint")),
                    "destructiveHint": bool(annotations.get("destructiveHint"))})
    return out


def _verify_stdio(name, server, settings, env, initialize, listing, timeout, record):
    view = client_view(name, server, "claude", settings=settings)
    command = _which(view["command"]) or view["command"]
    child_env = {k: v for k, v in os.environ.items() if k in VERIFY_ENV_PASSTHROUGH}
    child_env.update({k: v for k, v in (view.get("env") or {}).items()
                      if not ENV_REF_RE.fullmatch(str(v))})
    child_env.update(env)
    try:
        child = subprocess.Popen(
            [command, *view["args"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=child_env, text=True, bufsize=1, shell=False)
    except OSError as exc:
        record.update(outcome="failed", detail=redact(str(exc))[:240])
        return record
    try:
        payload = json.dumps(initialize) + "\n" + json.dumps(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n" + \
            json.dumps(listing) + "\n"
        try:
            out, err = child.communicate(payload, timeout=timeout)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate()
            record.update(outcome="failed",
                          detail=f"the server did not answer within {timeout}s")
            return record
        results = {}
        for line in (out or "").splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict) and message.get("id") in (1, 2):
                results[message["id"]] = message
        if 1 not in results:
            record.update(outcome="failed",
                          detail=redact((err or "the server produced no initialize result"))[:240])
            return record
        record["initialize"] = 200
        record["authenticated"] = True
        tools = ((results.get(2, {}).get("result") or {}).get("tools") or [])
        record["tools"] = _tool_summaries(tools)
        record["outcome"] = "ok" if record["tools"] else "failed"
        if not record["tools"]:
            record["detail"] = "the server listed no tools"
        return record
    finally:
        if child.poll() is None:
            child.kill()


# -------------------------------------------------------------- docker gateway --

def gateway_available():
    """Detection only, and deliberately cheap: Docker is optional for all of FDE."""
    docker = _which("docker")
    if not docker:
        return False, "docker is not installed"
    try:
        result = subprocess.run([docker, "mcp", "gateway", "--help"],
                                capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, redact(str(exc))[:160]
    if result.returncode != 0:
        return False, "docker is installed but the MCP Gateway plugin is not"
    return True, "docker mcp gateway is available"


def gateway_plan(catalog, *, profile=None, available=None):
    """Which direct entries the gateway would replace, without changing anything.

    Deduplication is the point: a server must never appear both directly and
    through the gateway in one effective configuration."""
    if available is None:
        available, detail = gateway_available()
    else:
        detail = "assumed available"
    routed, direct = {}, {}
    for name, server in catalog.enabled().items():
        docker_profile = (server.get("gateway") or {}).get("docker")
        if profile is not None and server["profiles"] and profile not in server["profiles"]:
            continue
        if docker_profile and available:
            routed[name] = docker_profile
        else:
            direct[name] = (server.get("gateway") or {}).get("docker")
    return {
        "available": bool(available),
        "detail": detail,
        "profile": profile,
        "routedThroughGateway": routed,
        "runDirectly": sorted(direct),
        "dockerProfiles": sorted({p for p in routed.values() if p}),
        "note": ("Docker is optional. FDE remains the policy authority for roles, "
                 "stages and approval gates; the gateway only provides isolation, "
                 "lifecycle and container-side allowlists."),
    }


# ---------------------------------------------------------- approval binding --

def mutation_targets(server):
    approval = server.get("mutationApproval") or {}
    return [t for t in approval.get("targets", []) if t in PUBLICATION_TARGETS]


def tool_is_mutation(name, server, tool, health=None):
    """Whether calling `tool` on this server counts as an external mutation."""
    allowed = enforceable_tools(name, server, {"values": {}, "tools": {}}, health)
    if allowed is None:
        return False
    return tool not in set(allowed)


# ------------------------------------------------------------------- scopes --

def scope_of_tool(tool_name, server, record=None):
    """Which scope calling this tool falls under.

    Four sources, in order of authority: what the catalogue declares, what the
    server's own MCP annotations say, what the name looks like, and — when none
    of those answer — `administer`. That last step is the important one: a tool
    nobody has classified is available only to a caller granted the broadest
    scope, so an unrecognised tool appearing in a server update cannot quietly
    ride in on a read-only grant.
    """
    declared = (server.get("scopes") or {})
    # Broadest first: a tool matching two declarations is the more dangerous one.
    for scope in reversed(SCOPES):
        for pattern in declared.get(scope, ()):
            try:
                if re.search(pattern, tool_name):
                    return scope
            except re.error:
                continue
    annotations = record or {}
    if annotations.get("destructiveHint"):
        return "delete"
    if annotations.get("readOnlyHint"):
        return "search" if any(re.search(p, tool_name)
                               for p in dict(_SCOPE_PATTERNS)["search"]) else "read"
    for scope, patterns in _SCOPE_PATTERNS:
        if any(re.search(pattern, tool_name) for pattern in patterns):
            return scope
    return "administer"


def discovered_tools(name, health):
    """The tool names `fde mcp verify` actually saw, with their annotations."""
    record = (health or {}).get(name) or {}
    return {tool["name"]: tool for tool in (record.get("tools") or [])
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)}


def scope_map(name, server, health):
    """{tool name: scope} over the tools this server was observed to offer."""
    observed = discovered_tools(name, health)
    return {tool: scope_of_tool(tool, server, record) for tool, record in observed.items()}


def tools_for_scopes(name, server, settings, health, granted):
    """The tools a caller holding `granted` may be given, and how sure we are.

    A scope NARROWS; it never widens. The starting point is whatever
    `enforceable_tools` already proved safe, so granting `delete` on a server
    whose delete tools are withheld by its allowlist adds nothing — and the
    result says so rather than leaving the operator to infer it.
    """
    granted = [scope for scope in SCOPES if scope in set(granted or ())]
    base = enforceable_tools(name, server, settings, health)
    mapping = scope_map(name, server, health)
    observed = sorted(mapping)

    if base == []:
        return {"tools": [], "state": "nothing-enforceable", "enforced": True,
                "granted": granted, "withheld": [], "byScope": {}, "unenforceable": granted,
                "reason": "No tool on this server can be proved safe, so none is offered."}

    universe = sorted(base) if base is not None else observed
    if not universe:
        # `base is None` means the whole tool set is safe, but nobody has listed
        # it yet. Claiming a scope was applied here would be a claim about tools
        # this machine has never seen.
        return {"tools": None, "state": "unverified", "enforced": False,
                "granted": granted, "withheld": [], "byScope": {}, "unenforceable": granted,
                "reason": ("Its tool list has not been verified, so scopes cannot be applied "
                           f"to it yet. Run: fde mcp verify {name}")}

    by_scope = {}
    allowed, withheld = [], []
    for tool in universe:
        scope = mapping.get(tool) or scope_of_tool(tool, server)
        by_scope.setdefault(scope, []).append(tool)
        (allowed if scope in granted else withheld).append(tool)
    unenforceable = [scope for scope in granted if not by_scope.get(scope)]
    return {"tools": sorted(allowed), "state": "enforced", "enforced": True,
            "granted": granted, "withheld": sorted(withheld),
            "byScope": {scope: sorted(tools) for scope, tools in sorted(by_scope.items())},
            "unenforceable": unenforceable,
            "reason": (f"{len(allowed)} of {len(universe)} enforceable tools fall within "
                       + (", ".join(granted) or "no granted scope") + ".")}


def minimum_scopes(server):
    """What a read-only stage needs from this server: nothing wider than search."""
    return list(READ_ONLY_SCOPES) if server.get("mutation") != "read-only" else list(READ_ONLY_SCOPES)


__all__ = [
    "SCOPES", "READ_ONLY_SCOPES", "scope_of_tool", "scope_map", "discovered_tools",
    "tools_for_scopes", "minimum_scopes",
    "SCHEMA_VERSION", "SUPPORTED_SCHEMA_VERSIONS", "GLOBAL_TARGETS", "TRANSPORTS",
    "AUTH_MODES", "MUTATION_CLASSES", "READ_ONLY_POLICIES", "LIFECYCLE_STATES",
    "UNAVAILABLE", "NOT_CONFIGURED", "AUTHENTICATION_REQUIRED", "READY", "ACTIVE",
    "UNHEALTHY", "BLOCKED", "KNOWN_ROLES", "KNOWN_STAGES", "PUBLICATION_TARGETS",
    "CatalogError", "Catalog", "migrate", "validate", "with_defaults", "redact",
    "load_user_config", "save_user_config", "server_settings", "set_server_settings",
    "secret_file", "secret_exists", "store_secret", "read_secret", "delete_secret",
    "secret_fields", "public_fields", "child_environment", "missing_dependencies",
    "resolved_version", "missing_configuration", "enforceable_tools", "server_state",
    "status_record", "load_health", "save_health", "effective_servers", "client_view",
    "render_claude", "render_claude_permissions", "render_gemini", "render_codex_block",
    "claude_launch_env", "effective_values", "field_visible",
    "generated_files", "generated_path", "verify_server", "gateway_available",
    "gateway_plan", "mutation_targets", "tool_is_mutation", "catalog_path",
    "user_config_path", "secrets_root", "generated_root", "health_path",
    "write_private", "read_json", "shared_root",
]
