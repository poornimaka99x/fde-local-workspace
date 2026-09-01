---
name: product-discovery
description: Turn stakeholder material, Jira items and research into a product brief with outcomes, scope, user journeys, acceptance criteria and traceability. Use for requirements analysis, product discovery, epic refinement or ambiguity reduction.
argument-hint: "<run-id> [requirement or Jira key]"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# Product discovery

Run `fde guard <run-id> --activity "product discovery"` before reading any
source. Delegate analysis to `product-analyst`. Preserve provenance and label
statements as stated, inferred or unresolved. Produce a brief containing users,
problem, outcomes and measures, in/out scope, journeys and edge cases,
constraints, assumptions, dependencies, open decisions and testable acceptance
criteria. Add a traceability table from requirement to Jira, design, code and
test. Stop for clarification when an unresolved decision changes scope or
architecture. Reading Jira is allowed after the guard; updating it requires an
approved publication manifest.
