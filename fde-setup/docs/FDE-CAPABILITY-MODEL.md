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
    skill:ponytail:ponytail-review
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
| `user:<plugin>`| anything the operator imported                        |

Anthropic's feature-dev plugin was considered for a reserved namespace and is
deliberately absent: it is distributed under Anthropic's commercial terms with
all rights reserved, and this toolkit is MIT, so vendoring it was not available
to us. Its code-explorer, code-architect and code-reviewer roles are held by
fde-core's repo-cartographer, solutioner and reviewer/test-engineer — which is
what the requirement asks for anyway wherever an imported agent overlaps one of
ours.

One deliberate exception to the three-part rule: a plugin *defines* a namespace
rather than living in one, so a plugin's id is `plugin:<namespace>` —
`plugin:fde`, `plugin:ponytail`, `plugin:user:acme`. Parsing is unambiguous
because the kind is always the first segment and a name never contains a colon.

Every record also carries `ref`, the short namespaced form the UI shows:
`fde:crosscheck`, `ponytail:ponytail-review`, `user:acme:deploy-check`.

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
  "workspaces": { "acme": { "mcp:fde:aws": "enabled" } },
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

## 9. Importing a plugin

An imported plugin is code from outside the trust boundary, and there is one
door it comes through:

    stage  ->  inspect  ->  validate  ->  approve  ->  activate  ->  lock

Nothing is executed at any point in that sequence — not an installation script,
not a hook, not a postinstall. A plugin is read, hashed and described; whether
any of it ever runs is a separate decision the operator makes afterwards, per
capability, through the layers in §4.

Refused before anything is copied into place: symbolic links, paths that
resolve outside the tree, anything that is not a regular file or a directory, a
tree over the file-count or byte caps, a manifest that does not parse, a name
that is reserved (`fde-core`, or a pinned namespace claimed by an unrelated
plugin), and a git source without an explicit 40-character commit — because a
branch is a name that means something different tomorrow.

Hooks and executables are not refusals in themselves; they are the parts an
operator has to actually look at. They become refusals only when nobody has:
`--accept-hooks` and `--accept-executables` are how the operator says they read
them, and what was accepted is recorded in the lock.

### The lock

Each plugin carries its own `.claude-plugin/fde-lock.json` — beside its
manifest, not in a central index, because a central file would be written by
the installer for the vendored plugins and by the import path for the
operator's, and those two owners would fight on every upgrade.

It records the source URL, ref, commit, licence, the imported paths, and the
SHA-256 of every file plus a digest over the whole tree. `fde plugins verify`
re-hashes what is on disk and answers `valid`, `drifted` (naming what changed,
was added or was removed) or `unpinned`.

Two claims are kept apart. The **checksum** pins the tree: it is recomputed
from the files on disk. The **commit** says where those files came from, and
`commitVerified` says whether FDE fetched them itself or is repeating what the
importer wrote down. A vendored tree is checksum-pinned with an unverified
commit; a `fde plugins add <url> --commit <sha>` tree has both.

### Reversibility

Activation is atomic: the tree it replaces is moved aside first, and only then
is the new one renamed in. The three most recent superseded versions are kept,
so `fde plugins rollback` restores one without going near the network.
`fde plugins remove` keeps the tree too.

### Ponytail

Ponytail is vendored at `v4.9.0`, commit `356918eb`, MIT, as a reviewed subset:
the manifest, six skills, six commands, three lifecycle hooks and the
JavaScript modules they require. Artwork, benchmarks, tests, translated
READMEs, the MCP server and the packaging for other agents are not imported.

It is enabled in two stages only — `vertical-slice` in `full` mode and
`quality-review` in `lite` — which is what keeps its lifecycle hooks out of the
stages they have no business in. `ponytail-audit`, `ponytail-debt` and
`ponytail-gain` are offered and never enabled: they scan whole repositories and
reach well outside the deliverable unit a stage is scoped to.

The mode is a **setting**, not a switch, and settings take the same precedence
walk as capabilities (§4) at the same scopes — so "the reviewer runs Ponytail in
lite mode on this one run" is expressible, and it lands in the run snapshot with
everything else.

### Code simplifier

Anthropic's code-simplifier is vendored from `claude-plugins-official` at commit
`da823e86c8feef13b73b6712af11eadd38c992f6` under Apache-2.0. The reviewed
subset contains only its manifest, agent definition and licence; it has no
hooks, executables, install scripts, network calls or runtime dependencies.

It is enabled only for the primary role in `vertical-slice`. The implementation
skill invokes it after the implementation is green, scopes it to recently
modified code, requires exact behavior preservation, and reruns affected checks
after refinement. The existing implementation write approval and workflow
governance remain authoritative.

### Governance

The template carries a `governance` block, and resolution and every run snapshot
carry it forward. It says that FDE governance and the project's own instructions
take precedence whenever instructions conflict, and it names what no plugin's
guidance may override: business acceptance criteria, security, privacy,
accessibility, required error handling, data-loss protection, regulatory
controls, recorded architectural decisions, required testing, and human approval
gates.

That is a statement the runtime hands to the agent. The mechanism that makes it
binding is the layer order: a plugin contributes at layer 8, and security policy
is layer 1.

## 10. Connectors: selection, states and scopes

### Selecting an MCP is not connecting one

A default-enabled MCP means "use it when it is there". It never installs a
server, connects an account, requests a credential, broadens a permission,
enables write access, or contacts anything — not during resolution, and not
while a page is being rendered. Every input is a file on this machine: the
catalogue, the operator's settings, and whatever `fde mcp verify` last recorded.
Only a server the operator has already configured and switched on can become
effectively active.

### The six states

| state | what it means |
|-------|----------------|
| `selected-and-connected` | a stage selected it, and it is configured, switched on and healthy |
| `selected-but-unavailable` | a stage selected it; it is not switched on, or a dependency or setting is missing |
| `installed-but-disabled` | present and usable, and the operator switched it off |
| `authentication-required` | the provider refused the stored credential |
| `connection-error` | it would not start |
| `blocked-by-policy` | disabled in the catalogue, ungovernable, or forbidden by the security policy |

They are derived from the MCP library's own lifecycle states rather than
re-decided here, and they are deliberately six rather than two: "off because you
switched it off" and "off because nothing is connected" send a reader to
different places, and one word for both is how somebody spends an afternoon
toggling the wrong switch.

### Scopes

A scope says what a caller may ask a server to do: `read`, `search`, `create`,
`update`, `delete`, `deploy`, `administer`.

**A scope is a ceiling, never a grant.** It narrows the tool set that
`allowTools` and `denyTools` already proved safe; it can never widen it.
Granting every scope in the vocabulary yields exactly the enforceable set and
not one tool more — there is a test that asserts precisely that. A scope granted
with no tool behind it is reported as `unenforceable` rather than left to look
like it did something.

A tool is placed in a scope by four things, in order of authority: what the
catalogue declares for that server, the MCP annotations discovery recorded
(`destructiveHint`, `readOnlyHint`), what the name looks like, and — when none of
those answer — `administer`. That last step matters: a tool nobody has
classified is available only to a caller granted the broadest scope, so a new
tool appearing in a server update cannot quietly ride in on a read-only grant.

Scopes are resolved by the same precedence walk as everything else, at the same
scopes, so "the reviewer holds read only, on this one run" is expressible and
lands in the run snapshot with the tool list it produced.

Three servers declare their scopes explicitly because their tool sets are known:
serena, playwright and chrome-devtools. Two consequences worth stating:
driving a browser — clicking, typing, filling a form — is `update`, so a stage
granted `read` alone can observe a page but not drive one; and serena is granted
`read` and `search` only, because its editing tools are withheld by its own
allowlist and repository writes belong to the run's Codex write approval rather
than to a connector.

Where a server's tool list has not been verified, FDE says so instead of
claiming a scope was applied. Where nothing can be proved safe, it offers
nothing. Neither is reported as success.

## 11. Commands

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
fde config set-option <name> <value> [--scope SCOPE]
fde plugins [list|show <name>]
fde plugins add <source> [--name N] [--commit SHA] [--ref R] [--url U]
                         [--subdirectory P] [--include GLOB]...
                         [--accept-hooks] [--accept-executables] [--note T] [--dry-run]
fde plugins update <source> --name N [same options]
fde plugins verify [<name>]
fde plugins rollback <name> [--version V]
fde plugins remove <name>
fde config set-option mcp.<server>.scopes read,search [--scope SCOPE]
```

`SCOPE` is `global`, `workspace:<name>`, `workflow:<name>`, `stage:<workflow>/<stage>`,
`role:primary`, `role:reviewer` or `run:<id>`. It defaults to `global`.

## 12. Out of scope for this phase

Deliberately not done yet, in the order they are planned:

- the nine stage bundles wired to real installed capabilities, and degraded
  workflow diagnostics
- runtime enforcement in `fde-start` and `mcp-sync`, including the fact that
  `fde-start` currently passes `--mcp-config` without `--settings`, so the tool
  scoping `mcp-sync` generates is written and never applied
- the Configuration UI
