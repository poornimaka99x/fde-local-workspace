---
name: harness-evaluation
description: Evaluate an FDE skill, subagent or workflow against realistic capability, regression and safety cases before trusting a change. Use when modifying the agent harness or when repeated agent behavior needs measurement.
argument-hint: "<component or workflow>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# Harness evaluation

Define expected behavior before changing the harness. Include:

- capability cases for the new behavior;
- regressions for existing invariants;
- adversarial cases for untrusted documents, role boundaries and approvals;
- deterministic graders where possible, model graders with explicit rubrics for
  semantic output, and human review for high-impact ambiguity.

Run cases in an isolated workspace with no live publication or deployment
access. Delegate scoring to `workflow-evaluator`, which must verify claims and
must not re-perform the original task. Track first-attempt success separately
from success after retries; never use retries to hide nondeterminism. Store the
case, baseline, result, model/tool versions and failure evidence together.
Promote an updated skill only when capability cases pass and safety/regression
cases do not deteriorate.
