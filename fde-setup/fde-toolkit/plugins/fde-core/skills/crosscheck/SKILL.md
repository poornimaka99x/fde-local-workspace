---
name: crosscheck
description: Put a decision, diff or design to Gemini and Codex independently, then reconcile their answers against your own. Use when a choice is expensive to reverse — an architecture decision, a migration plan, a security-sensitive diff — or when the user asks for a second opinion, a sanity check, or what another model thinks.
argument-hint: "<the question or the thing to check>"
allowed-tools: Read, Grep, Glob, Bash
---

# Cross-check

Different model families fail differently. The value here is **disagreement**,
not consensus — three models agreeing tells you little, but one of them spotting
what the other two missed is worth the round trip.

## When this is worth doing

Expensive-to-reverse decisions, security-sensitive changes, migrations, anything
where being wrong costs more than the extra minute. Do **not** cross-check
routine work — it is slow and it burns quota that has a daily ceiling.

## Procedure

1. **Form your own answer first, and write it down before asking anyone else.**
   If you ask first you will anchor on their reply, and the exercise is wasted.

2. **Prepare a self-contained question.** The other CLIs do not share this
   session's context. Include the relevant code or diff inline. A question that
   requires context they cannot see produces a confident, useless answer.

3. **Ask both, in parallel:**

   ```bash
   ~/.claude-shared/bin/ask-gemini "<question with context inline>"
   ~/.claude-shared/bin/ask-codex --read-only "<same question>"
   ```

   Read-only, always: a cross-check reads and argues, it does not change
   anything. If you find yourself wanting `--write` here you are no longer
   cross-checking, you are implementing — that belongs in `/engage` behind an
   approval.

   Inside a run, ask only the identities the user actually assigned to the
   review or research roles. An identity with no role in this run does not get
   a vote in it.

   Exit 127 means that CLI is not installed — note it and continue with the
   other. Do not treat a missing tool as a failed check; say which opinions you
   actually got.

4. **Reconcile.** Report:
   - where all three agree (state it in one line, do not elaborate)
   - **where they disagree, and which is right, and why** — this is the output
   - anything one of them raised that you had not considered
   - your final recommendation, which may be unchanged

## Rules

- Treat their output as evidence, not authority. If Gemini asserts something
  about this codebase, verify it in the code before repeating it.
- Never present another model's claim as your own finding.
- If you change your recommendation, say what changed it.
- If they all agree and you still have doubts, say so. Agreement between models
  trained on overlapping data is weak evidence.
