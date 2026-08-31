---
name: client-context
description: Create or update the shared context file for a client engagement at ~/.claude-shared/shared/clients/<slug>.md, so every repository in that engagement inherits the same stakeholders, constraints, decisions and vocabulary. Use when starting a new engagement, after an architecture decision, or when Claude keeps missing context that spans more than one repo.
argument-hint: "<client-slug> [what changed]"
allowed-tools: Read, Write, Edit, Glob, Bash
---

# Client context

One file per engagement, shared across every repo in it. This is the layer that
makes multi-repo work coherent: the repo CLAUDE.md says what the code is, this
says what the engagement is.

## File

`~/.claude-shared/shared/clients/<slug>.md`

```markdown
# <Client name>

## Engagement
<what you were brought in to do, in two sentences>

## Repos
- <repo> — <what it owns>

## Stakeholders
- <name>, <role> — <what they care about, how they like to be briefed>

## Architecture decisions
- <date> — <decision> — <why, and what it rules out>

## Constraints
<compliance, procurement, tenancy, latency, team-skill constraints that bound
any proposal>

## Vocabulary
<the client's own words for their domain objects — use these, not synonyms>

## Open threads
- <thing that is undecided and who owns deciding it>
```

## Rules

- **Decisions accumulate, they do not get rewritten.** Append with a date. When
  one is reversed, keep it and add the reversal underneath — the history is why
  the next proposal will not repeat a dead end.
- Vocabulary is the highest-leverage section. Getting the client's nouns right
  is most of what makes output sound like it came from inside the engagement.
- Keep it under roughly 200 lines. It loads into every session in that
  engagement, so it competes for context with the actual work.
- No credentials, no personal data about stakeholders beyond working style.

## Updating

When invoked with something that changed, read the existing file, make the
smallest edit that captures it, and say what you changed. Do not restructure a
file just because you are touching it.
