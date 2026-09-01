---
name: ci-diagnose
description: Diagnose GitHub Actions or Bitbucket Pipelines failures from provider logs and local reproduction, without masking flaky or infrastructure failures. Use when a PR/build pipeline is red or disagrees with local results.
argument-hint: "<run-id> <pipeline URL, run or PR>"
allowed-tools: Read, Grep, Glob, Bash, Task
---

# CI diagnosis

Guard provider and repository access, detect GitHub versus Bitbucket, and gather
the exact commit, runner/image, failed job/step and relevant log window. Delegate
to `ci-investigator`. Locate the first causal error rather than the final cascade,
then compare local/CI runtime, dependency locks, cache, environment, permissions,
secrets presence and concurrency. Reproduce with the smallest safe command.
Classify the cause and propose the smallest correction plus confirmation step.
Do not retry until green, weaken a gate or edit the pipeline unless the user has
asked for a fix; provider writes require publication approval.
