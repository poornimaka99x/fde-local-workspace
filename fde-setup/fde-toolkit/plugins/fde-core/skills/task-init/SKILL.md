---
name: task-init
description: Initialize an FDE run without accessing Jira, repositories, documents or other connected systems until the user has selected an orchestrator, confirmed the stage plan and assigned every required account role. Use at the beginning of any new piece of work.
argument-hint: "<requirement or Jira key>"
allowed-tools: Read, Bash
---

# Task initialization

Use `fde start` to create the empty run. Ask, in this order: who orchestrates;
what outcome and stages the user wants; which identity holds every required and
optional specialist role. Accounts have capabilities, never permanent jobs.
Do not suggest defaults or copy the previous run unless the user explicitly
says to. Record answers with `fde orchestrator`, `fde request`, `fde plan` and
`fde roles`. Until roles are confirmed, do not read Jira, Confluence,
SharePoint, Teams, Outlook, Figma, GitHub, Bitbucket, a repository, client
context or previous artifacts. If Codex is assigned implementation, explain
that each write invocation still requires its own `fde approve-codex` grant.
