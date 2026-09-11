"""fde_capabilities — what this installation can do, and what it is allowed to do.

Three callers need identical answers to "may this run use X": the console, so
the operator sees the truth; `fde-start` and `mcp-sync`, so the runtime enforces
it; and the run record, so an audit can reconstruct it. A second implementation
is a second answer, and the first time the two disagree the console is lying
about what the agents can reach. So discovery, validation and resolution live
here, once, beside the MCP catalogue that exists for the same reason.

Two invariants this module exists to keep:

  Reading the catalogue starts nothing. Discovery opens manifests and markdown
  front matter. It never executes a hook, a script, an installer or an MCP
  server, and it never contacts an external service.

  Nothing fails open. An unreadable or invalid policy file raises. There is no
  path through this module on which a malformed document widens what an agent
  may reach, and no path on which one capability enables another.

The contract is docs/FDE-CAPABILITY-MODEL.md. Python 3, standard library only.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import pathlib
import re
import shutil

SCHEMA_VERSION = 1

KINDS = ("plugin", "skill", "agent", "mcp", "tool", "command", "hook", "script", "workflow")

# A capability's configured state is never a boolean. A boolean cannot express
# "the operator has not decided", which is the state that makes upgrades safe:
# an untouched capability may gain a new default, an explicitly switched-off one
# may not.
INHERIT, ENABLED, DISABLED = "inherit", "enabled", "disabled"
STATES = (INHERIT, ENABLED, DISABLED)

# Highest first. The first layer with an opinion other than `inherit` decides.
# `builtin` is data shipped with FDE; it is never written by resolution or by
# the console, so an upgrade replaces it and cannot reach the layers above.
LAYERS = ("security", "run", "role", "stage", "workflow", "workspace", "global", "builtin")
USER_LAYERS = ("run", "role", "stage", "workflow", "workspace", "global")

ROLES = ("primary", "reviewer")

BUILTIN_PLUGIN = "fde-core"
BUILTIN_NAMESPACE = "fde"

# Namespaces reserved for pinned external plugins. The directory name is the
# namespace, so an imported plugin cannot claim one of these by accident: the
# import path checks this set and refuses.
PINNED_NAMESPACES = ("ponytail", "feature-dev")

# The built-in tool surface. Discovery seeds these rather than inferring the
# whole set from front matter, because a tool nobody happens to declare is still
# a tool the runtime offers, and an operator who cannot see it cannot switch it
# off.
BUILTIN_TOOLS = ("Read", "Grep", "Glob", "Bash", "Task", "Write", "Edit", "WebSearch", "WebFetch")

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PLUGIN_RE = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
MCP_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HOOK_EVENT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
SCOPE_RE = re.compile(r"^(global|workspace:[A-Za-z0-9._-]{1,64}|workflow:[a-z0-9-]{1,64}"
                      r"|stage:[a-z0-9-]{1,64}/[a-z0-9-]{1,64}|role:(primary|reviewer)"
                      r"|run:[A-Za-z0-9._-]{1,128})$")

MAX_MANIFEST_BYTES = 512 * 1024


class CapabilityError(Exception):
    """A refusal a caller can act on: a stable code, a sentence, a next step."""

    def __init__(self, code, message, detail=None, exit_code=2):
        super().__init__(message)
        self.code, self.message, self.detail, self.exit_code = code, message, detail, exit_code


def _file_digest(path):
    try:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _now():
    return _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds")


# ------------------------------------------------------------------ identity --

def plugin_namespace(plugin_name):
    """Which namespace a plugin directory contributes under.

    The built-in plugin is `fde`; the two pinned external plugins keep their own
    name; everything else an operator imported is under `user:` so it can never
    shadow a capability the FDE defaults refer to by id.
    """
    if plugin_name == BUILTIN_PLUGIN:
        return BUILTIN_NAMESPACE
    if plugin_name in PINNED_NAMESPACES:
        return plugin_name
    return f"user:{plugin_name}"


def make_id(kind, namespace, name=None):
    if kind not in KINDS:
        raise CapabilityError("invalid-kind", f"{kind!r} is not a capability kind.")
    # A plugin defines a namespace rather than living in one, so its id stops at
    # the namespace. Parsing stays unambiguous: the kind is always first.
    if kind == "plugin":
        return f"plugin:{namespace}"
    return f"{kind}:{namespace}:{name}"


def parse_id(cid):
    """(kind, namespace, name). `name` is None for a plugin id."""
    if not isinstance(cid, str) or ":" not in cid:
        raise CapabilityError("invalid-id", f"{cid!r} is not a capability id.")
    kind, rest = cid.split(":", 1)
    if kind not in KINDS or not rest:
        raise CapabilityError("invalid-id", f"{cid!r} is not a capability id.")
    if kind == "plugin":
        return kind, rest, None
    namespace, _, name = rest.rpartition(":")
    if not namespace or not name:
        raise CapabilityError("invalid-id", f"{cid!r} is not a capability id.")
    return kind, namespace, name


def valid_id(cid):
    try:
        parse_id(cid)
        return True
    except CapabilityError:
        return False


def ref_for(kind, namespace, name):
    """The short form the UI shows: `fde:crosscheck`, `ponytail:review`."""
    return namespace if kind == "plugin" else f"{namespace}:{name}"


# ------------------------------------------------------------- file reading --

def _read_text(path):
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise CapabilityError("manifest-too-large", f"{path.name} is larger than the manifest limit.")
    return path.read_text(encoding="utf-8")


def _read_json(path):
    return json.loads(_read_text(path))


def frontmatter(markdown):
    """The leading `---` block of a skill, agent or command file.

    Deliberately forgiving about what it does not understand and strict about
    what it does: an unparsed line is skipped, but a file without a front-matter
    block yields nothing rather than a guess.
    """
    if not markdown.startswith("---\n"):
        return {}
    end = markdown.find("\n---", 4)
    if end < 0:
        return {}
    fields = {}
    for line in markdown[4:end].split("\n"):
        match = re.match(r"^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$", line)
        if match:
            fields[match.group(1).lower()] = match.group(2).strip().strip("'\"")
    return fields


def declared_tools(value):
    if not value:
        return []
    return [item.strip().strip("'\"") for item in value.strip("[]").split(",") if item.strip()]


def _relative_source(shared, target):
    try:
        return f"~/.claude-shared/{pathlib.Path(target).relative_to(shared)}"
    except ValueError:
        return str(target)


def _escapes(root, target):
    """True if `target` leaves `root` once symlinks are resolved.

    Used on every discovered path. A plugin that links its SKILL.md at somebody
    else's private key should be reported as invalid, not read.
    """
    try:
        return not str(pathlib.Path(target).resolve()).startswith(str(pathlib.Path(root).resolve()) + os.sep)
    except OSError:
        return True


# ----------------------------------------------------------------- locations --

def shared_root():
    home = pathlib.Path(os.environ.get("HOME", pathlib.Path.home()))
    return pathlib.Path(os.environ.get("CLAUDE_SHARED", home / ".claude-shared"))


def plugins_root(shared):
    return pathlib.Path(os.environ.get("FDE_PLUGINS_ROOT", shared / "fde-toolkit" / "plugins"))


def workflows_root(shared):
    return shared / "config" / "workflows"


def config_file(shared):
    return shared / "config" / "capability-config.json"


def legacy_policy_file(shared):
    return shared / "config" / "capability-policy.json"


def security_policy_file(shared):
    return shared / "config" / "security-policy.json"


def locks_file(shared):
    return shared / "config" / "plugin-locks.json"


# ---------------------------------------------------------------- provenance --

def _load_locks(shared):
    """Pinned provenance for imported plugins, written by the import path.

    Absent for a fresh install, which is not an error: the built-in plugin's
    provenance is the installation itself. A lock file that exists and is
    invalid IS an error — a supply-chain record that cannot be read is not a
    record, and pretending otherwise is how an unpinned tree gets treated as
    pinned.
    """
    target = locks_file(shared)
    try:
        raw = _read_json(target)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError, CapabilityError) as exc:
        raise CapabilityError("invalid-locks", f"{target} could not be read as a plugin lock file.",
                              detail=str(exc))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
        raise CapabilityError("invalid-locks", f"{target} is not a schema {SCHEMA_VERSION} lock file.")
    plugins = raw.get("plugins")
    return plugins if isinstance(plugins, dict) else {}


def _provenance(plugin_name, manifest, locks, source_root, shared):
    lock = locks.get(plugin_name)
    if isinstance(lock, dict):
        return {
            "type": lock.get("type") or "git",
            "url": lock.get("url"),
            "ref": lock.get("ref"),
            "commit": lock.get("commit"),
            "checksum": lock.get("checksum"),
            "license": lock.get("license") or manifest.get("license"),
            "installedAt": lock.get("installedAt"),
            "validatedAt": lock.get("validatedAt"),
            "pinned": bool(lock.get("commit")),
        }
    builtin = plugin_name == BUILTIN_PLUGIN
    return {
        "type": "built-in" if builtin else "local",
        "url": None, "ref": None, "commit": None, "checksum": None,
        "license": manifest.get("license"),
        "installedAt": None, "validatedAt": None,
        # An external plugin with no lock entry is unpinned, and says so. It is
        # not silently treated as if somebody had pinned it.
        "pinned": builtin,
    }


def _runtime_health(needs):
    """Whether the runtimes a plugin's hooks or scripts require are present."""
    dependencies, problems = [], []
    for runtime in sorted(needs):
        found = shutil.which(runtime)
        dependencies.append({"kind": "runtime", "name": runtime,
                             "state": "ok" if found else "missing",
                             "path": found})
        if not found:
            problems.append(runtime)
    return dependencies, problems


def _ok():
    return {"state": "ok", "code": None, "message": None}


# ----------------------------------------------------------------- discovery --

def _record(*, kind, namespace, name, description, origin, plugin, source, shared,
            provenance, version=None, tools=None, dependencies=None, health=None,
            validation=None, protected=False, detail=None, availability=None):
    valid = validation is None or validation.get("valid", True)
    health = health or _ok()
    if availability is None:
        availability = "available" if valid and health["state"] not in ("invalid", "unavailable") else "unavailable"
    return {
        "id": make_id(kind, namespace, name),
        "kind": kind,
        "namespace": namespace,
        "name": name,
        "ref": ref_for(kind, namespace, name),
        "description": description or "No description provided.",
        "origin": origin,
        "plugin": plugin,
        "source": _relative_source(shared, source) if source else None,
        "version": version,
        "provenance": provenance,
        "health": health,
        "dependencies": dependencies or [],
        "availability": availability,
        "validation": validation or {"valid": True, "errors": []},
        "protected": protected,
        "tools": tools or [],
        "detail": detail,
    }


def _markdown_items(plugin_root, directory, kind, *, namespace, plugin, origin, shared,
                    provenance, errors):
    """Skills, sub-agents and commands, read from their front matter.

    A skill is a directory holding SKILL.md; an agent or command is a single
    markdown file. A file that cannot be read or whose name is unusable is
    recorded as an invalid capability rather than dropped, because a capability
    the operator can see and cannot use is a fixable problem and one that
    silently vanished is not.
    """
    target_dir = plugin_root / directory
    items = []
    try:
        entries = sorted(target_dir.iterdir(), key=lambda p: p.name)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return items
    for entry in entries:
        if kind == "skill":
            if not entry.is_dir():
                continue
            target = entry / "SKILL.md"
            default_name = entry.name
        else:
            if not entry.is_file() or entry.suffix not in (".md", ".toml"):
                continue
            target = entry
            default_name = entry.stem
        problems = []
        meta = {}
        if _escapes(plugin_root, target):
            problems.append("the file resolves outside its plugin directory")
        elif not target.is_file():
            problems.append(f"{target.name} is missing")
        else:
            try:
                if target.suffix == ".toml":
                    # Commands supplied in Codex form carry no front matter. The
                    # description line is the useful part; the rest is left alone.
                    text = _read_text(target)
                    match = re.search(r'^\s*description\s*=\s*"(.*)"\s*$', text, re.M)
                    meta = {"description": match.group(1)} if match else {}
                else:
                    meta = frontmatter(_read_text(target))
            except (OSError, UnicodeDecodeError, CapabilityError) as exc:
                problems.append(str(exc))
        name = meta.get("name") or default_name
        if not NAME_RE.match(name):
            problems.append(f"{name!r} is not a usable capability name")
            name = default_name if NAME_RE.match(default_name) else "unnamed"
        if problems:
            errors.append(f"{plugin}/{directory}/{entry.name}: {problems[0]}")
        items.append(_record(
            kind=kind, namespace=namespace, name=name,
            description=meta.get("description"), origin=origin, plugin=plugin,
            source=target, shared=shared, provenance=provenance,
            tools=declared_tools(meta.get("allowed-tools") or meta.get("tools")),
            dependencies=[{"kind": "capability", "id": make_id("plugin", namespace)}],
            validation={"valid": not problems, "errors": problems},
            health=_ok() if not problems else {"state": "invalid", "code": "manifest-invalid",
                                               "message": problems[0]},
            detail=f"Model: {meta['model']}" if meta.get("model") else None))
    return items


def _hook_items(plugin_root, manifest, *, namespace, plugin, origin, shared, provenance,
                errors, runtime_dependencies):
    """Lifecycle hooks, from wherever the plugin's manifest says they live.

    Hooks are the one kind whose definition is executable, so they are listed
    individually and never merged into their plugin's row: an operator who wants
    Ponytail's guidance without its SessionStart hook must be able to say so.
    """
    declared = manifest.get("hooks")
    candidates = []
    if isinstance(declared, str):
        candidates.append(plugin_root / declared.lstrip("./"))
    candidates.append(plugin_root / "hooks" / "hooks.json")
    items, seen = [], set()
    for target in candidates:
        if target in seen or not target.is_file() or _escapes(plugin_root, target):
            continue
        seen.add(target)
        try:
            raw = _read_json(target)
        except (json.JSONDecodeError, OSError, CapabilityError) as exc:
            errors.append(f"{plugin}: {target.name} is not readable as a hook manifest ({exc})")
            continue
        events = raw.get("hooks") if isinstance(raw, dict) else None
        if not isinstance(events, dict):
            errors.append(f"{plugin}: {target.name} has no hooks object")
            continue
        for event in sorted(events):
            if not HOOK_EVENT_RE.match(event):
                errors.append(f"{plugin}: {event!r} is not a usable hook event name")
                continue
            body = json.dumps(events[event])
            needs = sorted({runtime for runtime in ("node", "python3", "bash", "deno")
                            if re.search(rf"\b{runtime}\b", body)})
            runtime_dependencies.update(needs)
            deps, missing = _runtime_health(needs)
            deps.append({"kind": "capability", "id": make_id("plugin", namespace)})
            items.append(_record(
                kind="hook", namespace=namespace, name=event,
                description=f"Runs for the {event} lifecycle event.",
                origin=origin, plugin=plugin, source=target, shared=shared,
                provenance=provenance, dependencies=deps,
                health=_ok() if not missing else {
                    "state": "degraded", "code": "runtime-missing",
                    "message": f"{', '.join(missing)} is not on PATH."},
                availability="unavailable" if missing else "available"))
    return items


def _script_items(plugin_root, *, namespace, plugin, origin, shared, provenance):
    items = []
    for directory in ("bin", "scripts"):
        target_dir = plugin_root / directory
        try:
            entries = sorted(target_dir.iterdir(), key=lambda p: p.name)
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            continue
        for entry in entries:
            if not entry.is_file() or entry.name.startswith(".") or _escapes(plugin_root, entry):
                continue
            items.append(_record(
                kind="script", namespace=namespace, name=entry.name,
                description=("Runtime helper" if directory == "bin" else "Plugin utility")
                            + f" supplied by {plugin}.",
                origin=origin, plugin=plugin, source=entry, shared=shared,
                provenance=provenance,
                dependencies=[{"kind": "capability", "id": make_id("plugin", namespace)}]))
    return items


def _plugin_items(shared, warnings):
    root = plugins_root(shared)
    locks = _load_locks(shared)
    items = []
    try:
        entries = sorted(root.iterdir(), key=lambda p: p.name)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return items
    for entry in entries:
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        manifest_path = entry / ".claude-plugin" / "plugin.json"
        errors = []
        try:
            manifest = _read_json(manifest_path)
            if not isinstance(manifest, dict) or not isinstance(manifest.get("name"), str):
                raise CapabilityError("invalid-manifest", "the manifest has no name")
        except (FileNotFoundError, json.JSONDecodeError, OSError, CapabilityError) as exc:
            warnings.append(f"{entry.name}: missing or invalid .claude-plugin/plugin.json ({exc})")
            continue
        plugin = manifest["name"]
        if not PLUGIN_RE.match(plugin):
            warnings.append(f"{entry.name}: {plugin!r} is not a usable plugin name")
            continue
        if plugin != entry.name:
            # A manifest that names a different directory is how one plugin
            # takes another's namespace. The directory wins, and the mismatch
            # is reported rather than reconciled.
            errors.append(f"the manifest names {plugin!r} but the directory is {entry.name!r}")
            plugin = entry.name
        namespace = plugin_namespace(plugin)
        origin = ("built-in" if plugin == BUILTIN_PLUGIN
                  else "external" if namespace in PINNED_NAMESPACES else "user")
        provenance = _provenance(plugin, manifest, locks, entry, shared)
        if origin == "external" and not provenance["pinned"]:
            errors.append("an external plugin with no recorded commit is not pinned")
        runtime_dependencies = set()
        contributed = []
        for directory, kind in (("skills", "skill"), ("agents", "agent"), ("commands", "command")):
            contributed += _markdown_items(entry, directory, kind, namespace=namespace,
                                           plugin=plugin, origin=origin, shared=shared,
                                           provenance=provenance, errors=errors)
        contributed += _hook_items(entry, manifest, namespace=namespace, plugin=plugin,
                                   origin=origin, shared=shared, provenance=provenance,
                                   errors=errors, runtime_dependencies=runtime_dependencies)
        contributed += _script_items(entry, namespace=namespace, plugin=plugin, origin=origin,
                                     shared=shared, provenance=provenance)
        dependencies, missing = _runtime_health(runtime_dependencies)
        health = _ok()
        if errors:
            health = {"state": "invalid", "code": "manifest-invalid", "message": errors[0]}
        elif missing:
            health = {"state": "degraded", "code": "runtime-missing",
                      "message": f"{', '.join(missing)} is not on PATH."}
        items.append(_record(
            kind="plugin", namespace=namespace, name=plugin,
            description=manifest.get("description"), origin=origin, plugin=plugin,
            source=entry, shared=shared, provenance=provenance,
            version=manifest.get("version"), dependencies=dependencies, health=health,
            validation={"valid": not errors, "errors": errors},
            # fde-core is the control plane. Switching it off does not produce a
            # smaller FDE, it produces a broken one, so the switch is not offered.
            protected=(plugin == BUILTIN_PLUGIN),
            availability="unavailable" if missing else ("unavailable" if errors else "available")))
        items += contributed
        warnings.extend(errors)
    return items


def _mcp_items(shared, warnings):
    """The governed MCP catalogue, as capabilities.

    Selection here means "may be used when it is already connected". It never
    installs a server, connects an account, asks for a credential or contacts
    anything: the catalogue file and the operator's own settings are the only
    inputs.
    """
    target = shared / "mcp" / "mcp-servers.json"
    try:
        raw = _read_json(target)
    except FileNotFoundError:
        warnings.append("mcp/mcp-servers.json: not installed")
        return []
    except (json.JSONDecodeError, OSError, CapabilityError) as exc:
        raise CapabilityError("invalid-mcp-catalogue",
                              "mcp/mcp-servers.json could not be read.", detail=str(exc))
    servers = raw.get("servers") if isinstance(raw, dict) else None
    if not isinstance(servers, dict):
        raise CapabilityError("invalid-mcp-catalogue", "mcp/mcp-servers.json has no servers object.")
    configured = {}
    try:
        user = _read_json(shared / "config" / "mcp-user-config.json")
        if isinstance(user, dict) and isinstance(user.get("servers"), dict):
            configured = user["servers"]
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError, CapabilityError) as exc:
        raise CapabilityError("invalid-mcp-user-config",
                              "config/mcp-user-config.json could not be read.", detail=str(exc))
    health_doc = {}
    try:
        loaded = _read_json(shared / "mcp" / "health.json")
        if isinstance(loaded, dict):
            health_doc = loaded.get("servers") if isinstance(loaded.get("servers"), dict) else loaded
    except (FileNotFoundError, json.JSONDecodeError, OSError, CapabilityError):
        health_doc = {}
    items = []
    for name in sorted(servers):
        server = servers[name]
        if not MCP_RE.match(name) or not isinstance(server, dict):
            warnings.append(f"mcp: {name!r} is not a usable server entry")
            continue
        settings = configured.get(name) if isinstance(configured.get(name), dict) else {}
        connected = settings.get("enabled") is True
        reported = health_doc.get(name) if isinstance(health_doc.get(name), dict) else {}
        state = reported.get("state")
        # Connection state and configuration state are different questions. A
        # server the operator has selected but never connected is "selected but
        # unavailable", not "off" — and must never be reported as reachable.
        if not connected:
            health = {"state": "unavailable", "code": "not-connected",
                      "message": "This server is not configured and connected on this machine."}
            availability = "unavailable"
        elif state in ("unhealthy", "blocked"):
            health = {"state": "degraded" if state == "unhealthy" else "unavailable",
                      "code": state, "message": reported.get("reason")}
            availability = "unavailable" if state == "blocked" else "available"
        else:
            health, availability = _ok(), "available"
        allow = server.get("allowTools")
        items.append(_record(
            kind="mcp", namespace=BUILTIN_NAMESPACE, name=name,
            description=server.get("useWhen") or server.get("note") or "MCP server.",
            origin="built-in", plugin=None, source=target, shared=shared,
            provenance={"type": "built-in", "url": None, "ref": None, "commit": None,
                        "checksum": None, "license": None, "installedAt": None,
                        "validatedAt": None, "pinned": True},
            tools=[t for t in allow if isinstance(t, str)] if isinstance(allow, list) else [],
            dependencies=[{"kind": "connection", "name": name,
                           "state": "connected" if connected else "not-connected"}],
            health=health, availability=availability,
            detail=" · ".join(str(server[k]) for k in ("transport", "classification", "mutation")
                              if isinstance(server.get(k), str))))
    return items


def _tool_items(shared, contributed):
    """The built-in tool surface, plus anything a capability declares.

    Seeded from BUILTIN_TOOLS so the operator sees the whole surface rather than
    only the parts somebody happened to name in front matter.
    """
    owners = {}
    for item in contributed:
        if item["kind"] in ("mcp", "tool"):
            continue
        for tool in item["tools"]:
            if NAME_RE.match(tool):
                owners.setdefault(tool, set()).add(item["ref"])
    items = []
    for name in sorted(set(BUILTIN_TOOLS) | set(owners)):
        declared = sorted(owners.get(name, ()))
        builtin = name in BUILTIN_TOOLS
        items.append(_record(
            kind="tool", namespace=BUILTIN_NAMESPACE, name=name,
            description=("A built-in Claude tool." if builtin else "Declared by a capability.")
                        + (f" Declared by {', '.join(declared)}." if declared else ""),
            origin="built-in" if builtin else "user", plugin=None, source=None, shared=shared,
            provenance={"type": "built-in", "url": None, "ref": None, "commit": None,
                        "checksum": None, "license": None, "installedAt": None,
                        "validatedAt": None, "pinned": True},
            detail=f"{len(declared)} capability declaration{'' if len(declared) == 1 else 's'}"
                   if declared else None))
    return items


def _workflow_items(shared, warnings):
    items = []
    root = workflows_root(shared)
    try:
        entries = sorted(root.glob("*.json"), key=lambda p: p.name)
    except (OSError, PermissionError):
        return items
    for target in entries:
        try:
            template = _read_json(target)
            validate_template(template)
        except (json.JSONDecodeError, OSError, CapabilityError) as exc:
            warnings.append(f"workflows/{target.name}: {exc}")
            continue
        items.append(_record(
            kind="workflow", namespace=BUILTIN_NAMESPACE, name=template["name"],
            description=template.get("description"), origin="built-in", plugin=None,
            source=target, shared=shared,
            provenance={"type": "built-in", "url": None, "ref": None, "commit": None,
                        "checksum": None, "license": None, "installedAt": None,
                        "validatedAt": None, "pinned": True},
            version=template.get("revision"), protected=True,
            detail=f"{len(template['stages'])} stages"))
    return items


class Catalog:
    """Everything installed, discovered from the authoritative directories.

    Construction reads files. It does not resolve configuration and it does not
    decide what is enabled — that is `resolve()`, which takes a catalogue and a
    configuration and produces a third thing. Keeping the inventory separate
    from the decision is what makes a snapshot reproducible.
    """

    def __init__(self, shared, items, warnings):
        self.shared = shared
        self.items = {item["id"]: item for item in items}
        self.warnings = warnings

    @classmethod
    def discover(cls, shared=None):
        shared = pathlib.Path(shared) if shared else shared_root()
        warnings = []
        items = _plugin_items(shared, warnings)
        items += _mcp_items(shared, warnings)
        items += _tool_items(shared, items)
        items += _workflow_items(shared, warnings)
        seen, unique = set(), []
        for item in items:
            if item["id"] in seen:
                warnings.append(f"{item['id']}: declared more than once; the first was kept")
                continue
            seen.add(item["id"])
            unique.append(item)
        return cls(shared, unique, warnings)

    def get(self, cid):
        return self.items.get(cid)

    def of_kind(self, kind):
        return [item for item in self.items.values() if item["kind"] == kind]

    def children_of(self, plugin_id):
        """What a plugin actually contributes.

        Matched on the contributing plugin, not on the namespace: the MCP
        catalogue, the built-in tools and the workflow templates all live in the
        `fde` namespace without being supplied by fde-core, and switching a
        plugin off must not reach them.
        """
        plugin = self.items.get(plugin_id)
        if plugin is None:
            return []
        return [item for item in self.items.values()
                if item["kind"] != "plugin" and item["plugin"] == plugin["plugin"]]

    def counts(self):
        return {kind: len(self.of_kind(kind)) for kind in KINDS}

    def as_json(self):
        return {
            "schemaVersion": SCHEMA_VERSION,
            "pluginsRoot": str(plugins_root(self.shared)),
            "counts": self.counts(),
            "items": [self.items[cid] for cid in sorted(self.items)],
            "warnings": self.warnings,
        }


# ------------------------------------------------------------------ templates --

REQUIRED_TEMPLATE_KEYS = ("schemaVersion", "name", "revision", "stages")


def validate_template(template):
    """A built-in workflow template, checked before anything relies on it."""
    if not isinstance(template, dict):
        raise CapabilityError("invalid-template", "a workflow template must be an object")
    for key in REQUIRED_TEMPLATE_KEYS:
        if key not in template:
            raise CapabilityError("invalid-template", f"the template has no {key!r}")
    if template["schemaVersion"] != SCHEMA_VERSION:
        raise CapabilityError("invalid-template",
                              f"template schemaVersion {template['schemaVersion']} is not {SCHEMA_VERSION}")
    if not re.match(r"^[a-z][a-z0-9-]{1,63}$", str(template["name"])):
        raise CapabilityError("invalid-template", f"{template['name']!r} is not a usable workflow name")
    stages = template["stages"]
    if not isinstance(stages, list) or not stages:
        raise CapabilityError("invalid-template", "the template declares no stages")
    for stage in stages:
        if not isinstance(stage, dict) or not re.match(r"^[a-z][a-z0-9-]{1,63}$", str(stage.get("name", ""))):
            raise CapabilityError("invalid-template", "every stage needs a usable name")
        if not isinstance(stage.get("controllerStages"), list) or not stage["controllerStages"]:
            raise CapabilityError("invalid-template",
                                  f"stage {stage['name']!r} binds to no controller stage")
        for role in ("primary", "reviewer"):
            bundle = stage.get(role, {})
            if not isinstance(bundle, dict):
                raise CapabilityError("invalid-template",
                                      f"stage {stage['name']!r} has an invalid {role} bundle")
            for cid in bundle.get("enable", []) + bundle.get("disable", []):
                if not valid_id(cid):
                    raise CapabilityError("invalid-template",
                                          f"stage {stage['name']!r} names {cid!r}, which is not a capability id")
    return template


def load_template(shared, name):
    if not re.match(r"^[a-z][a-z0-9-]{1,63}$", str(name)):
        raise CapabilityError("unknown-workflow", f"{name!r} is not a workflow name.")
    target = workflows_root(shared) / f"{name}.json"
    try:
        return validate_template(_read_json(target))
    except FileNotFoundError:
        raise CapabilityError("unknown-workflow", f"No workflow template named {name!r} is installed.",
                              detail=str(target))
    except (json.JSONDecodeError, OSError) as exc:
        raise CapabilityError("invalid-template", f"{target} could not be read.", detail=str(exc))


def list_templates(shared):
    root = workflows_root(shared)
    out = []
    try:
        entries = sorted(root.glob("*.json"), key=lambda p: p.name)
    except (OSError, PermissionError):
        return out
    for target in entries:
        try:
            out.append(validate_template(_read_json(target)))
        except (json.JSONDecodeError, OSError, CapabilityError):
            continue
    return out


def template_defaults(template, stage=None, role="primary"):
    """Layer 8 for one stage and role: {capability id: enabled|disabled}.

    With no stage, the union of every stage's bundle — which is what "the
    workflow's defaults" means when nothing narrower has been asked for.
    """
    if role not in ROLES:
        raise CapabilityError("invalid-role", f"{role!r} is not a role.")
    stages = template["stages"]
    if stage is not None:
        stages = [s for s in stages if s["name"] == stage]
        if not stages:
            raise CapabilityError("unknown-stage",
                                  f"{template['name']} has no stage named {stage!r}.")
    defaults = {}
    for entry in stages:
        for cid in entry.get("common", {}).get("enable", []):
            defaults[cid] = ENABLED
        for cid in entry.get("common", {}).get("disable", []):
            defaults[cid] = DISABLED
        bundle = entry.get(role, {})
        for cid in bundle.get("enable", []):
            defaults[cid] = ENABLED
        for cid in bundle.get("disable", []):
            defaults[cid] = DISABLED
    return defaults


# -------------------------------------------------------------- configuration --

_EMPTY_CONFIG = {"schemaVersion": SCHEMA_VERSION, "global": {}, "workspaces": {},
                 "workflows": {}, "stages": {}, "roles": {}, "hookPayloads": {},
                 "legacySpellings": {}, "legacyDigest": None}

# scope string -> (document section, key or None)
_SCOPE_SECTIONS = {"workspace": "workspaces", "workflow": "workflows",
                   "stage": "stages", "role": "roles"}

# Which layer a scope writes to. `run` is stored with the run, not here.
_SCOPE_LAYER = {"global": "global", "workspace": "workspace", "workflow": "workflow",
                "stage": "stage", "role": "role", "run": "run"}


def parse_scope(scope):
    """('global', None) | ('workspace', 'maxeda') | ('stage', 'fde/implementation') ..."""
    scope = scope or "global"
    if not SCOPE_RE.match(scope):
        raise CapabilityError("invalid-scope", f"{scope!r} is not a configuration scope.",
                              detail="Use global, workspace:<name>, workflow:<name>, "
                                     "stage:<workflow>/<stage>, role:primary, role:reviewer "
                                     "or run:<id>.")
    kind, _, key = scope.partition(":")
    return kind, (key or None)


def _write_json_atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def _clean_states(raw, where):
    """A mapping of capability id to state, or a refusal. Never a partial read.

    A single unreadable entry invalidates the file. Skipping it would mean an
    operator's explicit disable silently becoming an enable, which is the exact
    failure this module is built to prevent.
    """
    if not isinstance(raw, dict):
        raise CapabilityError("invalid-config", f"{where} is not an object of capability states.")
    out = {}
    for cid, state in raw.items():
        if not valid_id(cid):
            raise CapabilityError("invalid-config", f"{where} names {cid!r}, which is not a capability id.")
        if state not in STATES:
            raise CapabilityError("invalid-config",
                                  f"{where} sets {cid} to {state!r}; use enabled, disabled or inherit.")
        if state != INHERIT:
            out[cid] = state
    return out


def legacy_id(cid, spellings=None):
    """A namespaced id back in v1 spelling, or None if it has no v1 form.

    Used only by the compatibility shim below. Where the original spelling was
    recorded at migration it is reused verbatim, because a round trip that
    changes the bytes of somebody else's file is not a compatibility shim.
    """
    if spellings and cid in spellings:
        return spellings[cid]
    try:
        kind, namespace, name = parse_id(cid)
    except CapabilityError:
        return None
    plugin = (BUILTIN_PLUGIN if namespace == BUILTIN_NAMESPACE
              else namespace[5:] if namespace.startswith("user:") else namespace)
    if kind == "plugin":
        return f"plugin:{plugin}"
    if kind in ("tool", "mcp") and namespace == BUILTIN_NAMESPACE:
        return f"{kind}:{name}"
    if kind == "script":
        # v1 spelled a script `script:<plugin>:<directory>:<name>` and the
        # directory is not recoverable. Scripts were never toggleable there, so
        # one with no recorded spelling simply has no v1 form.
        return None
    return f"{kind}:{plugin}:{name}"


def _legacy_document(doc):
    """The v1 view of the operator's global layer."""
    disabled, hooks = [], {}
    for cid, state in doc["global"].items():
        if state != DISABLED:
            continue
        spelling = legacy_id(cid, doc.get("legacySpellings"))
        if spelling is None:
            continue
        disabled.append(spelling)
        payload = doc["hookPayloads"].get(cid)
        if payload is not None:
            hooks[spelling] = payload
    return {"schemaVersion": 1, "disabled": sorted(set(disabled)), "disabledHooks": hooks}


class Config:
    """The operator's layers 3-7, on disk, three-valued.

    Only ids with an opinion are stored. An absent id is `inherit`, which is why
    the file stays small and why its diff reads as a list of decisions somebody
    actually made.
    """

    def __init__(self, shared, doc):
        self.shared = pathlib.Path(shared)
        self.doc = doc

    @classmethod
    def load(cls, shared=None, *, migrate=True):
        shared = pathlib.Path(shared) if shared else shared_root()
        target = config_file(shared)
        try:
            raw = _read_json(target)
        except FileNotFoundError:
            doc = json.loads(json.dumps(_EMPTY_CONFIG))
            config = cls(shared, doc)
            if migrate and legacy_policy_file(shared).is_file():
                config.migrate_legacy()
            return config
        except (json.JSONDecodeError, OSError, CapabilityError) as exc:
            raise CapabilityError("invalid-config", f"{target} could not be read.", detail=str(exc))
        if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
            raise CapabilityError("invalid-config",
                                  f"{target} is not a schema {SCHEMA_VERSION} capability configuration.")
        doc = json.loads(json.dumps(_EMPTY_CONFIG))
        doc["global"] = _clean_states(raw.get("global", {}), "global")
        for section in ("workspaces", "workflows", "stages", "roles"):
            block = raw.get(section, {})
            if not isinstance(block, dict):
                raise CapabilityError("invalid-config", f"{target}: {section} is not an object.")
            doc[section] = {key: _clean_states(value, f"{section}/{key}")
                            for key, value in block.items()}
        for role in doc["roles"]:
            if role not in ROLES:
                raise CapabilityError("invalid-config", f"{target}: {role!r} is not a role.")
        payloads = raw.get("hookPayloads", {})
        doc["hookPayloads"] = payloads if isinstance(payloads, dict) else {}
        spellings = raw.get("legacySpellings", {})
        doc["legacySpellings"] = spellings if isinstance(spellings, dict) else {}
        doc["legacyDigest"] = raw.get("legacyDigest")
        config = cls(shared, doc)
        # The v1 file is still what `fde-start` and the console read. While that
        # is true it is a live input, not an archive: if something wrote to it
        # since the last migration, those decisions are merged in rather than
        # lost. Remove this once both read the resolver.
        if migrate and legacy_policy_file(shared).is_file() \
                and _file_digest(legacy_policy_file(shared)) != doc["legacyDigest"]:
            config.migrate_legacy()
        return config

    # -- reading ------------------------------------------------------------

    def section(self, layer, key=None):
        if layer == "global":
            return dict(self.doc["global"])
        section = _SCOPE_SECTIONS.get(layer)
        if section is None or key is None:
            return {}
        return dict(self.doc[section].get(key, {}))

    def explicit(self):
        """Every explicit decision, flattened, for export and for auditing."""
        out = {"global": dict(self.doc["global"])}
        for section in ("workspaces", "workflows", "stages", "roles"):
            if self.doc[section]:
                out[section] = {key: dict(value) for key, value in self.doc[section].items()}
        return out

    # -- writing ------------------------------------------------------------

    def set(self, cid, state, scope="global"):
        if not valid_id(cid):
            raise CapabilityError("invalid-id", f"{cid!r} is not a capability id.")
        if state not in STATES:
            raise CapabilityError("invalid-state", f"{state!r} is not a state.",
                                  detail="Use enabled, disabled or inherit.")
        kind, key = parse_scope(scope)
        if kind == "run":
            raise CapabilityError("wrong-store", "A run override is stored with the run.",
                                  detail="Use run_overrides_path() and set_run_override().")
        if kind == "global":
            target = self.doc["global"]
        else:
            if kind == "role" and key not in ROLES:
                raise CapabilityError("invalid-role", f"{key!r} is not a role.")
            target = self.doc[_SCOPE_SECTIONS[kind]].setdefault(key, {})
        if state == INHERIT:
            target.pop(cid, None)
        else:
            target[cid] = state
        return self

    def reset(self, cid, scope="global"):
        return self.set(cid, INHERIT, scope)

    def save(self):
        # TRANSITIONAL. `fde-start` and the console still read the v1 boolean
        # file, so every save writes it too. Without this a migration would
        # silently stop the runtime denying a tool the operator switched off,
        # which is the exact failure this module exists to prevent. It goes when
        # both of those read `fde config show --json` instead.
        legacy = legacy_policy_file(self.shared)
        _write_json_atomic(legacy, _legacy_document(self.doc))
        self.doc["legacyDigest"] = _file_digest(legacy)
        doc = {"schemaVersion": SCHEMA_VERSION,
               "global": self.doc["global"],
               "workspaces": {k: v for k, v in self.doc["workspaces"].items() if v},
               "workflows": {k: v for k, v in self.doc["workflows"].items() if v},
               "stages": {k: v for k, v in self.doc["stages"].items() if v},
               "roles": {k: v for k, v in self.doc["roles"].items() if v},
               "hookPayloads": self.doc["hookPayloads"],
               "legacySpellings": self.doc["legacySpellings"],
               "legacyDigest": self.doc["legacyDigest"]}
        _write_json_atomic(config_file(self.shared), doc)
        return self

    # -- migration ----------------------------------------------------------

    def migrate_legacy(self):
        """Bring the v1 boolean policy forward without losing a single disable.

        Idempotent, and it fails closed: a legacy file that cannot be read stops
        the migration and changes nothing, rather than starting from empty and
        quietly re-enabling everything the operator had switched off.
        """
        source = legacy_policy_file(self.shared)
        try:
            raw = _read_json(source)
        except FileNotFoundError:
            return self
        except (json.JSONDecodeError, OSError, CapabilityError) as exc:
            raise CapabilityError("invalid-legacy-policy",
                                  f"{source} could not be read, so nothing was migrated.",
                                  detail=str(exc))
        if not isinstance(raw, dict) or raw.get("schemaVersion") != 1 or not isinstance(raw.get("disabled"), list):
            raise CapabilityError("invalid-legacy-policy",
                                  f"{source} is not a schema 1 capability policy, so nothing was migrated.")
        for legacy in raw["disabled"]:
            cid = migrate_id(legacy)
            if cid:
                self.doc["global"][cid] = DISABLED
                self.doc["legacySpellings"][cid] = legacy
        hooks = raw.get("disabledHooks")
        if isinstance(hooks, dict):
            for legacy, payload in hooks.items():
                cid = migrate_id(legacy)
                if cid:
                    self.doc["hookPayloads"].setdefault(cid, payload)
                    self.doc["global"].setdefault(cid, DISABLED)
                    self.doc["legacySpellings"].setdefault(cid, legacy)
        # The v1 file is kept, not renamed: it is still the runtime's input.
        # save() rewrites it from what was just merged, so the two cannot drift.
        self.save()
        return self


def migrate_id(legacy):
    """A v1 capability id in the namespaced form. None if it is unusable.

    `skill:fde-core:x` -> `skill:fde:x`, `tool:X` -> `tool:fde:X`,
    `mcp:X` -> `mcp:fde:X`, `plugin:fde-core` -> `plugin:fde`.
    """
    if not isinstance(legacy, str) or ":" not in legacy:
        return None
    kind, rest = legacy.split(":", 1)
    if kind not in KINDS or not rest:
        return None
    if kind == "plugin":
        return make_id("plugin", plugin_namespace(rest))
    if kind == "script":
        plugin, _, name = rest.partition(":")
        name = name.split(":", 1)[-1] if name else ""
        return make_id("script", plugin_namespace(plugin), name) if name else None
    if ":" in rest:
        plugin, name = rest.split(":", 1)
        return make_id(kind, plugin_namespace(plugin), name)
    return make_id(kind, BUILTIN_NAMESPACE, rest)


# ----------------------------------------------------------- security policy --

def load_security_policy(shared=None):
    """Layer 1: what no other layer may change.

    Absent means "nothing is pinned by policy", which is a legitimate posture.
    Present and unreadable means the machine's security posture is unknown, and
    that is refused rather than assumed benign.
    """
    shared = pathlib.Path(shared) if shared else shared_root()
    target = security_policy_file(shared)
    try:
        raw = _read_json(target)
    except FileNotFoundError:
        return {"required": set(), "forbidden": set(), "source": None}
    except (json.JSONDecodeError, OSError, CapabilityError) as exc:
        raise CapabilityError("invalid-security-policy",
                              f"{target} could not be read, so no capability may be resolved.",
                              detail=str(exc))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
        raise CapabilityError("invalid-security-policy",
                              f"{target} is not a schema {SCHEMA_VERSION} security policy.")
    out = {"source": str(target)}
    for key in ("required", "forbidden"):
        values = raw.get(key, [])
        if not isinstance(values, list):
            raise CapabilityError("invalid-security-policy", f"{target}: {key} is not a list.")
        for cid in values:
            if not valid_id(cid):
                raise CapabilityError("invalid-security-policy",
                                      f"{target}: {cid!r} is not a capability id.")
        out[key] = set(values)
    overlap = out["required"] & out["forbidden"]
    if overlap:
        raise CapabilityError("invalid-security-policy",
                              f"{target}: {sorted(overlap)[0]} is both required and forbidden.")
    return out


# -------------------------------------------------------------- run overrides --

def run_overrides_path(run_dir):
    return pathlib.Path(run_dir) / "capabilities" / "overrides.json"


def load_run_overrides(run_dir):
    target = run_overrides_path(run_dir)
    try:
        raw = _read_json(target)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError, CapabilityError) as exc:
        raise CapabilityError("invalid-run-overrides", f"{target} could not be read.", detail=str(exc))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != SCHEMA_VERSION:
        raise CapabilityError("invalid-run-overrides",
                              f"{target} is not a schema {SCHEMA_VERSION} override file.")
    return _clean_states(raw.get("capabilities", {}), str(target))


def set_run_override(run_dir, cid, state):
    if not valid_id(cid):
        raise CapabilityError("invalid-id", f"{cid!r} is not a capability id.")
    if state not in STATES:
        raise CapabilityError("invalid-state", f"{state!r} is not a state.")
    current = load_run_overrides(run_dir)
    if state == INHERIT:
        current.pop(cid, None)
    else:
        current[cid] = state
    _write_json_atomic(run_overrides_path(run_dir),
                       {"schemaVersion": SCHEMA_VERSION, "capabilities": current})
    return current


# -------------------------------------------------------------- resolution --

# What the console labels each outcome. `protected` and `parent-disabled` are
# additions to the operator-facing set, because "blocked" alone cannot tell an
# operator whether to go and change a security policy or go and switch a plugin
# back on.
EFFECTIVE_LABELS = (
    "fde-default", "inherited-enabled", "user-enabled", "user-disabled",
    "unavailable", "blocked", "invalid", "protected", "parent-disabled", "not-selected",
)


def _decide(cid, *, security, layers, builtin_default, unlisted):
    """The precedence walk for one capability. Returns (state, effective, layer, configured)."""
    if cid in security.get("forbidden", ()):
        return DISABLED, "blocked", "security", DISABLED
    if cid in security.get("required", ()):
        return ENABLED, "protected", "security", ENABLED
    for layer, states in layers:
        configured = states.get(cid, INHERIT)
        if configured == DISABLED:
            return DISABLED, "user-disabled", layer, DISABLED
        if configured == ENABLED:
            return ENABLED, "user-enabled", layer, ENABLED
    if builtin_default == ENABLED:
        return ENABLED, "fde-default", "builtin", ENABLED
    if builtin_default == DISABLED:
        return DISABLED, "fde-default", "builtin", DISABLED
    if unlisted == ENABLED:
        return ENABLED, "inherited-enabled", "default", INHERIT
    return DISABLED, "not-selected", "default", INHERIT


def resolve(catalog, config, *, workflow=None, stage=None, role="primary", workspace=None,
            run_overrides=None, security=None, template=None):
    """The effective configuration, and why each answer is what it is.

    The built-in template is read, never written: resolution produces a third
    document from the catalogue and the configuration, and leaves both alone.
    """
    if role not in ROLES:
        raise CapabilityError("invalid-role", f"{role!r} is not a role.")
    security = load_security_policy(catalog.shared) if security is None else security
    if workflow and template is None:
        template = load_template(catalog.shared, workflow)
    builtin = template_defaults(template, stage, role) if template else {}
    # Outside a workflow the whole installed surface is available unless somebody
    # switched something off. Inside one, a stage bundle IS the selection, so a
    # capability the bundle does not name is not selected for that stage.
    unlisted = DISABLED if template else ENABLED
    if template and template.get("unlistedDefault") in (ENABLED, DISABLED):
        unlisted = template["unlistedDefault"]

    layers = [
        ("run", dict(run_overrides or {})),
        ("role", config.section("role", role)),
        ("stage", config.section("stage", f"{workflow}/{stage}" if workflow and stage else None)),
        ("workflow", config.section("workflow", workflow)),
        ("workspace", config.section("workspace", workspace)),
        ("global", config.section("global")),
    ]

    resolved = {}
    for cid in sorted(catalog.items):
        item = catalog.items[cid]
        state, effective, layer, configured = _decide(
            cid, security=security, layers=layers,
            builtin_default=builtin.get(cid), unlisted=unlisted)
        resolved[cid] = {
            "id": cid, "kind": item["kind"], "namespace": item["namespace"],
            "name": item["name"], "ref": item["ref"], "description": item["description"],
            "origin": item["origin"], "plugin": item["plugin"], "source": item["source"],
            "version": item["version"], "provenance": item["provenance"],
            "health": item["health"], "dependencies": item["dependencies"],
            "protected": item["protected"], "tools": item["tools"],
            "availability": item["availability"],
            "state": state, "effective": effective, "layer": layer, "configured": configured,
            "overridden": layer in USER_LAYERS,
            "inheritedFrom": "builtin" if cid in builtin else "default",
            "reason": None,
        }

    # A disabled parent makes its contributions ineffective without touching what
    # the operator configured for them, so switching the parent back on restores
    # exactly what they had rather than a default.
    for plugin_item in catalog.of_kind("plugin"):
        decision = resolved[plugin_item["id"]]
        if decision["state"] == ENABLED:
            continue
        for child in catalog.children_of(plugin_item["id"]):
            entry = resolved[child["id"]]
            if entry["layer"] == "security":
                continue
            entry.update(state=DISABLED, effective="parent-disabled",
                         reason=f"The {plugin_item['name']} plugin is switched off.")

    degraded = []
    for cid, entry in resolved.items():
        item = catalog.items[cid]
        if not item["validation"]["valid"]:
            entry["effective"] = "invalid"
            entry["reason"] = item["validation"]["errors"][0]
        elif entry["state"] == ENABLED and item["availability"] != "available":
            entry["effective"] = "unavailable"
            entry["reason"] = item["health"].get("message") or "This capability is not usable right now."
        entry["active"] = entry["state"] == ENABLED and item["availability"] == "available" \
            and item["validation"]["valid"]
        if entry["state"] == ENABLED and not entry["active"]:
            degraded.append({"id": cid, "ref": entry["ref"], "reason": entry["reason"]})

    # A bundle that names something this installation does not have is reported,
    # never invented. The stage runs degraded and says what is missing.
    missing = [{"id": cid, "reason": "not installed"}
               for cid, state in sorted(builtin.items())
               if state == ENABLED and cid not in catalog.items]

    return {
        "schemaVersion": SCHEMA_VERSION,
        "workflow": workflow,
        "workflowRevision": template.get("revision") if template else None,
        "stage": stage,
        "role": role,
        "workspace": workspace,
        "securityPolicy": security.get("source"),
        "capabilities": [resolved[cid] for cid in sorted(resolved)],
        "enabled": sorted(cid for cid, entry in resolved.items() if entry["active"]),
        "degraded": degraded,
        "missing": missing,
        "warnings": list(catalog.warnings),
    }


# ------------------------------------------------------------------ snapshots --

def _digest(payload):
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(body).hexdigest()


def snapshot_document(resolution, catalog, *, run_id, role):
    """What a run was actually allowed to use, in a form an audit can replay.

    Versions and provenance travel with the ids on purpose: "serena was enabled"
    does not reproduce anything, and a snapshot that cannot be replayed is a
    log entry pretending to be evidence.
    """
    entries = []
    for cid in resolution["enabled"]:
        item = catalog.items[cid]
        entries.append({
            "id": cid, "ref": item["ref"], "kind": item["kind"],
            "version": item["version"],
            "commit": item["provenance"].get("commit"),
            "checksum": item["provenance"].get("checksum"),
            "source": item["source"],
        })
    decisions = [{"id": entry["id"], "state": entry["state"], "effective": entry["effective"],
                  "layer": entry["layer"]}
                 for entry in resolution["capabilities"]
                 if entry["layer"] != "default" or entry["state"] == ENABLED]
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "role": role,
        "workflow": resolution["workflow"],
        "workflowRevision": resolution["workflowRevision"],
        "stage": resolution["stage"],
        "securityPolicy": resolution["securityPolicy"],
        "capabilities": entries,
        "decisions": decisions,
        "degraded": resolution["degraded"],
        "missing": resolution["missing"],
    }
    payload["digest"] = _digest(payload)
    return payload


def snapshot_dir(run_dir):
    return pathlib.Path(run_dir) / "capabilities"


def snapshot_index(run_dir):
    target = snapshot_dir(run_dir) / "snapshots.jsonl"
    out = []
    try:
        for line in target.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                out.append(record)
    except FileNotFoundError:
        pass
    return out


def latest_snapshot(run_dir, role="primary"):
    entries = [r for r in snapshot_index(run_dir) if r.get("role") == role]
    return entries[-1] if entries else None


def write_snapshot(run_dir, document, *, role="primary"):
    """Write one immutable snapshot. An existing one is superseded, never edited.

    O_EXCL is the point: a snapshot file is created exactly once. A resolution
    that differs becomes the next sequence number and the index records what it
    superseded, exactly as a routing approval does.
    """
    directory = snapshot_dir(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    previous = latest_snapshot(run_dir, role)
    if previous and previous.get("digest") == document["digest"]:
        return previous
    sequence = (previous.get("sequence", 0) if previous else 0) + 1
    name = f"snapshot-{role}-{sequence}.json"
    target = directory / name
    body = json.dumps(document, indent=2, sort_keys=True) + "\n"
    handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    try:
        os.write(handle, body.encode("utf-8"))
    finally:
        os.close(handle)
    record = {"at": _now(), "role": role, "sequence": sequence, "file": name,
              "digest": document["digest"], "workflow": document.get("workflow"),
              "stage": document.get("stage"),
              "supersedes": previous.get("digest") if previous else None}
    with (directory / "snapshots.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return record


# --------------------------------------------------------------- export/import --

def export_config(config, *, run_dir=None):
    document = {
        "schemaVersion": SCHEMA_VERSION,
        "exportedAt": _now(),
        "config": config.explicit(),
        "hookPayloads": config.doc["hookPayloads"],
    }
    if run_dir is not None:
        document["runOverrides"] = load_run_overrides(run_dir)
    return document


def import_config(config, document, *, replace=True):
    """Apply an exported configuration, keeping every explicit decision exact.

    `replace` empties the operator's layers first, so an export that omits a
    decision removes it rather than leaving a stale one behind. Either way, no
    state is translated on the way in: enabled stays enabled and disabled stays
    disabled.
    """
    if not isinstance(document, dict) or document.get("schemaVersion") != SCHEMA_VERSION:
        raise CapabilityError("invalid-import",
                              f"That file is not a schema {SCHEMA_VERSION} capability export.")
    body = document.get("config")
    if not isinstance(body, dict):
        raise CapabilityError("invalid-import", "The export has no config object.")
    incoming = {"global": _clean_states(body.get("global", {}), "global"),
                "workspaces": {}, "workflows": {}, "stages": {}, "roles": {}}
    for section in ("workspaces", "workflows", "stages", "roles"):
        block = body.get(section, {})
        if not isinstance(block, dict):
            raise CapabilityError("invalid-import", f"The export's {section} is not an object.")
        incoming[section] = {key: _clean_states(value, f"{section}/{key}")
                             for key, value in block.items()}
    for role in incoming["roles"]:
        if role not in ROLES:
            raise CapabilityError("invalid-import", f"{role!r} is not a role.")
    if replace:
        for section in ("global", "workspaces", "workflows", "stages", "roles"):
            config.doc[section] = incoming[section] if section != "global" else dict(incoming["global"])
    else:
        config.doc["global"].update(incoming["global"])
        for section in ("workspaces", "workflows", "stages", "roles"):
            for key, states in incoming[section].items():
                config.doc[section].setdefault(key, {}).update(states)
    payloads = document.get("hookPayloads")
    if isinstance(payloads, dict):
        config.doc["hookPayloads"].update(payloads)
    return config.save()
