---
name: context-budget
description: Audit static FDE skill, agent, command, MCP and repository-instruction overhead and recommend bounded context reductions. Use after adding capabilities or when long sessions become slow, repetitive or incoherent.
argument-hint: "[repository path]"
allowed-tools: Read, Grep, Glob, Bash
---

# Context budget

Run the bundled read-only audit:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/context_budget.py" --repo "${PWD}"
```

Treat its token figures as comparative estimates, not live model usage. Inspect
the heaviest components and remove duplication before removing capability.
Prefer precise skill descriptions, short agent prompts, on-demand skills and
run-scoped MCP servers. Keep `CLAUDE.md`/`AGENTS.md` thin and put durable detail
in referenced files.

For long runs, compact only at a phase boundary after the current decision,
plan, file paths, evidence and next action are written into the FDE run. Good
boundaries are research→planning and planning→implementation; avoid compaction
mid-edit or mid-debug. Use `fde brief <run-id>` to reload bounded run context.
