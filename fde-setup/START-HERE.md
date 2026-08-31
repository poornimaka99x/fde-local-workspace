# Start here

Everything below is copy-paste. About 30 minutes to a first completed run.

`RUNBOOK.md` is the long version — go there for the parts that need your admin
(Copilot Studio licensing, Bitbucket scopes). This file is what you do today.

**The one idea to hold on to:** the toolkit no longer decides anything for you.
It asks who does what before it reads anything, and it asks again before Codex
writes or before anything reaches Jira. If a command refuses, that is the design
working — jump to *When something is refused* at the bottom.

---

## 1. Install (5 min)

```bash
cd ~/Library/CloudStorage/OneDrive-MaxedaDIYGroup/Maxeda/FDE-Agent/fde-setup
./install.sh --update --dry-run     # look first — nothing is written
./install.sh --update
exec $SHELL -l
```

This folder is now the canonical source. The `~/Downloads/fde-setup` copy is
stale; delete it or you will edit the wrong one in three weeks.

`--update` never deletes, shows you a diff before replacing anything you have
customised, and backs up what it replaces into `~/.claude-shared/.backups/`.
Your client contexts, intake files, run history, logins and profile settings are
not touched.

## 2. The one thing that will bite you (2 min)

The installer used to copy `claude-shared/.env.sh` — the file with your real
Atlassian token — into `~/.claude-shared/`. It no longer does, because a secret
should not travel in a synced folder. But your shell only ever sourced
`~/.claude-shared/env.sh`, so check that the live one actually has your token:

```bash
grep CONFLUENCE_API_TOKEN ~/.claude-shared/env.sh
```

Empty? Put it in and re-source:

```bash
open -e ~/.claude-shared/env.sh        # CONFLUENCE_BASE_URL, EMAIL, API_TOKEN
source ~/.claude-shared/env.sh
confluence spaces                      # should list your spaces
```

Your site is `https://maxedadiy.atlassian.net`, your email
`Poornima.Kahatapitiya@diymaxeda.com`.

While you are in there: that token has been sitting in plaintext in a
OneDrive-synced folder. Rotating it at
id.atlassian.com → Security → API tokens takes two minutes and I would do it.

## 3. Check what you have (2 min)

```bash
fde doctor
```

Read it as three groups:

- **`BROKEN*`** — blocks you. Fix before going further.
- **`--`** — advisory. Gemini and Codex missing is fine if you are not assigning
  them roles yet. Copilot Studio unconfigured is fine — that is RUNBOOK Phase 5
  and it needs your admin.
- **`ok`** — done.

`Claude Bedrock` should read `bedrock-dev / eu-west-1`. If it says
`expected bedrock-dev` or `expected eu-west-1`, your bedrock profile predates
this change:

```bash
open -e ~/.claude-profiles/bedrock/settings.json
```

and make sure it contains:

```json
"env": { "AWS_PROFILE": "bedrock-dev", "AWS_REGION": "eu-west-1" }
```

That file is now the *only* place those values live. `cc-bedrock` sets nothing
but the provider flag, so nothing can override it any more.

Want the two extra CLIs?

```bash
npm i -g @openai/codex @google/gemini-cli
```

## 4. Your first run (10 min)

You do not drive this with commands. You start a Claude session, say what you
want in a sentence, and answer four questions.

```bash
cc-bedrock      # or cc-work / cc-msc / cc-alt — any identity can scope a run
```

```
/engage MAX-142 same-day refunds — research it, get it validated, and give me slides
```

`/engage` creates the run and asks you, in order:

1. **Who orchestrates?** `work`, `msc`, `alt`, `bedrock` or `codex`. Gemini and
   Microsoft Copilot cannot — Gemini is a one-shot headless call with no session
   state, Copilot is a chat endpoint — but either can still research or review.
2. **Is this the ask?** It reads your sentence back before acting on it.
3. **Is this the plan?** It proposes the stages your sentence implies and shows
   what it is *not* doing. Most work is a slice, not all ten stages.
4. **Who does the rest?** Narrowed to the roles this plan needs — a research-only
   run never asks you for an implementation agent.

Answer in plain English. It runs the `fde` calls behind each answer and holds the
record; you never type `fde plan` or `fde roles` yourself.

Nothing has been read at this point. Not Jira, not your client file, nothing.
That is deliberate, and it is why the session then hands you over.

### The handover

Once roles are confirmed, `/engage` wires up the Atlassian connector for the
orchestrator you chose and gives you the line that starts the actual run:

```bash
CLAUDE_CONFIG_DIR=~/.claude-profiles/bedrock \
  claude --mcp-config ~/.claude-shared/runs/<run-id>/mcp/claude-bedrock.mcp.json
```

```
/engage <run-id>
```

**The restart is the design, not a rough edge.** The Atlassian connector is in
nobody's global config, so it does not exist for any identity until you have said
who holds which role in this run. A process that *cannot* reach Jira is a stronger
promise than an agent that has been told not to.

From there it works the stages you agreed to, and it will **stop and ask you** if
research turns up a gap that would change the design. That is it working, not
failing.

### Watching and steering it

Ask in the session — "where is this?", "what's next?", "park it, I need to check
with the PO" — and it runs the right command. The CLI is there for when you want
to look from outside, or from another terminal:

```bash
fde status <run-id>            # plan, roles, artifacts, approvals, next step
fde list                       # all runs
fde shapes                     # the named plan shapes
```

Named shapes are a shortcut when you already know the slice you want:

```
research          intake → research
research-to-adr   intake → research → solution architecture → review → reconciliation
review-only       intake → adversarial review
presentation      intake → presentation
delivery-plan     intake → development plan
build             intake → implementation → verification
full              all ten stages
```

Say "use the presentation and delivery-plan shapes" and it will — or skip the
questions entirely:

```bash
fde start -o bedrock "MAX-88" --shape presentation+delivery-plan
```

`fde` warns if you skip a stage's usual input — a deck with no research behind it,
say. Advisory, not a block; sometimes the input is in your head.

**Start a second task and all four questions come again.** Nothing is inherited.
Only you saying "same roles as <run-id>" reuses an assignment.

## 5. When you want Codex to write code (5 min)

This is one of only two places you type rather than talk, and that is the point.
Giving Codex the implementation role authorises nothing on its own. The write is
a separate, deliberate step, and the approval string is not something an agent can
hear you say by accident:

```bash
fde approve-codex <run-id> implementation \
  --task-file ~/.claude-shared/runs/<run-id>/artifacts/implementation/implementation-task.md \
  --repo ~/work/maxeda-returns \
  --commands "pytest -q"
```

You get shown the repo, the branch, the writable root, the SHA-256 of the task
file, whether network was asked for, and what it may run. **Read it, then type:**

```
APPROVE CODEX <run-id>
```

Then:

```bash
fde invoke <run-id> chatgpt_codex \
  ~/.claude-shared/runs/<run-id>/artifacts/implementation/implementation-task.md --write
```

One use, 30 minutes, bound to those exact bytes. Edit the task file and the
approval is refused rather than stretched — approve the new one. Codex runs
bounded to that repo with network off, and there is no bypass flag in this
toolkit.

## 6. When you want it in Jira or Confluence (3 min)

The other typed approval. `jira-plan.json` is a **preview** — a plan existing is
not a reason to create anything.

```bash
fde approve-publish <run-id> jira --summary "8 stories under MAX-142"
# type: APPROVE PUBLISH <run-id>

confluence create ENG "ADR 004: Token exchange" \
  ~/.claude-shared/runs/<run-id>/artifacts/architecture/adr.md --parent 123456
```

One target, one approval. Approving Jira says nothing about Confluence.

---

## Cheat sheet

Most of this `/engage` runs for you. It is listed so you can look from outside —
and for the two approvals, which are always yours to type.

```bash
/engage "<what you want>"            start a run — the four questions, in chat
/engage <run-id>                    pick an existing run back up
APPROVE CODEX <run-id>              yours to type; never inferred
APPROVE PUBLISH <run-id>            yours to type; never inferred

fde doctor                          what's configured, what's broken
fde status <run-id>                 plan, roles, artifacts, approvals, next
fde list                            all runs
fde shapes                          the named plan shapes
mcp-sync --run <run-id>             wire the connector once roles are confirmed

                                    /engage runs these for you; here for reference
fde start                           new run; stops to ask who orchestrates
fde orchestrator <run-id> <who>     the first decision
fde request <run-id> "..."          the ask, in your own words
fde plan <run-id> --stages a,b,c    what this run will actually do
fde plan <run-id> --add solutioning widen it later (forwards only)
fde roles <run-id> --set r=identity the rest; asked fresh every run
fde resume <run-id> --next          advance to whatever the plan says is next
fde resume <run-id> --block "..."   park it with a reason
fde resume <run-id> --unblock       back to where it was

cc-work  cc-msc  cc-alt  cc-bedrock    the four identities
cc-which                               which one is active

ask-gemini "..."                    research, long context, web
ask-codex --read-only "..."         second opinion, cannot write
ask-ms-copilot "..."                SharePoint, Outlook, Teams
ms-intake - --title "..."           paste a Notebook/recap in by hand
mcp-sync                            regenerate MCP config from one file
```

Everything for a run lives in `~/.claude-shared/runs/<run-id>/` — the artifacts,
the approval ledger (`approvals.jsonl`) and the full log (`events.jsonl`). That
directory is gitignored and belongs to this machine.

## When something is refused

| What you see | What it means | What to do |
|---|---|---|
| `has no orchestrator yet` | the first decision hasn't been made | `fde orchestrator <run-id> <who>` |
| `cannot orchestrate` | Gemini and MS Copilot can't hold a run together | pick a Claude profile or Codex |
| `has no stated ask yet` | you planned before saying what you want | `fde request <run-id> "..."` |
| `no confirmed plan` | the run hasn't been scoped | `fde plan <run-id> --stages ...` |
| `roles are not confirmed` | you tried to read or run something before assigning roles | `fde roles <run-id>` |
| `not a role this run needs` | that role isn't in the plan | `fde plan <run-id> --add <stage>` first |
| `not in this run's plan` | that stage isn't in scope | widen the plan, or don't do it |
| `already been passed` | you can widen a plan forwards, not backwards | new run for that work |
| `holds no role in run` | that identity was not assigned anything here | assign it, or use one that was |
| `does not cover the 'X' stage` | assigned, but to a different role | check `fde status <run-id>` |
| `Choose a replacement` | you assigned something not installed on this Mac | install it, pick another, or `--allow-unavailable` if you'll fix it before that stage |
| `no Codex write approval on record` | the role is not the approval | `fde approve-codex ...` |
| `task file changed since approval` | you edited the task after approving | approve the new one; never widen the old |
| `approval consumed` / `expired` | one use, 30 minutes | approve again |
| `illegal transition` | you skipped a stage | `fde status <run-id>` shows the next legal one |
| `GitHub Copilot is not part of this FDE ecosystem` | you called `ask-copilot` | use `ask-ms-copilot` — "Copilot" here always means Microsoft 365 |

## Still needs someone else

- **Copilot Studio** (`ask-ms-copilot`) — needs a licence and a published agent.
  RUNBOOK Phase 5. The secret goes in the Keychain, not `env.sh`:
  `security add-generic-password -a "$USER" -s fde-copilot-directline -w`
- **Bitbucket via the Atlassian connector** — depends on token scopes and whether
  the site is linked to your org. Ask your admin. Local git works regardless, and
  is still the right way to touch repositories.
- **`/client-context maxeda`** — RUNBOOK Phase 3. Do not skip it. It is why agent
  output either sounds like Maxeda or sounds like nobody.

## Checking it still works

```bash
cd ~/Library/CloudStorage/OneDrive-MaxedaDIYGroup/Maxeda/FDE-Agent/fde-setup
python3 -m unittest discover -s tests
fde doctor
```

60 tests, all against a temporary home and a stub Codex — they never touch your
real config.
