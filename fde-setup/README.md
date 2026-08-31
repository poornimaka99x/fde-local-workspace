# FDE Claude Code setup

One Claude Code installation, several identities, many repositories — without
copying config into every repo, without one account's settings leaking into
another's, and without any agent deciding for itself what it is allowed to do.

**New here, or coming back after the re-architecture? Read
[START-HERE.md](START-HERE.md)** — copy-paste, about 30 minutes to a first
completed run. `RUNBOOK.md` is the phased setup detail; this file is the design.

Canonical source: the private repository this directory came from. Clone it,
run `./install.sh`, and `./install.sh --update` when it changes.

## The idea in two sentences

**Identities are not roles.** "Claude: work", "ChatGPT/Codex", "Gemini" and
"Microsoft Copilot" are who is in the room; who researches, who architects, who
reviews and who implements is decided by *you*, at the start of every run, and
is never inherited from the last one.

**Nothing crosses a boundary without you.** Nothing is read until roles are
confirmed; Codex writes only under a one-time approval bound to the exact bytes
of one task file; and anything that leaves this machine — Jira, Confluence,
SharePoint, Bitbucket, email, Teams — needs its own publication approval.

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
cc-bedrock                  Maxeda on Bedrock
cc-which                    what exists, what's active
fde doctor                  what is configured, what is broken
```

**Bedrock has one source of truth:** `~/.claude-profiles/bedrock/settings.json`,
carrying `AWS_PROFILE=bedrock-dev` and `AWS_REGION=eu-west-1`. The `cc-bedrock`
wrapper sets the provider flag and nothing else. It used to export AWS variables
from the shell, which silently overrode the profile with an AWS profile that did
not exist — that is why the wrapper is now three lines.

## Running a piece of work

Four questions, in order, none of which reads anything:

```bash
fde start                                    # 1. who orchestrates?
fde orchestrator <run-id> bedrock            #    work | msc | alt | bedrock | codex
fde request <run-id> "MAX-142 — research it, validate it, give me slides"
fde plan <run-id> --stages intake,research,review,presentation   # 2. what does that mean?
fde roles <run-id> --set research=work --set review=codex \
                   --set presentation=work --set microsoftContext=none
```

**The orchestrator comes first** because it is the identity that reads your
sentence and proposes what the run should do. Any Claude profile or Codex can
hold it; Gemini and Microsoft Copilot cannot — Gemini is a one-shot headless call
with no session state and Copilot is a chat endpoint over the Microsoft estate,
so neither can hold a run together. Both can still research or review.

**A run is a slice of the pipeline, not all of it.** "Research this and get it
validated" is a real ask; so is "slides and a Jira breakdown". The plan decides
which of the ten stages this run does, and everything downstream follows it —
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
full              all ten stages
```

Skipping a stage's usual input warns rather than blocks — sometimes the input is
in your head or in a Confluence page. Widening a plan later works forwards
(`fde plan <run-id> --add solutioning`); going backwards is a new run.

Approval gates are not stages you can plan around. If `implementation` is in the
plan, `awaiting_implementation_approval` precedes it and the run will not enter
implementation without the approval that gate exists for. Same for publication.

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
`publication-manifest.json`.

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
`mcp-sync --run <run-id>` — which `fde roles` calls for you. Atlassian is
role-scoped for exactly this reason: there is no permanently privileged
orchestrator account, because there is no permanent orchestrator.

Merging is real. Servers this tool manages are listed in `_fdeManaged`, so a
server you added by hand survives an update, and one that is no longer targeted
is removed rather than left behind.

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
`--sandbox workspace-write --ask-for-approval never` — `never` is safe *only*
because the exact invocation was already approved, the filesystem is bounded to
the approved root and network is off. There is no `--yolo` and no
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

The Rovo MCP endpoint is `https://mcp.atlassian.com/v1/mcp/authv2` over HTTP; the
older `/v1/sse` entry is legacy. Bitbucket Cloud is supported under an API token
with the right scopes and the site linked to your organisation — but **local git
stays the primary interface to repositories**. The connector is for work items
and pages.

Reads are allowed once roles are confirmed. Jira, Confluence and Bitbucket
*writes* need `fde approve-publish`. Every Atlassian call is logged to the run's
`events.jsonl`.

## What's in the toolkit

**Skills** — `/engage` (the pipeline), `/repo-init`, `/agents-sync`,
`/crosscheck`, `/client-context`, `/handover`, `/standards`

**Agents** — `repo-cartographer`, `standards-reviewer`, `integration-scout`,
`researcher`, `solutioner`, `reviewer`

**Controller** — `fde doctor | start | roles | status | resume | invoke |
approve-codex | approve-publish | guard | log | list`

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
