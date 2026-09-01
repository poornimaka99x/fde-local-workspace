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
- For an existing run ID, call `fde status <run-id>`. If roles are not confirmed,
  read the scoping reference. Otherwise read
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
fde approve-plan <run-id>
fde status <run-id>
fde checkpoint <run-id> --stage <stage> --status <status> --evidence <item>
fde resume <run-id> --next
```

## Invariants

- Do only the confirmed stage slice. Widen the plan explicitly when the user
  adds work.
- Read nothing connected—not Jira, documents, Figma, client context or source
  repositories—until the user confirms roles for this run.
- Accounts have capabilities, not defaults. Ask again every run; copy prior
  roles only when the user explicitly requests it.
- Keep the proposed stages and assignments in the conversation until the user
  has seen one combined summary. Require the literal `APPROVE PLAN <run-id>`
  before recording them as executable; never infer it from general agreement.
- Guard connector/repository access with `fde guard` and invoke only identities
  assigned to the applicable role/stage.
- `APPROVE CODEX <run-id>` is required for each exact Codex write task.
- `APPROVE PUBLISH <run-id>` is required per external target, including
  deployment. Neither phrase may be inferred from general consent.
- A checkpoint records evidence; it never grants permission. Verification and
  observability require passing checkpoints before release progression.
- Report missing agents, unavailable checks and disagreements. Never present a
  partial pipeline as complete.
- After combined approval, use the configured tool surface autonomously for the
  approved scope. If intent, target, authority, destructive effect, acceptance
  criteria or required evidence is ambiguous, stop and ask the user.
- Use `/retrospective` for unreviewed lesson candidates; never auto-promote
  memory into policy.

At context-heavy phase boundaries, write durable state first and use
`fde brief <run-id>` as the bounded resume view.
