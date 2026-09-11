"""`fde capabilities`, `fde config`, `fde workflows` — the operator's view.

These live beside the capability library rather than inside the controller for
the same reason the MCP commands do: `fde`, `fde-start`, `mcp-sync` and the
console all have to answer "may this run use X" from one implementation. The
controller wires the subparsers in and owns the run store; everything here is
about the catalogue, the operator's configuration and the resolution between
them.

Two invariants, the same two the library keeps:

  Opening this page starts nothing. Every command here reads files. None of
  them executes a hook, a script or an MCP server, and none contacts an
  external service.

  Nothing fails open. A malformed policy at any layer is an error with a code
  and a sentence, never a quiet fallback to a permissive default.
"""
from __future__ import annotations

import functools
import json
import pathlib
import sys

import fde_capabilities as cap
import fde_mcp
import fde_plugin_import as imports

# The controller sets this. It is the only thing that knows how to turn a run id
# into a directory safely — a run id is a name, never a path — so the command
# layer asks rather than reimplementing that check a second time.
RUN_DIR_RESOLVER = None

# Set by the controller so a snapshot lands in the run's append-only record.
EVENT_HOOK = None


def _emit(payload):
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def command(fn):
    """One error envelope for every capability subcommand."""
    @functools.wraps(fn)
    def wrapper(args):
        try:
            return fn(args)
        except cap.CapabilityError as exc:
            payload = {"schemaVersion": cap.SCHEMA_VERSION,
                       "error": {"code": exc.code, "message": exc.message, "detail": exc.detail}}
            if getattr(args, "json", False):
                _emit(payload)
            else:
                print(f"fde: {exc.message}", file=sys.stderr)
                if exc.detail:
                    print(f"       {exc.detail}", file=sys.stderr)
            return exc.exit_code
    return wrapper


def _shared():
    return cap.shared_root()


def _catalog():
    return cap.Catalog.discover(_shared())


def _run_dir(run_id):
    if RUN_DIR_RESOLVER is None:
        raise cap.CapabilityError("no-run-store", "This build cannot resolve a run directory.")
    return RUN_DIR_RESOLVER(run_id)


def _resolution(args, catalog=None):
    catalog = catalog or _catalog()
    config = cap.Config.load(catalog.shared)
    run_id = getattr(args, "run", None)
    overrides = cap.load_run_overrides(_run_dir(run_id)) if run_id else {}
    return catalog, cap.resolve(
        catalog, config,
        workflow=getattr(args, "workflow", None), stage=getattr(args, "stage", None),
        role=getattr(args, "role", None) or "primary",
        workspace=getattr(args, "workspace", None), run_overrides=overrides)


# ------------------------------------------------------------------ rendering --

_MARK = {"fde-default": "default", "inherited-enabled": "inherited", "user-enabled": "you: on",
         "user-disabled": "you: off", "unavailable": "unavailable", "blocked": "blocked",
         "invalid": "invalid", "protected": "protected", "parent-disabled": "parent off",
         "not-selected": "not selected"}


def _print_rows(entries, *, show_state=True):
    if not entries:
        print("  (none)")
        return
    width = max(len(entry["ref"]) for entry in entries)
    for entry in entries:
        if show_state:
            # Three markers, not two. A capability the operator selected that
            # cannot be used right now is not "off": reading it that way sends
            # them to a switch when the actual problem is a connection.
            mark = ("on " if entry.get("active")
                    else "-- " if entry["state"] == cap.ENABLED else "off")
            print(f"  {mark}  {entry['ref']:<{width}}  {_MARK.get(entry['effective'], entry['effective'])}"
                  + (f"  — {entry['reason']}" if entry.get("reason") else ""))
        else:
            health = entry["health"]["state"]
            print(f"  {entry['ref']:<{width}}  {entry['kind']:<8}  {health}")


# ------------------------------------------------------------------- commands --

@command
def cmd_capabilities(args):
    """The installed inventory. Discovery only — nothing is resolved here."""
    catalog = _catalog()
    items = [catalog.items[cid] for cid in sorted(catalog.items)]
    if args.kind:
        items = [item for item in items if item["kind"] == args.kind]
    if args.namespace:
        items = [item for item in items if item["namespace"] == args.namespace]
    if args.json:
        payload = catalog.as_json()
        payload["items"] = items
        return _emit(payload)
    print(f"\n{len(items)} capabilities  (root {cap.plugins_root(catalog.shared)})\n")
    for kind in cap.KINDS:
        rows = [item for item in items if item["kind"] == kind]
        if rows:
            print(f"{kind}s")
            _print_rows(rows, show_state=False)
            print()
    for warning in catalog.warnings:
        print(f"  warning  {warning}", file=sys.stderr)
    return 0


@command
def cmd_capabilities_show(args):
    catalog = _catalog()
    item = catalog.get(args.id)
    if item is None:
        raise cap.CapabilityError("unknown-capability", f"{args.id} is not installed.",
                                  detail="see: fde capabilities")
    _catalog_unused, resolution = _resolution(args, catalog)
    decision = next(entry for entry in resolution["capabilities"] if entry["id"] == args.id)
    if args.json:
        return _emit({"schemaVersion": cap.SCHEMA_VERSION, "capability": item, "resolved": decision})
    print(f"\n{item['ref']}  ({item['kind']})\n")
    print(f"  {item['description']}\n")
    print(f"  source      {item['source']}")
    print(f"  origin      {item['origin']}" + (f"  version {item['version']}" if item["version"] else ""))
    provenance = item["provenance"]
    print(f"  provenance  {provenance['type']}"
          + (f"  {provenance['commit'][:12]}" if provenance.get("commit") else "")
          + ("  pinned" if provenance.get("pinned") else "  UNPINNED"))
    print(f"  health      {item['health']['state']}"
          + (f" — {item['health']['message']}" if item["health"].get("message") else ""))
    print(f"  state       {decision['state']}  ({_MARK.get(decision['effective'], decision['effective'])}"
          f", decided at layer {decision['layer']})")
    if item["dependencies"]:
        print("  depends on")
        for dependency in item["dependencies"]:
            label = dependency.get("id") or dependency.get("name")
            print(f"    {label}  {dependency.get('state', 'required')}")
    print()
    return 0


@command
def cmd_capabilities_validate(args):
    """Manifest and dependency validation, with an exit code a CI job can use."""
    catalog = _catalog()
    problems = [{"id": item["id"], "errors": item["validation"]["errors"],
                 "health": item["health"]}
                for item in catalog.items.values()
                if not item["validation"]["valid"] or item["health"]["state"] in ("invalid", "degraded")]
    problems.sort(key=lambda entry: entry["id"])
    payload = {"schemaVersion": cap.SCHEMA_VERSION, "checked": len(catalog.items),
               "problems": problems, "warnings": catalog.warnings}
    if args.json:
        _emit(payload)
    else:
        print(f"\nchecked {len(catalog.items)} capabilities")
        for problem in problems:
            detail = problem["errors"][0] if problem["errors"] else problem["health"].get("message")
            print(f"  {problem['id']}  {detail}")
        for warning in catalog.warnings:
            print(f"  warning  {warning}")
        print(f"\n{len(problems)} need attention\n" if problems else "\nall valid\n")
    return 1 if problems else 0


@command
def cmd_config_show(args):
    catalog, resolution = _resolution(args)
    if args.json:
        return _emit(resolution)
    scope = resolution["workflow"] or "no workflow"
    if resolution["stage"]:
        scope += f" / {resolution['stage']}"
    print(f"\neffective capabilities — {scope}, {resolution['role']}\n")
    for kind in cap.KINDS:
        rows = [entry for entry in resolution["capabilities"]
                if entry["kind"] == kind and (args.all or entry["state"] == cap.ENABLED)]
        if rows:
            print(f"{kind}s")
            _print_rows(rows)
            print()
    connectors = [entry for entry in resolution["capabilities"]
                  if entry["kind"] == "mcp" and entry.get("mcp")
                  and (args.all or entry["state"] == cap.ENABLED)]
    if connectors:
        print("connectors")
        width = max(len(entry["ref"]) for entry in connectors)
        for entry in connectors:
            connector = entry["mcp"]
            scopes = ", ".join(connector.get("granted") or []) or "no scope"
            print(f"  {entry['ref']:<{width}}  {connector['connectionState']:<24}  {scopes}")
            tools = connector.get("tools")
            if tools:
                print(f"  {'':<{width}}  {len(tools)} tools: {', '.join(tools[:6])}"
                      + (" …" if len(tools) > 6 else ""))
            elif connector.get("state") == "unverified":
                print(f"  {'':<{width}}  tool list not verified; scopes cannot be applied yet")
            elif connector.get("state") == "nothing-enforceable":
                print(f"  {'':<{width}}  no tool can be proved safe, so none is offered")
            if connector.get("unenforceable") and connector.get("state") == "enforced":
                print(f"  {'':<{width}}  granted but unavailable here: "
                      + ", ".join(connector["unenforceable"]))
        print()
    if resolution["settings"]:
        print("settings")
        for name, entry in sorted(resolution["settings"].items()):
            mark = "you" if entry["overridden"] else entry["layer"]
            print(f"  {name:<22} {str(entry['value']):<10} ({mark})"
                  + (f"  — {entry['reason']}" if entry.get("reason") else ""))
        print()
    if resolution.get("governance"):
        print("governance")
        print(f"  {resolution['governance']['statement']}")
        print(f"  never overridden: {', '.join(resolution['governance']['neverOverridden'])}")
        print()
    if resolution["missing"]:
        print("named by this workflow but not installed")
        for entry in resolution["missing"]:
            print(f"  {entry['id']}  {entry['reason']}")
        print()
    if resolution["degraded"]:
        print("switched on but not usable right now")
        for entry in resolution["degraded"]:
            print(f"  {entry['ref']}  {entry['reason']}")
        print()
    return 0


@command
def cmd_config_set(args):
    catalog = _catalog()
    if args.id not in catalog.items and not args.force:
        raise cap.CapabilityError(
            "unknown-capability", f"{args.id} is not installed.",
            detail="Use --force to record a decision about something that is not installed yet.")
    item = catalog.get(args.id)
    if item is not None and item["protected"] and args.state == cap.DISABLED:
        raise cap.CapabilityError("protected-capability",
                                  f"{item['ref']} is required by the FDE control plane.",
                                  detail="Protected capabilities are named in config/security-policy.json.")
    # Security policy is layer 1, so a decision against it would be recorded and
    # then ignored at every resolution. Refusing here means the operator learns
    # that now, instead of wondering later why their switch does nothing.
    security = cap.load_security_policy(catalog.shared)
    if args.state == cap.DISABLED and args.id in security.get("required", ()):
        raise cap.CapabilityError("required-by-policy",
                                  f"{args.id} is required by the runtime security policy.",
                                  detail=f"See {security.get('source')}.")
    if args.state == cap.ENABLED and args.id in security.get("forbidden", ()):
        raise cap.CapabilityError("forbidden-by-policy",
                                  f"{args.id} is forbidden by the runtime security policy.",
                                  detail=f"See {security.get('source')}.")
    kind, key = cap.parse_scope(args.scope)
    if kind == "run":
        current = cap.set_run_override(_run_dir(key), args.id, args.state)
        payload = {"schemaVersion": cap.SCHEMA_VERSION, "scope": args.scope,
                   "id": args.id, "state": args.state, "overrides": current}
    else:
        config = cap.Config.load(catalog.shared)
        config.set(args.id, args.state, args.scope).save()
        payload = {"schemaVersion": cap.SCHEMA_VERSION, "scope": args.scope,
                   "id": args.id, "state": args.state, "config": config.explicit()}
    if args.json:
        return _emit(payload)
    print(f"{args.id} is {args.state} at {args.scope}")
    return 0


@command
def cmd_config_reset(args):
    args.state = cap.INHERIT
    return cmd_config_set.__wrapped__(args)


@command
def cmd_config_set_option(args):
    """Set something that is not on/off — a Ponytail mode, a permission scope."""
    shared = _shared()
    value = args.value
    if value != "inherit":
        if args.name.startswith("mcp.") and args.name.endswith(".scopes"):
            # A scope list, not a string. Validated here so an unusable scope is
            # refused at the point somebody types it rather than silently
            # narrowing a connector to nothing at run time.
            value = [part.strip() for part in args.value.split(",") if part.strip()]
            unknown = [scope for scope in value if scope not in fde_mcp.SCOPES]
            if unknown:
                raise cap.CapabilityError(
                    "invalid-value", f"{unknown[0]!r} is not a permission scope.",
                    detail="Use one or more of: " + ", ".join(fde_mcp.SCOPES) + ".")
            server = args.name[len("mcp."):-len(".scopes")]
            if cap.Catalog.discover(shared).get(f"mcp:fde:{server}") is None:
                raise cap.CapabilityError("unknown-capability",
                                          f"No MCP server named {server!r} is in the catalogue.",
                                          detail="see: fde mcp list")
        elif args.workflow and args.name == "ponytail.mode":
            template = cap.load_template(shared, args.workflow)
            modes = (template.get("ponytail") or {}).get("modes", [])
            if modes and value not in modes:
                raise cap.CapabilityError(
                    "invalid-value", f"{value!r} is not a Ponytail mode.",
                    detail=f"{args.workflow} offers: {', '.join(modes)}.")
    config = cap.Config.load(shared)
    config.set_setting(args.name, None if value == "inherit" else value, args.scope).save()
    payload = {"schemaVersion": cap.SCHEMA_VERSION, "scope": args.scope,
               "name": args.name, "value": args.value, "config": config.explicit()}
    if args.json:
        return _emit(payload)
    print(f"{args.name} is {args.value} at {args.scope}")
    return 0


@command
def cmd_config_export(args):
    config = cap.Config.load(_shared())
    run_dir = _run_dir(args.run) if getattr(args, "run", None) else None
    document = cap.export_config(config, run_dir=run_dir)
    if args.json or not args.out:
        return _emit(document)
    target = pathlib.Path(args.out)
    target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"exported to {target}")
    return 0


@command
def cmd_config_import(args):
    source = pathlib.Path(args.file)
    try:
        document = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise cap.CapabilityError("no-such-file", f"{source} does not exist.")
    except (json.JSONDecodeError, OSError) as exc:
        raise cap.CapabilityError("invalid-import", f"{source} could not be read.", detail=str(exc))
    config = cap.Config.load(_shared())
    cap.import_config(config, document, replace=not args.merge)
    payload = {"schemaVersion": cap.SCHEMA_VERSION, "imported": str(source),
               "config": config.explicit()}
    if args.json:
        return _emit(payload)
    print(f"imported {source}")
    return 0


@command
def cmd_workflows(args):
    templates = cap.list_templates(_shared())
    if args.json:
        return _emit({"schemaVersion": cap.SCHEMA_VERSION,
                      "workflows": [{"name": t["name"], "label": t.get("label"),
                                     "revision": t["revision"],
                                     "description": t.get("description"),
                                     "stages": [s["name"] for s in t["stages"]]}
                                    for t in templates]})
    print("\nWorkflow configurations\n")
    for template in templates:
        print(f"  {template['name']}  ({template['revision']})")
        print(f"    {template.get('description', '')}")
        print(f"    stages: {' → '.join(s['name'] for s in template['stages'])}\n")
    return 0


@command
def cmd_workflow_show(args):
    template = cap.load_template(_shared(), args.name)
    if args.json:
        return _emit({"schemaVersion": cap.SCHEMA_VERSION, "workflow": template})
    print(f"\n{template.get('label', template['name'])}  ({template['revision']})\n")
    for entry in template["stages"]:
        print(f"  {entry['name']}  →  {', '.join(entry['controllerStages'])}")
        for role in ("common", "primary", "reviewer"):
            enabled = entry.get(role, {}).get("enable", [])
            if enabled:
                print(f"    {role:<8} {len(enabled)} capabilities")
        if entry.get("optional"):
            print(f"    optional {len(entry['optional'])} offered, not enabled")
        print()
    return 0


@command
def cmd_capabilities_snapshot(args):
    """Record what this run is allowed to use, immutably, for both roles."""
    run_dir = _run_dir(args.run_id)
    catalog = _catalog()
    config = cap.Config.load(catalog.shared)
    overrides = cap.load_run_overrides(run_dir)
    roles = cap.ROLES if args.role == "both" else (args.role,)
    written = []
    for role in roles:
        resolution = cap.resolve(catalog, config, workflow=args.workflow, stage=args.stage,
                                 role=role, workspace=args.workspace, run_overrides=overrides)
        document = cap.snapshot_document(resolution, catalog, run_id=args.run_id, role=role)
        record = cap.write_snapshot(run_dir, document, role=role)
        written.append(record)
        if EVENT_HOOK is not None:
            EVENT_HOOK("capabilities.snapshot", runId=args.run_id, role=role,
                       digest=document["digest"], workflow=args.workflow, stage=args.stage)
    payload = {"schemaVersion": cap.SCHEMA_VERSION, "runId": args.run_id, "snapshots": written}
    if args.json:
        return _emit(payload)
    for record in written:
        print(f"{record['role']:<9} snapshot {record['sequence']}  {record['digest'][:19]}…  {record['file']}")
    return 0


# -------------------------------------------------------------- plugins --

def _plugin_rows(plugins):
    if not plugins:
        print("  (none)")
        return
    width = max(len(entry["name"]) for entry in plugins)
    for entry in plugins:
        pin = ("pinned " + entry["commit"][:12]) if entry.get("commit") else (
            "built-in" if entry["origin"] == "built-in" else "UNPINNED")
        print(f"  {entry['name']:<{width}}  {entry['origin']:<8}  {pin:<20}"
              f"  {entry.get('license') or 'licence unknown'}")
        contributes = ", ".join(f"{count} {kind}s" for kind, count in sorted(entry["contributes"].items()))
        if contributes:
            print(f"  {'':<{width}}  {contributes}")
        if entry["health"]["state"] != "ok":
            print(f"  {'':<{width}}  {entry['health']['state']}: {entry['health'].get('message')}")


@command
def cmd_plugins_list(args):
    payload = imports.list_plugins(_shared())
    if args.json:
        return _emit(payload)
    print(f"\n{len(payload['plugins'])} plugins  (root {payload['pluginsRoot']})\n")
    _plugin_rows(payload["plugins"])
    print()
    for warning in payload["warnings"]:
        print(f"  warning  {warning}", file=sys.stderr)
    return 0


@command
def cmd_plugins_show(args):
    payload = imports.list_plugins(_shared())
    entry = next((row for row in payload["plugins"] if row["name"] == args.name), None)
    if entry is None:
        raise cap.CapabilityError("unknown-plugin", f"No plugin named {args.name!r} is installed.",
                                  detail="see: fde plugins list")
    if args.json:
        return _emit({"schemaVersion": cap.SCHEMA_VERSION, "plugin": entry})
    print(f"\n{entry['name']}  ({entry['namespace']})\n")
    print(f"  {entry['description']}\n")
    print(f"  origin      {entry['origin']}"
          + (f"  version {entry['version']}" if entry["version"] else ""))
    print(f"  source      {entry.get('url') or 'this installation'}")
    print(f"  pinned      {entry['commit'][:12] if entry.get('commit') else 'no'}"
          + ("  (fetched and checked)" if entry.get("commitVerified")
             else "  (recorded by the importer, not re-fetched)" if entry.get("commit") else "")
          + (f"  ref {entry['ref']}" if entry.get("ref") else ""))
    print(f"  checksum    {entry.get('checksum') or '(none)'}")
    print(f"  licence     {entry.get('license') or 'unknown'}")
    print(f"  installed   {entry.get('installedAt') or '(with the toolkit)'}")
    print(f"  validated   {entry.get('validatedAt') or 'never'}  {entry.get('validationStatus') or ''}")
    print(f"  health      {entry['health']['state']}"
          + (f" — {entry['health']['message']}" if entry["health"].get("message") else ""))
    if entry["dependencies"]:
        print("  depends on")
        for dependency in entry["dependencies"]:
            print(f"    {dependency.get('name') or dependency.get('id')}  {dependency.get('state')}")
    if entry["versionsKept"]:
        print(f"  rollback    {len(entry['versionsKept'])} kept: {', '.join(entry['versionsKept'])}")
    print()
    return 0


def _import(args, *, expect_existing):
    shared = _shared()
    installed = {row["name"] for row in imports.list_plugins(shared)["plugins"]}
    name = args.name
    if expect_existing and name not in installed:
        raise cap.CapabilityError("unknown-plugin", f"No plugin named {name!r} is installed.",
                                  detail="Use `fde plugins add` to install one.")
    summary = imports.import_plugin(
        shared, args.source, name=name, commit=args.commit, ref=args.ref,
        subdirectory=args.subdirectory, include=args.include or None,
        accept_hooks=args.accept_hooks, accept_executables=args.accept_executables, url=args.url,
        expect_namespace=name if name in cap.PINNED_NAMESPACES else None,
        review_note=args.note, dry_run=args.dry_run)
    if args.json:
        return _emit(summary)
    verb = "would import" if args.dry_run else "imported"
    print(f"\n{verb} {summary['name']}  ({summary['namespace']})\n")
    print(f"  files       {summary['fileCount']}  ({summary['totalBytes']} bytes)")
    print(f"  checksum    sha256:{summary['treeSha256']}")
    print(f"  licence     {summary['license'] or 'unknown'}")
    if summary["source"].get("commit"):
        print(f"  pinned      {summary['source']['commit'][:12]}  {summary['source'].get('url')}")
    if summary["hooks"]:
        print(f"  hooks       {', '.join(summary['hooks'])}  (off until you switch each one on)")
    if summary["installFiles"]:
        print(f"  not run     {', '.join(summary['installFiles'])}")
    for dependency in summary["dependencies"]:
        if dependency.get("state") == "missing":
            print(f"  MISSING     {dependency['name']} is not on PATH")
    print()
    return 0


@command
def cmd_plugins_add(args):
    return _import(args, expect_existing=False)


@command
def cmd_plugins_update(args):
    return _import(args, expect_existing=True)


@command
def cmd_plugins_verify(args):
    shared = _shared()
    names = [args.name] if args.name else [row["name"] for row in imports.list_plugins(shared)["plugins"]]
    results = [imports.verify_plugin(shared, name) for name in names]
    if args.json:
        return _emit({"schemaVersion": cap.SCHEMA_VERSION, "results": results})
    drifted = 0
    for result in results:
        print(f"\n{result['name']}  {result['state']}")
        if result["state"] == "drifted":
            drifted += 1
            for label, paths in (("changed", result["changed"]), ("added", result["added"]),
                                 ("removed", result["removed"])):
                for path in paths:
                    print(f"    {label:<8} {path}")
        elif result["state"] == "unpinned":
            print(f"    {result['message']}")
    print()
    return 1 if drifted else 0


@command
def cmd_plugins_rollback(args):
    payload = imports.rollback_plugin(_shared(), args.name, version=args.version)
    if args.json:
        return _emit(payload)
    print(f"{args.name} rolled back to {payload['restored']}"
          + (f"  ({payload['commit'][:12]})" if payload.get("commit") else ""))
    return 0


@command
def cmd_plugins_remove(args):
    payload = imports.remove_plugin(_shared(), args.name)
    if args.json:
        return _emit(payload)
    print(f"{args.name} removed; its tree is kept at {payload['keptAs']}")
    return 0


# -------------------------------------------------------------- registration --

def register(sub):
    """Wire the capability subcommands into the controller's parser."""
    s = sub.add_parser("capabilities", help="what is installed, and whether it is usable")
    s.add_argument("--kind", choices=cap.KINDS)
    s.add_argument("--namespace")
    s.add_argument("--workflow")
    s.add_argument("--stage")
    s.add_argument("--role", choices=cap.ROLES)
    s.add_argument("--run")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_capabilities)
    csub = s.add_subparsers(dest="capability_command")

    c = csub.add_parser("show", help="one capability, its provenance and its resolved state")
    c.add_argument("id")
    c.add_argument("--workflow")
    c.add_argument("--stage")
    c.add_argument("--role", choices=cap.ROLES)
    c.add_argument("--run")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_capabilities_show)

    c = csub.add_parser("validate", help="check every manifest and dependency; nonzero if any fails")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_capabilities_validate)

    c = csub.add_parser("snapshot", help="record this run's resolved capabilities, immutably")
    c.add_argument("run_id")
    c.add_argument("--role", choices=(*cap.ROLES, "both"), default="both")
    c.add_argument("--workflow", default="forward-deployed-engineer")
    c.add_argument("--stage")
    c.add_argument("--workspace")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_capabilities_snapshot)

    s = sub.add_parser("config", help="which capabilities apply, and at which layer")
    gsub = s.add_subparsers(dest="config_command", required=True)

    c = gsub.add_parser("show", help="the effective configuration and why each answer is what it is")
    c.add_argument("--workflow")
    c.add_argument("--stage")
    c.add_argument("--role", choices=cap.ROLES)
    c.add_argument("--workspace")
    c.add_argument("--run")
    c.add_argument("--all", action="store_true", help="include capabilities that are switched off")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_config_show)

    c = gsub.add_parser("set", help="switch a capability on or off at one scope")
    c.add_argument("id")
    c.add_argument("state", choices=cap.STATES)
    c.add_argument("--scope", default="global")
    c.add_argument("--force", action="store_true",
                   help="record a decision about something not installed yet")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_config_set)

    c = gsub.add_parser("reset", help="return a capability to its inherited default at one scope")
    c.add_argument("id")
    c.add_argument("--scope", default="global")
    c.add_argument("--force", action="store_true")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_config_reset)

    c = gsub.add_parser("set-option", help="set a non-boolean option at one scope")
    c.add_argument("name", help="for example ponytail.mode")
    c.add_argument("value", help="a value, or 'inherit' to clear it")
    c.add_argument("--scope", default="global")
    c.add_argument("--workflow", default="forward-deployed-engineer",
                   help="validate the value against this workflow's template")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_config_set_option)

    c = gsub.add_parser("export", help="every explicit decision, as a portable document")
    c.add_argument("--out")
    c.add_argument("--run")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_config_export)

    c = gsub.add_parser("import", help="apply an exported configuration")
    c.add_argument("file")
    c.add_argument("--merge", action="store_true", help="keep decisions the export does not mention")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_config_import)

    s = sub.add_parser("plugins", help="installed plugins, their pins and their provenance")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_plugins_list)
    psub = s.add_subparsers(dest="plugin_command")

    c = psub.add_parser("list", help="every installed plugin with its pin and licence")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_plugins_list)

    c = psub.add_parser("show", help="one plugin, its provenance and its dependencies")
    c.add_argument("name")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_plugins_show)

    for verb, handler, helptext in (
            ("add", cmd_plugins_add, "stage, validate and install a plugin"),
            ("update", cmd_plugins_update, "re-pin an installed plugin, keeping the old version")):
        c = psub.add_parser(verb, help=helptext)
        c.add_argument("source", help="an absolute local directory, or a git URL")
        c.add_argument("--name", help="install under this name (defaults to the manifest's)")
        c.add_argument("--commit", help="the 40-character commit to pin; required for a git source")
        c.add_argument("--ref", help="the tag or release the commit corresponds to")
        c.add_argument("--url", help="the upstream URL, when importing a local copy of it")
        c.add_argument("--subdirectory", help="the plugin's path inside the source")
        c.add_argument("--include", action="append", metavar="GLOB",
                       help="import only these paths; repeatable")
        c.add_argument("--accept-hooks", action="store_true",
                       help="you have read the lifecycle hooks this plugin defines")
        c.add_argument("--accept-executables", action="store_true",
                       help="you have read the executable files this plugin ships")
        c.add_argument("--note", help="what your review of this import found")
        c.add_argument("--dry-run", action="store_true", help="report, install nothing")
        c.add_argument("--json", action="store_true")
        c.set_defaults(fn=handler)

    c = psub.add_parser("verify", help="re-hash installed trees against their pins")
    c.add_argument("name", nargs="?")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_plugins_verify)

    c = psub.add_parser("rollback", help="restore the version an update replaced")
    c.add_argument("name")
    c.add_argument("--version")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_plugins_rollback)

    c = psub.add_parser("remove", help="uninstall a plugin, keeping its tree")
    c.add_argument("name")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_plugins_remove)

    s = sub.add_parser("workflows", help="the installed workflow configurations")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_workflows)

    s = sub.add_parser("workflow", help="one workflow configuration and its stage bundles")
    wsub = s.add_subparsers(dest="workflow_command", required=True)
    c = wsub.add_parser("show")
    c.add_argument("name")
    c.add_argument("--json", action="store_true")
    c.set_defaults(fn=cmd_workflow_show)
