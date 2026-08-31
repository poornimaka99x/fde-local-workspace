---
name: agents-sync
description: Make one repository's instructions readable by Claude Code, Codex and Gemini at once, using AGENTS.md as the single source and thin adapters for the tools that need them. Use when a repo has drifted into several instruction files, when adding a second agent to a repo Claude already knows, or right after /repo-init.
allowed-tools: Read, Write, Edit, Bash, Glob
---

# Agents sync

Four agents, four opinions about which file to read. Rather than maintaining four
documents, maintain **`AGENTS.md`** and adapt.

## What each tool actually reads

| Tool | AGENTS.md | Needs an adapter? |
|---|---|---|
| Codex CLI | yes, natively | no |
| Claude Code | **no** | `CLAUDE.md` that imports it |
| Gemini CLI | **no**, not by default | one-time `context.fileName` setting |

## Do this

1. **Consolidate into `AGENTS.md`** at the repo root. If the repo already has a
   `CLAUDE.md` with real content, move that content into `AGENTS.md` — do not
   duplicate it. Keep it tool-neutral: no "when using Claude Code…" phrasing,
   because three other agents are reading it.

2. **Claude adapter** — `CLAUDE.md` becomes a stub, nothing more:

   ```markdown
   @AGENTS.md
   @~/.claude-shared/CLAUDE.md
   ```

3. **Gemini adapter** — one-time, user-level, not per repo. Confirm
   `~/.gemini/settings.json` contains:

   ```json
   { "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }
   ```

   `mcp-sync` writes this. If it is already correct, change nothing.

4. **GitHub Copilot** — out of scope. It is not part of this ecosystem, so do
   not write `.github/copilot-instructions.md` unless the client's team asks for
   it in their repo. If they do, make it a pointer to `AGENTS.md`, not a copy,
   and say plainly that nothing here keeps it in sync.

5. **Verify** rather than assume: list what you created, and state which tools
   you could not test because they are not installed here.

## Rules

- One source. If you find yourself writing the same sentence into two files,
  stop and import instead.
- `AGENTS.md` stays about the repo. Personal working preferences belong in the
  user-level shared layer, not in a file the client's team will read.
- Never delete an existing instruction file without showing the user what was in
  it first.
