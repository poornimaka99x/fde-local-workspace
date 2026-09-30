---
name: evo-experimentation
description: Govern an explicitly requested Evo autoresearch run inside an approved FDE implementation task. Use only when a measurable optimization target, reproducible benchmark and correctness gates justify experiment-tree search; never for ordinary feature work or open-ended refactoring.
---

# Evo experimentation in FDE

Evo is an optional optimization system, not the normal implementation path. It
creates experiment worktrees, edits code, runs benchmarks, commits successful
branches and can provision paid remote sandboxes. Use the pinned official Evo
plugin and its skills for the mechanics; this skill defines the FDE boundary
around them.

## Admission gate

Start only when all of these are true:

- the user explicitly wants iterative optimization or autoresearch;
- one primary metric and its `min`/`max` direction are written down;
- the benchmark is deterministic enough to compare candidates, or its repeated
  aggregate is defined in advance;
- correctness, security and acceptance checks are executable gates;
- the target, benchmark and gate dependencies are committed and the relevant
  working tree is clean;
- the run is in an approved implementation stage with repository writes
  allowed.

Do not use Evo to discover product requirements, implement an ordinary feature,
perform a vague "make it better" refactor, or compensate for missing tests.

## Runtime and version contract

The official plugin, skills, CLI and hook protocol must all be exactly `0.8.0`.
Run `evo --version` and stop on any mismatch. Never substitute the unrelated
`evo` SLAM package. Set `EVO_TELEMETRY=0` for every FDE-controlled invocation.

Use the official `user:evo:discover`, `user:evo:optimize`,
`user:evo:report` and `user:evo:ship` skills rather than reproducing their
experiment protocol. Keep Evo on the implementation identity and model already
selected by FDE; Evo does not authorize a provider, account or model-tier change.

## Safe default run

1. Use ProjectAtlas for current-code routing and OpenWiki only for durable
   architectural context before starting the experiment loop.
2. Start with the local `worktree` backend. Remote Modal, E2B, Daytona, AWS,
   Azure or SSH execution needs explicit deployment/cost approval and separately
   configured credentials.
3. Run discovery only after implementation-write approval. Do not install the
   SDK or add benchmark dependencies without the user's explicit selection of
   SDK instrumentation; inline instrumentation remains available.
4. Require at least the affected test suite plus a held-out or invariant gate.
   A faster result that fails a gate is not an improvement.
5. Default to `evo autonomous off`, `evo subagents-only on`, one bounded round,
   the smallest resource-safe subagent width and an explicit experiment budget.
   Autonomous continuation requires an explicit user request.
6. Preserve rejected hypotheses and failure traces as experiment evidence, but
   never promote benchmark-only artifacts into the product branch.
7. Review the winning diff independently. Rerun the benchmark and every gate
   outside the candidate's self-report before accepting it.
8. `user:evo:ship` may merge or create a PR. It therefore requires the normal
   FDE review/reconciliation evidence and the matching SCM publication approval.

The local dashboard may bind only to loopback. Never expose it publicly or put
credentials, customer data or production datasets into Evo traces. Evo hooks
are enabled only for the opted-in implementation stage and must remain off in
research, planning, review, deployment and operations.

## Evidence to retain

Record the baseline score, metric direction, benchmark command, gate commands,
budget, backend, selected FDE model/effort, experiment count, winning experiment,
independent rerun, rejected regressions and final diff/PR. Report improvement as
measured on the declared aggregate, never the best noisy replicate.
