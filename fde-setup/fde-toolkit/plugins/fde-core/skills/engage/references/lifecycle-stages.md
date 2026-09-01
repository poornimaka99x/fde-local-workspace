# Lifecycle stage execution

Use this only after roles are confirmed. Call `fde guard` before the first
connector/repository read and `fde status` before resuming.

Operate autonomously inside the approved stage slice using the configured tools
and assigned specialist methods. Do not pause for routine reversible actions.
Stop and ask when the requirement, target, authority, destructive effect,
acceptance criteria or evidence needed to declare success is ambiguous. Plan
approval does not replace the separate Codex-write, deployment or publication
gates and does not authorize scope expansion.

## Intake and research

Load the client context and authoritative sources assigned to the run. Jira is
the project-management source; SharePoint/Outlook/Teams context comes from the
assigned Microsoft surface. Log connector calls. Restate the ask in one sentence
before dispatching research. If a research gap would materially change scope or
architecture, block the run and ask the user.

## Architecture, UI and review

The solution architect provides real alternatives, costs and an ADR. UI work
uses `/ui-prototype` and `/design-system` before `/design-to-code`; screenshots
alone are not specifications. Dispatch independent reviewers for the planned
lenses. Reconciliation decides which objections stand and documents why; one
revision is preferred over an unbounded agent loop.

## Presentation and delivery planning

The assigned author creates the stakeholder artifact. Product/delivery roles
produce `development-plan.md` and a `jira-plan.json` preview with requirement,
design, repository, test and release traceability. A preview is not permission
to create Jira work.

## Implementation

Create `artifacts/implementation/implementation-task.md` with bounded scope and
acceptance criteria. Use `/implementation` and `/tdd-evidence`. If Codex holds
the role, obtain `fde approve-codex` for the exact task file and repository,
then invoke through the gated controller. Claude implementation remains subject
to the active session's normal permissions.

## Verification

Use `/quality-gates`, `/scm-pr-review`, `/ci-diagnose` and specialist reviewers
as applicable. Write `artifacts/implementation/verification-report.md`; include
RED/GREEN mapping, commands, results, environment, unavailable checks and
residual risk. Then use `/verification-evidence` to record a passing checkpoint.
The controller blocks entry to the deployment gate without both artifacts.

## Deployment and observability

Use `/release-observability` to prepare immutable release identity, migrations,
rollout, rollback, SLOs, alerts, runbooks, baseline and abort thresholds. The
actual deployment needs `fde approve-publish <run-id> deployment` and the user's
literal publication confirmation. Write the deployment report and observability
plan. Record live health evidence in a passing observability checkpoint before
completion or later publication.

## Publication and closeout

Preview each external mutation and obtain a separate publication approval for
Jira, Confluence, SharePoint, GitHub, Bitbucket, email or Teams. Publish only the
approved items and log resulting identifiers. Use `/retrospective` for a
supported lesson or failure pattern and `/handover` when work remains. Mark the
run complete only when planned artifacts and evidence are present.
