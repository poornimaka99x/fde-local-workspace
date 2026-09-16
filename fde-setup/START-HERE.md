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
cd ~/Library/CloudStorage/OneDrive-AcmeDIYGroup/Acme/FDE-Agent/fde-local-workspace/fde-setup
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

The installer deliberately does **not** copy any `.env.sh` out of this
repository: a secret should never travel with the source, and never into a
cloud-synced folder. Your shell sources `~/.claude-shared/env.sh`, which you
create once, by hand, from the template:

```bash
cp claude-shared/env.sh.example ~/.claude-shared/env.sh
chmod 600 ~/.claude-shared/env.sh
open -e ~/.claude-shared/env.sh        # CONFLUENCE_BASE_URL, EMAIL, API_TOKEN
source ~/.claude-shared/env.sh
confluence spaces                      # should list your spaces
```

Get an Atlassian API token at id.atlassian.com → Security → API tokens. Set
`CONFLUENCE_BASE_URL` to your own site (`https://your-site.atlassian.net`) and
`CONFLUENCE_EMAIL` to the account that token belongs to.

`~/.claude-shared/env.sh` is the only place a live credential belongs. It is
gitignored here, it is never read into an agent prompt, and `fde doctor` will
warn you if its permissions are looser than `600`.

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

You do not drive this with controller commands. Start the orchestrator launcher,
choose the Claude identity, give it the request in a sentence, and make the
decisions in chat.

```bash
fde-start                         # choose work, msc, alt or bedrock
# or: fde-start --orchestrator bedrock
```

The orchestrator asks for the request, then:

1. **Is this the ask?** It reads your sentence back before acting on it.
2. **Is this the plan?** It proposes the stages your sentence implies and shows
   what it is *not* doing. Most work is a slice, not the full lifecycle.
3. **Who should do each job?** It shows the required specialist roles, why each
   is needed and every eligible account identity. A research-only run never asks
   you for an implementation agent. Accounts have no fixed roles.
4. **Do you approve the combined result?** It shows one summary of the request,
   plan, deliverables, assignments, access and remaining hard gates. Type the
   exact phrase `APPROVE PLAN <run-id>` only when it is correct.

Answer in plain English. It runs the `fde` calls behind each answer and holds the
record; you never type `fde plan` or `fde roles` yourself.

Nothing has been read at this point. Not Jira, not your client file, nothing.
That is deliberate, and it is why the session then hands you over.

### The handover

After approval the orchestrator asks you to type `/exit`. Do that once.
`fde-start` then resumes the same conversation automatically, this time with the
run-scoped connectors. The Atlassian connector is in nobody's global config, so
it cannot be used during scoping and appears only after combined approval.

From there it works the stages you agreed to, and it will **stop and ask you** if
anything material is ambiguous. Within clear approved scope it uses the normal
configured tool surface without asking for each routine operation. Codex coding,
deployment, publication, destructive actions and scope expansion still require
their specific approvals.

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
pr-review         intake → review → verification
design-to-build   intake → solution architecture/design → presentation → planning → implementation → verification
design-panel      intake → solution architecture → adversarial review → reconciliation → presentation
release           verification → deployment → observability
operate           intake → observability
full              all twelve stages
```

Say "use the presentation and delivery-plan shapes" in the orchestrator chat.
It still shows the resulting plan and roles for approval; a named shape is a
planning shortcut, not an approval shortcut.

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
  --repo ~/work/client-returns \
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
fde approve-publish <run-id> jira --summary "8 stories under ACME-142"
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
fde-start                           start a run and orchestrator chat
fde-start -o bedrock                choose the orchestrator directly
fde-start --resume <run-id>         resume an unfinished launcher session
APPROVE PLAN <run-id>               approve the combined plan and role selection
APPROVE CODEX <run-id>              yours to type; never inferred
APPROVE PUBLISH <run-id>            yours to type; never inferred

fde doctor                          what's configured, what's broken
fde status <run-id>                 plan, roles, artifacts, approvals, next
fde list                            all runs
fde list --json                     the same, for a program to read

fde project create --name "..."     group runs under a project
fde projects                        projects, repositories, run counts
fde project show <project-id>       its repositories and its runs
fde start "..." --project <id>      a run inside that project
fde attach <run-id> <file>          copy an input in, hashed and recorded
fde attachments <run-id>            what has been attached

                                    a design panel: same context, several accounts
fde design-panel create <run-id> --brief-file b.md --propose-plan \
    --participant work:flow --participant msc:visual --participant alt:system
fde design-panel show <run-id>      participants, digests, next step
fde design-panel start <run-id> claude_work --print-prompt
fde design-panel reconcile <run-id> once two proposals are in
APPROVE DEGRADED RECONCILIATION <run-id>   yours to type, when only one is
fde shapes                          the named plan shapes
mcp-sync --run <run-id>             wire the connector once roles are confirmed

                                    /engage runs these for you; here for reference
fde start                           new run; stops to ask who orchestrates
fde orchestrator <run-id> <who>     the first decision
fde request <run-id> "..."          the ask, in your own words
fde plan <run-id> --stages a,b,c    what this run will actually do
fde plan <run-id> --preview ...     calculate without changing run state
fde plan <run-id> --require-approval record a chat-proposed plan
fde plan <run-id> --add solutioning widen it later (forwards only)
fde roles <run-id> --set r=identity the rest; asked fresh every run
fde approve-plan <run-id>           exact combined approval gate
fde output-hygiene <run-id> --check preview safe final-artifact cleanup
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
mcp-sync --dry-run                  show changes; write and download nothing

                                    the governed MCP catalogue
fde mcp list                        every server, with its lifecycle state
fde mcp status <server>             one server, in detail
fde mcp configure <s> --set k=v     its non-secret settings
fde mcp set-secret <s> <field>      reads stdin, echoes nothing
fde mcp verify <server>             bounded initialize + tool listing
fde mcp effective --run <run-id>    what this run may actually reach
fde mcp gateway                     Docker routing preview; changes nothing
fde routing models --refresh        refresh the exact models auto-plan may select
```

An entry in that catalogue is not access. A server has to be **configured** (you
supplied what it needs), **ready** (installed and verified) and then **active**
(this run's approved stages, roles and profile call for it) before anything can
reach it — and `fde mcp effective --run <id>` will tell you which of those is
missing. See `docs/MCP-GOVERNANCE.md`.

Everything for a run lives in `~/.claude-shared/runs/<run-id>/` — the artifacts,
the approval ledger (`approvals.jsonl`) and the full log (`events.jsonl`). That
directory is gitignored and belongs to this machine.

Before a run enters `publication` or `complete`, FDE automatically applies its
narrow output hygiene policy to files under `artifacts/` and records a hashed report under
`artifacts/evidence/`. It removes unsafe invisible Unicode, local home-directory
prefixes and selected personal/path-like Office properties. It does not remove
visible watermarks, creator/copyright/ownership fields or C2PA/content
credentials. Symlinks and unknown binary metadata are left untouched.

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
| `no such project` | the project id doesn't exist | `fde projects` |
| `Roles are not confirmed` on a panel | you tried to start a designer before the combined approval | assign the remaining roles, then `APPROVE PLAN <run-id>` |
| `Panel participants work the 'solutioning' stage` | the run has not reached it yet | `fde resume <run-id> --next` |
| `only 1 proposal succeeded` | one account failed or was stopped | retry it, or `fde design-panel approve-degraded <run-id>` |
| `no '## Comparison' section` | the reconciliation answer arrived in the wrong shape | reconcile again; nothing was written |
| `does not match design-sources.lock.json` | a vendored design source drifted | `vendor/bin/design-sources audit`, then `update` |
| `repository path does not exist` | a project repo path is wrong or not yet cloned | give an existing directory; FDE never clones one |
| `refusing to attach a symlink` | the file you pointed at is a link | attach the real file |
| `over the ... byte limit` | the attachment is above the 100 MiB ceiling, or a lower one you set | attach a smaller file; the ceiling only goes down |

## Still needs someone else

- **Copilot Studio** (`ask-ms-copilot`) — needs a licence and a published agent.
  RUNBOOK Phase 5. The secret goes in the Keychain, not `env.sh`:
  `security add-generic-password -a "$USER" -s fde-copilot-directline -w`
- **Bitbucket via the Atlassian connector** — depends on token scopes and whether
  the site is linked to your org. Ask your admin. Local git works regardless, and
  is still the right way to touch repositories.
- **`/client-context acme`** — RUNBOOK Phase 3. Do not skip it. It is why agent
  output either sounds like Acme or sounds like nobody.

## Checking it still works

```bash
cd ~/Library/CloudStorage/OneDrive-AcmeDIYGroup/Acme/FDE-Agent/fde-local-workspace/fde-setup
python3 -m unittest discover -s tests
fde doctor
```

The controller and harness suites run against temporary homes and a stub Codex;
they never touch your real configuration.
