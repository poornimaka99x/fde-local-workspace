# FLOW

**F**orward-deployed **L**ocal **O**perations **W**orkspace — a local console and
controller for running real delivery work through several AI coding agents
(Claude Code, ChatGPT/Codex, Gemini, Microsoft Copilot) under one governed
lifecycle, on your own machine.

Most agent tooling can tell you what changed. FLOW is built so you can also answer
what it was allowed to read, whose authority it acted on, and what you would show
a client who asked. It was built for forward-deployed work — client estates,
client constraints, interrupted sessions, several engagements at once — where
that second question is the one that actually costs you.

The design rule throughout: **read-only is enforced, or it is not claimed.** Tool
scope is built from the tool list a server actually reported and expressed in each
client's own mechanism. A code write is bound to the SHA-256 of one task file. And
where a provider's tools cannot be enumerated at all, FLOW reports it as `blocked`
with the reason rather than describing it as safe.

**New here? [START-HERE.md](START-HERE.md)** is copy-paste, about 30 minutes to a
first completed run. [`RUNBOOK.md`](RUNBOOK.md) is the phased setup detail. This
file is the design.

> **On naming.** FLOW is the system. `fde` is the controller command, `fde-start`
> the launcher, `fde-gui` the console package, `~/.claude-shared` the shared root.
> Those identifiers are a stable contract with anything already installed and are
> deliberately not renamed.

## Quickstart

```bash
git clone https://github.com/poornimaka99x/fde-local-workspace.git
cd fde-local-workspace

./install.sh --update --dry-run     # look first — nothing is written
./install.sh --update
exec $SHELL -l

cp claude-shared/env.sh.example ~/.claude-shared/env.sh   # then edit it
chmod 600 ~/.claude-shared/env.sh

fde doctor                          # what is configured, what is broken
fde-start                           # start a run and its orchestrator chat
```

Then open the console:

```bash
cd fde-gui && npm install && npm start
# open the http://127.0.0.1:7317/#token=... link it prints
```

Requires Node 22+ and Claude Code signed in at least once. Codex and Gemini are
optional until you assign them a role. The full walkthrough, including the two
typed approvals and what to do when a command refuses you, is in
[START-HERE.md](START-HERE.md).

## The idea in two sentences

**Identities are not roles.** "Claude: work", "ChatGPT/Codex", "Gemini" and
"Microsoft Copilot" are who is in the room; who researches, who architects, who
reviews and who implements is decided by *you*, at the start of every run, and
is never inherited from the last one.

**Nothing crosses a boundary without you.** Nothing is read until you approve
the combined plan and role assignment; Codex writes only under a one-time
approval bound to the exact bytes of one task file; and anything that leaves
this machine — Jira, Confluence, SharePoint, GitHub, Bitbucket, Figma,
deployment, email or Teams — needs its own publication approval.

## What is in this repository

| Path | What it is |
|---|---|
| [`START-HERE.md`](START-HERE.md) | Copy-paste setup to a first completed run, plus the refusal table |
| [`RUNBOOK.md`](RUNBOOK.md) | Phased setup detail, including the parts that need an admin |
| `claude-shared/bin/fde` | The controller — a single Python 3 program, no dependencies |
| [`fde-gui/`](fde-gui/README.md) | The FLOW console: projects, runs, plans, roles, approvals, evidence |
| `fde-toolkit/` | The plugin marketplace: skills, specialist agents, commands, hooks |
| [`docs/FDE-DESIGN-PANEL.md`](docs/FDE-DESIGN-PANEL.md) | Several Claude accounts, one sealed context, one reconciled recommendation |
| [`docs/MCP-GOVERNANCE.md`](docs/MCP-GOVERNANCE.md) | Per-server setup, credentials, read/write boundaries, tool scope |
| [`docs/FDE-CONTROLLER-CONTRACTS.md`](docs/FDE-CONTROLLER-CONTRACTS.md) | The machine-readable controller surface |
| [`docs/FDE-GUI-THREAT-MODEL.md`](docs/FDE-GUI-THREAT-MODEL.md) | The console's security boundaries |
| [`docs/index.html`](docs/index.html) | The project landing page |

## The four layers

| Layer | Lives in | Changes when |
|---|---|---|
| **Shared** — how you work, standards, client context | `~/.claude-shared/` | rarely |
| **Toolkit** — skills, agents, commands, MCP servers, hooks | `~/.claude-shared/fde-toolkit/` (a plugin marketplace) | when you build a capability |
| **Run** — one requirement, its roles, approvals and artifacts | `~/.claude-shared/runs/<run-id>/` | constantly, and never shared |
| **Repo** — what *this* codebase is | `<repo>/CLAUDE.md` + `<repo>/.claude/` | per engagement |

Plus one config dir per identity in `~/.claude-profiles/`, holding *only* auth
and provider settings. The shared layer is symlinked into each, so all profiles
see the same context without duplicating it.

## Install

```bash
./install.sh                   # profiles: work, msc, alt, bedrock
./install.sh work bedrock      # or name your own
./install.sh --update          # refresh an existing install
./install.sh --update --dry-run
```

The installer never deletes, never overwrites a file you changed without showing
you the diff first, backs up anything it does replace, and never touches your
client contexts, intake, run history, credentials or profile settings. A skill
you wrote that the source does not ship stays where it is.

Then open a new shell and sign in once per profile:

```bash
cc-work  cc-msc  cc-alt     personal accounts
cc-bedrock                  Acme on Bedrock
cc-which                    what exists, what's active
fde doctor                  what is configured, what is broken
```

**Bedrock account settings live in the FDE account registry.** Choose the AWS
profile and region when adding the account, or change them later under
Configuration → AI accounts. FDE exports those values for verification and every
launch; the profile's `settings.json` retains a compatible copy for direct CLI use.

## Running a piece of work

Start one continuous orchestrator conversation:

```bash
fde-start                                    # asks which Claude profile orchestrates
fde-start --orchestrator bedrock             # or select it directly
```

Give the request in chat. The orchestrator proposes the smallest suitable plan
and a table of required specialist roles, explains why each role is needed, and
shows the eligible account identities. You select the identities. It then shows
one combined summary of the request, stages, deliverables, roles, access and
retained approval gates. Only the exact phrase it gives you —
`APPROVE PLAN <run-id>` — confirms both plan and roles.

When prompted, type `/exit`. `fde-start` resumes the same Claude conversation
with the run-scoped connectors enabled. Within the approved scope the
orchestrator can use its normal configured tools autonomously. It must stop and
ask when intent, target, authority, destructive effect, acceptance criteria or
required evidence is ambiguous. Codex writes, deployments, external
publication, destructive actions and scope expansion retain their explicit
gates.

**The orchestrator comes first** because it is the identity that reads your
sentence and proposes what the run should do. Any Claude profile or Codex can
hold it; Gemini and Microsoft Copilot cannot — Gemini is a one-shot headless call
with no session state and Copilot is a chat endpoint over the Microsoft estate,
so neither can hold a run together. Both can still research or review. The
continuous `fde-start` launcher currently supports Claude profiles; a Codex-led
run can still be created and driven with the controller commands.

**A run is a slice of the pipeline, not all of it.** "Research this and get it
validated" is a real ask; so is "slides and a Jira breakdown". The plan decides
which lifecycle stages this run does, and everything downstream follows it —
the role question shrinks to fit, `fde status` shows only the artifacts in scope,
and `fde invoke` refuses a stage that is not in the plan. `fde shapes` lists the
common ones:

```
research          intake → research
research-to-adr   intake → research → solution architecture → review → reconciliation
review-only       intake → adversarial review
presentation      intake → presentation
delivery-plan     intake → development plan
build             intake → implementation → verification
pr-review         intake → adversarial review → verification
design-to-build   intake → solution architecture/design → presentation → planning → implementation → verification
release           verification → deployment → observability
operate           intake → observability
full              all twelve stages
```

Skipping a stage's usual input warns rather than blocks — sometimes the input is
in your head or in a Confluence page. Widening a plan later works forwards
(`fde plan <run-id> --add solutioning`); going backwards is a new run.

Approval gates are not stages you can plan around. If `implementation` is in the
plan, `awaiting_implementation_approval` precedes it and the run will not enter
implementation without the approval that gate exists for. Deployment and
publication have their own external-write approvals.

Any identity may hold any role it has the capability for; one identity may hold
several; `none` is valid. If something you assigned is not available on this
machine, `fde roles` stops and says what is missing rather than substituting.
The assignment lives in that run's `roles.json` — a new run asks again, from
scratch.

Then `/engage <run-id>` runs it, with `fde status <run-id>` showing state,
artifacts, approvals and what is next, and `fde resume <run-id> --next` moving it
along.

Artifacts land under the run, and only the ones the plan calls for:
`research-brief.md`, `architecture-options.md`, `adr.md`, `review.md`,
`reconciliation.md`, `solution-presentation.pptx`, `development-plan.md`,
`jira-plan.json`, `implementation-task.md`, `verification-report.md`,
`deployment-report.md`, `observability-plan.md` and
`publication-manifest.json`. Verification and observability also carry
append-only evidence checkpoints; a passing checkpoint is required before
release progression.

Every legal transition into `publication` or `complete` runs
provenance-preserving output hygiene first. It scans only `artifacts/`, never
follows symlinks, and removes a narrow allowlist of unsafe invisible Unicode,
home-directory prefixes and personal or
path-like Office properties, and writes a hashed JSON report under
`artifacts/evidence/`. Creator, copyright, ownership, visible-watermark and C2PA
metadata are preserved. Run it early with `fde output-hygiene <run-id> --check`,
or apply it manually without `--check`.

The optional [watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover)
service is inspect-only in FDE. Set `WATERMARKS_SERVICE_URL` to its loopback URL
to include its findings in the evidence report; FDE never calls `/clean`.

`jira-plan.json` is a preview. A plan existing is not a reason to create
anything.

## The other identities

Codex and Gemini run locally as CLIs; Microsoft Copilot is reached through a
Copilot Studio agent over Direct Line. Two problems have to be solved to make
them one system: they disagree about which instruction file to read, and each
stores MCP config in a different place and shape.

**Instructions — `AGENTS.md` is the single source.**

| Tool | Reads AGENTS.md | Adapter needed |
|---|---|---|
| Codex CLI | natively | none |
| Claude Code | no | `CLAUDE.md` containing `@AGENTS.md` |
| Gemini CLI | not by default | one-time `context.fileName` setting |

`/repo-init` writes `AGENTS.md` plus the adapters. `/agents-sync` fixes a repo
that has already drifted into several instruction files.

**MCP — one source file, three generated configs, and not everything is global.**

Edit `~/.claude-shared/mcp/mcp-servers.json`, run `mcp-sync`:

```
Claude Code   <plugin>/.mcp.json          type optional, stdio inferred
Gemini CLI    ~/.gemini/settings.json     streamable HTTP is "httpUrl", not "url"
Codex CLI     ~/.codex/config.toml        TOML, [mcp_servers.<name>]
```

Each server declares who gets it. `["claude","gemini","codex"]` is global.
`["role:orchestrator"]` is **not**: that server stays out of every global config
and is written per run, for whichever identity holds the role, by
`mcp-sync --run <run-id>` — which the combined approval flow calls for you.
Atlassian is
role-scoped for exactly this reason: there is no permanently privileged
orchestrator account, because there is no permanent orchestrator.

Claude orchestrators and Claude/Codex specialist invocations load the generated
run-scoped MCP configuration. For Claude two files travel together — `--mcp-config`
says which servers exist, `--settings` says which of their tools may be called —
and a config without its settings withholds the servers rather than widening
access. Antigravity currently exposes only machine-global MCP management, so FDE
does not temporarily widen it with role-scoped servers.

Merging is real. Servers this tool manages are listed in `_fdeManaged`, so a
server you added by hand survives an update, and one that is no longer targeted
is removed rather than left behind.

**Being in the catalogue is not access.** Four words, four different things:

| | |
| --- | --- |
| **catalogue** | FDE knows how to run this server |
| **configured** | you supplied the settings and credentials it declares |
| **ready** | also installed, and a bounded verification succeeded |
| **active** | in a specific run's or chat's effective set, because that run's approved stages, roles and profile call for it |

`fde mcp list` shows every entry's state — `unavailable`, `not_configured`,
`authentication_required`, `ready`, `active`, `unhealthy` or `blocked` — with the
reason and the exact next action. `fde mcp effective --run <id>` shows what one
run may actually reach, and why anything else may not. The combined plan approval
prints the same set before you type the phrase, so access is never widened
silently.

**Read-only is enforced or it is not claimed.** A prompt is not a control. Each
client gets the scope in its own mechanism — Claude permission rules
(`mcp__server__tool`, exact names, no wildcards), Codex `enabled_tools`, Gemini
`includeTools` — built from the tool list the server actually reported. Where a
provider offers no verifiable read-only subset, the server stays inactive and
reports `blocked` with the reason instead of being described as safe. Atlassian
and Figma are the honest exception: their OAuth token belongs to the MCP client,
so FDE cannot enumerate their tools, and every surface says so — their writes are
gated at publication by `fde approve-publish`, and you can pin a real allowlist
with `fde mcp configure atlassian --set allowTools=…`.

**Profiles** name a slice of the catalogue for a kind of work — `coding`,
`frontend-testing`, `client-delivery`, `data`, `observability`. Selecting one
narrows the effective set; it never widens it.

Ten servers ship in the catalogue: Context7 and Serena for code, Playwright and
Chrome DevTools for the browser, Atlassian and Figma for delivery and design,
DBHub, AWS, Azure and Langfuse for data, cloud and observability. Versions are
pinned, nothing installs itself, and neither `npx` nor `uvx` runs because you
opened a page. `docs/MCP-GOVERNANCE.md` is the full reference: per-server setup,
credentials, read/write boundaries, the Docker-optional gateway, and
troubleshooting.

**Delegation.** Gemini cannot be exposed as an MCP server, so the bridge is
headless invocation:

```bash
ask-gemini "…"                # bulk reading, long context, web research
ask-codex --read-only "…"     # independent read from another model family
ask-ms-copilot "…"            # SharePoint, Outlook, Teams, M365 documents
git diff | ask-gemini "what breaks in production?"
```

`ask-gemini` matters more than it looks: **Bedrock has no WebSearch**, so on that
profile it is your research path.

Codex writing is a different thing entirely:

```bash
fde approve-codex <run-id> implementation --task-file <file> --repo <path>
# → shows run, repo, branch, writable root, task hash, network, commands
# → you type: APPROVE CODEX <run-id>
fde invoke <run-id> chatgpt_codex <file> --write
```

The approval is one-time, expires in 30 minutes, and is bound to the SHA-256 of
the task file. Edit the task and it is refused, not widened. Codex then runs
non-interactively with `--sandbox workspace-write`; the current CLI fails closed
unless an explicit auto-approval option is passed, and this toolkit never passes
one. The filesystem is bounded to the approved root and network is off. There is
no `--yolo` and no
`danger-full-access` anywhere in this toolkit, and `fde doctor` fails if one
ever appears.

**GitHub Copilot is not part of this ecosystem.** `ask-copilot` is a stub that
says so; `mcp-sync` never reads or writes `~/.copilot`; your existing
configuration there is left alone. "Copilot" in this repository always means
Microsoft 365 Copilot / Copilot Studio.

## Microsoft

`ask-ms-copilot` talks to a Copilot Studio agent over Direct Line: SharePoint,
Outlook, Teams recaps, M365 documents, Copilot Notebook material where the
tenant exposes it. It does not touch source code, git, Bitbucket or Jira work
items — it sends text to a chat endpoint and prints the reply, so that boundary
is structural, not just a policy.

The Direct Line secret belongs in the Keychain, not in a globally sourced env
file that every process you run can read:

```bash
security add-generic-password -a "$USER" -s fde-copilot-directline -w
ask-ms-copilot --check    # confirms it resolves; prints no secret
```

`ms-intake` is the manual path for anything the tenant will not expose — a
Copilot Notebook export, a Teams recap, a pasted thread. `.docx` needs pandoc or
python-docx; `fde doctor` says which you have.

## Atlassian

The Rovo MCP endpoint is `https://mcp.atlassian.com/v2/mcp` over HTTP; the
older `/v1/sse` entry is legacy. Bitbucket Cloud is supported under an API token
with the right scopes and the site linked to your organisation — but **local git
stays the primary interface to repositories**. The connector is for work items
and pages.

Reads are allowed once roles are confirmed. Jira, Confluence and Bitbucket
*writes* need `fde approve-publish`. Every Atlassian call is logged to the run's
`events.jsonl`.

## What's in the toolkit

**Skills** — core control and context (`/task-init`, `/engage`, `/repo-init`,
`/agents-sync`, `/client-context`, `/handover`, `/crosscheck`); product and
delivery (`/product-discovery`, `/jira-delivery`, `/scm-pr-review`); UI and
design (`/ui-prototype`, `/design-system`, `/design-to-code`); implementation
and quality (`/implementation`, `/tdd-evidence`, `/verification-evidence`,
`/quality-gates`, `/ci-diagnose`); operations and continuous improvement
(`/release-observability`, `/context-budget`, `/retrospective`,
`/harness-evaluation`, `/agent-config-audit`).

**Agents** — the original research, architecture and review agents plus focused
product, UI/UX, design-system, delivery, implementation, PR analysis, standards,
security, test, CI, release and SRE/observability specialists. The pinned
Anthropic code-simplifier refines recently changed code after implementation is
green. These are methods, not fixed account assignments: the user chooses the
identity for every role at the start of each run.

**Controller** — `fde doctor | start | roles | status | brief | checkpoint |
output-hygiene | learn | resume | invoke | approve-codex | approve-publish |
guard | log | list | projects | project | attach | attachments`

## Projects, attachments and machine-readable views

Three additions that a local operator console — or any other non-human reader —
can build on without parsing formatted text or writing run files itself.

**Projects** group runs. A project is a name, a description and a list of
existing repository paths; it holds no workflow state.

```bash
fde project create --name "Returns modernisation" --repo ~/code/returns-api
fde start "ACME-142 returns orchestration" --project returns-modernisation-a1b2
fde projects                       # names, repositories, run counts
fde project show <project-id>      # its repositories and its runs
fde delete <run-id> --confirm <run-id>       # move a complete run to recoverable trash
fde project delete <project-id> --confirm <project-id>  # only when no run/chat refers to it
```

Runs created before projects existed keep working and are listed as unassigned.
Repository paths must already exist: nothing here initialises, clones, modifies
or deletes a repository. Deleted run and project records are moved under the
corresponding `.trash` directory rather than erased permanently.

**Attachments** copy an input file into the run, hash it, and record it in an
append-only ledger.

```bash
fde attach <run-id> ./requirements.pdf
fde attach <run-id> --stdin --name requirements.pdf < requirements.pdf
fde attachments <run-id>
```

The source file is copied, never moved or modified. Symlinks, directories and
devices are refused; the stored name is generated, so a supplied filename can
never become a path. Files land in `<run-dir>/inputs/files/` with a SHA-256 in
`<run-dir>/inputs/attachments.jsonl`, and each one appends `attachment.added` to
the run log.

**JSON views** give a stable contract:

```bash
fde list --json
fde status <run-id> --json --events-limit 50
fde projects --json
fde project show <project-id> --json
fde attachments <run-id> --json
```

Each payload carries `schemaVersion`, writes only JSON to stdout, keeps
diagnostics on stderr, contains no secret values and exits nonzero for an
unknown run or project. Events are paginated rather than dumped. Human output is
unchanged. The full shapes are in
[`docs/FDE-CONTROLLER-CONTRACTS.md`](docs/FDE-CONTROLLER-CONTRACTS.md).

## Automatic model and effort selection

`fde start --routing auto --orchestrator <who>` lets the controller choose the
orchestrator's model and effort and propose the specialist matrix, instead of you
picking them. You still choose the account. The choice is deterministic and
explainable — no model is asked for a score — and it optimises in one order:
meet the capability, safety and quality requirements first; then minimise
*expected* cost, which is cost times the chance the attempt has to be repeated,
so an underpowered attempt on hard work is correctly priced as the expensive
option; then minimise latency and agent count.

Nothing it decides authorises anything. `APPROVE PLAN <run-id>` approves the
plan, the roles and the route together and freezes the exact route you saw;
after that every invocation is checked against it. `fde routing preview`,
`show`, `explain` and `override` are the rest of the surface, and
`~/.claude-shared/config/routing-policy.json` holds the tiers, relative cost
weights, quality floors and ceilings — yours to edit, and preserved across
updates. Costs are relative cost units, never money.

Retries are bounded and have to be earned: a failure needs a classification
before the budget is spent again, one of them buys a same-tier retry and the rest
climb a frozen ladder, and the approved retry count, tier, effort and cost units
are all hard stops rather than guidance. Every attempt keeps its own artifact, so
the cheap attempt that failed is still there as the reason the expensive one was
allowed. Usage is recorded with its provenance — reported by a provider,
estimated by the controller, or unavailable — and never as a zero standing in for
a measurement nobody made.

`fde routing report` reads all of it back and produces calibration
recommendations for a person. It changes no policy, and nothing reads it back as
configuration.

The console offers the same thing on **New run**: automatic model and effort as
the recommended mode, a debounced preview showing the complexity band, the model,
the estimated cost and an expandable "Why this choice?", and an execution matrix
on the run itself that keeps account identity, specialist method, model and
effort as four separate columns. Nothing in the console approves anything.

Manual selection is still the default and still works exactly as before, as do
runs created before any of this existed. See
[docs/FDE-CONTROLLER-CONTRACTS.md](docs/FDE-CONTROLLER-CONTRACTS.md#routing).

## Design panels

One design brief, two or three Claude accounts, the same sealed context, one
reconciled recommendation.

```bash
fde start --json -o work --project <project-id> --shape design-panel -- "Rework returns"
fde design-panel create <run-id> --brief-file brief.md --propose-plan \
    --participant work:flow --participant msc:visual:high --participant alt:system
fde approve-plan <run-id>              # still typed by you
fde design-panel start <run-id> claude_work --print-prompt
```

It is a normal run in a named shape, not a second orchestration system:
`uiUxDesign` may simply be held by several identities. The controller builds the
shared context **once**, writes it and its manifest into the run, and gives every
participant those exact bytes with only a distinct lens block appended — so "they
all got the same context" is a SHA-256 you can check, not a promise. Until
reconciliation, no participant's prompt may contain another's proposal.

Concept generation writes nothing but the run: participants run with all tools
disabled, and implementation stays a separate stage behind its own approval.
Reconciliation needs two proposals, or an explicitly typed degraded approval, and
produces a comparison, a reconciliation with accepted and rejected ideas, and a
final design under `artifacts/design-panel/`.

Optional, off by default, and pinned to reviewed commits: a catalog of
design-language references and two guidance packs (Taste, Impeccable). Their
provenance, licences and the audit behind them are in
[`docs/FDE-DESIGN-SOURCES.md`](docs/FDE-DESIGN-SOURCES.md); how to run a panel is
in [`docs/FDE-DESIGN-PANEL.md`](docs/FDE-DESIGN-PANEL.md).

## The FLOW console

`fde-gui/` is a local operator console over this controller: projects, runs,
plans, roles, approvals, checkpoints, events, attachments, artifacts and
output-hygiene evidence, in a browser on this machine only.

```bash
cd fde-gui && npm install && npm start
# then open the http://127.0.0.1:7317/#token=... link it prints
```

It reads runs through `fde … --json`, and can create a project, edit one, create
a run, attach a file and drive a design panel — each one a controller command,
not a write of its own.
It can resume a Claude-led run in an embedded terminal — exactly
`fde-start --resume <run-id>`, one process per run — and a Codex-led run is
labelled honestly rather than given a resume button that could not work.
Approving is still yours: roles, plan approval, Codex writes, deployment and
publication all happen in that conversation, typed by you.
Details, environment variables and the deliberate deviations are in
[`fde-gui/README.md`](fde-gui/README.md); the security boundaries are in
[`docs/FDE-GUI-THREAT-MODEL.md`](docs/FDE-GUI-THREAT-MODEL.md).

### Configuration

The console's **Configuration** page keeps two deliberately separate kinds of
access. **AI accounts** are identities that may be assigned roles in a run;
Claude and Codex use isolated profile directories, Gemini uses Antigravity's
single machine Keychain sign-in, and Copilot Studio uses a separately stored
Direct Line credential. **Service connections** are Atlassian REST, Atlassian
Rovo MCP, GitHub, Bitbucket and Figma access. They never become role identities and configuring
one never authorises an external write.

**Capabilities** is the inventory of the agent harness itself. It lists every
installed plugin, skill, sub-agent, MCP server, declared tool, command, hook and
runtime utility, with its built-in or user-owned origin. From the same tab a
user can create a skill in the separately managed `fde-user` plugin, or import
a local plugin that contains `.claude-plugin/plugin.json`. Imports are bounded,
reject symbolic links and never overwrite an existing plugin. Refresh or
install the resulting marketplace plugin in each AI account that should use it;
sessions already running retain the capabilities they started with.

Each configurable capability has an on/off switch. States are stored in the
local capability policy and apply to new FDE processes. MCP changes still pass
through the MCP controller, tool changes become explicit CLI deny rules, and
hook changes update the local hook manifest. `fde-core` itself is protected
because disabling the control-plane plugin would make the configuration screen
an unreliable description of the system it controls.

Atlassian, GitHub and Bitbucket tokens are submitted once and stored in
`~/.claude-shared/secrets/service-connections/` with owner-only directory and
file permissions. This avoids an interactive Keychain password prompt; the
browser and metadata registry never receive them back. Figma uses the official remote MCP endpoint
`https://mcp.figma.com/mcp`; its OAuth credential remains owned by the MCP
client. Figma is wired only after roles are confirmed, and canvas writes require
`fde approve-publish <run-id> figma`, like every other publication target.

General chats have no service access by default. The New chat screen lets the
user grant read-only access to specific configured connections. For REST
connections, FDE resolves only matching Jira, Confluence, GitHub or Bitbucket
links included in the message, then gives the result—not the credential—to the
selected Claude, Codex or Gemini account. Atlassian REST tokens and Rovo OAuth
are separate connections: the former enables this bounded link reader; the
latter remains owned by each MCP-capable client.

## Caveats

- **WebSearch is unavailable on Bedrock.** For research-heavy work use a
  subscription profile, or give the research role to Gemini as well. The session
  banner reminds you which provider you are on.
- Model aliases resolve differently on Bedrock; pin versions via
  `/setup-bedrock` rather than assuming `opus`/`sonnet` mean the same in both.
- Gemini CLI cannot run as an MCP server. Codex can (`codex mcp-server`) but it
  is deprecated in favour of `codex app-server`. Headless invocation is the
  stable path.
- Each `ask-*` call is a cold context with no memory of your Claude session, so
  the question must carry its own context inline.
- Anthropic's consumer subscriptions are per-person. These profiles keep your own
  accounts' contexts separate — they are not a way to pool capacity.
- A run directory holds client material and an approval ledger. It is gitignored
  and belongs to the machine, not to the repository.
