---
feature: {{FEATURE_ID}}
title: {{TITLE}}
document: verification
status: draft
owner-stage: quality-review
updated: {{DATE}}
---

# {{FEATURE_ID}} — {{TITLE}}: verification

Whether each acceptance check in `spec.md` was met, and how we know. Task
completion is recorded in `tasks.md`; acceptance is recorded here. They are
different facts.

<!-- One entry per acceptance check. Result: pass | fail | not-run | unavailable.
     A pass names its Evidence: a test, command, report or review a reader can
     find. No raw logs, credentials or private engagement notes. -->

### CHECK-{{N}}-001: {{short name}}

- Result: not-run
- Method: {{what was actually done}}
- Evidence: {{test name, command, or report path}}

## Checks performed

| Check | Command or procedure | Environment | Result |
| --- | --- | --- | --- |
| {{e.g. unit tests}} | {{command}} | {{env}} | {{pass/fail}} |

## Limitations

- {{What was not verified, and why; residual risk}}
