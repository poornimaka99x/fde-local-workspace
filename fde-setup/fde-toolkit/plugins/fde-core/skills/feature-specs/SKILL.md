---
name: feature-specs
description: Draft, maintain and validate the four feature documents (spec, plan, tasks, verification) for an FDE run whose artifact profile is feature-specs. Use in solution requirements, technical architecture, development planning, implementation handoff and quality review.
argument-hint: "<run-id> [FEAT-nnn]"
allowed-tools: Read, Grep, Glob, Bash, Write
---

# Feature specs

Use only when `fde status <run-id> --json` reports `artifactProfile:
"feature-specs"`. Otherwise the run keeps its normal artifacts. The contract is
`docs/FDE-FEATURE-SPECS.md` in the toolkit source; this is the working summary.

## Where things live

- Drafts: `artifacts/features/<FEAT-id>/{spec,plan,tasks,verification}.md` in
  the run. Create them with `fde features scaffold`; never by copying templates
  by hand.
- Maintained record: `docs/features/<FEAT-id>/` in the client repository. It
  reaches the repository only through an approved write (the implementation
  task, or a verification-stage write). The controller never writes a
  repository.
- Existing record: `fde features import <run-id> <repo>/docs/features/<FEAT-id>`
  snapshots it into the run before you revise it.

## Stage duties

| Controller stage | Workflow stage | You own |
| --- | --- | --- |
| research | solution-requirements | `spec.md` — outcomes, REQ, CHECK, exclusions, assumptions, Q |
| solutioning | technical-architecture | `plan.md` — approach, components, compatibility, risks, validation |
| planning | development-planning | `tasks.md` — bounded TASK items mapped to REQ |
| implementation | vertical-slice | consume the documents; deliver them to the repository |
| verification | quality-review | `verification.md` — one result per CHECK, with evidence |

Rules that the validator enforces:

- IDs are `REQ|CHECK|TASK|Q-<n>-<seq>` where `<n>` is the feature number.
  Never renumber or reuse an ID; mark a withdrawn item as withdrawn.
- Every REQ has a CHECK; every CHECK names its Requirement and a Verification
  method; every TASK names Requirements or a Justification, a `Done when` and
  a Status; every Q has a Status and, when answered, an Answer.
- `verification.md` has an entry for every CHECK. A `pass` names Evidence.
- No credentials, private engagement notes or raw sensitive evidence.

Do not resolve an open question by assumption. Leave it `open` and raise it.

## Handoffs

Before handing work to a specialist or to implementation:

```bash
fde features validate <run-id> --feature FEAT-012 --stage <stage>
fde features record   <run-id> --feature FEAT-012 --stage <stage> --json
```

`record` refuses while there are errors. Its `inputEvidence` rows go verbatim
into the handoff sidecar, and the requirement IDs go into `requirementIds`.
Validate the sidecar with `fde handoff validate` as usual.

For implementation, the task file names the repository destination
`docs/features/<FEAT-id>/` in its owned paths, so the documents are delivered by
the same approved write as the code. Update `tasks.md` Status as tasks finish.

After any change to `spec.md`, `plan.md` or `tasks.md` past a recorded handoff,
`validate` reports `changed-since-handoff`. Stop, reconcile scope through the
run (widen or amend the plan, re-approve if the controller requires it), then
record a new handoff. `verification.md` changing later is expected.

`fde features validate <run-id> --feature FEAT-012 --repo <repo>` also reports
whether the repository copy matches the run copy.

## Principles

`fde features scaffold <run-id> --feature FEAT-012 --title "..." --principles
--repo <repo>` drafts `PRINCIPLES.md` only when the repository has no
equivalent (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, ADRs, a constitution). Fill
it from `standards show <section>` and agreed client constraints; keep it short.
If an equivalent exists, reference it from `plan.md` instead.

## Boundaries

A clean validation means well-formed and traceable, not correct. A `done` task
or a ticked box grants nothing; FDE task-file hashes and approvals stay
authoritative. Only the controller updates run state.
