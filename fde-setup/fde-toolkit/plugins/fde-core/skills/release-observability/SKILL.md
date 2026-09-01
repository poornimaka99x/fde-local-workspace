---
name: release-observability
description: Prepare, approve and verify deployment plus production observability, rollback and monitoring evidence. Use after verification, for release readiness, deployment planning or post-release monitoring.
argument-hint: "<run-id> <environment or release>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# Release and observability

Delegate release preparation to `release-manager` and telemetry/readiness to
`sre-observability`. Produce a release manifest containing immutable artifact or
commit, environment/config changes, migrations, dependency order, rollout,
rollback, owners and go/no-go evidence. Produce an observability plan covering
SLOs, user and domain signals, logs/traces/metrics, dashboards, actionable
alerts, runbooks, baseline, watch window and abort thresholds. Preparing and
reading are non-mutating; an actual deployment requires
`fde approve-publish <run-id> deployment` and must be logged. Afterward record
health evidence and incidents—never call a deployment successful merely because
the command exited zero.
