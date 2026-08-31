---
name: engage
description: Run the full solutioning pipeline for a requirement or Jira epic — role assignment, intake, research, solution architecture, adversarial review, reconciliation, presentation, development plan, implementation and publication — with the user assigning roles before anything is read and approving every write. Use when asked to work up a solution, analyse an epic, produce an architecture proposal, or take a business requirement through to a delivered change.
argument-hint: "<jira-key | requirement | confluence-page-id>"
allowed-tools: Read, Grep, Glob, Bash, Write, Task
---

# Engage

The orchestration pipeline. You coordinate; the assigned identities work. Keep
your own context for the engagement and the reconciliation — do not do the
research yourself, or by stage three you will have no room left to think.

Every stage is recorded by the `fde` controller. Use it rather than remembering:

```bash
fde start <jira-key-or-description>    # creates the run; state: awaiting_roles
fde status <run-id>                    # state, roles, artifacts, approvals
fde resume <run-id> --advance <state>  # move the pipeline on
```

---

## -1. Assign roles — before anything else

**This stage comes first. Nothing may be read before it completes.**

Identities are not roles. "Claude: work", "ChatGPT/Codex", "Gemini" and
"Microsoft Copilot" are *who is in the room*; what each of them does is decided
by the user, for this run, every run.

Run `fde start`, then put this question to the user verbatim:

```
Before I initialize this task, assign the roles.

Available identities:
- Claude: work
- Claude: msc
- Claude: alt
- Claude Code: Bedrock
- ChatGPT/Codex
- Gemini
- Microsoft Copilot

Choose:
- Orchestrator:
- Researcher(s):
- Solution architect:
- Reviewer(s):
- Delivery planner:
- Presentation author:
- Implementation agent:
- Microsoft context source: include / exclude

An identity may hold more than one role. Use "none" where a role is unnecessary.
I will not initialize the task or access connected systems until you confirm.
```

Record the answer:

```bash
fde roles <run-id> --set orchestrator=claude_alt --set research=claude_work,gemini ...
```

Rules, and they are not negotiable:

- **No implicit defaults.** Do not choose on the user's behalf, and do not offer
  a "suggested" assignment they only have to accept — that is choosing.
- **Do not carry roles over from the previous run.** A new run asks again. Only
  the user saying "same as the previous task" makes `--same-as <run-id>` valid.
- **Read nothing until roles are confirmed.** No Jira, no Confluence, no
  SharePoint, no email, no repository, no client context file. Creating the
  empty run record is allowed; initialising the task is not.
- **If an assigned identity is unavailable, stop and ask for a replacement.**
  `fde roles` refuses and names what is missing. Do not silently substitute.
- **Agents may only be invoked for roles they hold in this run.** `fde invoke`
  enforces it; do not work around it with a direct CLI call.
- Assignments live in the run's `roles.json` and nowhere else. Nothing is written
  back to `agents.json`.

Before any connector call:

```bash
fde guard <run-id> --activity "reading the Jira epic"
```

## 0. Intake

Now — and only now — load context. Read the engagement file for this client from
`~/.claude-shared/shared/clients/`. If the argument is a Jira key, pull the epic
and its comments: the PO's own words are the requirement, and your paraphrase of
them is not. If a Microsoft context source was included, that is what answers
SharePoint, Outlook and Teams questions — `ask-ms-copilot`, or `ms-intake` for
material that has to come across by hand.

Log every Atlassian call: `fde log <run-id> --tool atlassian.searchJiraIssues`.

State in one line what you understand the ask to be, **before** dispatching. If
that sentence is wrong, everything downstream is wasted.

## 1. Research → `artifacts/research/research-brief.md`

Dispatch the assigned researcher(s). Wait.

Read the gaps section first. **If a gap would change the design, stop the
pipeline and bring it back to the user** (`fde resume <run-id> --block "..."`).
Continuing here is the single most expensive mistake this pipeline can make —
every later stage will look confident and be built on a hole.

## 2. Solution architecture → `artifacts/architecture/architecture-options.md`

Dispatch the assigned solution architect. Options with their costs, not one
option with its virtues.

## 3. Adversarial review → `artifacts/review/review.md`

Dispatch the assigned reviewer(s). Their job is to find what is wrong. A review
that agrees with everything did not happen.

## 4. Reconciliation — this part is yours → `artifacts/review/reconciliation.md`

Do not just relay the review. Decide:

- Which blocking objections are correct? Those go back to the solution architect
  for **one** revision. One, not a loop — if it is still contested after that, it
  is a judgement call and it belongs to the user, not to another round of agents.
- Which objections are wrong, and why? A dismissed objection that is documented
  is worth more than one silently dropped.
- What remains genuinely open?

Write the decision up as `artifacts/architecture/adr.md`.

## 5. Presentation → `artifacts/presentation/solution-presentation.pptx`

Dispatch the assigned presentation author. If no identity holds that role, say
so and skip it rather than doing it yourself by default.

## 6. Development plan → `artifacts/delivery-plan/development-plan.md`
##    and the Jira preview → `artifacts/delivery-plan/jira-plan.json`

The delivery planner produces the breakdown. `jira-plan.json` is a **preview**:
what would be created, in which project, with which parents and estimates.

**Do not create Jira issues because the plan exists.** The plan existing is not
approval to publish it. That comes at stage 10.

## 7. Implementation-agent selection

The implementation agent was named at stage -1. Confirm it is still the user's
intent and that it is available. Write the task as
`artifacts/implementation/implementation-task.md` — exact, bounded, and complete
enough that the approval the user gives means something.

## 8. Implementation approval

```bash
fde approve-codex <run-id> implementation \
  --task-file artifacts/implementation/implementation-task.md \
  --repo <repository path> --commands "<tests it may run>"
```

The user is shown the run, repository, branch, writable root, task hash, whether
network was requested and what may run, and must type `APPROVE CODEX <run-id>`.

**Assigning Codex as the implementation agent is not this approval.** It never
was. The approval is one-time, expires in 30 minutes, is bound to the exact bytes
of the task file, and cannot be reused or widened. Editing the task file after
approval invalidates it — approve the new one, do not stretch the old one.

## 9. Implementation and verification

```bash
fde invoke <run-id> chatgpt_codex artifacts/implementation/implementation-task.md --write
```

`ask-codex` re-hashes the task file and consumes the approval immediately before
the process starts, then runs Codex in a `workspace-write` sandbox bounded to the
approved root, with network off. There is no bypass flag in this toolkit and
there must never be one.

Then verify — build, tests, a read of the diff —
→ `artifacts/implementation/verification-report.md`. Report what you did not
verify as plainly as what you did.

## 10. Publication approval → `publication-manifest.json`

Anything leaving this machine — Jira, Confluence, SharePoint, Bitbucket, email,
Teams — needs its own approval, separate from the Codex one:

```bash
fde approve-publish <run-id> jira --summary "8 stories under MAX-142" \
  --items artifacts/delivery-plan/jira-preview.txt
```

The user types `APPROVE PUBLISH <run-id>`. One target, one approval.

## 11. Publish

Only what was approved, only to the approved target. Then
`fde resume <run-id> --advance complete`.

---

## Rules

- **Nothing is read before roles are confirmed; nothing is written outside this
  machine without a publication approval.** Those two sentences are the whole
  design. Everything else is detail.
- Report disagreement between stages rather than smoothing it. Where the reviewer
  and the architect disagreed and you picked a side, say that you picked.
- If an assigned identity could not run — a CLI missing, a service unreachable —
  say which opinion you did not get. Do not present a partial pipeline as a
  complete one.
- Stages are sequential for a reason: each one's output is the next one's input.
  Do not parallelise them.
- Microsoft Copilot means Microsoft 365 Copilot / Copilot Studio. It answers
  questions about the Microsoft estate. It does not touch source code, git,
  Bitbucket or Jira work items, and it is not the orchestrator unless the user
  explicitly makes it one and the integration supports what you are asking.
- Local git stays the primary interface to Bitbucket repositories, whatever the
  Atlassian connector exposes.
