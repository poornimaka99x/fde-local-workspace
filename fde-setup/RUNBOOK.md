# Configuration runbook

If you just want to get running, read [START-HERE.md](START-HERE.md) first — it
is the 30-minute path. This runbook is the detail behind it, including the phases
that need someone else's approval.

Work through in order. Each phase is usable before you start the next, so stop
anywhere and you still have something that works.

Time estimates assume nothing goes wrong, which it will.

---

## Phase 0 — install (15 min)

```bash
cd fde-setup            # the canonical clone
./install.sh work msc alt bedrock
exec $SHELL -l
cc-which
fde doctor
```

Sign in once per profile — `cc-work`, `cc-msc`, `cc-alt` open a browser flow.
For `cc-bedrock`, run it then `/setup-bedrock` inside it and follow the wizard.

**Check:** `cc-which` lists four profiles. `fde doctor` prints a status table and
exits 0. Anything marked `BROKEN*` is a required component and blocks the rest.

Re-running the installer later is safe: `./install.sh --update` never deletes,
shows a diff before replacing anything you have customised, backs up what it
replaces into `~/.claude-shared/.backups/<timestamp>/`, and leaves client
contexts, intake, run history, credentials and profile settings alone.
`--dry-run` shows exactly what it would do.

---

## Phase 1 — Bedrock, properly (10 min)

There is one source of truth: `~/.claude-profiles/bedrock/settings.json`.

```json
{ "env": { "AWS_PROFILE": "bedrock-dev", "AWS_REGION": "eu-west-1" } }
```

`cc-bedrock` sets `CLAUDE_CODE_USE_BEDROCK=1` and nothing else. If you need a
different account or region, change that file — not the shell, not `env.sh`.

```bash
aws configure list-profiles | grep bedrock-dev
fde doctor | grep -i bedrock
```

`fde doctor` fails if the profile settings and the wrapper disagree, if the AWS
profile is not configured, or if the region is unset. It prints no credentials.

**Check:** `cc-bedrock` starts and the session banner names Bedrock, eu-west-1.

---

## Phase 2 — Atlassian (30 min)

This is the highest-value connection: it is where your PO lives.

**2.1 API token** — id.atlassian.com → Security → Create API token. Put it in
`~/.claude-shared/env.sh` with your site URL and email, then
`source ~/.claude-shared/env.sh`. This is for the `confluence` CLI; the MCP
server authenticates separately over OAuth.

**2.2 Verify the REST path works:**

```bash
confluence spaces          # should list your spaces
confluence search "architecture"
```

If this fails, fix it before going further — a REST failure is a credentials
problem you can debug in minutes.

**2.3 The MCP server.** The endpoint is
`https://mcp.atlassian.com/v1/mcp/authv2` over HTTP. It is deliberately **not**
in anyone's global config: it is role-scoped, so it reaches whichever identity
you make orchestrator for a run, written by `mcp-sync --run <run-id>` when you
approve the combined plan and roles. There is no permanently privileged account
because there is no permanent orchestrator.

To use it, start the interactive workflow and approve its combined proposal:

```bash
fde-start --orchestrator bedrock
# give the request, select roles, type APPROVE PLAN <run-id>, then /exit
# the same conversation resumes with Atlassian available
```

Expect an OAuth consent screen; on a corporate site your admin may have to
approve the app.

**Bitbucket Cloud** *is* reachable under an API token with the right scopes and
the site linked to your organisation — check your own tenant. Even so, keep
local git as the primary interface to repositories; the connector is for work
items and pages.

Reads are fine once the combined proposal is approved. **Writes are not**: Jira,
Confluence and Bitbucket writes need `fde approve-publish <run-id> <target>`,
every time. Every Atlassian call is logged to the run's `events.jsonl`.

**Check:** in the orchestrator's session, ask it to find a Jira epic by key.

---

## Phase 3 — engagement context (20 min, do not skip)

```bash
cc-bedrock
/client-context maxeda
```

Fill in stakeholders (Erik, Berend), the decisions already made with dates, the
constraints, and **the vocabulary** — Maxeda's own nouns for their domain
objects. Every later stage inherits this file. Skipping it is why agent output
sounds generic.

Also decide and write down, in that file, the system of record per artefact:

| Artefact | Lives in |
|---|---|
| Business requirements, client-facing docs | SharePoint |
| Technical docs, ADRs, anything the PO reads | Confluence |
| Work breakdown | Jira |
| Code, repo docs | Bitbucket |

Ambiguity here is what makes agent output land in the wrong place.

Note that `/engage` will not read this file until you have assigned roles for the
run. That is deliberate.

---

## Phase 4 — Microsoft, the manual path (20 min)

Do this one first even though you want the automated path, because it works
today and needs nobody's approval.

```bash
# from a Copilot Notebook, a Teams recap, an Outlook thread — copy, then:
pbpaste | ms-intake - --title "Returns discovery call" --kind meeting
#  ...or a Word export from a Notebook:
ms-intake ~/Downloads/Notebook.docx --title "Returns policy review"
```

It files to `~/.claude-shared/intake/` with a provenance header, and the
researcher reads that directory. Add `--space ENG` to push to Confluence too.

`.docx` needs pandoc or python-docx:

```bash
brew install pandoc          # or: pip install python-docx --break-system-packages
fde doctor | grep -i docx
```

**Check:** run `ms-intake`, then ask a Claude session about the content without
pasting it again.

---

## Phase 5 — Microsoft Copilot, the automated path (a few days, mostly waiting)

Microsoft Copilot here means **Microsoft 365 Copilot / Copilot Studio**. GitHub
Copilot is not part of this ecosystem; `ask-copilot` is a stub that says so and
nothing here touches `~/.copilot`.

**5.1 Confirm you can.** You need a Copilot Studio licence and a Power Platform
environment you can publish in. Ask your admin two things: can you publish an
agent, and can an external client call it. Either answer being no stops this
phase; the manual path still works.

**5.2 Build the agent** in Copilot Studio. Keep it narrow — one agent over the
SharePoint sites and Graph content you actually need. A broad agent is harder to
get approved and worse at answering.

Point it at SharePoint sites as knowledge sources. **Teams meeting transcripts
are the hard case** — check what your tenant's licensing exposes before designing
around them; if it is difficult, that content comes in via `ms-intake`, which is
a perfectly good answer.

**5.3 Publish and enable a channel.** You will get either a Direct Line secret or
a token endpoint URL.

A Direct Line secret is a *service-side* credential — Microsoft's guidance is that
exposed clients get conversation-scoped tokens instead. An env file sourced from
your shell rc is readable by every process you run, which is exactly the shape
they warn about. So it goes in the Keychain:

```bash
security add-generic-password -a "$USER" -s fde-copilot-directline -w
# paste the secret at the prompt; it is not echoed and not in your shell history
```

If your tenant gives you a token endpoint instead, put that in `env.sh`:

```bash
export COPILOT_TOKEN_ENDPOINT="https://..."
```

**5.4 Test:**

```bash
ask-ms-copilot --check      # says where the credential came from, never what it is
ask-ms-copilot "which SharePoint documents describe the returns process?"
```

Empty response usually means the agent is not published, or the channel is not
enabled — not that the script is wrong.

**Check:** the researcher answers Microsoft-estate questions without you pasting
anything.

---

## Phase 5b — projects and input attachments (5 min, optional)

Runs stand on their own. A project is only a grouping — a name, a description and
the repositories the work concerns — for when one engagement produces many runs.

```bash
fde project create --name "Returns modernisation" \
  --description "Store and web returns" \
  --repo ~/code/returns-api --repo ~/code/returns-web
fde projects
fde start "MAX-142 returns orchestration" --project returns-modernisation-a1b2
```

The repository paths must already exist. FDE reads about them; it does not
clone, initialise, modify or delete a repository, and there is no project
deletion. Runs made before you had projects keep working and show as unassigned.

Give a run its input documents the same way you give it the ask:

```bash
fde attach <run-id> ~/Downloads/requirements.pdf
fde attachments <run-id>
```

The file is copied into `<run-dir>/inputs/files/` under a generated name, hashed,
and recorded in `inputs/attachments.jsonl` with an `attachment.added` line in the
run log. The original is not moved or changed. Symlinks, directories and devices
are refused.

Every one of these commands takes `--json` for a program reading the run —
`docs/FDE-CONTROLLER-CONTRACTS.md` has the shapes and the exit codes.

## Phase 6 — run the pipeline (15 min)

```bash
fde-start
# or: fde-start --orchestrator bedrock
```

Choose the orchestrator, then state the request in the chat. It proposes the
smallest suitable plan and the specialist roles it needs. Select an account
identity for every required role; identities have no fixed role between runs.
The orchestrator shows one combined summary. Type
`APPROVE PLAN <run-id>` exactly to approve the plan and assignments together.
Before that approval it must not read Jira, Confluence, SharePoint, a repository
or client context.

When the orchestrator asks, type `/exit`. The launcher resumes the same Claude
session with the generated run-scoped MCP configuration. It then uses its normal
configured tools autonomously inside the approved plan and asks you whenever
intent, scope, target, authority, destructive effect or acceptance criteria are
ambiguous. The separate Codex-write, deployment, publication, destructive and
scope-expansion gates remain in force.

The plan decides everything downstream: the role question only asks for roles the
plan needs, `fde status` shows only the artifacts in scope, and `fde invoke`
refuses a stage that is not in it. `fde shapes` lists the common shapes. The
controller commands remain available for automation and troubleshooting, but
`fde-start` is the normal interactive entry point.

It will **stop and ask you** if the researcher finds a gap that would change the
design. That is the pipeline working, not failing.

Track it with `fde status <run-id>`, advance it with `fde resume <run-id> --next`.

**Start a second task and it asks for roles again.** It will not reuse these.
Only you saying "same as the previous task" makes `--same-as <run-id>` valid.

---

## Phase 7 — implementation, behind the gate (10 min)

Assigning Codex the implementation role does **not** authorise it to write. That
is a separate, just-in-time approval:

```bash
fde approve-codex <run-id> implementation \
  --task-file artifacts/implementation/implementation-task.md \
  --repo ~/work/maxeda-returns \
  --commands "pytest -q"
```

You are shown the run, repository, branch and worktree, writable root, task
summary, the SHA-256 of the task file, whether network was requested, and what it
may run. You type `APPROVE CODEX <run-id>`.

The approval is one-time, expires in 30 minutes, and is bound to those exact
bytes. Then:

```bash
fde invoke <run-id> chatgpt_codex artifacts/implementation/implementation-task.md --write
```

`ask-codex` re-hashes the file, refuses if it changed, refuses if the approval
expired or was already used, marks it consumed *before* the process starts, and
runs Codex in a `workspace-write` sandbox bounded to the approved root with
network off.

If Codex needs network, another repository, or a wider writable root: stop and
approve a new, narrower task. Never widen an existing approval. There is no
`--yolo` and no `danger-full-access` in this toolkit, and `fde doctor` fails if
one ever appears.

After independent verification, record the evidence before release progression:

```bash
fde checkpoint <run-id> --stage verification --status pass \
  --evidence artifacts/implementation/verification-report.md \
  --command "pytest -q"
```

The controller refuses the deployment gate if the report or passing checkpoint
is missing. Use `/tdd-evidence`, `/quality-gates`, `/scm-pr-review` and
`/ci-diagnose` as applicable; an unavailable check is recorded, never silently
treated as a pass.

---

## Phase 8 — deploy and establish observability

Use `/release-observability` to prepare an immutable release identity, migration
and rollback steps, rollout thresholds, SLOs, alerts and runbooks. Deployment is
an external mutation and requires its own approval:

```bash
fde approve-publish <run-id> deployment --summary "<environment and release>"
# you type: APPROVE PUBLISH <run-id>
```

Write `artifacts/deployment/deployment-report.md` and
`artifacts/observability/observability-plan.md`. Record live rollout health as a
passing observability checkpoint before the run completes or publishes later
artifacts.

---

## Phase 9 — publish, behind the other gate (5 min)

A plan existing is not a reason to create anything. `jira-plan.json` is a
preview. When you actually want it out there:

```bash
fde output-hygiene <run-id> --check
fde approve-publish <run-id> jira --summary "8 stories under MAX-142" \
  --items artifacts/delivery-plan/jira-preview.txt
# you type: APPROVE PUBLISH <run-id>

confluence create ENG "ADR 004: Token exchange" \
  ~/.claude-shared/runs/<run-id>/artifacts/architecture/adr.md --parent 123456
```

One target, one approval. What was approved is recorded in the run's
`publication-manifest.json`.

The `publication` transition applies the bounded hygiene policy before the
state is recorded, so external publication reads the cleaned artifact. The
`complete` transition runs it again to cover artifacts created during
publication. Each pass writes hashed evidence under `artifacts/evidence/`.
Creator/copyright/ownership fields, visible watermarks and C2PA/content
credentials are never removed.

For optional deeper inspection, run the linked `watermarks-remover` service on
loopback and add this to `~/.claude-shared/env.sh`:

```bash
export WATERMARKS_SERVICE_URL="http://127.0.0.1:8765"
```

FDE sends supported artifacts only to `/inspect/batch`; it never calls the
service's `/clean` endpoint. Remote service URLs are refused unless you also set
`FDE_ALLOW_REMOTE_HYGIENE_SERVICE=1`, because inspection uploads artifact bytes
to that endpoint.

---

## Phase 10 — close the loop (optional)

Once the pipeline earns its keep, add a weekly scheduled task that reads Jira and
Confluence and writes you a state-of-the-engagement brief. That is what turns a
set of tools into something that notices drift without being asked.

---

## Verify the whole thing

```bash
# syntax-check only the actual shell scripts (several bin/ files are Python)
for f in install.sh shell/*.sh shell/claude-profile-new claude-shared/bin/*; do
  head -1 "$f" | grep -q bash && bash -n "$f" && echo "ok   $f"
done
python3 -m unittest discover -s tests -v
python3 fde-toolkit/plugins/fde-core/scripts/audit_agent_config.py \
  --plugin-root fde-toolkit/plugins/fde-core --shared-root claude-shared
fde doctor
```

The test suite runs entirely against a temporary home directory and a stub Codex
binary, so it never reads or writes your real configuration. Where a real `codex`
is installed it additionally exercises the genuine sandbox.

## Two things to verify yourself

1. **Bitbucket scopes.** Rovo MCP supports Bitbucket Cloud under specific API
   token scopes with the site linked to your organisation. Whether *your* tenant
   is set up that way is a question for your admin. Local git works regardless.
2. **Copilot Studio's channel options.** The exact menu path, and whether you get
   a secret or a token endpoint, varies by tenant and changes between releases.
   `ask-ms-copilot` handles both; you just need to know which you have.
