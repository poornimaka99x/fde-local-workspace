---
name: engage
description: Scope or resume an evidence-backed FDE run with fresh account roles and explicit approval boundaries. Use for any lifecycle slice from discovery through operations.
argument-hint: "[requirement | Jira key | run-id]"
allowed-tools: Read, Grep, Glob, Bash, Write, Task
---

# Engage

Coordinate the identities the user assigns; do not give accounts permanent
jobs. The `fde` controller is the run record for plan, roles, events, artifacts,
checkpoints and approvals.

## Entry routing

- For a requirement, Jira key or no argument, start a run and read
  [scoping-and-roles.md](references/scoping-and-roles.md). Scoping itself reads
  no connected systems or repository.
- For an existing run ID, call `fde status <run-id> --json`. Its persisted state
  is authoritative. When `requirement.hasFile` is true, use the recorded request
  and do not ask the user to repeat or re-record it. Ask for the request only
  when status reports it missing. If roles are not confirmed, read the scoping
  reference. Otherwise read
  [lifecycle-stages.md](references/lifecycle-stages.md) and continue only the
  planned stage.

Core controller surface:

```bash
fde start
fde orchestrator <run-id> <identity>
fde request <run-id> "<user's words>"
fde plan <run-id> --preview --stages <stages>
fde plan <run-id> --require-approval --stages <stages>
fde roles <run-id> --set <role>=<identity>
fde routing show <run-id> --json
fde routing explain <run-id> [--task-id <task-id>] --json
fde routing override <run-id> --task-id <task-id> --reason "<why>"
fde routing outcome <run-id> --task-id <task-id> --status pass|fail [--classification <r>]
fde routing attempts <run-id> --json
fde approve-plan <run-id>
fde status <run-id>
fde checkpoint <run-id> --stage <stage> --status <status> --evidence <item>
fde output-hygiene <run-id> --check
fde resume <run-id> --next
```

## Invariants

- Do only the confirmed stage slice. Widen the plan explicitly when the user
  adds work.
- Read nothing connected—not Jira, documents, Figma, client context or source
  repositories—until the user confirms roles for this run.
- Never describe an existing run as having no request when controller status
  reports `requirement.hasFile=true`; its summary and `requirement.md` are the
  durable user input for scoping.
- Accounts have capabilities, not defaults. Ask again every run; copy prior
  roles only when the user explicitly requests it.
- Keep the proposed stages and assignments in the conversation until the user
  has seen one combined summary. Require the literal `APPROVE PLAN <run-id>`
  before recording them as executable; never infer it from general agreement.
- On an automatically routed run (`fde status --json` reports
  `routing.mode: "auto"`), the combined summary must also show the proposed
  execution matrix from `fde routing show <run-id> --json`: for every task, the
  account identity, the specialist method, the selected model and effort, the
  quality floor, the dependency, the estimated cost units and the escalation
  ceiling. Those are four different things and must be presented as four
  different things. Costs are relative estimates, never money — say so.
  `fde routing explain` is the answer to "why that one"; do not invent a
  rationale. Approval covers the route as well as the plan and the roles, and if
  the controller refuses because the route recomputed differently, show the
  revision and ask again rather than retrying.
- Never adjust a route yourself. `fde routing override` is the only path, it
  needs a reason, and raising a tier, effort or account needs the user to type
  `APPROVE ROUTING <run-id>`. A quality floor is not negotiable.
- Invoke a routed run only with `--task-id <task-id>` naming an approved task.
  The frozen decision is the authority for the model and effort; never pass your
  own.
- Record what every attempt produced with `fde routing outcome`. A failure needs
  a classification before a retry is permitted, and there is no classification
  for "the answer was not what I wanted" — if the output was simply not useful,
  change the task or the plan instead of re-running it. Never retry to see if a
  second roll is better.
- Never work around a ceiling. When the controller reports a retry, escalation or
  cost ceiling, stop and tell the user what it would take, in their terms. Report
  usage exactly as the record states it: reported, estimated, or unavailable —
  never a zero standing in for a measurement nobody made.
- Guard connector/repository access with `fde guard` and invoke only identities
  assigned to the applicable role/stage.
- `APPROVE CODEX <run-id>` is required for each exact Codex write task.
- `APPROVE PUBLISH <run-id>` is required per external target, including
  deployment. Neither phrase may be inferred from general consent.
- A checkpoint records evidence; it never grants permission. Verification and
  observability require passing checkpoints before release progression.
- A legal transition into `publication` or `complete` automatically runs
  provenance-preserving output hygiene on `artifacts/` and records hashed evidence. Never substitute
  a watermark-removal or C2PA-stripping tool for this bounded policy.
- Report missing agents, unavailable checks and disagreements. Never present a
  partial pipeline as complete.
- After combined approval, use the configured tool surface autonomously for the
  approved scope. If intent, target, authority, destructive effect, acceptance
  criteria or required evidence is ambiguous, stop and ask the user.
- Use `/retrospective` for unreviewed lesson candidates; never auto-promote
  memory into policy.

At context-heavy phase boundaries, write durable state first and use
`fde brief <run-id>` as the bounded resume view.
