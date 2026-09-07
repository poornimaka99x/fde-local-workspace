---
name: quality-gates
description: Apply the attached strict engineering coding standards as executable pre-PR and CI quality gates, including architecture, complexity, tests, security, contracts and brownfield/greenfield rules. Use during implementation, review and verification.
argument-hint: "<run-id> [base branch]"
allowed-tools: Read, Grep, Glob, Bash, Task
---

# Quality gates

The shared `engineering-standards.md` is normative: RFC 2119 MUST/MUST NOT rules
are merge blockers and SHOULD deviations require written PR rationale. Do not read
the whole document — `standards list` maps sections to purpose; pull the ones this
gate run actually tests (typically `standards show 17`, then 14, 10, 19 and 20).
Read repository overrides and tool configuration, then establish which checks
are executable. Delegate semantic review to `standards-reviewer`, security to
`security-reviewer`, and test evidence to `test-engineer`. Run, where applicable:
formatter; linter/static analysis; types; complexity and duplication; unit,
integration, contract and end-to-end tests with coverage; build; migration
apply/rollback; dependency vulnerability, secret and SAST scans. Report each
gate as pass, fail, unavailable or not applicable with command/evidence. Never
turn an unavailable gate into a pass, and do not mass-format brownfield code.
Use `verification-evidence` to create the run's report and checkpoint; the gate
report alone does not approve deployment or publication.
