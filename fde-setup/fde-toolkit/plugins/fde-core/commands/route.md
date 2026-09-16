---
description: Show which identity can do what, and why — roles are still assigned per run
---

Print this and nothing else. It is a reminder for the user, not a task.

**Identities are not roles.** This table says what each surface is *good at*. Who
actually holds which role is decided by the user at the start of every run — the
orchestrator first (`fde orchestrator`), the rest after the plan is set
(`fde roles`) — and never inherited from the last one.

**A run is a slice of the pipeline, not all of it.** `fde shapes` lists the
common ones; `fde plan <run-id> --stages a,b,c` scopes a run to exactly what was
asked for.

| Need | Surface | Because |
|---|---|---|
| Research volume, long documents, independent web grounding | assigned Gemini via `fde invoke` | large context and a separate model family; Bedrock orchestration can use the run-scoped isolated browser, while Gemini receives bounded evidence with `--context-file` |
| Independent critique from another model family | assigned Codex via `fde invoke` | disagreement is the point; read-only sandbox plus eligible run-scoped MCP |
| Implementation by Codex | `fde approve-codex` then `fde invoke ... --write` | write needs a one-time, hash-bound approval every time |
| Microsoft estate — SharePoint, Outlook, Teams, Copilot Notebooks | `ask-ms-copilot`, or `ms-intake` for the manual path | Microsoft Copilot is the enterprise-context surface, not a coding agent |
| Jira and Confluence reads | Atlassian MCP, wired to the run's orchestrator and assigned reviewers | no permanently privileged account; role, stage, profile and readiness still constrain it |
| GitHub or Bitbucket PR analysis | `/scm-pr-review` + local git + matching provider context | provider is detected; reviews verify the local diff |
| Jira, Confluence, SharePoint, GitHub, Bitbucket, email, Teams writes | `fde approve-publish <run-id> <target>` | other people watch those spaces |
| UI flows and prototypes | `/ui-prototype` using Figma or Claude Design | design states and accessibility are settled before code |
| Figma-to-code work | `/design-system` then `/design-to-code` | reuse tokens/components and keep a traceable design contract |
| Strict development gates | `/quality-gates` | the attached engineering standard is normative and testable |
| Deployment | `/release-observability` then an approved `deployment` publication | rollout and rollback are external state changes |
| Orchestrating a run | any Claude profile, or Codex | Gemini and MS Copilot cannot hold a run together |
| Scoping a run | `fde plan` / `fde shapes` | most work is a slice, not the whole pipeline |
| Running it | `/engage <run-id>` | orchestrator → ask → plan → roles → only the stages you asked for |
| Onboarding a repo | `/repo-init` | writes AGENTS.md that Claude, Codex and Gemini all read |
| What is configured, what is broken | `fde doctor` | statuses only, never secrets |

GitHub Copilot is **not** part of this ecosystem. `ask-copilot` is a stub that
says so; nothing here reads or writes `~/.copilot`.
