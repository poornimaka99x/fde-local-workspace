---
name: jira-delivery
description: Analyse Jira work, decompose approved scope into delivery slices, maintain requirement-design-code-test traceability and report project health. Use for planning, backlog refinement, dependency mapping, RAID, status or Jira publication.
argument-hint: "<run-id> <Jira key or planning request>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# Jira delivery

Guard first, then use the assigned orchestrator's Atlassian connection. Treat
Jira as the project-management source of truth, not as the only source of
requirements or architecture. Delegate the plan to `delivery-manager` and write
`artifacts/delivery-plan/development-plan.md` plus a dry-run
`jira-plan.json`. Each item needs outcome, acceptance criteria, dependencies,
repository/component, design/ADR links, test evidence and release slice. Show
the preview and validation errors before any mutation. Create/update Jira only
after `fde approve-publish <run-id> jira`; log created keys and links in the run.
Never silently rewrite team estimates, assignees, status or sprint placement.
