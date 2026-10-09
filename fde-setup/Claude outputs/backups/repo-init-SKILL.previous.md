---
name: repo-init
description: Onboard agents into a repository none of them have worked in before. Surveys the codebase, then writes a thin AGENTS.md that Claude Code, Codex and Gemini all read, plus the small adapters each needs. Use when starting on a new client repo, a new service in an existing engagement, or any repo with no AGENTS.md yet.
argument-hint: "[client-slug]"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Task
---

# Repo init

Goal: leave the repository with roughly 40 lines of Claude config that say only
what is **true of this repo and nothing else**. Everything general — how the operator
works, review standards, shared MCP servers — already lives in the toolkit and
must not be copied here.

## 1. Survey before writing

Delegate the survey to the `repo-cartographer` agent. Do not read the whole tree
yourself. Ask it for:

- languages, frameworks, and the build/test/lint commands that actually work
- the top-level module boundaries and what each one owns
- how the app is configured and deployed (env vars, IaC, pipelines)
- auth/identity approach, if any
- the three things a new engineer would get wrong in their first week

## 2. Verify the commands

Before writing a command into AGENTS.md, run it — bare, not through `quiet`, so
you see the real output once. A build command that does not work is worse than no
command, because Claude will keep retrying it. Mark anything you could not verify
as `# unverified`.

## 3. Write the files

`AGENTS.md` at the repo root is the **single source**. Codex reads it
natively; Claude and Gemini get one-line adapters. Write it tool-neutral — four
different agents and the client's own team will read it, so no "when using
Claude Code…" phrasing.

```markdown
# <repo name>

## What this is
<two sentences: what it does, who uses it>

## Layout
<one line per top-level module, only where the name is not self-explanatory>

## Commands
- build: <cmd>
- test: <cmd>
- lint: <cmd>
- run locally: <cmd>

## Conventions
<only what contradicts or refines the shared standards; if nothing does, delete
this section rather than padding it>
```

`CLAUDE.md` — a stub plus the agent-only command forms. Claude Code does not
read AGENTS.md, and `quiet` is a local wrapper the client's team will not have,
so it belongs here rather than in AGENTS.md:

```markdown
@AGENTS.md
@~/.claude-shared/CLAUDE.md
@~/.claude-shared/shared/clients/<client-slug>.md

Run the AGENTS.md commands through `quiet`: `quiet <test cmd>`,
`quiet <build cmd>`. It prints failures and a summary instead of the whole log
and names the full log file.
```

`.claude/settings.json` — permissions for this repo's real commands, and denies
for the files an agent should never spend context on:

```json
{
  "permissions": {
    "allow": ["Bash(quiet:*)", "Bash(rtk:*)", "Bash(<test cmd>:*)", "Bash(<lint cmd>:*)"],
    "deny": [
      "Read(./.env)", "Read(./.env.*)", "Read(./**/secrets/**)",
      "Read(./**/node_modules/**)", "Read(./**/dist/**)",
      "Read(./**/build/**)", "Read(./**/.next/**)",
      "Read(./**/*-lock.json)", "Read(./**/*.lock)",
      "Read(./**/__pycache__/**)", "Read(./**/*.min.js)",
      "Read(./**/*.map)"
    ]
  }
}
```

Tune the deny list to the repo — a repo whose only build output is `out/` needs
that instead of `dist/`. The point is that a generated bundle or a lockfile is
never worth the tokens: it is derived, and the manifest beside it says the same
thing in a hundredth of the size.

`.mcp.json` — only servers specific to this repo (a local database, a client's
own MCP endpoint). Shared servers come from the toolkit; do not repeat them. If
there are none, do not create the file.

Gemini needs a one-time user-level opt-in to read AGENTS.md, not a per-repo file
— `mcp-sync` handles it.

## 4. Report

Tell the user what you wrote, which commands you verified, and what you could
not determine. If the repo already had a CLAUDE.md, show a diff and ask before
overwriting.

## Rules

- Never invent a command. Unverified means unverified.
- Never copy shared standards into the repo. Import, don't duplicate.
- Client-facing content goes in AGENTS.md; personal working preferences stay in
  the user-level shared layer. The client's team will read AGENTS.md.
- If `.gitignore` has no `.claude/settings.local.json` entry, add one.
