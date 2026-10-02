---
feature: FEAT-012
title: Return status notifications
document: plan
status: approved
owner-stage: technical-architecture
updated: 2026-10-02
---

# FEAT-012 — Return status notifications: technical plan

## Approach

Subscribe to the existing `return.status-changed` topic, look up the
customer's contact preference, and queue an email through the existing
notification service. Deduplicate on `(returnId, status)` with a short-lived
record, satisfying REQ-012-003 without changing the warehouse integration.
Decision recorded in ADR-0042.

## Affected components

| Component | Change | Requirements |
| --- | --- | --- |
| returns-service: new `StatusNotifier` consumer | new | REQ-012-001, REQ-012-003 |
| notification-service templates | four new templates | REQ-012-001 |
| preferences client | read-only use | REQ-012-002 |

## Compatibility and migration

- No API changes. The consumer is behind the `returns.notify` flag, off by
  default; rollback is switching it off.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Warehouse skips a transition | medium | medium | alert on returns with no event for 72 h |
| Burst on backlog replay | low | medium | rate-limit the consumer; dedup covers repeats |

## Validation approach

- Contract tests on the consumer for CHECK-012-001 to CHECK-012-003 using
  recorded events; copy review for CHECK-012-004 in staging.

## Standards and principles

- Follows the repository's `AGENTS.md` and ADR-0042.
- Exceptions: none.
