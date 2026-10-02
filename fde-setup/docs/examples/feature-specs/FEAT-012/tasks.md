---
feature: FEAT-012
title: Return status notifications
document: tasks
status: approved
owner-stage: development-planning
updated: 2026-10-02
---

# FEAT-012 — Return status notifications: tasks

A task's Status records progress for readers; it never authorises execution.

### TASK-012-001: Status consumer behind a flag

Consume `return.status-changed`, map the four statuses, queue an email.

- Requirements: REQ-012-001
- Depends on: none
- Done when: contract tests for all four statuses pass with the flag on
- Status: done

### TASK-012-002: Honour contact preferences

Check transactional-email opt-out before queueing.

- Requirements: REQ-012-002
- Depends on: TASK-012-001
- Done when: opted-out fixture queues nothing and the account page updates
- Status: done

### TASK-012-003: Deduplicate replayed events

Record `(returnId, status)` for 24 h and skip repeats.

- Requirements: REQ-012-003
- Depends on: TASK-012-001
- Done when: triple-delivery test queues one email
- Status: done

### TASK-012-004: Email templates

Add the four templates with the approved copy and reason labels.

- Requirements: REQ-012-001
- Depends on: none
- Done when: templates render in staging with sample data
- Status: done

### TASK-012-005: Missing-event alert

Alert when a return has had no status event for 72 hours.

- Requirements: none
- Justification: risk mitigation from plan.md; supports operations, not a requirement
- Depends on: TASK-012-001
- Done when: alert fires in staging for a synthetic stalled return
- Status: in-progress
