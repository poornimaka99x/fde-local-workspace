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

```bash
fde start MAX-142
```

It prints a run id and the role question, and stops. **Nothing has been read** —
no Jira, no Confluence, no SharePoint, no repo, no client context. That is the
point of the stop.

Assign the roles. Use the identity ids on the left:

| id | who |
|---|---|
| `claude_work` | Claude: work |
| `claude_msc` | Claude: msc |
| `claude_alt` | Claude: alt |
| `claude_bedrock` | Claude Code: Bedrock |
| `chatgpt_codex` | ChatGPT/Codex |
| `gemini` | Gemini |
| `microsoft_copilot` | Microsoft Copilot |

A sensible first shape — orchestrate on Bedrock because that is the Maxeda
account, research on a subscription profile because **Bedrock has no WebSearch**:

```bash
fde roles <run-id> \
  --set orchestrator=claude_bedrock \
  --set research=claude_work \
  --set solutioning=claude_work \
  --set review=claude_msc \
  --set deliveryPlanning=claude_bedrock \
  --set presentation=claude_work \
  --set implementation=none \
  --set microsoftContext=none
```

`none` is a real answer. Leave implementation off until you actually want code
written. Add `gemini` or `chatgpt_codex` once they are installed —
`--set research=claude_work,gemini` gives you two researchers.

If you would rather be asked question by question, run `fde roles <run-id>` with
no flags in a terminal.

Then run the pipeline. Start the orchestrator's session **with the run-scoped
Atlassian config** — that connector is deliberately not in anyone's global
config, so this is how it gets wired to the identity you chose:

```bash
CLAUDE_CONFIG_DIR=~/.claude-profiles/bedrock \
  claude --mcp-config ~/.claude-shared/runs/<run-id>/mcp/claude-bedrock.mcp.json
```

Inside that session:

```
/engage MAX-142
```

From another terminal, watch it:

```bash
fde status <run-id>       # state, artifacts, approvals, what's next
fde list                  # all runs
```

`/engage` will **stop and ask you** if research finds a gap that would change the
design. That is it working, not failing.

**Start a second task and it asks for roles again.** It will not reuse these.
Only you typing `--same-as <run-id>` makes that happen.

## 5. When you want Codex to write code (5 min)

Giving Codex the implementation role authorises nothing on its own. The write is
a separate, deliberate step:

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

`jira-plan.json` is a **preview**. A plan existing is not a reason to create
anything.

```bash
fde approve-publish <run-id> jira --summary "8 stories under MAX-142"
# type: APPROVE PUBLISH <run-id>

confluence create ENG "ADR 004: Token exchange" \
  ~/.claude-shared/runs/<run-id>/artifacts/architecture/adr.md --parent 123456
```

One target, one approval. Approving Jira says nothing about Confluence.

---

## Cheat sheet

```bash
fde doctor                          what's configured, what's broken
fde start <key-or-description>      new run; stops for roles
fde roles <run-id> --set r=identity assign; asked fresh every run
fde status <run-id>                 state, artifacts, approvals, next step
fde resume <run-id>                 where am I, what now
fde resume <run-id> --block "..."   park it with a reason
fde resume <run-id> --unblock       back to where it was
fde list                            all runs

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
| `roles are not confirmed` | you tried to read or run something before assigning roles | `fde roles <run-id>` |
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
