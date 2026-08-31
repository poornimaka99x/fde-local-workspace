---
description: Show which identity can do what, and why — roles are still assigned per run
---

Print this and nothing else. It is a reminder for the user, not a task.

**Identities are not roles.** This table says what each surface is *good at*. Who
actually holds which role is decided by the user at the start of every run, in
`fde roles <run-id>`, and never inherited from the last one.

| Need | Surface | Because |
|---|---|---|
| Research volume, long documents, web grounding | `ask-gemini` | large context, ~1,000 req/day, and Bedrock has no WebSearch |
| Independent critique from another model family | `ask-codex --read-only` | disagreement is the point; read-only sandbox |
| Implementation by Codex | `fde approve-codex` then `fde invoke ... --write` | write needs a one-time, hash-bound approval every time |
| Microsoft estate — SharePoint, Outlook, Teams | `ask-ms-copilot`, or `ms-intake` for the manual path | M365 Copilot has no API; a Copilot Studio agent does |
| Jira, Confluence, Bitbucket reads | Atlassian MCP, wired only to the run's orchestrator | no permanently privileged account |
| Jira, Confluence, SharePoint, Bitbucket, email, Teams writes | `fde approve-publish <run-id> <target>` | other people watch those spaces |
| Source code in a Bitbucket repository | local git | the connector is for work items, not for your working tree |
| Full pipeline | `/engage` | roles → intake → research → architecture → review → reconcile → present → plan → implement → verify → publish |
| Onboarding a repo | `/repo-init` | writes AGENTS.md that Claude, Codex and Gemini all read |
| What is configured, what is broken | `fde doctor` | statuses only, never secrets |

GitHub Copilot is **not** part of this ecosystem. `ask-copilot` is a stub that
says so; nothing here reads or writes `~/.copilot`.
