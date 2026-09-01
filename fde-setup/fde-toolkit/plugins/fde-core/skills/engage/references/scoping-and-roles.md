# Scoping and role assignment

Use this only before a run has confirmed roles.

## Conversation sequence

The user talks; you run the controller commands. Do not hand the workflow back
as a list of commands for them to execute.

1. `fde start [requirement]` creates a run in `awaiting_orchestrator` and reads
   nothing.
2. Ask who orchestrates. Candidates are the three Claude profiles, Claude Code
   on Bedrock and ChatGPT/Codex. Do not choose because the current session uses
   that identity.
3. Record the request verbatim with `fde request`.
4. Propose the smallest stage slice that produces the requested outcome. Show
   included stages, skipped stages and roles needed, then wait for confirmation.
5. Record the plan with `fde plan` or an appropriate `fde shapes` shortcut.
6. Put the controller's narrowed role question to the user. An identity may hold
   several roles; optional specialists may be `none`. Do not recommend defaults.
7. Record assignments with `fde roles`. Stop if an assigned identity is
   unavailable; ask for a replacement rather than silently substituting.

Nothing in this sequence authorizes connector/repository access. The user's own
request is input; it is not permission to fetch the referenced Jira item.

## Stage selection

Available stages, in order:

| Stage | Outcome |
|---|---|
| `intake` | product/client context and the requester's words |
| `research` | evidence, prior art, gaps and provenance |
| `solutioning` | architecture/ADR and UI/design-system direction where applicable |
| `review` | adversarial, PR, standards, security and reliability review |
| `reconciliation` | decision on which objections stand |
| `presentation` | stakeholder presentation |
| `planning` | development plan and Jira preview |
| `implementation` | bounded code change; Codex writes need one-use approval |
| `verification` | independent tests and quality evidence |
| `deployment` | approved rollout and rollback evidence |
| `observability` | SLOs, telemetry, alerts, runbooks and rollout health |
| `publication` | approved changes to shared external systems |

Common mappings:

- research and validation: `intake,research,review`
- architecture/ADR: `intake,research,solutioning,review,reconciliation`
- PR analysis: `--shape pr-review`
- UI design through implementation: `--shape design-to-build`
- build only: `--shape build`
- verified release: `--shape release`
- full lifecycle: `--shape full`

Include `intake` unless the user has already supplied sufficient governed
context. Advisory prerequisite warnings may be accepted only when you state
where the missing input will come from.

## Run-scoped handoff

After roles are confirmed, `mcp-sync --run <run-id>` creates role-restricted MCP
configuration. If a fresh Claude session is needed, launch the orchestrator with
that generated config and `FDE_RUN_ID=<run-id>` so SessionStart prints a bounded
brief. End the scoping session without fetching data.
