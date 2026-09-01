---
name: task-init
description: Initialize an interactive FDE run without accessing connected systems until the user selects an orchestrator, chooses identities for the proposed roles and explicitly approves the combined plan. Use at the beginning of any new piece of work.
argument-hint: "<requirement or Jira key>"
allowed-tools: Read, Bash
---

# Task initialization

Prefer `fde-start` for an interactive orchestrator chat, or use `fde start` to
create the empty run manually. Ask, in this order: who orchestrates; what outcome
the user wants; which stages and specialist agents are needed; which identity
holds every required and optional role. Accounts have capabilities, never
permanent jobs. Show the request, stages, skipped work, deliverables, roles,
identities, access and later approval gates as one combined proposal. Do not
suggest defaults or copy the previous run unless the user explicitly says to.

Require the user to type `APPROVE PLAN <run-id>` exactly. Only then record the
plan with `fde plan --require-approval`, select roles with `fde roles`, and pass
the exact phrase to `fde approve-plan`. Until that approval succeeds, do not
read Jira, Confluence,
SharePoint, Teams, Outlook, Figma, GitHub, Bitbucket, a repository, client
context or previous artifacts. If Codex is assigned implementation, explain
that each write invocation still requires its own `fde approve-codex` grant.
