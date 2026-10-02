---
feature: FEAT-012
title: Return status notifications
document: verification
status: draft
owner-stage: quality-review
updated: 2026-10-02
---

# FEAT-012 — Return status notifications: verification

### CHECK-012-001: Each status produces one email

- Result: pass
- Method: contract tests with recorded events, flag on
- Evidence: `StatusNotifierTest.queuesOneEmailPerStatus` (CI build 4812)

### CHECK-012-002: Opted-out customers receive nothing

- Result: pass
- Method: contract test with opted-out fixture; account page checked in staging
- Evidence: `StatusNotifierTest.skipsOptedOutCustomers` (CI build 4812)

### CHECK-012-003: Replayed events are idempotent

- Result: pass
- Method: triple delivery of one event
- Evidence: `StatusNotifierTest.deduplicatesReplays` (CI build 4812)

### CHECK-012-004: Copy approved by the client

- Result: not-run
- Method: review by the client's customer service lead in staging
- Evidence: scheduled; not yet performed

## Checks performed

| Check | Command or procedure | Environment | Result |
| --- | --- | --- | --- |
| unit and contract tests | `./gradlew :returns-service:test` | CI | pass |
| static analysis | `./gradlew :returns-service:check` | CI | pass |

## Limitations

- CHECK-012-004 is outstanding, so REQ-012-001 is not yet accepted even though
  its tasks are done.
- Behaviour under a real backlog replay was not load-tested.
