# Measured FDE quality and efficiency

## Configuration provenance

Run the controller against the installation you intend to inspect:

```bash
fde config provenance --source-root /path/to/fde-setup/claude-shared \
  --workflow forward-deployed-engineer --stage quality-review --json
```

This compares configuration bytes, reports SHA-256 digests and changed JSON
paths, and optionally includes the existing resolver's installed effective
capability decisions. It never prints configuration values, reads credential
files, starts an MCP server, installs anything or changes policy. Source-only,
installed-only, invalid, formatting-only and substantive differences are
distinct. `--check` returns nonzero for any difference. Operator-only files may
legitimately differ; this is a review signal, not an instruction to overwrite.

The effective view covers controller-managed invocations. A desktop session's
own tools, sandbox and approval settings are outside that attestation. Use
`fde mcp effective --run <id>` for connector bindings and `fde config show` for
the full capability explanation. Running chats retain their starting surface.

## Specialist authority

`fde-core/agents/permissions.json` declares each agent's tool policy. Six
review-only specialists have native `tools: Read, Grep, Glob` declarations.
They return findings; the orchestrator collects missing evidence and saves the
review artifact. Other specialists explicitly inherit the parent surface.
The audit rejects undeclared inheritance, stale contract entries and tool drift.
It reports declared authority separately from errors. Native client enforcement
still needs runtime verification; inheritance is not specialist isolation.

## Capability selection

Workflow defaults keep the browser research fallback and technical documentation
where relevant. Repository indexes, wiki, symbol navigation, design, business,
cloud, database and trace connectors are offered as optional capabilities.
Select only the tools needed for the approved task, using existing stage/run
overrides. No connector is installed or authenticated by selection.

Use direct reads for known files; ProjectAtlas for indexed navigation, Serena
for references, and OpenWiki for existing explanations verified against source.
Playwright drives UI flows; DevTools diagnoses them. Select both only when both
jobs exist. Select the actual cloud, not every cloud. Evo remains opt-in for
measurable experiments, with the existing budget and approval boundaries.

## Task handoffs and traceability

The engage skill links the versioned handoff schema. Save a task text file and
JSON sidecar under the run, then:

```bash
fde handoff validate <run-id> tasks/<task-id>.json --json
```

The validator checks the run ID, bounded task and evidence paths, content hashes,
requirement/check coverage, declared ownership, review-only constraints and
finite budgets. It is a preflight used by the skill, not a new authorization
gate or an automatic interceptor of legacy `fde invoke` calls. Frozen routing,
tool availability, write approvals and publication approvals remain authoritative.

One orchestrator owns reconciliation. Parallel workers resolve separate
uncertainties; concurrent writers use disjoint ownership and separate worktrees.
Preserve requirement IDs from business outcome through design, code and tests.

## Evaluation and calibration

`config/evaluation-suite.json` seeds eight realistic scenarios. The harness
evaluation skill describes recording real attempts and independent judgments.

```bash
fde evaluate --results /path/to/candidate/results.json \
  --baseline /path/to/baseline/results.json --json
```

The command verifies evidence hashes, requires every check and contiguous
attempt numbers, and reports first-attempt and eventual acceptance, missing
cases, safety failures, known cost provenance and optional quality/time metrics.
Missing metrics remain null. Safety failures survive retries; case-level
acceptance regressions block baseline comparison. Reported and estimated
relative cost units are labelled and never described as money.

This command aggregates submitted judgments; it neither launches models nor
proves their semantic correctness. Establish baseline and candidate results on
identical isolated fixtures before claiming an improvement. Keep the prompt,
inputs, outputs, versions and adjudication alongside each result. Feed findings
into `fde routing report`; policy updates remain reviewed decisions.

## Promotion

1. Run the configuration audit and affected regression tests in a throwaway install.
2. Inspect provenance against the intended installation.
3. Review `install.sh --update --dry-run`; workflow and evaluation policy changes
   are confirmation-protected, like routing policy.
4. Update the installation through the installer, preserving operator overrides.
5. Repeat audit and provenance, then start new sessions for changed tool surfaces.

No live model benchmark or client enforcement claim follows from unit tests
alone. Track those separately from deterministic controller regression results.
