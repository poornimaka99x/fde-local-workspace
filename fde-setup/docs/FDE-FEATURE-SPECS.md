# Feature documentation: the `feature-specs` artifact profile

An optional way for an FDE run to leave a maintained, client-readable feature
record in the target repository: what was asked for, how it was designed, how
the work was cut, and how acceptance was verified. The formats are compatible
in spirit with GitHub Spec Kit (spec → plan → tasks) but FDE-owned; Spec Kit
itself is not installed or required.

The profile is **off unless selected**. A run without it behaves exactly as
before: no directories, no checks, no extra steps.

## 1. Selecting the profile

```bash
fde project create --name "Returns" --repo ~/src/returns --artifact-profile feature-specs
fde project update <project-id> --artifact-profile feature-specs   # or: none
fde start "…" --project <project-id>                               # inherits
fde start "…" --artifact-profile feature-specs                     # per run
fde start "…" --project <project-id> --artifact-profile none       # opt out
```

The run's profile is fixed at `fde start` and recorded in `manifest.json` as
`artifactProfile` (`"feature-specs"` or `null`). Changing the project later
does not change runs that already exist. Selecting the profile also records a
run-scoped capability override enabling `skill:fde:feature-specs`, through the
existing override mechanism; it enables nothing else.

## 2. Documents

```text
docs/features/<feature-id>/        in the client repository (maintained record)
├── spec.md
├── plan.md
├── tasks.md
└── verification.md
docs/features/PRINCIPLES.md        only if the repository has no equivalent
```

| File | Contents | Drafted in (workflow / controller stage) |
| --- | --- | --- |
| `spec.md` | outcomes, requirements, acceptance criteria, exclusions, assumptions, open questions | `solution-requirements` / `research` |
| `plan.md` | approach, affected components, compatibility, risks, validation approach, standards | `technical-architecture` / `solutioning` |
| `tasks.md` | bounded tasks, dependencies, requirement mappings, completion criteria, status | `development-planning` / `planning` |
| `verification.md` | one result per acceptance check, checks performed, limitations | `quality-review` / `verification` |

`vertical-slice` (`implementation`) consumes the documents through the normal
handoff and delivers them to the repository.

Templates: `fde-toolkit/plugins/fde-core/skills/feature-specs/templates/`.
Worked example: [`docs/examples/feature-specs/FEAT-012/`](examples/feature-specs/FEAT-012/).

### Where the documents live during a run

The controller never writes a client repository. So:

1. Drafts live in the run, at `artifacts/features/<feature-id>/`, created by
   `fde features scaffold` or snapshotted from an existing repository record
   by `fde features import`. They are run artifacts like any other: covered by
   status, output hygiene and the run record.
2. They reach the repository only through an approved write — the
   implementation task lists `docs/features/<feature-id>/` among its owned
   paths, so the documents travel with the code under the same task-file hash
   and approval. Verification outcomes reach the repository through a
   verification-stage write, under the same rules.
3. Once in the repository, that copy is the maintained record. A later run
   starts with `fde features import`, never from memory.

`fde features validate --repo <repo>` reports whether the repository copy
matches the run copy, so a forgotten delivery is visible rather than silent.

## 3. Identifiers

```text
Feature            FEAT-012
Requirement        REQ-012-003
Acceptance check   CHECK-012-004
Task               TASK-012-007
Open question      Q-012-002
```

- The middle number is the feature number. An ID from another feature is an
  error.
- IDs are permanent. Revisions keep IDs; a withdrawn item stays, marked
  withdrawn. Never renumber or reuse.
- An item is defined by a level-3 heading, `### <ID>: <title>`, followed by
  `- Field: value` lines. REQ, CHECK and Q are defined in `spec.md`; TASK in
  `tasks.md`. `verification.md` headings record results for CHECKs; they define
  nothing.
- Each document starts with front matter naming `feature: FEAT-012`.

## 4. Rules

Errors (the record is invalid and `fde features record` refuses):

| Code | Rule |
| --- | --- |
| `missing-document` | a document required at the given stage is absent (see §5) |
| `wrong-feature` | front matter names another feature or none |
| `duplicate-id`, `misplaced-id`, `foreign-id` | each ID is defined once, in its owning document, for this feature |
| `unknown-reference`, `foreign-reference` | every referenced ID exists in this feature |
| `no-requirements` | `spec.md` defines at least one REQ |
| `requirement-without-check` | every REQ has a CHECK naming it |
| `check-without-requirement`, `check-without-method` | every CHECK names its Requirement and a Verification method |
| `question-without-status`, `answer-missing` | every Q has Status `open`, `answered` or `deferred`; an answered Q records its Answer |
| `task-without-requirement` | every TASK names Requirements, or gives a Justification |
| `task-bad-requirement`, `task-bad-dependency`, `task-self-dependency`, `task-dependency-cycle` | requirement and dependency references are well formed and acyclic |
| `task-without-completion`, `task-without-status` | every TASK has `Done when` and Status `todo`, `in-progress`, `done` or `dropped` |
| `check-unrecorded`, `result-missing`, `pass-without-evidence` | once `verification.md` exists, every CHECK has a Result (`pass`, `fail`, `not-run`, `unavailable`) and a pass names Evidence |
| `credential` | the text contains something shaped like a credential |
| `changed-since-handoff` | `spec.md`, `plan.md` or `tasks.md` changed after the latest recorded handoff |

Warnings (reported, never blocking): `open-question`, `requirement-without-task`,
`done-not-accepted` (a task is done but its requirement has no passing check),
`unusual-method`. Info: `outcome-updated` (`verification.md` changed after the
handoff, which is expected).

Task completion (`tasks.md` Status) and verified acceptance
(`verification.md` Result) are separate facts and are recorded in separate
documents.

Client-facing documents carry no credentials, private engagement notes or raw
sensitive evidence. The credential check is a narrow backstop, not a review.

## 5. Required documents by stage

| `--stage` | Required |
| --- | --- |
| none given | `spec.md` |
| `research`, `review`, `reconciliation`, `presentation` | `spec.md` |
| `solutioning` | `spec.md`, `plan.md` |
| `planning`, `implementation` | `spec.md`, `plan.md`, `tasks.md` |
| `verification` and later | all four |

## 6. Commands

```bash
fde features scaffold <run-id> --feature FEAT-012 --title "<title>"
                     [--principles --repo <repo>] [--json]
fde features import   <run-id> <repo>/docs/features/FEAT-012 [--replace] [--json]
fde features validate <run-id> --feature FEAT-012 [--stage <stage>] [--repo <repo>] [--json]
fde features validate --path <dir> --feature FEAT-012 [--stage <stage>] [--json]
fde features record   <run-id> --feature FEAT-012 --stage <stage> [--json]
```

- `scaffold` renders the templates into `artifacts/features/<id>/`. It is
  create-only: an existing file is kept and reported, never overwritten. With
  `--principles` it also drafts `artifacts/features/PRINCIPLES.md`, stamped with
  the source and SHA-256 of `shared/engineering-standards.md`, **only** when the
  repository has none of `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`,
  `docs/principles.md`, `docs/features/PRINCIPLES.md`, ADR directories or
  `.specify/memory/constitution.md`; otherwise it names the equivalents to
  reference. Reading the repository requires confirmed roles.
- `import` copies an existing repository record into the run (read-only on the
  repository; requires confirmed roles; the source must sit inside one of the
  run's project repositories when the project lists any). A differing run copy
  is kept unless `--replace` is given.
- `validate` applies §4 and §5 and compares hashes with the latest recorded
  handoff. `--repo` adds a comparison with `<repo>/docs/features/<id>/`.
  `--path` validates any directory with no run involved (for example a
  repository checkout in CI). Exit 0 when valid, 1 when there are errors.
- `record` validates for the stage and, only if valid, appends a hashed
  snapshot to the run's controller-owned `features.jsonl` and an event to
  `events.jsonl`. Its JSON carries `inputEvidence` rows and `requirementIds` in
  the shape the handoff sidecar expects (`docs/` reference:
  `skills/engage/references/specialist-handoffs.md`).

`fde status <run-id> --json` reports `artifactProfile` and a `features` summary:
each feature directory in the run, its documents, and its latest recorded
handoff.

## 7. Boundaries

- `plan.md` is a design record for people. It never writes, replaces or is read
  as the controller's `plan.json`.
- A status of `done`, a ticked box or a passing validation grants no execution
  authority. Task files, their hashes and `APPROVE CODEX` / `APPROVE PUBLISH`
  remain the only authority.
- A requirement or scope change after a recorded handoff is reconciled through
  existing FDE rules: amend or widen the plan, re-approve when the controller
  requires it, then record a new handoff.
- Only the controller writes run state (`features.jsonl`, `events.jsonl`).
- Validation establishes structure and traceability. It does not establish that
  a requirement is correct or that an implementation works; FDE review and
  evidence do.
- No scheduler, automatic implementation command or new approval exists in this
  version.

## 8. Pilot, then decide on Spec Kit

Pilot on one bounded feature. Judge it on: can another developer continue
from the repository documents alone; are acceptance criteria missed less; do
agents need fewer clarification rounds; is the effort proportionate to the
feature. If the templates deliver the benefit, stop there. If cross-document
consistency review stays weak, add a pinned Spec Kit integration starting with
its read-only `analyze`; anything it proposes enters FDE as proposed work, and
this layout is adapted to the pinned release's structure at that point.
