# FDE selection from Addy Osmani's Agent Skills

Pinned upstream: `addyosmani/agent-skills` at
`bcab6a1b8503100e8618c3b4e32cc78de43de769` (version 0.6.10).

## Included gaps

- `api-and-interface-design`: contract-first APIs and module boundaries.
- `debugging-and-error-recovery`: general root-cause debugging outside CI-only incidents.
- `deprecation-and-migration`: expand/contract schema and safe retirement workflows.
- `documentation-and-adrs`: architecture decision records and durable rationale.
- `performance-optimization`: measurement-first frontend, backend, and database work.
- `security-and-hardening`: threat modelling and secure implementation guidance.
- `source-driven-development`: current official documentation as implementation evidence.

## Excluded overlaps

The other upstream skills substantially overlap FDE's existing product discovery,
planning, context budgeting, incremental implementation, TDD evidence, UI/design,
browser/MCP use, code review, simplification, CI/CD, observability, release, and
shipping workflows. The `using-agent-skills` meta-skill and upstream commands are
also excluded because FDE's controller owns routing, approvals, roles, and stages.

No upstream hooks, commands, agents, scripts, package manifests, or executable
files are included. The two shared checklists referenced by the selected skills
are vendored under `references/`.

