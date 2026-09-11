# The FDE capability model

How FDE decides which skills, sub-agents, tools, MCP servers, plugins, hooks,
commands and scripts a run may use — and how an operator changes that answer.

This document is the contract. `claude-shared/lib/fde_capabilities.py` is its
implementation; `fde capabilities`, `fde config` and `fde workflow` are its
interface; the console renders it and writes nothing of its own.

## 1. Why the controller owns this

Three callers need identical answers to "may this run use X": the console (so
the operator sees the truth), `fde-start` and `mcp-sync` (so the runtime
enforces it), and the run record (so an audit can reconstruct it). A second
implementation is a second answer, and the first time they disagree the console
is lying about what the agents can reach.

So discovery, validation and resolution live in one library beside the
controller, exactly as the MCP catalogue already does. The console became a
proxy over `fde capabilities --json` and `fde config show --json`.

## 2. Identity and namespaces

A capability id is `<kind>:<namespace>:<name>`.

    skill:fde:crosscheck
    agent:feature-dev:code-explorer
    mcp:fde:serena
    tool:fde:Read
    hook:ponytail:SessionStart
    skill:user:acme:deploy-check

`kind` is one of `plugin`, `skill`, `agent`, `mcp`, `tool`, `command`, `hook`,
`script`, `workflow`.

`namespace` says who provides it, and is the collision boundary:

| namespace      | provider                                              |
|----------------|-------------------------------------------------------|
| `fde`          | the built-in fde-core plugin, the MCP catalogue, the built-in tool set |
| `ponytail`     | the pinned external Ponytail plugin                   |
| `feature-dev`  | the pinned Anthropic feature-dev plugin               |
| `user:<plugin>`| anything the operator imported                        |

One deliberate exception to the three-part rule: a plugin *defines* a namespace
rather than living in one, so a plugin's id is `plugin:<namespace>` —
`plugin:fde`, `plugin:ponytail`, `plugin:user:acme`. Parsing is unambiguous
because the kind is always the first segment and a name never contains a colon.

Every record also carries `ref`, the short namespaced form the UI shows:
`fde:crosscheck`, `ponytail:review`, `feature-dev:code-architect`.

## 3. The capability record

Discovery reads the authoritative directories — it never trusts a cached
inventory, and it never executes anything it finds.

```json
{
  "id": "skill:ponytail:review",
  "kind": "skill",
  "namespace": "ponytail",
  "name": "review",
  "ref": "ponytail:review",
  "description": "...",
  "origin": "built-in | external | user",
  "plugin": "ponytail",
  "source": "~/.claude-shared/fde-toolkit/plugins/ponytail/skills/ponytail-review/SKILL.md",
  "version": "4.9.0",
  "provenance": {
    "type": "built-in | git | local",
    "url": "https://github.com/dietrichgebert/ponytail",
    "ref": "v4.9.0",
    "commit": "356918eb...",
    "checksum": "sha256:...",
    "license": "MIT",
    "installedAt": "2026-09-11T09:12:00+05:30",
    "validatedAt": "2026-09-11T09:12:00+05:30"
  },
  "health": { "state": "ok | degraded | invalid | unavailable | unknown",
              "code": "node-missing", "message": "..." },
  "dependencies": [ { "kind": "runtime", "name": "node", "state": "ok" },
                    { "kind": "capability", "id": "plugin:ponytail" } ],
  "availability": "available | unavailable | blocked",
  "validation": { "valid": true, "errors": [] },
  "protected": false,
  "tools": ["Read", "Grep"]
}
```

`health` is about the thing itself (is its manifest valid, is its runtime
present). `availability` is about whether it can be used at all right now
(unavailable dependency, blocked by security policy). `validation` is the
manifest check. They are three separate fields because conflating them is how a
console ends up reporting "off" for something that is actually broken, and the
operator spends an afternoon toggling a switch that was never the problem.

Discovery is non-destructive and side-effect free. It reads manifests and
front-matter. It does not run hooks, scripts, installers or MCP servers, and it
does not contact any external service.

## 4. Configuration state

A capability's configured state at any layer is one of three values, never a
boolean:

- `inherit` — this layer has no opinion; ask the layer below
- `enabled`  — this layer turns it on
- `disabled` — this layer turns it off

A boolean cannot express "the operator has not decided", which is the state that
makes upgrades safe: a capability the operator never touched may gain a new
default, and one they explicitly switched off may not.

### Precedence

Highest first. The first layer with an opinion other than `inherit` wins.

1. `security`  — runtime security policy, non-overridable
2. `run`       — this run only
3. `role`      — primary or reviewer account
4. `stage`     — one lifecycle stage of one workflow
5. `workflow`  — this workflow
6. `workspace` — this workspace
7. `global`    — this installation
8. `builtin`   — the workflow template's defaults

Layer 8 is data shipped with FDE and is never written by resolution or by the
console. An upgrade replaces it; it cannot reach layers 1–7.

### The invariants

- **An explicit disable survives an upgrade.** User layers are keyed by stable
  capability id and are never rewritten by `install.sh`. `capability-config.json`
  is in the installer's PRESERVE list.
- **Nothing is restored transitively.** A stage bundle, plugin, sub-agent,
  command, hook, MCP or workflow upgrade can only ever contribute at layer 8. No
  mechanism exists by which one capability enables another.
- **A disabled parent plugin makes its contributions ineffective**, with source
  `parent-disabled`. The child's own configured state is retained untouched, so
  re-enabling the parent restores exactly what the operator had, not a default.
- **Disabling a child does not disable its parent** or its siblings.
- **A malformed policy fails closed.** An unreadable or invalid file at any
  layer raises; it never degrades to "everything enabled". This is the existing
  behaviour in `fde-start` and it now holds everywhere.
- **Unavailable is not disabled.** A capability whose dependency is missing
  resolves to unavailable and keeps its configured state, so the operator's
  intent is not silently rewritten by a transient absence.

### Resolved state

```json
{
  "id": "skill:fde:crosscheck",
  "state": "enabled | disabled",
  "effective": "fde-default | inherited-enabled | user-enabled | user-disabled
                | unavailable | blocked | invalid | parent-disabled",
  "layer": "global",
  "configured": "disabled",
  "overridden": true,
  "inheritedFrom": "builtin",
  "reason": "..."
}
```

## 5. On-disk layout

| path | owner | contents |
|------|-------|----------|
| `config/security-policy.json` | FDE | layer 1. Ids that may never be enabled or never be disabled. |
| `config/capability-config.json` | operator | layers 3–7. PRESERVEd across upgrades. |
| `config/capability-policy.json` | legacy | v1 boolean file. Migrated in, and kept in step by the shim in §8. |
| `config/workflows/*.json` | FDE | layer 8 templates. Read-only. |
| `runs/<id>/capabilities/overrides.json` | operator | layer 2. |
| `runs/<id>/capabilities/snapshot-<role>.json` | FDE | immutable resolved snapshot. |

`capability-config.json`:

```json
{
  "schemaVersion": 1,
  "global":     { "skill:fde:engage": "disabled" },
  "workspaces": { "maxeda": { "mcp:fde:aws": "enabled" } },
  "workflows":  { "forward-deployed-engineer": { "skill:ponytail:audit": "disabled" } },
  "stages":     { "forward-deployed-engineer/implementation": { "agent:fde:security-reviewer": "enabled" } },
  "roles":      { "reviewer": { "mcp:fde:aws": "disabled" } },
  "hookPayloads": { "hook:ponytail:SessionStart": { } }
}
```

Only ids with an opinion appear. An absent id is `inherit`, which is why the
file stays small and why a diff of it reads as a list of operator decisions.

## 6. Workflow templates

A template is immutable built-in data. `forward-deployed-engineer` declares nine
named stages, each bound to one or more controller stages:

| template stage | controller stages |
|----------------|-------------------|
| `business-intent` | intake |
| `solution-requirements` | research |
| `technical-architecture` | solutioning |
| `development-planning` | planning |
| `vertical-slice` | implementation |
| `quality-review` | review, verification |
| `documentation` | presentation, publication |
| `scm-build-deploy` | deployment |
| `operations` | observability |

The controller's twelve-stage spine, its approval gate states and every existing
named shape are unchanged. The template is a selection layer over them, so a
template cannot plan its way past `awaiting_implementation_approval`,
`awaiting_deployment_approval` or `awaiting_publication_approval`.

Each stage declares `skills`, `agents`, `tools`, `mcps` and `plugins`, and may
declare a different bundle for the `reviewer` role than for `primary`. An entry
naming a capability that is not installed is reported, not invented: the stage
resolves degraded and names what is missing.

## 7. Run snapshots

At the point a run's capabilities are first resolved, the controller writes
`runs/<id>/capabilities/snapshot-primary.json` and `-reviewer.json`. A snapshot
records every effective capability id, its version and provenance, the layer and
reason behind each decision, the template revision, and a `digest` over the
whole thing. It is written once with `O_EXCL` and never rewritten; a later
change writes a new snapshot and records the supersession, exactly as routing
approvals already do.

Primary and reviewer snapshots are independent documents. The reviewer's is
built from the reviewer's own resolution — it is not the primary's with fields
removed.

## 8. Migration from `capability-policy.json`

The v1 file is a `disabled: [...]` list of booleans plus stashed hook payloads.
On first read the controller migrates it:

- every id in `disabled` becomes `"disabled"` in `global`
- ids are rewritten to the namespaced form (`skill:fde-core:x` → `skill:fde:x`,
  `tool:X` → `tool:fde:X`, `mcp:X` → `mcp:fde:X`, `plugin:fde-core` → `plugin:fde`)
- each id's original spelling is recorded, so writing the v1 file back changes
  no bytes it does not have to
- `disabledHooks` payloads move to `hookPayloads` unchanged

Migration is idempotent and never loses a disable. If the legacy file is
malformed the migration fails closed and writes nothing at all.

### The shim, and why it is here

`fde-start` and the console still read the v1 file — that is what turns a
disabled tool into a `--disallowedTools` entry today. If migration had renamed
it, an operator's switch-off would have stopped being enforced at the moment
they upgraded, silently. So the v1 file is **kept**, and:

- every `Config.save()` rewrites it from the `global` layer
- a v1 file whose digest has changed since the last migration is merged back in,
  so a decision the console writes is picked up rather than overwritten
- only the `global` layer is projected into it, because v1 has exactly one layer
  and flattening a stage or role decision into it would be a lie

This is transitional and marked as such in the source. It goes when `fde-start`
and the console read `fde config show --json` instead, which is the runtime
enforcement phase.

One gap it does not close: the console disables a hook by physically removing it
from the plugin's `hooks.json` and stashing the payload, while `fde config set`
only records the decision. Until runtime enforcement lands, a hook switched off
through the CLI is recorded but still fires.

## 9. Commands

```
fde capabilities [--kind K] [--namespace N] [--json]
fde capabilities show <id> [--json]
fde capabilities validate [--json]
fde config show [--workflow W] [--stage S] [--role R] [--run ID] [--json]
fde config set <id> enabled|disabled|inherit [--scope SCOPE]
fde config reset <id> [--scope SCOPE]
fde config export [--json]
fde config import <file> [--json]
fde workflows [--json]
fde workflow show <name> [--json]
fde capabilities snapshot <run-id> [--role primary|reviewer] [--json]
```

`SCOPE` is `global`, `workspace:<name>`, `workflow:<name>`, `stage:<workflow>/<stage>`,
`role:primary`, `role:reviewer` or `run:<id>`. It defaults to `global`.

## 10. Out of scope for this phase

Deliberately not done yet, in the order they are planned:

- the nine stage bundles wired to real installed capabilities, and degraded
  workflow diagnostics
- Ponytail and feature-dev import, pinning and validation
- MCP permission scopes and the six connection states
- runtime enforcement in `fde-start` and `mcp-sync`, including the fact that
  `fde-start` currently passes `--mcp-config` without `--settings`, so the tool
  scoping `mcp-sync` generates is written and never applied
- the Configuration UI
