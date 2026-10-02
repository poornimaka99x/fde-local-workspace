---
feature: {{FEATURE_ID}}
title: {{TITLE}}
document: tasks
status: draft
owner-stage: development-planning
updated: {{DATE}}
---

# {{FEATURE_ID}} — {{TITLE}}: tasks

Bounded units of work. A task's Status records progress for readers; it never
authorises execution. Execution is authorised only by an FDE task file and its
approval.

<!-- Requirements: the REQ IDs the task serves. A task that serves none must give
     a Justification instead (e.g. an enabling refactor).
     Depends on: TASK IDs, or none.
     Status: todo | in-progress | done | dropped -->

### TASK-{{N}}-001: {{short name}}

{{What will be done, bounded enough to finish and review in one go.}}

- Requirements: REQ-{{N}}-001
- Depends on: none
- Done when: {{the concrete completion criterion}}
- Status: todo
