---
name: implementation
description: Implement an approved development slice under repository instructions and the strict shared engineering standards, with bounded scope, tests and recorded evidence. Use when the run reaches implementation.
argument-hint: "<run-id> <approved slice>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write, Edit
---

# Implementation

Require confirmed roles and an approved design/plan or explicitly recorded
reason why one is unnecessary. Delegate to `implementation-engineer`. Read the
repo's `AGENTS.md`/`CLAUDE.md`, then the standards sections this slice touches
(`standards list` to choose, `standards show <n>` to read — §3 or §4 for
architecture, §6 for complexity, §14 for tests). Classify the work as greenfield
or brownfield:
greenfield follows the prescribed architecture; brownfield preserves existing
structure, adds characterization tests and separates refactor from behaviour.
Search the repository and its dependency graph before creating a new utility or
pattern. For version-sensitive library behavior, verify primary documentation;
prefer a maintained dependency or an existing project abstraction when it meets
the requirement without unacceptable cost.

Use `tdd-evidence` for behavior changes. Implement the smallest complete slice,
validate contracts and failure paths, and run formatter, linter/static analysis,
types, tests and build. Coding by
Codex is allowed only through `ask-codex --write` after an exact, one-use FDE
approval; never infer that approval from general consent.
