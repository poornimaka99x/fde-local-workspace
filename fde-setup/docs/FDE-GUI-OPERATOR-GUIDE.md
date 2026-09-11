# FDE Control Center — operator guide

A local console over the `fde` controller. It shows you what your runs are
doing, lets you create projects and runs, attach input files, and resume a
Claude-led run in an embedded terminal.

It approves nothing. Roles, plan approval, Codex writes, deployment and
publication all stay where they were: typed by you, in a conversation or a
terminal. The console has no button for any of them and adds none.

## Start it

```bash
fde-gui
```

That builds the interface if it needs building, starts the server on
`127.0.0.1:7317`, and opens your browser. The link looks like:

```text
http://127.0.0.1:7317/#token=<a new token every launch>
```

The token rides in the URL fragment, which a browser never sends to a server —
so it stays out of request logs, `Referer` headers and history sync. It is valid
for that launch alone. Stop the console with Ctrl-C.

| | |
|---|---|
| `fde-gui --port 7400` | listen somewhere else |
| `fde-gui --no-open` | start without opening a browser |
| `fde-gui --rebuild` | rebuild the interface |
| `fde-gui --install` | reinstall dependencies first |

## The screens

### Runs

Every run the controller knows about, newest activity first. Search by run id,
requirement or Jira key; filter by state, project, orchestrator or whether a
session can be resumed. A run's state comes from the controller — the console
never decides a run is finished because a file appeared.

### Run detail

The header carries the run id, its project, the requirement and the state. The
**Next** panel shows the controller's own next step, to run in a terminal.

Six tabs:

- **Overview** — the plan as a stage timeline, the roles with the identity
  holding each, and the raw manifest behind a disclosure.
- **Session** — whether this run can be resumed, and the terminal if it can.
- **Inputs** — attachments with their size and SHA-256, and the input files.
- **Artifacts** — what the plan expects, what exists, and a file browser with
  previews.
- **Events** — the run log, paginated, with each record's raw JSON available.
- **Approvals & evidence** — approvals with their status, checkpoints with their
  evidence, and the output-hygiene report.

### Resuming a run

For a Claude-led run, **Resume session** starts exactly
`fde-start --resume <run-id>` and streams it into the page. You type into it as
you would in a terminal — including the approval phrases, which are yours to
type.

One process per run: a second tab attaches to the same session rather than
starting another. Closing the tab detaches; it does not stop the run. **Stop**
sends an interrupt, and a **Force stop** appears a few seconds later if the
session is still there — behind a confirmation.

A Codex-led run says so instead of offering a button: it is driven from its own
Codex task, and the console will not pretend otherwise.

### Attaching a file

On the Inputs tab, pick a file and press Attach. The bytes go to
`fde attach --stdin --name`, so the controller — not the console — sanitizes the
filename, generates the stored name, hashes what it wrote and appends the audit
record. Your original is copied, never moved or changed.

### Projects

Projects group runs. A project is a name, a description and repository paths
that must already exist; it holds no workflow state. Nothing here clones,
changes or deletes a repository.

### Active sessions and system health

**Active sessions** lists what this console has started. A session you started in
your own terminal is not listed — it belongs to that terminal.

**System health** shows the roots the console is pointed at, whether `fde` and
`fde-start` are present, the contracts the installed controller speaks, and the
names of your Claude profiles. No credential is opened, and no network or
Keychain check runs here.

## Themes and keyboard

The console follows your machine's light or dark setting; the **Theme** control
in the top bar overrides it for this browser. Every screen passes an automated
WCAG 2.1 AA audit, contrast included, in both themes. Tab reaches a skip link
first; the run tabs move with the arrow keys, Home and End.

## MCP servers

**Configuration → MCP servers** is the catalogue: every server FDE knows how to
run, what state it is in, and what it would still need. Four words on that page
mean four different things, and they are not interchangeable:

| | |
|---|---|
| **catalogue** | FDE knows how to run this server. Nothing more. |
| **configured** | you supplied the settings and credentials it declares |
| **ready** | also installed on this machine, and a bounded verification succeeded |
| **active** | in a specific run's or chat's effective set — never a property of the catalogue |

Each card shows the state, the reason, the pinned package version, and one line
saying what the server can do to the world once active. **Verify** is the only
button that starts anything: it performs an initialize and a tool listing, never
a business operation, and it is what turns "read-only" from a claim into a fact —
the tool names it collects become the allowlist each client is given.

The **Profile** selector narrows the list to one kind of work — coding,
frontend testing, Acme delivery, data, observability. It never widens it: role,
stage and readiness still all have to agree before a run sees a server.

Three banners are worth reading rather than dismissing:

- *Not installed on this machine* — FDE will not install anything for you. The
  card shows the exact command.
- *Held back on purpose* — the server can change things and offers no verifiable
  read-only subset, so it stays inactive. That is the control working.
- *FDE cannot scope this provider's tools* — Atlassian and Figma sign in inside
  the MCP client, so there is no tool list to build an allowlist from. They reach
  a session with every tool they offer, and their writes are stopped only at
  publication. Pin the read tool names in that card's settings to close it.

**Service connections and MCP servers are different things** and stay on separate
tabs. A connection is a credential for a system; an MCP server is a governed
capability with a lifecycle, a profile and a tool scope.

## Capabilities and extensions

**Configuration → Capabilities** is the complete local inventory of the FDE
agent harness: plugins, skills, sub-agents, MCP servers, declared tools,
commands, hooks and runtime utilities. Use the type chips or search box to find
a capability. Every card says whether the item is built in or user owned, which
plugin supplies it, and where its definition lives. Skill and sub-agent cards
also expose their declared tools; MCP cards expose their tool-scope policy.

Every switch is persisted in
`~/.claude-shared/config/capability-policy.json`. Skill, sub-agent and plugin
states constrain what a new FDE session may select or delegate to. Disabled
built-in tools are also passed to Claude as explicit CLI deny rules. MCP
switches go through the existing `fde mcp enable|disable` controller path, and
hook switches remove or restore the event in the plugin hook manifest. The
required `fde-core` plugin and inventory-only commands/utilities cannot be
switched off. Existing processes keep the capability set they started with.

**Create skill** writes a new `SKILL.md` under the separately managed
`fde-user` plugin. Its name, trigger description, instructions and allowed tools
are explicit, and updates to `fde-core` do not overwrite it. **Import local
plugin** accepts an absolute path to a plugin containing
`.claude-plugin/plugin.json`, validates its manifest and bounded file tree,
rejects symbolic links, then copies it into the local `fde-toolkit` marketplace.
It never replaces an existing plugin with the same name.

Adding an extension changes the marketplace source, not a session that is
already running. Refresh or install the plugin in every AI account that should
use it, then start a new session. This keeps extension authorship separate from
run authority: a new capability does not grant a role, activate an MCP server,
or bypass an approval.

## Service access in a chat

A chat has no plan, no roles and no approvals behind it, so the console offers a
connection only where the tool scope can actually be enforced: a Codex chat gets
an explicit allowlist of the tools that only read, and a Claude chat gets a
connection only when every tool it offers reads. A connection that has never been
verified is listed as withheld, with the reason — FDE will not describe as
read-only something it has not asked.

## When something looks wrong

| What you see | What it means | What to do |
|---|---|---|
| *The installed controller is older than this console* | `~/.claude-shared/bin/fde` predates the JSON contracts | `./install.sh --update` from your fde-setup checkout |
| *This installation has no terminal backend* | `node-pty` did not build here | `fde-start --resume <run-id>` in a terminal; reinstall dependencies to fix it |
| *Resume this run in its original Codex task* | the run is Codex-led | drive it from Codex; the console can still show its state and files |
| *The controller refused this request* | a controller gate or a bad input | the message is the controller's own; fix what it names |
| *This run is busy* | another change is in flight for it | refresh and try again |
| *N things in this data could not be read cleanly* | a malformed or half-written record | the rest of the run still renders; the file on disk is untouched |
| A red banner across every screen | the console cannot talk to the controller at all | check System health for the path it is using |
| An MCP server stuck at *not configured* with nothing missing | its tool list has not been verified, so no allowlist exists yet | press **Verify** on its card |
| An MCP server at *blocked* | no verifiable read-only subset — it is inactive by design | leave it; use it inside a run behind an approval, or pin an allowlist |
| A run sees no MCP servers | roles are not confirmed, or the plan's stages do not call for any | `fde mcp effective --run <id>` names the reason per server |

## Where things live

| | |
|---|---|
| The console | `~/.claude-shared/fde-gui` |
| Runs | `~/.claude-shared/runs/<run-id>` |
| Projects | `~/.claude-shared/projects/<project-id>` |
| The launcher | `~/.claude-shared/bin/fde-gui` |
| User skills | `~/.claude-shared/fde-toolkit/plugins/fde-user/skills/` |
| Imported plugins | `~/.claude-shared/fde-toolkit/plugins/<plugin-name>/` |

Run, project, account, connection and MCP lifecycle changes continue to go
through the `fde` controller. Capability authoring is the narrow exception: the
console writes user-owned plugin files and the local marketplace directly after
validation. It does not edit `fde-core`, install executable dependencies, or
change a running session. If the console is not running, nothing changes.
