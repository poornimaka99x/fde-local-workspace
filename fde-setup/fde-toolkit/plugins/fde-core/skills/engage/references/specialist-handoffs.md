# Bounded specialist handoffs

Use one accountable orchestrator. Add a specialist only for a named uncertainty
or independent check within the approved route. Simple work can stay with the
orchestrator; parallelize independent research or reviews, not dependent design
and implementation. Concurrent writers need disjoint ownership and separate
worktrees. A second model's agreement is not verification.

Before dispatch, save the task text and a JSON sidecar in the run's `tasks/`.
Validate it with `fde handoff validate <run-id> tasks/<task-id>.json --json`.
Use the same task text file for `fde invoke` and any task-bound write approval.
The sidecar validates evidence and intent; permissions, approval and budget
enforcement still belong to the controller and the client. It cannot grant
tools or increase a frozen route's budget.

The version 1 sidecar contains:

| Field | Contract |
| --- | --- |
| `schemaVersion`, `runId`, `taskId` | `1`, the current run ID, the approved routing task ID |
| `objective`, `specialist`, `assignedIdentity`, `stage` | Bounded outcome and the approved assignment |
| `task` | `{ "path": "tasks/task.md", "sha256": "<actual digest>" }` |
| `requirementIds` | Stable IDs, such as `["REQ-001"]` |
| `inputEvidence` | Array of `{path, sha256, source, retrievedAt}`; paths inside the run, exact source URL/ID or repository commit/path, retrieval time |
| `acceptanceChecks` | Array of `{requirementId, check}` covering every requirement |
| `permissions` | `{tools: [...], writePaths: [...]}`; intent constrained by actual runtime authority |
| `ownedPaths` | Files/directories owned by this writer, or `[]` for review |
| `reviewOnly` | Boolean; when true, tools are a subset of Read/Grep/Glob and writePaths is empty |
| `output` | `{path, format}`; path inside the run. The orchestrator saves review-only output |
| `budget` | `{maxAttempts, maxSeconds, maxCostUnits}` within approved ceilings; cost units are estimates, not currency |
| `stopCondition`, `escalationCondition` | When to stop, and the specific evidence needed to request escalation |

Reviewers receive requirements, the actual diff/artifact and source evidence.
Do not seed the review with the author's desired verdict. Missing evidence is
requested through the orchestrator; reviewers return findings rather than
editing the artifact they judge. Reconcile findings against evidence before
updating the shared decision record.

Keep requirement IDs through the brief, design/ADR, implementation and test
report. At handoff, record decisions, evidence paths, unresolved issues and the
next action before compacting context. Reload with `fde brief`.
