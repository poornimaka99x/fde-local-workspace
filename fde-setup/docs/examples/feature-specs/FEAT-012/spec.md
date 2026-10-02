---
feature: FEAT-012
title: Return status notifications
document: spec
status: approved
owner-stage: solution-requirements
updated: 2026-10-02
---

# FEAT-012 — Return status notifications: specification

Worked example. A fictional retailer's customers start returns online and then
call the contact centre to ask where their refund is. This feature tells them.

## Outcomes

- Customers learn about each change in their return without contacting support.
- Contact-centre "where is my refund" calls fall; measured over the four weeks
  after release against the four weeks before.

## Requirements

### REQ-012-001: Notify on status change

When a return moves to Received, Inspected, Refunded or Rejected, the customer
receives one email describing the new status.

- Priority: must
- Source: RET-118 (Jira), discovery workshop 2026-09-12

### REQ-012-002: Respect contact preferences

No notification is sent to a customer who has opted out of transactional
email; the status change is still visible in their account.

- Priority: must
- Source: privacy review, RET-121

### REQ-012-003: No duplicate notifications

A status change that is reported more than once by the warehouse system
produces one notification, not several.

- Priority: should
- Source: RET-118 comment thread

## Acceptance criteria

### CHECK-012-001: Each status produces one email

Given a return in each of the four statuses, when the status event is
processed, then exactly one email with the matching template is queued.

- Requirement: REQ-012-001
- Verification: automated-test

### CHECK-012-002: Opted-out customers receive nothing

Given a customer opted out of transactional email, when their return changes
status, then no email is queued and the account page shows the new status.

- Requirement: REQ-012-002
- Verification: automated-test

### CHECK-012-003: Replayed events are idempotent

Given the same status event delivered three times, when all are processed,
then one email is queued.

- Requirement: REQ-012-003
- Verification: automated-test

### CHECK-012-004: Copy approved by the client

The four email templates match the copy approved by the client's customer
service lead.

- Requirement: REQ-012-001
- Verification: review

## Exclusions

- SMS and push notifications.
- Notifications for exchanges (a separate flow, RET-130).

## Assumptions

- The warehouse system emits a status event for every transition (to be
  confirmed by the client's integration team).

## Open questions

### Q-012-001: Should Rejected emails include the inspection reason?

- Status: answered
- Owner: client customer service lead
- Answer: Yes, using the reason codes' customer-facing labels only.

### Q-012-002: Do marketplace-seller returns follow the same flow?

- Status: deferred
- Owner: client product owner
- Answer: Out of scope for this release; revisit with RET-130.
