---
description: Review the current branch against this repo's written standards
argument-hint: "[base-branch]"
---

Review the changes on this branch against the standards this repository declares.

Base branch: $1 (default to `main` if empty, or `master` if `main` does not exist).

Current diff:

!`git diff --stat $(git merge-base HEAD ${1:-main} 2>/dev/null || echo HEAD~1)...HEAD 2>/dev/null || git diff --stat HEAD`

Delegate the review to the `standards-reviewer` agent, passing it the base branch.
Report its findings ranked by consequence. Do not fix anything unless I ask.
