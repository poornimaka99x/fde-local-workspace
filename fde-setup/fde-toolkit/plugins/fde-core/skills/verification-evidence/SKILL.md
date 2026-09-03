---
name: verification-evidence
description: Convert build, test, review, security and operational checks into an evidence-backed FDE stage checkpoint. Use before a PR, deployment, publication or completion claim.
argument-hint: "<run-id> [stage]"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# Verification evidence

Run the FDE guard, read the acceptance criteria and select applicable gates from
`quality-gates`. Prefer deterministic checks; use model review for semantic
questions and human review for material ambiguity or risk. Record every gate as
pass, fail, unavailable or not applicable with command, environment and output
location. A truncated log is not evidence unless it still contains the causal
result and exit status.

For the verification stage, write
`artifacts/implementation/verification-report.md`, then append its immutable
hash to the run ledger:

```bash
fde checkpoint <run-id> --stage verification --status pass \
  --evidence artifacts/implementation/verification-report.md \
  --command "<actual verification command>"
```

For observability, use the corresponding observability plan and live rollout
evidence. Record `fail` or `blocked` when evidence is incomplete. A checkpoint
is an observation, not an approval; deployments and publications still require
their separate FDE approval.

Before publication, preview final-artifact hygiene when useful:

```bash
fde output-hygiene <run-id> --check
```

The controller applies the same bounded policy automatically before publication
and completion and appends a hash-bound evidence event. Treat any reported
C2PA/content credential or creator/copyright field as provenance to preserve,
not as cleanup work.
