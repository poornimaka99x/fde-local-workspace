---
name: retrospective
description: Capture a verified lesson, failure pattern, decision or handoff as unreviewed run-local memory and promote it only after human review. Use after meaningful delivery work or when a repeated pattern should improve the FDE system.
argument-hint: "<run-id>"
allowed-tools: Read, Grep, Glob, Bash, Task, Write
---

# Retrospective

Delegate outcome analysis to `workflow-evaluator`. Compare intent, plan,
checkpoints, artifacts, failures and user corrections. Extract only a pattern
that is supported by evidence and likely to recur. Write a small body containing
context, observation, evidence, proposed future action and counterexample, then:

```bash
fde learn <run-id> --kind <lesson|decision|failure|pattern|handoff> \
  --title "<title>" --body-file <file>
```

The result is create-only, run-local and marked `trust: unreviewed`. It is not a
policy source and must not be injected automatically into later tasks. Search
existing run/client documentation before creating a duplicate. After human
review, promote accepted knowledge explicitly into the client context, ADR,
runbook, engineering standard, skill or test that governs it. Never store raw
transcripts, credentials or sensitive personal data.
