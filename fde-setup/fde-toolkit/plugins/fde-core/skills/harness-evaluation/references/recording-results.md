# Record and compare real evaluation attempts

The installed `config/evaluation-suite.json` contains eight starting scenarios.
Create deterministic local fixtures for the affected scenario; do not give
evaluation agents live client credentials. Use the same fixtures and suite
revision for baseline and candidate, changing one policy or skill decision at
a time. A passing unit suite tests the harness implementation; it does not
establish real model task success.

Record `results.json` beside the captured evidence files:

```json
{
  "schemaVersion": 1,
  "suiteRevision": "2026-10-01.1",
  "model": "exact model used",
  "toolVersion": "recorded tool versions or revision",
  "policyRevision": "recorded policy revision",
  "evaluator": "independent evaluator identity",
  "attempts": []
}
```

For each actual attempt append an object with `caseId`, `attempt` (contiguous
from 1), `checks` (every case check mapped to pass/fail/unavailable), and
`evidence` (nonempty array of `{path, sha256}` records relative to results.json).
Capture the prompt, inputs, output, logs and the evaluator's rubric judgments
in that evidence. A hash proves artifact integrity, not correctness.

Record `cost: {units, provenance}` using reported/estimated/unavailable;
unavailable units must be null. Optional `latencySeconds`, `humanReworkMinutes`,
`escapedDefects` and `reviewerFalsePositives` are nonnegative measurements or
null. Do not invent zeros. Defect counts and reviewer false positives require
follow-up or adjudication, not the producing agent's self-assessment.

```bash
fde evaluate --results /path/to/candidate/results.json --json
fde evaluate --results /path/to/candidate/results.json \
  --baseline /path/to/baseline/results.json --json
```

The command runs no models and writes no policy. It checks all artifact hashes,
rejects duplicate/missing attempt numbers, reports missing cases and separates
first-attempt acceptance from acceptance on the latest attempt. Any failed or
unavailable safety check on any attempt remains a failure after retries.
Baseline comparison also blocks case-level first-attempt regressions. Unknown
measurements remain null; relative cost totals are not monetary prices.

Use a deliberately smaller versioned suite with `--suite` for a focused change;
never remove a failed case just to get a pass. Preserve broader safety and
regression coverage before promoting the harness. Use `fde routing report`
alongside these results for calibration, with human review of policy changes.
