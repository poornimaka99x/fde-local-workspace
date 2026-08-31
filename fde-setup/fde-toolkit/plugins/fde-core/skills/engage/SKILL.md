---
name: engage
description: Scope and run a piece of forward-deployed engineering work — the user says in plain English what they want done, you propose a plan of stages, they assign the roles, and only then does anything get read. Covers research, solution architecture, adversarial review, reconciliation, presentation, delivery planning, implementation and publication, in whatever combination the user actually asked for. Use when asked to work up a solution, analyse an epic, research something, get work validated, build a deck, produce a Jira breakdown, or take a requirement through to a delivered change.
argument-hint: "<jira-key | requirement | run-id>"
allowed-tools: Read, Grep, Glob, Bash, Write, Task
---

# Engage

You coordinate; the assigned identities work. Keep your own context for the
engagement and the reconciliation — do not do the research yourself, or by stage
three you will have no room left to think.

**Most work is a slice of the pipeline, not all of it.** "Research this and get
it validated" is a real ask. So is "slides and a Jira breakdown". Running either
of those through all ten stages produces nine artifacts nobody wanted. Your first
job is to find out which slice this is.

The `fde` controller holds the record. Use it rather than remembering:

```bash
fde start                              # creates the run; state: awaiting_orchestrator
fde orchestrator <run-id> <identity>   # the first decision — who interprets the ask
fde request <run-id> "<what you want>" # the ask, in the user's own words
fde plan <run-id> --stages a,b,c       # what this run will actually do
fde roles <run-id> --set role=identity # who does the rest — asked fresh every run
fde status <run-id>                    # plan, roles, artifacts, approvals, next
fde resume <run-id> --next             # advance to whatever the plan says is next
```

---

## -3. Who orchestrates — the first decision

Before the ask, before anything. The orchestrator is the identity that reads the
user's sentence and proposes what the run should do, so choosing it is not a
detail to fill in afterwards.

Put this to them:

```
Who orchestrates this run?

  Claude: work          Claude: msc          Claude: alt
  Claude Code: Bedrock  ChatGPT/Codex
```

Gemini and Microsoft Copilot cannot: Gemini is a one-shot headless call with no
session state, and Copilot is a chat endpoint over the Microsoft estate. Both can
still hold research, review or context roles. `fde orchestrator` refuses them and
says why.

```bash
fde orchestrator <run-id> codex
```

Short names work: `work`, `msc`, `alt`, `bedrock`, `codex`.

**Do not pick on their behalf, and do not carry the last run's choice over.** If
you are already running as one of these identities, that is not a reason to
assume you are this run's orchestrator — say which you are and ask.

## -2. The ask, and the plan it implies

Now take the request:

```bash
fde request <run-id> "<their words, verbatim>"
```

**Most work is a slice of the pipeline, not all of it.** "Research this and get
it validated" is a real ask. So is "slides and a Jira breakdown". Running either
through all ten stages produces nine artifacts nobody wanted.

Map their sentence onto stages. The ten available:

| stage | what it produces |
|---|---|
| `intake` | what the ask is; client context; the PO's own words |
| `research` | `research-brief.md` — evidence, prior art, gaps |
| `solutioning` | `architecture-options.md`, `adr.md` |
| `review` | `review.md` — someone whose job is to find what is wrong |
| `reconciliation` | `reconciliation.md` — which objections stand, and why |
| `presentation` | `solution-presentation.pptx` |
| `planning` | `development-plan.md`, `jira-plan.json` (a preview) |
| `implementation` | code, behind a one-time approval |
| `verification` | `verification-report.md` |
| `publication` | the step where other people start seeing it |

How to read them:

- "research X" → `intake, research`
- "research X and get it validated" → `intake, research, review`
- "...and present it" → add `presentation`
- "work up a solution" / "I need an ADR" → `intake, research, solutioning, review, reconciliation`
- "slides and a Jira breakdown" → `intake, presentation, planning`
- "just review this design" → `intake, review`
- "build it" → `intake, implementation, verification`
- "the full thing" / a bare Jira key with no other steer → `full`

`fde shapes` lists the named shortcuts; `--shape presentation+delivery-plan`
combines them.

**Include `intake` unless they have already given you everything.** It is cheap
and it is what stops the output sounding generic.

**Then show them the plan and wait.** Not a paraphrase — the actual list, what is
being skipped, and which roles it will need:

```
Proposed plan — 4 stages:
  intake  →  research  →  adversarial review  →  presentation

Not doing: solution architecture, reconciliation, development plan,
           implementation, verification, publication

Roles still to assign: researcher(s), reviewer(s), presentation author
(no delivery planner or implementation agent — this run does not go there)

Confirm?
```

On confirmation, record it verbatim:

```bash
fde plan <run-id> --stages intake,research,review,presentation \
  --intent "research MAX-142, get it validated, present it"
```

`fde` will warn if a stage's usual input is missing — a presentation with no
research behind it, say. That is advisory. Relay the warning, say where you
intend to get that input instead, and carry on if they still want it.

If they later say "actually, I do want an ADR", widen it:
`fde plan <run-id> --add solutioning`. You cannot add a stage the run has already
gone past; that is a new run.

## -1. Assign roles — before anything is read

Identities are not roles. "Claude: work", "ChatGPT/Codex", "Gemini" and
"Microsoft Copilot" are *who is in the room*; what each of them does is decided
by the user, for this run, every run.

`fde plan` prints the role question already narrowed to the roles this plan
needs, with the orchestrator shown as already chosen. Put it to the user
verbatim — a research-only run has no implementation agent to assign, and asking
for one invites an answer that means nothing.

Record the answer:

```bash
fde roles <run-id> --set orchestrator=claude_alt --set research=claude_work,gemini ...
```

Short names work: `work`, `msc`, `alt`, `bedrock`, `codex`, `gemini`.

Rules, and they are not negotiable:

- **No implicit defaults.** Do not choose on the user's behalf, and do not offer
  a "suggested" assignment they only have to accept — that is choosing.
- **Do not carry roles over from the previous run.** A new run asks again. Only
  the user saying "same as the previous task" makes `--same-as <run-id>` valid.
- **Read nothing until roles are confirmed.** No Jira, no Confluence, no
  SharePoint, no email, no repository, no client context file. Creating the run,
  choosing an orchestrator and scoping the work are allowed — none of them reads
  anything, and the user's own sentence is not a connector. Initialising the task
  is not allowed.
- **If an assigned identity is unavailable, stop and ask for a replacement.**
  `fde roles` refuses and names what is missing. Do not silently substitute.
- **Agents may only be invoked for roles they hold in this run**, and only for
  stages in this run's plan. `fde invoke` enforces both.
- Assignments live in the run's `roles.json` and nowhere else. Nothing is written
  back to `agents.json`.

Before any connector call:

```bash
fde guard <run-id> --activity "reading the Jira epic"
```

## The stages themselves

**Do only the stages in the plan.** `fde status <run-id>` shows which those are
and which one is next; `fde resume <run-id> --next` moves you on. A stage below
that is not in this run's plan does not happen, however natural it feels — if it
turns out to be needed, widen the plan explicitly and say why.

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

Dispatch the assigned presentation author. If this stage is in the plan but no
identity holds the role, stop and ask — do not quietly write the deck yourself.

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
- **Do what was asked, not the whole pipeline.** A plan is a promise about scope.
  Producing an unasked-for ADR is not generosity, it is noise in someone's
  Confluence space and an hour of your context spent badly.
- The approval gates are not stages you can plan around. If `implementation` is
  in the plan, `awaiting_implementation_approval` precedes it and the run will
  not enter implementation without the approval that gate exists for. Same for
  publication.
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
