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
3. Inspect the controller status before asking for the request. If
   `requirement.hasFile` is true, use its recorded summary and
   `requirement.md` as authoritative user input; do not ask the user to repeat
   it and do not overwrite it with `fde request`. Ask only focused clarification
   questions needed for the plan. If `requirement.hasFile` is false, ask for the
   request in chat and record it verbatim with `fde request`.
4. Propose the smallest stage slice that produces the requested outcome. Use
   `fde plan --preview` if useful; previewing must not write plan state.
5. Show one table containing each required role, why it is needed, the focused
   specialist agent/method it will use, and all eligible account identities.
   Specialist agents are methods; account identities are selected by the user.
6. Let the user select the identity for every required role. One identity may
   hold several roles and optional specialists may be `none`. Do not turn an
   orchestrator recommendation into an assignment.
7. Show a combined summary: request, included stages, skipped stages,
   deliverables, role assignments, access needed and explicit approval gates.
   On an automatically routed run, include the proposed execution matrix from
   `fde routing show <run-id> --json` — task id, stage, required role,
   specialist method, account identity, model and effort, quality floor,
   dependency, estimated cost units and escalation ceiling — plus the complexity
   band, the confidence, and anything the controller listed as not scheduled or
   as missing information. If the assessment returned a clarification question,
   ask it before asking for approval. Resolve every ambiguity before asking for
   approval.
8. Ask the user to type `APPROVE PLAN <run-id>` exactly. General agreement is
   not approval. If anything changes, show the revised summary and ask again.
9. Only after the exact phrase, record the plan with `--require-approval`, save
   the role selections, and pass the same phrase to `fde approve-plan`. The
   controller then confirms roles, freezes the routing decision against the
   approved plan, and creates run-scoped connector config. If it refuses because
   the route recomputed differently from the one displayed, show the revised
   matrix and ask for the phrase again — never approve a route the user has not
   seen.

Nothing before step 9 authorizes connector/repository access. The user's own
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

`fde-start` maintains a Claude session ID across the process boundary. After
combined approval, tell the user to type `/exit`; the launcher resumes the same
conversation with the generated role-restricted MCP configuration and
`FDE_RUN_ID=<run-id>`. End the scoping process without fetching data. When the
launcher is not in use, provide the generated manual launch command instead.
