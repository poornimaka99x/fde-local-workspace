---
name: design-to-code
description: Translate an approved Figma or Claude Design prototype into a repository-aware implementation contract and production code with visual and accessibility verification. Use after design approval and before or during implementation.
argument-hint: "<run-id> <design URL or artifact>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write, Edit
---

# Design to code

Guard the run and confirm the design version/node, target repository, framework
and acceptance criteria. Inspect existing components/tokens and reuse them.
Create a mapping from design regions and states to components, data contracts,
responsive rules, accessibility semantics and tests. Delegate system questions
to `design-system-steward`, implementation to `implementation-engineer`, and
independent UI verification to `test-engineer`. Compare rendered output at the
required viewports and test keyboard/focus/screen-reader semantics. If Codex is
the chosen implementer, prepare an exact task file and stop until the user grants
the one-time Codex write approval.
