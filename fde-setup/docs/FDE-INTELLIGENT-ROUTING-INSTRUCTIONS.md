# Claude implementation brief: intelligent FDE model, effort, and specialist routing

Implement this feature in the existing FDE repository. Do not build a second
orchestration system beside the `fde` controller. The controller-owned run files
remain the source of truth, and the browser remains a client of stable controller
commands.

## Goal

When a run is created, FDE should recommend or automatically select:

- the orchestrator model and effort;
- the smallest useful set of specialist/sub-agent tasks;
- the model and effort for each specialist task;
- whether an independent reviewer is needed;
- a bounded retry/escalation policy.

Optimize lexicographically:

1. satisfy capability, access, safety, and quality requirements;
2. among choices that satisfy those requirements, minimize expected cost/quota use;
3. then minimize latency and unnecessary agent count.

Do not interpret “minimize cost” as “always use the cheapest model.” A cheap
attempt that is likely to fail and be repeated is more expensive than one
appropriately capable attempt.

## Read before editing

Read these files completely, plus any applicable `AGENTS.md` or `CLAUDE.md`:

1. `README.md`
2. `START-HERE.md`
3. `RUNBOOK.md`
4. `claude-shared/bin/fde`
5. `claude-shared/bin/fde-start`
6. `claude-shared/config/agents.json`
7. `fde-toolkit/plugins/fde-core/skills/engage/SKILL.md`
8. `fde-toolkit/plugins/fde-core/skills/engage/references/scoping-and-roles.md`
9. `fde-gui/server/src/services/accounts.ts`
10. `fde-gui/server/src/services/controller.ts`
11. `fde-gui/server/src/services/design-panel.ts`
12. `fde-gui/server/src/routes/runs.ts`
13. `fde-gui/web/src/features/runs/NewRunForm.tsx`
14. `fde-gui/web/src/components/ClaudeSettings.tsx`
15. the controller, server, and web tests covering runs, invocation, accounts,
    sessions, and design panels.

Preserve unrelated working-tree changes.

## Existing behavior that must remain intact

- Identities are accounts, not permanent roles. Roles are assigned per run.
- A specialist/sub-agent is a focused method or task, not a new identity.
- The user still chooses or confirms the account identities holding run roles.
- No connected system or repository is read during scoping.
- The exact `APPROVE PLAN <run-id>` gate remains mandatory and must cover the
  plan, roles, and displayed routing proposal.
- Codex writes, publication, deployment, destructive actions, and degraded
  operation retain their existing separate approval gates.
- Account authentication and availability checks remain authoritative.
- Manual account/model/effort selection must remain available and backwards
  compatible.
- Existing design-panel isolation, sealed context, distinct account rules, and
  reconciliation contracts must not be weakened.

## Architectural rule

Put deterministic policy and durable decisions in the Python `fde` controller.
The GUI may request previews and render explanations, but it must not independently
score complexity, select models, create specialist plans, or write routing files.

The routing engine must be explainable and testable. Do not ask a model to return
an opaque score and blindly trust it. Version 1 should use deterministic features
from the saved request, selected shape, proposed/approved stages, attachment
metadata, role, task type, and risk flags. An optional low-cost classifier may be
added later only as advisory evidence; deterministic safety and quality floors
always win.

## New policy file

Add `claude-shared/config/routing-policy.json` and validate it strictly. Add it
to the installer’s confirm/preserve behavior so local cost and entitlement
customizations are not silently overwritten.

The policy must contain:

- `schemaVersion`;
- supported strategies: `balanced`, `quality_first`, `cost_first`, `manual`;
- per-provider/model capability tier (`economy`, `standard`, `premium`);
- compatible effort levels;
- relative cost/quota weights, not invented currency prices;
- task strengths, context limits when known, and provider limitations;
- quality floors by task/risk class;
- maximum automatic effort, agent count, parallelism, retries, and cost units;
- escalation rules;
- a policy revision identifier.

Do not hard-code live provider prices as facts. If monetary pricing is later
configured, require a source, currency, and `effectiveAt` date. Until then expose
all estimates as `costUnits` and clearly label them estimates. Do not select the
ambiguous `default` model in automatic mode because its quality and cost cannot
be compared reliably; select a concrete model offered by the chosen account.

The provider clients' live model catalogues are the availability boundary.
Refresh Codex and Gemini availability before automatic planning, keep a dated
last-known-good cache for offline use, and make `AccountService` consume that
same snapshot. Never generate a model/effort combination that
`validateSelection` rejects. Claude family aliases resolve to the provider's
latest available Haiku, Sonnet and Opus models.

## Complexity and risk assessment

Create a pure, unit-tested assessment function. It must read only already-saved
local run input and metadata during scoping. Score each dimension from 0 to 2:

- scope breadth;
- ambiguity/underspecification;
- reasoning depth or novelty;
- context volume;
- cross-system coordination;
- change reversibility and operational risk;
- verification burden.

Return:

- total score and `simple`, `standard`, `complex`, or `critical` band;
- each dimension’s score and short evidence;
- confidence (`high`, `medium`, `low`);
- risk flags;
- missing information that could change the route.

Risk overrides the arithmetic score. Security-sensitive changes, production or
deployment work, publication, destructive operations, data migration, legal or
compliance advice, authentication/authorization changes, and irreversible writes
must receive an appropriate high/critical quality floor. Low assessment
confidence must either raise the recommendation one tier or produce a focused
clarification question; it must never silently lower quality.

Keep keyword rules conservative and explainable. Do not infer repository size,
connector contents, or data sensitivity from systems FDE has not been approved
to read.

## Routing algorithm

Implement constraint-based selection, not a single weighted “smartness” number:

1. Determine the task type, stage, required role/capability, risk class, and
   quality floor.
2. Filter to authenticated/available identities assigned to that role and to
   model/effort combinations actually supported by the account.
3. Filter out choices below the quality floor or above hard context/risk limits.
4. Apply the selected strategy within the remaining choices.
5. Choose the lowest expected total cost choice that meets the floor.
6. Add specialists only where they reduce a named uncertainty or provide an
   independent check that the task needs.
7. Return the decision, alternatives considered, rejected reasons, estimated
   cost units, confidence, and escalation ceiling.

Initial specialist-count policy:

- `simple`: orchestrator only unless a required stage needs one focused
  specialist;
- `standard`: at most one specialist per active stage;
- `complex`: at most two complementary or independent specialists where their
  outputs have different purposes;
- `critical`: at most three, including a genuinely independent reviewer when
  the relevant role has a distinct eligible identity;
- never create duplicate agents that receive the same prompt and role without a
  stated independence/reconciliation reason;
- never use three agents merely because three Claude accounts exist.

Suggested quality tiers, expressed through policy rather than scattered code:

- economy model/automatic or low effort: classification, extraction, bounded
  formatting, and mechanical low-risk tasks;
- standard model/medium effort: normal research, planning, implementation, and
  test tasks with clear acceptance criteria;
- premium model/high effort: architecture, ambiguous synthesis,
  reconciliation, security/reliability review, and high-risk decisions;
- `xhigh`, `max`, or `ultra`: never the routine default. Automatic use requires
  a critical quality floor or a recorded failed lower-cost attempt and must stay
  within the approved escalation ceiling.

Do not assume models from different providers are equivalent merely because
they occupy the same tier. Put mappings and strengths in policy data.

## Orchestrator selection at run creation

Extend run creation with a routing mode and strategy:

```text
routingMode: auto | manual
routingStrategy: balanced | quality_first | cost_first
```

For `manual`, retain the current account/model/effort behavior exactly.

For `auto`:

- the user still selects the orchestrator account because authentication,
  organizational access, and provider choice are operator decisions;
- FDE selects a concrete supported model and effort from that account using
  only the submitted requirement, project metadata already stored locally, and
  optional named shape;
- if the chosen account is not authenticated or has no qualifying combination,
  fail with an actionable explanation and offer manual selection; do not silently
  switch accounts;
- persist the exact selection and rationale in the run;
- pass the selected model and effort through `fde-start` on every resume.

Add a non-mutating controller preview suitable for the form:

```bash
fde routing preview --orchestrator <identity> \
  --strategy balanced [--shape <shape>] --requirement-stdin --json
```

Add auto-routing to the authoritative creation command, which must recompute and
persist the decision rather than trusting browser output:

```bash
fde start --routing auto --strategy balanced \
  --orchestrator <identity> [--shape <shape>] -- <requirement>
```

The preview must perform no writes and no network or connector reads.

## Specialist task plan

Extend the combined scoping summary to show a proposed execution matrix with:

- stable task ID;
- stage and objective;
- required role;
- focused specialist method/agent definition;
- selected account identity;
- selected concrete model and effort;
- dependency and whether it may run in parallel;
- reason the specialist exists;
- quality floor, estimated cost units, and escalation ceiling.

Generate no specialist for work the orchestrator can safely perform without
loss of quality. Prefer narrow tasks with explicit output contracts.

Persist an approved task/routing plan in `<run>/routing.json`. Recommended
shape:

```json
{
  "schemaVersion": 1,
  "policyRevision": "...",
  "mode": "auto",
  "strategy": "balanced",
  "assessment": {},
  "orchestrator": {
    "accountId": "claude_work",
    "model": "sonnet",
    "effort": "medium",
    "reason": "..."
  },
  "tasks": [],
  "limits": {
    "maxCostUnits": 0,
    "maxParallel": 0,
    "maxRetries": 0,
    "maxAutomaticTier": "premium",
    "maxAutomaticEffort": "high"
  },
  "estimatedCostUnits": 0,
  "decisionHash": "sha256...",
  "approvedAt": null,
  "approvedWithPlanHash": null,
  "overrides": []
}
```

Before the exact plan approval, routing is a preview and may not authorize
execution. When `APPROVE PLAN <run-id>` is processed, persist/freeze the exact
displayed routing proposal with the plan hash. If recomputation differs from the
displayed proposal, refuse approval and show a revised combined summary.

Any post-approval change that increases model tier, effort, agent count, cost
ceiling, access, or scope needs explicit approval. A manual override records the
operator, timestamp, old value, new value, and reason. Never overwrite history.

## Invocation changes

Ordinary `fde invoke` currently chooses an identity but does not pass a routed
model or effort to Claude/Codex. Extend it so every invocation references an
approved task ID and the controller resolves the frozen route:

```bash
fde invoke <run-id> <identity> --task-id <task-id> --task-file <path>
```

- Validate that task stage, role, identity, model, and effort match the approved
  routing decision.
- Pass Claude `--model` and `--effort` as argument-array elements.
- Pass Codex its supported model/reasoning settings through the existing safe
  wrapper, without shell interpolation.
- Preserve Bedrock profile environment handling.
- Continue to enforce role, stage, write, and connector guards.
- Do not allow task text to inject CLI options.
- Record the resolved route in `invoke.start` and `invoke.end` events.

Design-panel participants already persist model and effort. Reuse the shared
routing policy to offer an “Auto” setting for each participant and the
reconciler, but do not change panel identity separation or allow auto-routing to
replace a distinct account with the same account twice.

## Retry and escalation

Retries must be bounded and evidence-driven:

- no retry merely because an answer is disliked;
- retry only for a classified transient provider failure, invalid output
  contract, failed deterministic validation, or failed required checkpoint;
- allow at most one same-tier retry by default;
- escalate only along the frozen approved ladder;
- never exceed approved cost units, model tier, effort, or retry count;
- if the ceiling is insufficient, pause and ask the user instead of continuing;
- preserve every failed attempt as evidence and never replace it in place.

For critical work, prefer one capable producer plus an independent reviewer over
several cheap duplicate attempts. A reviewer must not be described as independent
when it uses the same conversation/context lineage; surface degraded independence
and require the existing degraded-operation approval pattern where appropriate.

## Usage and learning loop

Record, when a provider actually reports it:

- input/output/cache tokens;
- duration;
- provider/model/effort;
- retries and escalation;
- reported monetary cost, if supplied by the provider;
- estimated cost units;
- validation/checkpoint outcome.

Mark every value as `reported`, `estimated`, or `unavailable`. Never fabricate
token or monetary values. Do not place prompts, credentials, or sensitive output
in cost telemetry.

Add an append-only `<run>/routing-events.jsonl` or use the existing event log for:

- `routing.assessed`;
- `routing.proposed`;
- `routing.approved`;
- `routing.overridden`;
- `routing.escalated`;
- `routing.budget_exhausted`.

Build read-only aggregate reporting later from these durable events. Do not let
the system silently rewrite its own policy based on a few runs. Produce
calibration recommendations for human review; policy updates remain explicit.

## GUI requirements

On **New run**:

- add `Automatic model and effort` as the recommended mode;
- keep `Manual` available;
- allow `Balanced`, `Quality first`, and `Cost first` strategies;
- keep account selection explicit;
- debounce a routing preview after sufficient request text is entered;
- show complexity band, selected model/effort, estimated cost units, confidence,
  and a short “Why this choice?” explanation;
- show warnings when information is missing or the account needs login;
- never auto-submit or approve anything.

In the scoping/run view:

- show the proposed specialist execution matrix before approval;
- clearly distinguish account identity, specialist method, model, and effort;
- show manual overrides and why they were made;
- show approved ceilings and actual/estimated usage;
- provide an accessible expandable explanation, not only color badges.

The API must call controller JSON commands, validate responses with Zod, retain
the existing bearer/CSRF protections, and never write routing files directly.

## Backwards compatibility and failure behavior

- Runs without `routing.json` remain readable and executable under legacy manual
  behavior.
- Existing API clients that send `model` and `effort` continue to work as
  `routingMode=manual`.
- Invalid policy, unknown model, unsupported effort, unavailable account, low
  confidence, or exhausted budget must produce an actionable typed error.
- Automatic routing must fail closed when it cannot meet the quality floor. It
  must not silently choose `default`, reduce effort, omit a required reviewer,
  or swap account identities.
- Status JSON must expose a bounded routing summary and warnings without dumping
  entire task prompts or telemetry logs.

## Required controller/API contracts

Add and document versioned JSON contracts for at least:

```bash
fde routing preview ... --json
fde routing show <run-id> --json
fde routing explain <run-id> [--task-id <id>] --json
fde routing override <run-id> ... --json
fde routing refresh-retries <run-id> --task-id <id> --reason <text> --json
fde status <run-id> --json
```

Add capability strings to `fde version --json` so the GUI can feature-detect
these contracts. Do not make the GUI guess from controller version text.

## Test requirements

Add controller, server, and React tests covering at least:

1. a simple request receives no unnecessary specialist and an economical valid
   route;
2. a normal implementation request receives a standard route;
3. ambiguous architecture/security/production work cannot route below its
   quality floor;
4. low confidence raises quality or requests clarification;
5. `cost_first` still respects the quality floor;
6. automatic mode never selects `default` or an unsupported effort;
7. preview is deterministic, performs no writes, and reads no connected source;
8. creation recomputes and persists the authoritative decision;
9. exact plan approval freezes the displayed decision hash;
10. a changed decision cannot be approved under a stale hash;
11. invocation passes the exact approved model/effort through argument arrays;
12. task text beginning with `-` cannot become CLI options;
13. unavailable/login-required accounts fail actionably without account
    substitution;
14. retries and escalation stop at all approved ceilings;
15. critical work requires independent review or an explicit degraded decision;
16. manual mode remains backwards compatible;
17. legacy runs without routing data still work;
18. missing provider usage is displayed as unavailable, never zero;
19. the browser preview and explanation are keyboard accessible;
20. design panels retain sealed context and distinct-account guarantees.

Use fake model catalogs and cost weights in tests. Tests must not call live model
providers or depend on current commercial prices.

Run at minimum:

```bash
python3 -m unittest discover -s tests
cd fde-gui && npm test
cd fde-gui && npm run typecheck
cd fde-gui && npm run build
```

Do not dismiss existing failures. Identify whether each failure is introduced,
pre-existing, or platform-specific, and report evidence.

## Implementation sequence

Implement in small reviewable phases:

1. policy schema, pure assessor, constraint router, JSON preview, and unit tests;
2. durable `routing.json`, status/version contracts, hashes, approval binding,
   and backwards compatibility;
3. approved task IDs and model/effort propagation through invocation;
4. GUI auto/manual mode, preview, explanations, overrides, and login failures;
5. bounded retry/escalation and usage telemetry;
6. design-panel reuse and calibration reporting.

At the end of each phase, run its focused tests. Do not begin runtime auto-
dispatch until routing decisions are durable, approval-bound, and visible.

## Definition of done

This work is complete only when a user can create an auto-routed run, see and
understand the proposed orchestrator and specialist choices before approval,
override them, approve the exact combined plan, and observe that each invocation
uses the frozen model/effort without exceeding agent, retry, or budget ceilings.
The run must retain auditable evidence explaining every choice and escalation,
while manual and legacy runs continue to work.

When finished, report:

- files and contracts changed;
- policy defaults and the reason for each;
- controller/server/web test results;
- one simple, one complex, and one critical routing example;
- known limitations, especially where providers do not report usage or cost.
