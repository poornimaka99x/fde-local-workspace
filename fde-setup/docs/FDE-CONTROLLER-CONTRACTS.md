# Controller contracts (schema version 1)

Machine-readable views of the FDE controller. The local **FDE Control Center**
GUI, and anything else that reads a run without being a person, uses these
instead of parsing human output.

Two rules hold for every reader:

- **The controller owns workflow state.** `manifest.json`, `plan.json`,
  `roles.json`, `approvals.jsonl`, `checkpoints.jsonl` and `events.jsonl` are
  written by `fde` and by nothing else. A reader may index those files directly;
  it may never write them.
- **Human output is unchanged.** `--json` is an addition. Every existing command
  prints exactly what it printed before.

Every payload carries `"schemaVersion": 1`. It is bumped when a field changes
meaning, not when one is added. In JSON mode stdout carries JSON and nothing
else; warnings and errors go to stderr, and an unknown run or project exits
nonzero with empty stdout.

## Commands

```bash
fde version [--json]
fde list --json
fde status <run-id> --json [--events-limit N] [--events-cursor OFFSET]
fde projects --json
fde project create --name <name> [--description <text>] [--repo <path> ...] [--json]
fde project update <project-id> [--name <name>] [--description <text>] [--repo <path> ...] [--json]
fde project show <project-id> [--json]
fde attach <run-id> <source-path> [--name <original-name>] [--max-bytes N] [--json]
fde attach <run-id> --stdin --name <original-name> [--max-bytes N] [--json]
fde attachments <run-id> [--json]
fde start [requirement] --project <project-id>
fde start --json [--orchestrator <who>] [--project <id>] [--shape <name>]
          [--model <alias-or-id>] [--effort auto|low|medium|high|xhigh|max]
          [--routing manual|auto] [--strategy balanced|quality_first|cost_first]
          [-- <requirement>]

fde approve-plan <run-id> [--reapprove]
fde routing preview --orchestrator <who> [--strategy <s>] [--shape <name>]
          [--stages a,b,c] [--project <project-id>]
          (--requirement-stdin | --requirement -- <text>) --json
fde routing propose <run-id> [--strategy <s>] --json
fde routing show <run-id> --json
fde routing explain <run-id> [--task-id <task-id>] --json
fde routing override <run-id> (--task-id <task-id> | --orchestrator)
          [--model <id>] [--effort <e>] [--account <identity>]
          --reason <text> [--approve] --json
fde routing attempts <run-id> [--task-id <task-id>] --json
fde routing outcome <run-id> --task-id <task-id> --status pass|fail
          [--classification transient-provider|invalid-contract|failed-validation|failed-checkpoint]
          [--evidence <text> ...] [--usage-file <path>] --json
fde routing refresh-retries <run-id> --task-id <task-id> --reason <text>
          [--approve] --json
fde routing report [--project <project-id>] [--since <iso>] [--min-sample N] --json
fde design-panel create <run-id> ... [--routing manual|auto] [--strategy <s>]
fde invoke <run-id> <identity> (<task-file> | --task-file <path>)
          [--stage <stage>] [--task-id <task-id>]

fde design-panel create <run-id> --json [--brief <text> | --brief-file <path> | --brief-stdin]
          --participant <agent>:<lens>[:<effort>[:<model>]] ...
          [--lens <participant>=<text>] [--mode independent|collaborative]
          [--output recommendation|prototype|design-to-code]
          [--attachment <attachment-id> ...] [--include-product-md] [--include-design-md]
          [--reference <catalog-id> ...] [--pack <pack>[:<dial>=<n>,...]]
          [--acknowledge-pack-conflict] [--media-support none|file]
          [--propose-plan] [--replace]
fde design-panel show <run-id> --json
fde design-panel context <run-id> --json
fde design-panel start <run-id> <participant-id> [--json | --print-prompt]
fde design-panel record <run-id> <participant-id> --status ok|failed
          [--stdin | --file <path>] [--error <text>] [--json]
fde design-panel stop <run-id> <participant-id> [--json]
fde design-panel retry <run-id> <participant-id> [--json]
fde design-panel recover <run-id> [--json]
fde design-panel approve-degraded <run-id>
fde design-panel reconcile <run-id> [--json | --print-prompt]
fde design-panel record-reconciliation <run-id> --status ok|failed
          [--stdin | --file <path>] [--error <text>] [--json]
fde design-panel references --json
fde design-panel packs --json
fde design-panel lenses --json
```

## Checking compatibility first

`fde version --json` says what this controller is and which contracts it speaks:

```json
{
  "schemaVersion": 1,
  "toolkit": "fde-core",
  "contracts": ["list --json", "status --json", "projects --json", "..."],
  "capabilities": ["routing.policy.v1", "routing.preview", "routing.propose",
                   "routing.show", "routing.explain", "routing.override",
                   "routing.start-auto", "routing.invoke-task-id",
                   "routing.status-summary"],
  "routingPolicy": {
    "state": "available",
    "policyRevision": "2026-09-07.1",
    "schemaVersion": 1,
    "strategies": ["balanced", "quality_first", "cost_first"],
    "providers": ["anthropic", "bedrock", "codex"],
    "costUnitsAreEstimates": true,
    "monetaryPricing": "not configured"
  }
}
```

Feature-detect on `capabilities`, not on a version number. Each string is added
when its contract ships and is never repurposed. `routingPolicy.state` is
`"unavailable"` with a `code` and a `message` when the policy on disk is missing
or invalid — `fde version --json` still answers 0 in that case, because
"automatic routing is unavailable and here is why" is a useful answer and a
traceback is not.

Ask this before depending on a contract. A controller that predates them answers
argparse's own refusal — `invalid choice: 'version'`, or
`unrecognized arguments: --json`, with exit 2. That is an **installation**
problem, not a workflow refusal: the fix is `./install.sh --update` from the
fde-setup checkout, and a reader should say so rather than showing a usage
string. The local console does exactly this.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | bad input: unusable id, missing name, refused attachment, nothing to update |
| 4 | unknown run or project, or a record too malformed to interpret |

The existing codes (5 illegal transition, 6 guard, 7 approval, 9 evidence,
10 hygiene) are unchanged.

## Projects

A project groups runs. It holds no workflow state of its own.

```text
~/.claude-shared/projects/<project-id>/project.json
~/.claude-shared/projects/<project-id>/events.jsonl
```

Override the root with `FDE_PROJECTS_DIR`.

```json
{
  "schemaVersion": 1,
  "projectId": "returns-modernisation-a1b2",
  "name": "Returns modernisation",
  "description": "Improve store and web returns workflows",
  "repoPaths": ["/absolute/path/to/repository"],
  "createdAt": "2026-09-03T11:10:43+01:00",
  "updatedAt": "2026-09-03T11:10:43+01:00"
}
```

- Ids are generated by the controller: a slug of the name plus a random suffix.
  Names need not be unique; ids are.
- `repoPaths` are resolved through symlinks, must already exist and must be
  directories. The controller reads about repositories; it never initialises,
  clones, modifies or deletes one.
- `fde project update --repo` **replaces** the recorded list.
- `project.created` and `project.updated` are appended to the project's own
  `events.jsonl`, as is `run.created` when a run is started under it. Updating a
  project never rewrites a run's events.
- There is no project deletion.

`fde projects --json`:

```json
{
  "schemaVersion": 1,
  "projects": [{ "...project fields...": null, "runCount": 3, "lastActivityAt": "..." }],
  "unassignedRunCount": 7,
  "warnings": ["...a malformed project.json, named rather than hidden..."]
}
```

`fde project show <id> --json` adds `runs` (the run summaries below), `events`
and `malformedEvents`.

## Creating a run

`fde start --json` prints the created run and nothing else on stdout; the usual
narration — what was read, what to do next — goes to stderr, so a machine reader
loses none of it and parses none of it.

```json
{
  "schemaVersion": 1,
  "run": { "...the run summary above..." },
  "nextAction": "fde plan <run-id> --stages <stages>   — scope the work; reads nothing"
}
```

Put `--json` **before** the requirement, and pass the requirement after `--`:
everything following `--` is the ask, so a requirement that begins with a dash
is text rather than a flag.

Creating a run assigns no specialist role and approves no plan. A run arrives in
`awaiting_plan` (or `awaiting_roles` when `--shape` was given), exactly as it
does from a terminal.

`--model` and `--effort` are session choices, not workflow authority. They are
stored in the manifest as `sessionConfig` and `fde-start --resume` reapplies
them to the same Claude conversation. Omitting them records `default` and
`auto`. A GUI must validate model identifiers and effort values before passing
them to the controller.

## Containment rules every reader can rely on

- **A run id is a name, not a path.** Separators, `.` and `..` are refused with
  exit 2, and `<runs root>/<run id>` must be a real directory sitting directly in
  the runs root. A symlink standing in for a run is refused (exit 4) by every
  command and never appears in `fde list`.
- **A project record must name itself.** If `project.json` carries a
  `projectId` different from the directory it lives in, every command that
  touches it exits 4 rather than acting on the id inside the file — that value is
  used to build paths.
- **A manifest's `projectId` is data.** A value that is not a usable project id
  is reported in `warnings` and ignored; it is never used as a path.
- **A JSONL record is a JSON object.** A line that parses to a string, number,
  `null` or array is reported as malformed alongside genuinely broken lines. It
  is never treated as a record, and never rewritten.

## Runs

`fde start --project <id>` records `projectId` in `manifest.json`. A run created
before projects existed has `projectId: null` and belongs to the **Unassigned**
group. Nothing else about run creation changed.

`fde list --json` returns `runs`, each a summary:

```json
{
  "runId": "20260903-acme-142-cd3d",
  "dir": "/Users/.../.claude-shared/runs/20260903-acme-142-cd3d",
  "state": "awaiting_plan",
  "blockedFrom": null,
  "projectId": "returns-modernisation-a1b2",
  "requirement": "ACME-142 returns orchestration",
  "jiraKey": "ACME-142",
  "createdAt": "...", "updatedAt": "...",
  "orchestrator": { "agentId": "claude_work", "label": "Claude: work", "kind": "claude" },
  "stages": ["intake", "research"],
  "planConfirmed": true,
  "session": { "...see below..." },
  "malformed": false
}
```

Completion is never inferred from artifacts. `state` is the answer.

## Run status

`fde status <run-id> --json` returns the run in one payload:

| Field | Contents |
|---|---|
| `manifest`, `state`, `blockedFrom` | the manifest as written, and its state |
| `projectId`, `project` | the project id, and its name/repositories when the project resolves |
| `requirement` | `summary`, `jiraKey`, `hasFile`, `path` |
| `plan`, `planLine`, `stageTimeline`, `sequence` | the confirmed plan, and each stage as `done`/`current`/`pending` |
| `nextState`, `nextAction` | the next legal state, and the controller's own next-step line |
| `roles` | `confirmed`, `confirmedAt`, `selectedAt`, `orchestrator`, and one row per needed role with agent ids and display labels |
| `approvals` | replayed approval ledger with `status` of `valid`/`consumed`/`expired`/`revoked`/`malformed` |
| `checkpoints` | the checkpoint ledger as recorded |
| `events` | one bounded page (see below) |
| `artifacts` | `expected` (from the plan) and `discovered` (never following symlinks) |
| `attachments` | the input attachment ledger |
| `outputHygiene` | the last hygiene run: status, counts, evidence path, digest, whether the evidence file is still present |
| `session` | see below |
| `warnings` | malformed ledger lines, a project that no longer resolves, and similar |

Availability of an identity is deliberately **not** in this payload: it would
mean touching the Keychain and the network on every poll. Use `fde doctor` for
that, on demand.

### Events

`events` is a page, never the whole ledger:

```json
{ "total": 128, "offset": 78, "limit": 50, "returned": 50, "nextCursor": null, "items": [] }
```

With no cursor you get the **latest** page. `--events-cursor <offset>` pages
forward from a line offset; `nextCursor` is the next offset, or `null` at the
end. `--events-limit` is capped at 1000.

### Malformed lines

A ledger is append-only and can be read mid-write, so the last line may be half
a record. Such a line is reported — in `warnings`, and in `malformed` for
attachments — never dropped, never repaired, never rewritten.

### Session

Derived, honest, and opaque:

```json
{
  "provider": "claude",
  "profile": "work",
  "sessionId": "0b9d6c2e-1f3a-4a5b-8c7d-9e0f1a2b3c4d",
  "resumable": true,
  "resumeReason": null
}
```

- The orchestrator comes from `roles.json`; the provider is that identity's kind.
- `sessionId` is read from `orchestrator-session-id`, checked only for shape
  (`[A-Za-z0-9._-]{1,200}`) and handed back. It is a resume token and nothing
  else: no transcript store is read, and no id is derived or invented.
- Claude-led runs are resumable through `fde-start --resume <run-id>`, whether or
  not a session has been recorded yet; `resumeReason` says which case you are in.
- Codex-led runs are **not** resumable here. `resumeReason` is
  `"Resume this run in its original Codex task"`. A Codex task id is never
  derived from a run id.

## Attachments

```bash
fde attach <run-id> ./requirements.pdf
fde attach <run-id> --stdin --name requirements.pdf < requirements.pdf
fde attachments <run-id> --json
```

```text
<run-dir>/inputs/files/<generated-name>
<run-dir>/inputs/attachments.jsonl
```

```json
{
  "schemaVersion": 1,
  "attachmentId": "9f1c...",
  "runId": "20260903-acme-142-cd3d",
  "originalName": "requirements.pdf",
  "storedName": "requirements-af3fcf73.pdf",
  "relativePath": "inputs/files/requirements-af3fcf73.pdf",
  "mediaType": "application/pdf",
  "size": 12345,
  "sha256": "hex digest of the bytes actually stored",
  "attachedAt": "ISO-8601",
  "source": "file"
}
```

- Bytes are **copied**. The source is never moved, modified or deleted.
- Symlinks are refused at `open()` with `O_NOFOLLOW`, so there is no window
  between checking a path and reading it. Directories, devices, sockets and
  fifos are refused too.
- `originalName` is the sanitized display name: everything up to the last
  separator is discarded, so `../../etc/passwd` becomes `passwd`. A caller's
  filename never becomes a path or a shell word.
- `storedName` is generated and collision-resistant. The write is an atomic
  temporary sibling plus rename, and the digest is of the bytes that landed.
- Default ceiling 100 MiB. `FDE_MAX_ATTACHMENT_BYTES` and `--max-bytes` may only
  lower it; neither can raise it.
- Every attachment appends `attachment.added` to the run's `events.jsonl`.
- Records are immutable. There is no detach in this version.
- **A GUI uploads through `fde attach --stdin --name`**, so a browser-supplied
  filename never reaches the filesystem or a command line.

## What these contracts do not do

They add no state machine, no approval shortcut and no bypass. Plan approval,
Codex write approval, deployment approval and publication approval are unchanged
and are still typed by the operator, every time.

## Design panels

A design panel is a normal run in the `design-panel` shape, whose `uiUxDesign`
role is held by two or three Claude identities. The controller owns the panel
record exactly as it owns the plan and the roles: `design-panel.json`,
`artifacts/design-panel/context-manifest.json`, `common-context.md` and every
proposal are written by `fde` and by nothing else.

### Multi-valued role assignments

`uiUxDesign` joins `research` and `review` as a role a run may give to several
identities. On the wire that is the existing shape — `assignments.uiUxDesign` is
a list, and `status --json` reports `multi: true` on that row. **A record written
when it was single-valued still reads**: a bare string is normalised to a
one-element list by every reader, and no record is rewritten to migrate it.

### `design-panel show --json`

```json
{
  "schemaVersion": 1,
  "designPanel": {
    "schemaVersion": 2,
    "runId": "20260906-returns-aaaa",
    "panelId": "panel-a1b2c3d4",
    "state": "running",
    "mode": "independent",
    "outputTarget": "recommendation",
    "rolesConfirmed": true,
    "pendingRoles": [],
    "runState": "solutioning",
    "conceptStageReady": true,
    "reconcileStageReady": false,
    "barrierOpenedAt": null,
    "degradedApprovedAt": null,
    "context": { "contextSha256": "…", "manifestSha256": "…", "commonContextBytes": 4096 },
    "contextManifest": { "…the manifest as written…": null },
    "handoffOrder": ["claude_work", "claude_msc"],
    "mediaFiles": [
      { "runPath": "artifacts/design-panel/media/9f1c00aa.png", "sha256": "…",
        "originalName": "screen.png", "mediaType": "image/png", "bytes": 20480 }
    ],
    "participants": [
      {
        "participantId": "claude_work", "label": "Claude: work",
        "model": "opus", "effort": "high", "lensId": "flow", "order": 0,
        "state": "succeeded", "attempts": 1, "durationMs": 61000,
        "commonContextSha256": "…", "promptSha256": "…",
        "handoffFrom": [], "handoffSha256": null,
        "proposalPath": "artifacts/design-panel/proposals/claude_work.md",
        "proposalPresent": true,
        "prototypePath": "artifacts/design-panel/prototypes/claude_work.html",
        "prototypePresent": true, "error": null
      }
    ],
    "succeededCount": 1,
    "reconciliation": { "state": "pending" },
    "artifacts": [{ "path": "artifacts/design-panel/final-design.md", "present": false }],
    "nextAction": "…"
  },
  "nextAction": "…"
}
```

Participant states are `pending`, `running`, `succeeded`, `failed`, `stopped`
and `interrupted`. The last four are terminal; only `failed`, `stopped` and
`interrupted` can be retried.

The panel document is `schemaVersion: 2`. Version 2 adds `order` and
`handoffFrom` (the collaborative handoff), `mediaFiles` (the sealed copy and
digest of every image the panel passes through) and `prototypePath` (the
artifact a `prototype` panel produces). A version-1 panel on disk is refused
rather than half-read, because none of those claims can be recovered from it.

### `design-panel start --json`

Applies every guard — plan confirmed, roles confirmed, the run in `solutioning`,
the participant holding `uiUxDesign`, the participant `pending`, at most three
running, in a collaborative panel every participant ahead of it finished, and
every sealed image still matching its recorded digest — and answers with the
exact prompt for that one participant:

```json
{
  "schemaVersion": 1, "runId": "…", "panelId": "…", "participantId": "claude_work",
  "profile": "work", "model": "opus", "effort": "high", "attempt": 1,
  "commonContextSha256": "…", "promptSha256": "…", "promptBytes": 4096,
  "prompt": "…the shared context, the handoff if any, then this lens block…",
  "mediaPaths": ["/…/artifacts/design-panel/media/9f1c00aa.png"],
  "handoffFrom": [], "handoffSha256": null,
  "proposalPath": "artifacts/design-panel/proposals/claude_work.md"
}
```

`mediaPaths` are the run's own sealed copies, re-hashed against the manifest
during this call. They are never paths into the operator's writable attachment
directory: a digest checked once when the panel was created would say nothing
about the bytes the *next* participant receives.

The shared context is a **strict prefix** of the prompt, and
`commonContextSha256` is the digest of that prefix. It is identical for every
participant in a panel, and the controller refuses to start a participant whose
prompt would break the independent-first barrier.

In a **collaborative** panel the prompt carries, between the shared context and
the lens block, a `<handoff>` block holding the proposals of the participants
ahead of this one, each with its digest. `handoffFrom` names them,
`handoffSha256` digests the block, and the run log records a
`design-panel.handoff` event. The order is enforced: a participant whose
predecessors have not finished is refused.

A reader is expected to run that one account and hand the answer back through
`design-panel record`. It must not compose a prompt of its own, and must not
write into `artifacts/design-panel/`.

### `design-panel reconcile --json`

Refuses unless the run is in `reconciliation`, every participant has finished or
failed, and at least two proposals succeeded — or exactly one did **and**
`design-panel approve-degraded` has been typed. It opens the information
barrier, records that opening as an event, and answers with the reconciliation
prompt, `degraded`, and the orchestrator identity to run it with.

`design-panel record-reconciliation` refuses an answer that does not carry
`## Comparison`, `## Reconciliation` and `## Final design recommendation` — plus
`## Prototype` when the output target is `prototype`, or `## Design-to-code
handoff` when it is `design-to-code` — in that order, with no empty section. A
refused answer writes nothing.

When the output target is `prototype`, `## Prototype` must contain exactly one
```html fenced block holding a complete, self-contained HTML document that
fetches nothing over the network. `design-panel record` applies the same rule to
each participant's proposal. The controller extracts the document into
`artifacts/design-panel/prototypes/` and refuses prose about a prototype: a
refused proposal leaves the participant `running` and retryable, and writes
nothing.

### Events

Appended to the run's `events.jsonl`, append-only like everything else:

```text
design-panel.created            design-panel.context-sealed
design-panel.participant.started    design-panel.participant.succeeded
design-panel.participant.failed     design-panel.participant.stopped
design-panel.participant.retried    design-panel.interrupted
design-panel.participants-finished  design-panel.barrier-opened
design-panel.degraded-approved      design-panel.reconciliation.started
design-panel.reconciliation.failed  design-panel.reconciliation.completed
design-panel.final-selected
```

A degraded-reconciliation approval is also appended to `approvals.jsonl` as
`design-panel-degraded-approval`. It is a separate record type from the Codex
and publication approvals and does not appear in the `approvals` view, which
continues to report only those two.

### `status --json`

Gains one additive field, `designPanel`: `null` for a run without one, a small
summary otherwise (`panelId`, `state`, `mode`, `outputTarget`, `contextSha256`,
`participants` — each with `order`, `handoffFrom` and `prototypeSha256` —
`succeededCount`, `reconciliation.state`). A panel written by a
schema this controller does not speak answers `{"readable": false}` rather than
a guess. `schemaVersion` is unchanged: a field was added, not redefined.

### Catalogs

`design-panel references|packs|lenses --json` describe what an operator may
choose from. They read only the vendored tree under
`fde-toolkit/plugins/fde-core/vendor/`, verify each file against
`design-sources.lock.json` before using it, and refuse anything that has drifted
(exit 2) or is not in the lock at all.

## Routing

Routing chooses the orchestrator's model and effort, the smallest useful set of
specialist tasks, the model and effort for each, and the ceiling on all of it.
Three properties matter to a reader:

- **The controller decides.** A client may ask for a preview and render an
  explanation. It must not score complexity, select a model, invent a specialist
  plan, or write `routing.json`. `fde start --routing auto` recomputes the
  decision from the run's own files rather than trusting anything sent to it.
- **A route is a preview until the plan is approved.** Before
  `APPROVE PLAN <run-id>` it authorises nothing, and it is recomputed whenever
  the plan or the role assignment moves. The approval freezes the exact
  displayed decision. Because that gate is what freezes the route, recording a
  plan on an auto-routed run always sets `approvalRequired`, whether or not
  `--require-approval` was passed.
- **Costs are relative estimates.** Every figure is in `costUnits` and every
  payload carries `costUnitsAreEstimates: true`. There are no provider prices in
  this toolkit. If monetary pricing is ever configured it must carry a source, a
  currency and an `effectiveAt` date; a bare number is refused by policy
  validation.

### The policy

`~/.claude-shared/config/routing-policy.json` holds model classification and
routing judgement: tier assignments, relative cost weights, quality floors,
per-band ceilings and the escalation ladder. Live availability is separate.
Before an automatic proposal, FDE queries `codex debug models` and `agy models`,
intersects their visible models and efforts with policy metadata, and saves a
last-known-good snapshot at `~/.claude-shared/cache/model-catalog.json`. Claude
uses the CLI's `haiku`, `sonnet` and `opus` latest-family aliases. The policy is
validated strictly on every load: an unknown effort, a
tier below its own band's floor, a descending escalation ladder, the ambiguous
`default` model, or a price without provenance are each refused with the field
named.

`default` is absent because a decision naming it cannot be compared or audited,
and `ultra` is absent because no automatic route may reach it. Retired models
are removed when the installed client no longer lists them; newly listed Codex
and Gemini models receive deterministic fallback classification until explicit
policy metadata ships. The console reads the same snapshot, so
`validateSelection` and the controller share one availability boundary. The
snapshot digest is approval-bound in the routing decision.

`fde routing models --refresh` shows the exact catalogue and its provenance.
If discovery is offline, FDE uses the dated last-known-good provider snapshot
and reports the fallback. It never treats a failed refresh as proof that a model
exists.

The installer treats the policy as **confirm**: a shipped change is shown as a
diff and applied only with the operator's say-so, so local cost and entitlement
customisations survive an update.

### `routing preview --json`

It creates no run and reads no client data, repository or connector. It may
refresh provider model metadata and its cache. Same request, policy and model
catalogue digest gives the same `decisionHash`; availability changes deliberately
produce a different decision.

```json
{
  "schemaVersion": 1,
  "preview": {
    "policyRevision": "2026-09-07.1",
    "mode": "auto",
    "strategy": "balanced",
    "effectiveBand": "standard",
    "assessment": {
      "score": 4, "maxScore": 14, "band": "standard", "bandFromScore": "standard",
      "confidence": "medium", "qualityFloor": "standard", "riskFloor": "standard",
      "strictestStageFloor": "high",
      "dimensions": [{"id": "scopeBreadth", "label": "scope breadth", "score": 1,
                      "evidence": "3 stages planned"}],
      "riskFlags": [{"flag": "codeChange", "floor": "standard", "evidence": "..."}],
      "overrides": [], "missingInformation": [], "clarification": null
    },
    "orchestrator": {"accountId": "claude_work", "account": "work",
                     "provider": "anthropic", "routable": true,
                     "model": "sonnet", "effort": "medium", "tier": "standard",
                     "qualityFloor": "standard", "costUnits": 4.0,
                     "retryProbability": 0.15, "expectedCostUnits": 4.6,
                     "reason": "...", "strategyRule": "...",
                     "escalationCeiling": {"tier": "standard", "effort": "high",
                                           "maxRetries": 1, "rungsAbove": 1,
                                           "requiresRecordedFailureAbove": {"...": "..."}},
                     "alternatives": [], "rejected": []},
    "tasks": [],
    "limits": {"maxSpecialists": 6, "maxSpecialistsPerStage": 1, "maxParallel": 2,
               "maxRetries": 1, "maxCostUnits": 60,
               "maxAutomaticTier": "standard", "maxAutomaticEffort": "high",
               "requireIndependentReview": false},
    "estimatedCostUnits": 4.6, "costUnitsAreEstimates": true,
    "notScheduled": [], "unroutable": [], "warnings": [],
    "specialistCount": 0, "discretionaryCount": 0,
    "decisionHash": "sha256:...",
    "provisional": true,
    "provisionalReason": "no role assignment exists yet, ..."
  }
}
```

`provisional` is always true here: at preview time no role has been assigned, so
only the orchestrator's own stages carry tasks. The authoritative matrix is
computed when the plan and roles are recorded.

The assessment reads only what is already on this disk — the recorded request,
the stage slice, attachment **metadata**, and the project's repository count. It
never infers anything about the contents of a repository, a connector or a
client system.

Two rules are load-bearing. **Risk overrides the arithmetic score**: a security,
authentication, production, destructive, migration, compliance or payment
concern raises the band and the floor whatever the dimensions added up to.
**Low confidence never lowers quality**: an uncertain assessment is routed one
tier higher *and* returns the question that would settle it, in
`assessment.clarification`.

### Task records

Each entry in `tasks` describes one unit of work and is the thing an invocation
is later checked against:

| Field | Meaning |
|---|---|
| `taskId` | stable within a plan; `<stage>-<n>` |
| `stage`, `objective` | the FDE stage and what this task is for |
| `requiredRole`, `roleLabel` | the role that authorises it |
| `specialist`, `specialistReason` | the focused method, or `null` when the role's own account does the stage directly — and why |
| `accountId`, `accountAvailable` | the identity, and whether it is available on this machine |
| `model`, `effort`, `tier`, `provider`, `routable` | the concrete selection |
| `qualityFloor`, `band` | the floor it must clear and the band its ceilings come from |
| `dependsOn`, `parallelizable` | ordering |
| `estimatedCostUnits`, `escalationCeiling` | the estimate and the bound |
| `independence` | present only on an independent check: `independent`, `of`, `reason`, `requiresDegradedApproval` |

Account identity, specialist method, model and effort are four different things
and are always four different fields. A check is only described as independent
when a **different** eligible identity holds it; otherwise `independent` is
false, `requiresDegradedApproval` is true, and the run's existing
degraded-operation approval applies before relying on it.

### `routing show|explain|override --json`

`show` returns the stored record plus the same bounded summary `status --json`
carries. `explain` returns the assessment with per-dimension evidence, the
alternatives considered, and each rejected combination with the reason it was
rejected; when the policy on disk has moved since the decision was made,
`policyDrift` says so rather than pretending today's candidate set is the one
that was approved.

`override` changes one decision on the record. It refuses a model the policy does
not offer (`routing-not-in-catalog`), refuses anything below the target's quality
floor (`routing-below-floor`), and requires the operator to type
`APPROVE ROUTING <run-id>` before raising a tier, an effort or an account —
`--approve` records that this already happened. Each change appends an entry with
`at`, `operator`, `target`, `field`, `from`, `to`, `reason`, `escalation`,
`previousDecisionHash` and `decisionHash`. History is never overwritten.

### Approval binding

`APPROVE PLAN <run-id>` covers the plan, the roles and the route together. On
approval the controller recomputes the route; if the recomputation differs from
the one last displayed it **refuses** with `routing-decision-changed` (exit 5)
and prints the revised proposal instead of approving something nobody saw.

The freeze records `approvedAt`, `approvedBy` and `approvedWithPlanHash` — a
hash of the exact stage slice and role assignment. If either changes afterwards,
`status --json` reports `routing.planHashMatches: false` with a warning,
`nextAction` names the fix, and every invocation is refused with
`routing-plan-changed`.

There are two ways back, because the two changes differ. **Amending the plan**
(`fde plan <run-id> --add <stage>`) rewrites `plan.json` without
`executionApprovedAt`, so the run returns to the ordinary combined gate and
plain `fde approve-plan <run-id>` covers the recomputed route. **Reassigning a
role** leaves the plan approved, so it needs `fde approve-plan <run-id>
--reapprove`, which is refused when there is in fact nothing to re-approve.

Either way the previous freeze is superseded rather than discarded: the old
`approvedAt`, `approvedBy`, `approvedWithPlanHash`, `decisionHash` and the reason
it stopped applying are appended to `supersededApprovals`, and a
`routing.proposed` event records the supersession before the recomputation. The
new route still has to be read and approved with the typed phrase; nothing is
re-frozen silently.

### `invoke --task-id`

On an automatically routed run, `--task-id` is required and names the approved
task the invocation carries out. The controller resolves the frozen route and
checks the stage, the role, the identity, the model and the effort against it; a
mismatch is refused, never reconciled, and no identity is ever substituted for
another. The selection reaches the CLI as separate argument-array elements
(`claude --model <m> --effort <e> -p <body>`; `ask-codex ... --model <m>
--effort <e>`), so the task body is always the value of a preceding option and a
task file beginning with `-` is text, not a flag. `invoke.start` and
`invoke.end` record the resolved route.

Codex and Gemini sidecar invocations also accept repeatable `--context-file`
arguments. Each path must resolve to a regular file inside the run; symlinks and
paths outside it are refused, and the combined payload is capped at 512 KiB.
The start event records each relative path and SHA-256. Codex additionally gets
the role's eligible MCP servers as per-invocation overrides. Antigravity uses a
run-local workspace MCP config and isolated permission file, so Gemini gets the
role's eligible MCP servers without widening its machine-global configuration.
Both providers also receive the explicit evidence packet.

A run with no `routing.json` keeps the original behaviour exactly: `claude -p
<body>`, no `--task-id`, `route.source: "manual"`. Passing `--task-id` to such a
run is refused rather than ignored.

### `status --json`

Gains one additive field, `routing`: `null` for a run with no routing record, a
bounded summary otherwise — mode, strategy, `policyRevision`, band, score,
confidence, quality floor, risk flags, the orchestrator's selection, up to 50
task rows, limits, `estimatedCostUnits`, `approved`, `decisionHash`,
`approvedWithPlanHash`, `planHashMatches`, `overrideCount`, `notScheduled`,
`unroutable` and `warnings`. Task prompts, telemetry logs and full candidate sets
are deliberately absent; `routing explain` is where those live. A record written
by a schema this controller does not speak answers `{"readable": false}` rather
than a guess.

`routing.usage` reports provider usage, and reports it honestly. Until a provider
actually returns figures it is `{"state": "unavailable", "reason": "..."}`.
Nothing here is ever written as zero, and no token or monetary value is inferred.

### Events

`<run>/routing-events.jsonl` is append-only and uses a closed vocabulary:
`routing.assessed`, `routing.proposed`, `routing.approved`, `routing.overridden`,
`routing.escalated`, `routing.budget_exhausted`. A bounded line for each is also
appended to the run's own `events.jsonl`, so "what did this run decide" does not
need a second log to answer. Neither file is ever rewritten.

### Routing exit codes and error codes

JSON callers get `{"schemaVersion": 1, "error": {"code", "message", "hint"}}` on
stdout with a documented exit code; a terminal gets the controller's usual
one-line refusal. Neither gets a traceback.

| Exit | Codes |
|---|---|
| 2 | `routing-policy-invalid`, `routing-policy-missing`, `routing-mode-unknown`, `routing-strategy-unknown`, `routing-no-orchestrator`, `routing-unknown-identity`, `routing-not-in-catalog`, `routing-task-id-required`, `routing-task-id-invalid`, `routing-override-no-reason`, `routing-override-incomplete`, `routing-override-noop`, `routing-account-unroutable`, `routing-schema-unsupported`, `routing-requirement-too-large` |
| 3 | `routing-account-unavailable`, `routing-no-qualifying-model` |
| 4 | `routing-absent`, `routing-task-unknown` |
| 5 | `routing-manual`, `routing-already-approved`, `routing-below-floor`, `routing-decision-changed`, `routing-frozen-route-unavailable` |
| 6 | `routing-task-stage-mismatch`, `routing-task-identity-mismatch`, `routing-task-role-mismatch` |
| 7 | `routing-not-approved`, `routing-plan-changed` |
| 9 | `routing-budget-exceeded` |

Automatic routing **fails closed**. When it cannot meet a quality floor it says
so and stops; it does not fall back to `default`, reduce effort, omit a required
reviewer, or swap one account identity for another to make an answer possible.

## Attempts, retries and escalation

An attempt is not a free action, and the ledger that records them is what makes
every ceiling enforceable.

`<run>/routing-attempts.jsonl` is append-only. Recording an outcome appends a
line carrying `supersedes: {attempt, at}` rather than editing the attempt it
describes, so reading means replaying: the latest line for each `(taskId,
attempt)` wins. That is why writing down what happened never consumes a retry.
Each attempt also keeps its own artifact — `<stage>-<agent>-a<N>-<timestamp>.md`
— because a failed cheap attempt is the evidence that justifies the expensive
one, and replacing it in place would destroy the only reason the escalation was
allowed.

### What may follow a failed attempt

| Situation | Outcome |
|---|---|
| The last attempt passed | Refused: `routing-task-complete` |
| The last attempt has no recorded outcome | Refused: `routing-attempt-unjudged` |
| It failed with no classification | Refused: `routing-retry-unclassified` |
| `transient-provider`, first time at this rung | One same-tier retry |
| Any other classification, or a second failure at this rung | One rung up the frozen ladder |
| The approved retry count is used | Refused: `routing-retry-ceiling` (exit 9) |
| The ladder is at the approved ceiling | Refused: `routing-escalation-ceiling` (exit 9) |
| The next attempt would pass the approved cost units | Refused: `routing-budget-exhausted` (exit 9) |

The classification list has four entries and none of them is "the answer was not
what I wanted". A disliked answer is a scoping problem; spending the budget again
on the same prompt is the most expensive way of not fixing it, and the refusal
says so.

The shipped policy grants three retries per task. Once that batch is exhausted,
an explicit user request can grant exactly three more with `routing
refresh-retries`. The grant is task-scoped and append-only: prior attempts,
classifications, artifacts, and cost remain in the record. A refresh is refused
before the current batch is exhausted or when the last attempt is not a
classified failure. It does not widen the escalation ladder or the run's total
cost ceiling.

The cost ceiling is checked on **every** attempt including a task's first,
because a later task's opening attempt spends from the same approved budget an
earlier task's retries have already drawn on. `routing.budget_exhausted` is
appended when a ceiling actually stops work — a read never appends one, so
`fde routing outcome`'s `nextAttempt` preview and `fde invoke --dry-run` are
free of side effects and cannot inflate the evidence the calibration report
reads back.

Escalation climbs only `escalation.ladder` from the policy, never past the
task's frozen `escalationCeiling`, and never above
`escalation.requireRecordedFailureAbove` without a recorded failure at that
rung. `routing.escalated` records each climb with its from/to.

### `routing attempts --json`

Returns `attempts` (the replay, one entry per attempt), `ledger` (every line as
written), `retryGrants`, `progress` per task, `spentCostUnits`,
`approvedCostUnits`, and a `usage` roll-up.

### `routing outcome --json`

Records what an attempt produced. On a failure it answers whether a retry is
permitted (`retryPermitted`, plus `nextAttempt` or `retryRefusal`) without
performing one. `--usage-file` takes provider-reported usage as JSON.

## Usage telemetry

Every figure carries its own provenance:

```json
{"state": "reported",    "value": 1200, "source": "provider report"}
{"state": "estimated",   "value": 44.0, "source": "policy cost weights; relative units, not money"}
{"state": "unavailable", "value": null, "reason": "no provider reported this figure"}
```

Three states and no fourth. An `unavailable` figure carries no value at all,
because a missing measurement written as `0` is a lie that reads like data — the
console renders it as "unavailable" for the same reason.

Only these fields are ever stored: `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `durationMs`,
`monetaryCost`, `currency`. It is an allowlist, not a convention: a report
containing a prompt, an API key or a model's output has those fields dropped and
their **names** listed in a diagnostic note, so an integration sending them can
be fixed rather than silently ignored. A negative, non-numeric or non-finite
value is refused the same way.

A total is `reported` only when **every** recorded attempt reported that field.
One missing measurement makes the total unknown, and an unknown total is reported
as `unavailable` with the arithmetic said out loud rather than as the sum of the
parts that happened to arrive. `durationMs` is measured by the controller, so it
is `reported`; token counts are not available through the CLI invocation path, so
they stay `unavailable`.

## Calibration reporting

`fde routing report --json` is read-only. It opens `routing.json`,
`routing-attempts.jsonl` and `routing-events.jsonl` across runs, writes nothing
anywhere, and reads the **newest** runs first with `--since` applied before the
500-run cap.

It reports the band, strategy, confidence and floor mix; attempt, retry and
escalation counts; estimated cost at approval against estimated cost consumed;
which usage fields providers actually reported; and `calibration`.

`calibration` carries `minSample` (5 by default), `bands` (the per-band counts
each recommendation was derived from, so the arithmetic can be checked),
`recommendations`, `insufficientEvidence`, `policyChanged: false` — a literal, so
a client can pin it — and a note. Every recommendation carries `applied: false`
and names the policy field it concerns.

**Nothing here changes policy, and no part of this controller reads this report
back as configuration.** A pattern below `minSample` is reported as insufficient
evidence rather than as a recommendation: a policy nudged by three runs would
drift somewhere nobody chose, and the drift would look like data.

## Design panels

`design-panel create --routing auto [--strategy <s>]` fills in the model and
effort each participant was not given, from the same shared policy. A panel works
the `solutioning` stage, so it inherits that stage's quality floor. The strategy
defaults to the run's own.

What routing does **not** touch: who is in the panel. The participants, their
order, their lenses and their sealed context are the operator's decisions and the
entire basis of the panel's independence. The controller compares the participant
identities before and after routing and refuses to continue (exit 8) if they
differ or if the same account appears twice — a guarantee, not an intention. The
sealed context depends on the brief and the inputs, never on which models were
chosen.

An explicitly chosen model or effort is left exactly as it was. A pinned model is
priced and tiered **as itself**: the candidate set is narrowed to that model
before a choice is made, so the recorded `tier`, `estimatedCostUnits` and
`routingReason` describe what will actually run. A pinned model the policy does
not offer keeps `routingSource: "operator"`, gets no tier and no cost estimate,
and the reason is recorded in `routing.notes` — a model the policy never priced
gets no price.

Each participant records `routingSource` (`auto` or `operator`), `routingReason`,
`tier`, `qualityFloor` and `estimatedCostUnits`. The reconciler takes its model
and effort from the approved reconciliation-stage task, failing that the approved
orchestrator route, failing that the run's session configuration, and records
which in `reconciliation.modelSource`.

## The console

The console is a client of these contracts and nothing more. It calls controller
JSON commands, validates every answer against a pinned Zod schema, keeps the
existing bearer-token and origin checks, and never opens a routing file — it
cannot, because it has no code that writes one.

| Endpoint | Controller command |
|---|---|
| `GET /api/routing/policy` | `version --json` (capabilities + `routingPolicy`) |
| `POST /api/routing/preview` | `routing preview --requirement-stdin --json` |
| `GET /api/runs/:runId/routing` | `routing show --json` |
| `GET /api/runs/:runId/routing/explain` | `routing explain --json` |
| `GET /api/runs/:runId/routing/attempts` | `routing attempts --json` |
| `POST /api/runs/:runId/routing/override` | `routing override --json` |
| `GET /api/routing/report` | `routing report --json` |

Four properties hold across all of it.

**Nothing approves a plan.** There is no endpoint that can clear the
`APPROVE PLAN` gate, and the UI has no control that tries. An escalating override
still needs the operator to type `APPROVE ROUTING <run-id>`; the server forwards
`--approve` only when the phrase it received matches exactly, and always closes
the controller's stdin so an unconfirmed escalation is refused rather than left
waiting for an answer nobody is there to type.

**The request text is never argv.** A requirement goes to the controller's stdin,
so a request beginning with a dash is text. Every other argv-bound value is
pattern- or enum-constrained before it gets near a command line.

**A routing refusal arrives as itself.** The controller's typed error is parsed
back out of its JSON envelope, so the browser sees `routing-below-floor` and can
say something useful about it rather than "the controller refused this request".

**Automatic routing is offered only when it exists.** `routingPolicy.state`
distinguishes available from unavailable, and the console distinguishes both from
"not asked yet": while the answer is pending neither mode is shown as selected
and the run cannot be created, because showing the recommended option as chosen
while quietly creating a manual run on `default` is the one outcome the whole
mechanism exists to prevent. A failing policy endpoint is said out loud.
