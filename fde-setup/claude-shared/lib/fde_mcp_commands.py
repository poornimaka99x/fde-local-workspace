"""`fde mcp …` — the operator's view of the governed MCP catalogue.

These live beside the catalogue library rather than inside the controller so
that `fde`, `mcp-sync` and `fde-doctor` all answer "is this server usable, for
whom, with which tools" from one implementation. The controller wires the
subparser in and owns the run store, events and approvals; everything here is
about the catalogue, the operator's configuration and readiness.

Two invariants the whole file exists to keep:

  Opening this page starts nothing. `list`, `status`, `effective`, `gateway`
  and `profiles` read files. Only `verify` launches a server, and only because
  the operator asked it to.

  A credential is never returned. Secrets arrive on stdin, are written
  owner-only, and every response says whether one is present — never what it is.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

import fde_mcp as mcp

# The controller sets this so a verification, an activation or a refusal lands in
# the run's append-only record. Left unset, the commands still work — they just
# have nowhere to write history, which is the right behaviour outside a run.
EVENT_HOOK = None

SET_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9_]{0,39})=(.*)$", re.DOTALL)
MAX_SECRET_BYTES = 8192


class McpCommandError(Exception):
    def __init__(self, code, message, detail=None, exit_code=2):
        super().__init__(message)
        self.code, self.message, self.detail, self.exit_code = code, message, detail, exit_code


def _emit(payload):
    print(json.dumps(mcp.redact(payload), indent=2))
    return 0


def command(fn):
    """One error envelope for every `fde mcp` subcommand, redacted on the way out."""
    @functools.wraps(fn)
    def wrapper(args):
        try:
            return fn(args)
        except McpCommandError as exc:
            _emit({"schemaVersion": mcp.SCHEMA_VERSION,
                   "error": {"code": exc.code, "message": exc.message,
                             "detail": exc.detail}})
            return exc.exit_code
        except mcp.CatalogError as exc:
            _emit({"schemaVersion": mcp.SCHEMA_VERSION,
                   "error": {"code": exc.code, "message": exc.message,
                             "problems": exc.problems[:20]}})
            return 2
    return wrapper


def _event(kind, **fields):
    if EVENT_HOOK is not None:
        try:
            EVENT_HOOK(kind, **mcp.redact(fields))
        except Exception:  # noqa: BLE001 — history is best-effort, never load-bearing
            pass


# --------------------------------------------------------------------- state --

def _catalog(strict=True):
    try:
        return mcp.Catalog.load(strict=strict)
    except mcp.CatalogError:
        if strict:
            raise
        return None


def _state():
    return _catalog(), mcp.load_user_config(), mcp.load_health()


def _record(catalog, user_doc, health, name, *, active=False):
    server = catalog.get(name)
    settings = mcp.server_settings(user_doc, name)
    record = mcp.status_record(name, server, settings, health, active=active)
    # The operator's own non-secret choices, so the console can render the form
    # it already filled in. Secret fields are absent by construction.
    record["values"] = {k: str(v) for k, v in
                        mcp.effective_values(name, server, settings).items()
                        if not any(f.get("secret") and f["name"] == k
                                   for f in server["userConfig"])}
    return record


def _require(catalog, name):
    if name not in catalog.servers:
        raise McpCommandError("unknown_server", f"no MCP server '{name}' in the catalogue",
                              exit_code=4)


# ------------------------------------------------------------------ commands --

@command
def cmd_list(args):
    catalog = _catalog(strict=False)
    if catalog is None:
        strict = mcp.Catalog.load(strict=False)
        return _emit({"schemaVersion": mcp.SCHEMA_VERSION,
                      "catalogue": {"path": str(mcp.catalog_path()), "valid": False,
                                    "problems": strict.problems[:50],
                                    "schemaVersionOnDisk": strict.doc.get("schemaVersion", 1)},
                      "profiles": [], "servers": []})
    user_doc, health = mcp.load_user_config(), mcp.load_health()
    profiles = [{"name": name, "label": spec.get("label", name),
                 "description": spec.get("description", ""),
                 "servers": sorted(spec.get("servers") or []),
                 "docker": spec.get("docker")}
                for name, spec in sorted(catalog.profiles.items())]
    return _emit({
        "schemaVersion": mcp.SCHEMA_VERSION,
        "catalogue": {"path": str(mcp.catalog_path()), "valid": True, "problems": [],
                      "schemaVersionOnDisk": catalog.doc.get("schemaVersion",
                                                             mcp.SCHEMA_VERSION)},
        "profiles": profiles,
        "servers": [_record(catalog, user_doc, health, name) for name in catalog.names()],
    })


@command
def cmd_status(args):
    catalog, user_doc, health = _state()
    _require(catalog, args.server)
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION,
                  "server": _record(catalog, user_doc, health, args.server)})


@command
def cmd_profiles(args):
    catalog = _catalog()
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION,
                  "profiles": [{"name": name, "label": spec.get("label", name),
                                "description": spec.get("description", ""),
                                "servers": sorted(spec.get("servers") or []),
                                "docker": spec.get("docker")}
                               for name, spec in sorted(catalog.profiles.items())]})


@command
def cmd_configure(args):
    """Store the operator's non-secret settings and regenerate the server's files.

    Rejects a field the catalogue does not declare, and refuses to accept a
    secret here: a credential has its own command and never travels as an
    argument, where it would reach the process table and the shell history."""
    catalog, user_doc, health = _state()
    _require(catalog, args.server)
    server = catalog.get(args.server)
    declared = {f["name"]: f for f in server["userConfig"]}
    supplied = {}
    for pair in args.set or []:
        match = SET_RE.match(pair)
        if not match:
            raise McpCommandError("field_invalid", "settings must use name=value")
        supplied[match.group(1)] = match.group(2).strip()
    unknown = set(supplied) - set(declared)
    if unknown:
        raise McpCommandError("field_invalid",
                              f"unknown setting(s) for {args.server}: "
                              f"{', '.join(sorted(unknown))}")
    secretish = [name for name in supplied if declared[name].get("secret")]
    if secretish:
        raise McpCommandError(
            "secret_not_accepted",
            f"{', '.join(sorted(secretish))} is a credential: use "
            f"`fde mcp set-secret {args.server} <field>`, which reads stdin and echoes nothing")
    for name, value in supplied.items():
        options = declared[name].get("options")
        if options and value not in {str(o.get("value")) for o in options}:
            raise McpCommandError("field_invalid",
                                  f"{declared[name].get('label') or name} must be one of "
                                  f"{', '.join(str(o.get('value')) for o in options if o.get('value'))}")
        if declared[name].get("type") == "url" and value:
            problems = []
            mcp._validate_url(problems, f"{name}", value)  # noqa: SLF001 — one URL rule
            if problems:
                raise McpCommandError("field_invalid", problems[0])

    settings = mcp.server_settings(user_doc, args.server)
    values = dict(settings["values"])
    values.update({k: v for k, v in supplied.items() if v != ""})
    for key, value in supplied.items():
        if value == "":
            values.pop(key, None)
    mcp.set_server_settings(user_doc, args.server, values=values, enabled=True)
    mcp.save_user_config(user_doc)

    settings = mcp.server_settings(user_doc, args.server)
    written = mcp.generated_files(args.server, server, settings)
    record = _record(catalog, user_doc, health, args.server)
    _event("mcp.server.configured", server=args.server, state=record["state"],
           fields=sorted(supplied), generated=[os.path.basename(p) for p in written])
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION, "server": record})


@command
def cmd_set_secret(args):
    raw = sys.stdin.read(MAX_SECRET_BYTES + 1)
    if not raw or len(raw.encode()) > MAX_SECRET_BYTES or "\n" in raw.rstrip("\r\n"):
        raise McpCommandError("secret_invalid", "the credential must be one non-empty line "
                                                "under 8 KiB")
    secret = raw.rstrip("\r\n")
    if len(secret) < 8:
        raise McpCommandError("secret_too_short", "that credential is too short")
    if any(ord(char) < 32 or ord(char) == 127 for char in secret):
        raise McpCommandError("secret_invalid", "a credential cannot contain control characters")

    catalog, user_doc, health = _state()
    _require(catalog, args.server)
    server = catalog.get(args.server)
    field = next((f for f in mcp.secret_fields(server) if f["name"] == args.field), None)
    if field is None:
        raise McpCommandError("field_invalid",
                              f"{args.server} declares no credential field '{args.field}'",
                              exit_code=4)
    mcp.store_secret(args.server, args.field, secret)
    # A stored credential invalidates what verification previously concluded.
    health.pop(args.server, None)
    mcp.save_health(health)
    mcp.set_server_settings(user_doc, args.server, enabled=True)
    mcp.save_user_config(user_doc)
    settings = mcp.server_settings(user_doc, args.server)
    mcp.generated_files(args.server, server, settings)
    _event("mcp.server.configured", server=args.server, field=args.field, credential="stored")
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION,
                  "server": _record(catalog, user_doc, health, args.server)})


@command
def cmd_clear_secret(args):
    catalog, user_doc, health = _state()
    _require(catalog, args.server)
    mcp.delete_secret(args.server, args.field)
    health.pop(args.server, None)
    mcp.save_health(health)
    _event("mcp.server.configured", server=args.server, field=args.field, credential="cleared")
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION,
                  "server": _record(catalog, user_doc, health, args.server)})


@command
def cmd_enable(args):
    catalog, user_doc, health = _state()
    _require(catalog, args.server)
    mcp.set_server_settings(user_doc, args.server, enabled=bool(args.enabled))
    mcp.save_user_config(user_doc)
    record = _record(catalog, user_doc, health, args.server)
    _event("mcp.server.enabled" if args.enabled else "mcp.server.disabled",
           server=args.server, state=record["state"])
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION, "server": record})


@command
def cmd_verify(args):
    """Bounded initialize + tools/list. Never a business operation.

    This is also where a read-only subset stops being a claim and becomes a fact:
    the tool names the server actually reported are what a client allowlist is
    built from."""
    catalog, user_doc, health = _state()
    _require(catalog, args.server)
    server = catalog.get(args.server)
    settings = mcp.server_settings(user_doc, args.server)
    missing = mcp.missing_dependencies(server)
    if missing:
        raise McpCommandError(
            "unavailable",
            f"{args.server} needs {', '.join(missing)}, which this machine does not have",
            (server.get("requires") or {}).get("setup"), exit_code=4)
    missing_config = mcp.missing_configuration(args.server, server, settings)
    if missing_config:
        raise McpCommandError("not_configured",
                              f"{args.server} is missing: {', '.join(missing_config)}",
                              exit_code=4)
    record = mcp.verify_server(args.server, server, settings,
                               timeout=getattr(args, "timeout", None))
    record["at"] = _now()
    health[args.server] = record
    mcp.save_health(health)
    status = _record(catalog, user_doc, health, args.server)
    _event("mcp.server.verification", server=args.server, outcome=record.get("outcome"),
           initialize=record.get("initialize"), toolCount=len(record.get("tools") or []),
           state=status["state"])
    _emit({"schemaVersion": mcp.SCHEMA_VERSION, "server": status})
    return 0 if status["state"] in (mcp.READY, mcp.ACTIVE) else 4


def _now():
    import datetime as _dt
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z")


@command
def cmd_effective(args):
    """What a run, or a hypothetical selection, may actually reach — and why not.

    With `--run`, this reads the run's approved plan and confirmed roles; the
    answer is the same one `mcp-sync --run` would write. Without it, the flags
    describe a proposal, which is what the combined approval summary shows before
    anything is generated."""
    catalog, user_doc, health = _state()
    roles, stages, profile, run_id = set(args.role or []), list(args.stage or []), args.profile, None
    identities = {}
    if args.run:
        run_id = args.run
        run_dir = pathlib.Path(os.environ.get(
            "FDE_RUNS_DIR", mcp.shared_root() / "runs")) / args.run
        if not run_dir.is_dir():
            raise McpCommandError("unknown_run", f"no such run: {args.run}", exit_code=4)
        roles_doc = mcp.read_json(run_dir / "roles.json", {})
        plan = mcp.read_json(run_dir / "plan.json", {})
        assignments = roles_doc.get("assignments") or {}
        for role, value in assignments.items():
            holders = value if isinstance(value, list) else [value] if value else []
            if holders:
                roles.add(role)
                identities[role] = [h for h in holders if h]
        stages = stages or list(plan.get("stages") or [])
        profile = profile or plan.get("mcpProfile")
    if profile and profile not in catalog.profiles:
        raise McpCommandError("unknown_profile", f"no MCP profile '{profile}'", exit_code=4)
    for role in roles:
        if role not in mcp.KNOWN_ROLES:
            raise McpCommandError("unknown_role", f"no such role: {role}")
    for stage in stages:
        if stage not in mcp.KNOWN_STAGES:
            raise McpCommandError("unknown_stage", f"no such stage: {stage}")

    chosen, rejected = mcp.effective_servers(
        catalog, roles=roles, stages=stages, profile=profile, user_doc=user_doc,
        health=health, include_global=not args.run)
    active = []
    for name in sorted(chosen):
        server = catalog.get(name)
        holders = sorted({aid for role, ids in identities.items() for aid in ids
                          if f"role:{role}" in server["targets"]})
        active.append({
            "name": name,
            "mutation": server["mutation"],
            "classification": server["classification"],
            "allowedTools": mcp.enforceable_tools(name, server,
                                                  mcp.server_settings(user_doc, name), health),
            "identities": holders,
        })
    payload = {
        "schemaVersion": mcp.SCHEMA_VERSION, "runId": run_id, "profile": profile,
        "roles": sorted(roles), "stages": stages, "active": active,
        "refused": [{"name": name, "state": state, "reason": mcp.redact(reason)}
                    for name, (state, reason) in sorted(rejected.items())],
    }
    if args.json:
        return _emit(payload)
    print_effective(payload)
    return 0


def print_effective(payload, *, indent="  "):
    """The same answer in the shape a person reads before approving it."""
    if not payload["active"]:
        print(f"{indent}(no MCP server is active for this selection)")
    for item in payload["active"]:
        tools = item["allowedTools"]
        scope = ("every tool" if tools is None
                 else f"{len(tools)} read tool(s)" if tools else "no tool")
        print(f"{indent}{item['name']:16s} {item['mutation']:17s} {item['classification']:22s} "
              f"{scope}"
              + (f"  -> {', '.join(item['identities'])}" if item["identities"] else ""))
    # Only refusals an operator could act on. "Not in this profile" and "no role
    # holds it" are the design working, not problems to read past every time.
    scoping = ("outside the '", "no role in this run", "no approved stage",
               "not targeted at this client")
    actionable = [r for r in payload["refused"]
                  if not any(marker in r["reason"] for marker in scoping)]
    for item in actionable[:8]:
        print(f"{indent}{item['name']:16s} {item['state']:22s} {item['reason'][:80]}")
    if len(actionable) > 8:
        print(f"{indent}… and {len(actionable) - 8} more — fde mcp list")


@command
def cmd_gateway(args):
    catalog = _catalog()
    if args.profile and args.profile not in catalog.profiles:
        raise McpCommandError("unknown_profile", f"no MCP profile '{args.profile}'", exit_code=4)
    plan = mcp.gateway_plan(catalog, profile=args.profile)
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION, **plan})


@command
def cmd_env(args):
    """NUL-delimited KEY=VALUE pairs for one server's child process. No other output.

    This is the only path a credential takes out of the secret store, and it
    goes to a process, never to a file, an argument list or a response body."""
    catalog, user_doc, _health = _state()
    _require(catalog, args.server)
    server = catalog.get(args.server)
    settings = mcp.server_settings(user_doc, args.server)
    env = mcp.child_environment(args.server, server, settings=settings)
    raw = b"\0".join(f"{k}={v}".encode() for k, v in sorted(env.items()))
    if raw:
        raw += b"\0"
    sys.stdout.buffer.write(raw)
    return 0


@command
def cmd_migrate(args):
    """Rewrite the catalogue on disk in the current schema version.

    Migration is in memory everywhere else, so this command exists only so an
    operator can stop being told their file is old. It never invents governance
    metadata: an entry migration cannot classify keeps its tools denied."""
    path = mcp.catalog_path()
    raw = mcp.read_json(path, None)
    if not raw:
        raise McpCommandError("catalog_missing", f"no readable catalogue at {path}", exit_code=4)
    if raw.get("schemaVersion") == mcp.SCHEMA_VERSION and not args.force:
        return _emit({"schemaVersion": mcp.SCHEMA_VERSION, "migrated": False,
                      "path": str(path), "detail": "already current"})
    doc = mcp.migrate(raw)
    problems = mcp.validate(doc)
    if problems:
        raise McpCommandError("catalog_invalid",
                              "the migrated catalogue is not valid; nothing was written",
                              "; ".join(problems[:5]))
    backup = path.with_name(path.name + ".v1.bak")
    if not backup.exists():
        backup.write_text(json.dumps(raw, indent=2) + "\n")
    mcp.write_private(path, json.dumps(doc, indent=2) + "\n", 0o644)
    return _emit({"schemaVersion": mcp.SCHEMA_VERSION, "migrated": True,
                  "path": str(path), "backup": str(backup),
                  "servers": sorted(doc.get("servers") or {})})


@command
def cmd_tool_check(args):
    """Is this tool call inside the run's approved read-only scope?

    Called by the controller before a tool is allowed through, and by anything
    that wants to know whether an approval would be needed. It answers from the
    verified tool list, not from a description or a prompt."""
    catalog, user_doc, health = _state()
    _require(catalog, args.server)
    server = catalog.get(args.server)
    allowed = mcp.enforceable_tools(args.server, server,
                                    mcp.server_settings(user_doc, args.server), health)
    approval = server["mutationApproval"] or {}
    is_mutation = allowed is not None and args.tool not in set(allowed)
    return _emit({
        "schemaVersion": mcp.SCHEMA_VERSION,
        "server": args.server, "tool": args.tool,
        "classification": "mutation" if is_mutation else "read",
        "allowedWithoutApproval": not is_mutation,
        "gate": approval.get("gate") or ("publication" if approval.get("targets") else None),
        "publicationTargets": mcp.mutation_targets(server),
    })


# ------------------------------------------------------------------- doctor --

def doctor_rows():
    """(name, status, detail, required) tuples for `fde doctor`.

    The whole lifecycle, from "is the executable here" through "did it answer a
    tool list", in the order an operator would work through it — and never a
    credential value, only whether one is present.
    """
    ok, warn, bad = "ok", "warn", "bad"
    rows = []
    try:
        catalog = mcp.Catalog.load()
    except mcp.CatalogError as exc:
        rows.append(("MCP catalogue", bad,
                     f"{exc.message}: {'; '.join(exc.problems[:2]) or exc.code}", True))
        return rows
    version = catalog.doc.get("schemaVersion", mcp.SCHEMA_VERSION)
    rows.append(("MCP catalogue", ok if version == mcp.SCHEMA_VERSION else warn,
                 f"schema v{version}, {len(catalog.servers)} server(s)"
                 + ("" if version == mcp.SCHEMA_VERSION else " — run: fde mcp migrate"), True))
    user_doc, health = mcp.load_user_config(), mcp.load_health()
    severity = {mcp.READY: ok, mcp.ACTIVE: ok, mcp.NOT_CONFIGURED: warn,
                mcp.UNAVAILABLE: warn, mcp.AUTHENTICATION_REQUIRED: warn,
                mcp.BLOCKED: warn, mcp.UNHEALTHY: bad}
    for name in catalog.names():
        server = catalog.get(name)
        settings = mcp.server_settings(user_doc, name)
        state, reason = mcp.server_state(name, server, settings, health)
        pinned = mcp.resolved_version(server)
        detail = f"{state}"
        if pinned:
            detail += f" · {pinned}"
        detail += f" · {server['mutation']}"
        creds = mcp.secret_fields(server)
        if creds:
            present = sum(1 for f in creds if mcp.secret_exists(name, f["name"]))
            detail += f" · credentials {present}/{len(creds)}"
        record = health.get(name) or {}
        if record.get("initialize"):
            detail += f" · initialize {record['initialize']}"
        if record.get("tools"):
            detail += f" · {len(record['tools'])} tool(s)"
        detail += f" — {mcp.redact(reason)}"
        rows.append((f"MCP {name}", severity.get(state, warn), detail[:220], False))
    rows.append(("MCP tool scope (Claude)", *claude_scope_support(), True))
    available, gateway_detail = mcp.gateway_available()
    rows.append(("MCP Docker gateway", ok if available else warn,
                 f"{gateway_detail} (optional — nothing in FDE requires it)", False))
    return rows


def claude_scope_support():
    """Whether this Claude build accepts the flag that carries the tool scope.

    Claude Code scopes MCP tools through permission rules, not through
    `.mcp.json`, so a run's generated pair is `--mcp-config` plus `--settings`.
    If a build does not take `--settings`, the servers would arrive unscoped —
    and `_run_mcp_options` withholds them rather than allow that, which would
    look like a broken connector rather than a missing flag. So the flag is
    checked here, by name, and reported as a required component."""
    ok, warn, bad = "ok", "warn", "bad"
    claude = shutil.which("claude")
    if not claude:
        return warn, "claude is not on PATH — cannot confirm --settings support"
    try:
        result = subprocess.run([claude, "--help"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        return warn, f"could not ask claude for its options: {mcp.redact(str(exc))[:120]}"
    text = (result.stdout or "") + (result.stderr or "")
    if "--settings" in text:
        return ok, "claude accepts --settings, so a run's MCP tool allowlist is enforceable"
    if not text.strip() or "only `claude -p" in text:
        return warn, ("this claude build does not list its options, so --settings support "
                      "could not be confirmed. Run a governed run once and check that "
                      "servers appear in /mcp.")
    return bad, ("this claude build does not accept --settings, so an MCP tool allowlist "
                 "cannot be enforced for it. FDE withholds run-scoped servers from Claude "
                 "rather than granting them unscoped — update Claude Code, or reach those "
                 "connectors through Codex, which takes enabled_tools directly.")


# ------------------------------------------------------------------- parser --

def register(sub):
    """Wire `fde mcp …` into the controller's argument parser."""
    s = sub.add_parser("mcp", help="the governed MCP catalogue: what exists, what is "
                                   "ready, and what a run may actually reach")
    group = s.add_subparsers(dest="mcp_cmd", required=True)

    a = group.add_parser("list", help="every catalogue entry with its lifecycle state")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_list)

    a = group.add_parser("status", help="one server, in detail")
    a.add_argument("server")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_status)

    a = group.add_parser("profiles", help="the declared MCP profiles and their servers")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_profiles)

    a = group.add_parser("configure", help="set a server's non-secret user settings")
    a.add_argument("server")
    a.add_argument("--set", action="append", metavar="NAME=VALUE", default=[])
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_configure)

    a = group.add_parser("set-secret",
                         help="store a credential for a server; reads stdin, echoes nothing")
    a.add_argument("server")
    a.add_argument("field")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_set_secret)

    a = group.add_parser("clear-secret", help="remove a stored credential")
    a.add_argument("server")
    a.add_argument("field")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_clear_secret)

    a = group.add_parser("enable", help="opt a configured server in")
    a.add_argument("server")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_enable, enabled=True)

    a = group.add_parser("disable", help="opt a server out without removing its configuration")
    a.add_argument("server")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_enable, enabled=False)

    a = group.add_parser("verify", help="bounded initialize and tool listing — the only "
                                        "command here that starts a server")
    a.add_argument("server")
    a.add_argument("--timeout", type=int, metavar="SECONDS")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_verify)

    a = group.add_parser("effective", help="what a run, or a proposed selection, may reach")
    a.add_argument("--run", metavar="RUN-ID")
    a.add_argument("--profile", metavar="NAME")
    a.add_argument("--role", action="append", default=[])
    a.add_argument("--stage", action="append", default=[])
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_effective)

    a = group.add_parser("gateway", help="what a Docker MCP Gateway would own; changes nothing")
    a.add_argument("--profile", metavar="NAME")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_gateway)

    a = group.add_parser("env", help=argparse.SUPPRESS)
    a.add_argument("server")
    a.set_defaults(fn=cmd_env)

    a = group.add_parser("tool-check", help=argparse.SUPPRESS)
    a.add_argument("server")
    a.add_argument("tool")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_tool_check)

    a = group.add_parser("migrate", help="rewrite the catalogue in the current schema version")
    a.add_argument("--force", action="store_true")
    a.add_argument("--json", action="store_true")
    a.set_defaults(fn=cmd_migrate)
    return s
