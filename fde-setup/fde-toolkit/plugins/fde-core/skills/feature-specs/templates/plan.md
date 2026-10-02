---
feature: {{FEATURE_ID}}
title: {{TITLE}}
document: plan
status: draft
owner-stage: technical-architecture
updated: {{DATE}}
---

# {{FEATURE_ID}} — {{TITLE}}: technical plan

How the requirements in `spec.md` will be met. Refer to requirements by ID.
This document is a design record for people; it is not the FDE run plan and
never replaces the controller's `plan.json`.

## Approach

{{The chosen design in a few paragraphs. Link the ADR if one was recorded.}}

## Affected components

| Component | Change | Requirements |
| --- | --- | --- |
| {{service / module / screen}} | {{new / modified / removed}} | REQ-{{N}}-001 |

## Compatibility and migration

- {{API, data, configuration or behaviour compatibility; migration and rollback}}

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| {{risk}} | {{low/med/high}} | {{low/med/high}} | {{mitigation}} |

## Validation approach

- {{How the acceptance checks in spec.md will be exercised; environments, data}}

## Standards and principles

- {{Reference the repository's AGENTS.md, ADRs or PRINCIPLES.md rather than restating them}}
- Exceptions: {{none, or each agreed exception with who agreed it}}
