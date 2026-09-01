---
name: scm-pr-review
description: Review a GitHub or Bitbucket pull request using provider metadata, CI status, linked Jira context and a verified local diff. Use when analysing another team member's PR, preparing a PR, or performing a pre-merge risk review.
argument-hint: "<run-id> <PR URL, number or branch>"
allowed-tools: Read, Grep, Glob, Bash, Task
---

# SCM pull-request review

Run the FDE guard before repository or provider access. Detect the provider from
the PR URL and `git remote -v`; never equate Microsoft Copilot with GitHub and
never assume GitHub when the remote is Bitbucket. Collect base/head commit,
description, linked Jira items, changed files, review history and CI/check
status using the matching connector/CLI. Fetching must not alter the working
tree. Delegate code analysis to `pr-analyst`, standards checks to
`standards-reviewer`, and security-sensitive diffs to `security-reviewer`.
Reconcile duplicates into one report ranked: merge blocker, important, question,
optional. Every finding needs file/line, evidence, consequence and smallest
fix. Do not comment, approve, request changes, merge or push without a separate
publication approval for `github` or `bitbucket`.
