---
name: handover
description: Write an end-of-session handover note for the current repo — what changed, what is half-done, what the next session needs to know. Use at the end of a working session, before switching repos or engagements, or when the user says they are stopping for the day.
allowed-tools: Read, Grep, Glob, Bash
---

# Handover

Forward-deployed work is interrupted work. This produces the note that makes the
next session cheap to start.

## Gather

```
!`git status --short`
!`git log --oneline -15`
!`git diff --stat HEAD`
```

Also check for stashes and unpushed branches.

## Write

Append to `.claude/HANDOVER.md` (create it if missing, add it to `.gitignore`):

```markdown
## <ISO date>

**Done:** <what landed, referencing commits>

**In flight:** <what is edited but not finished, and where the seam is>

**Blocked on:** <who or what, and what you asked for>

**Next:** <the single next action, concrete enough to start cold>

**Watch out:** <anything you learned the hard way this session>
```

When the work belongs to an FDE run, prefer the run-local handoff/lesson record
(`fde learn <run-id> --kind handoff ...`) and link it here. It is marked
unreviewed and remains evidence/context, not policy.

## Rules

- Newest entry at the top of the file, under the heading.
- "Next" is one action, not a list. If there are three, pick the one that
  unblocks the others.
- Report facts from git, not your recollection of the session.
- If nothing meaningful changed, say so and write nothing.
