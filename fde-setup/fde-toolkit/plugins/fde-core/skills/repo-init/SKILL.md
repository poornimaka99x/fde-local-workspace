---
name: repo-init
description: Initialize a project when the user asks to initialize, set up or onboard a project or repository. Greenfield derives the folder structure from the agreed architecture and stack, then writes AGENTS.md, CLAUDE.md, docs/CODING-STANDARDS.md, lint/format/import-sort config and the docs/implementation log. Brownfield surveys the existing code, writes standards that codify its conventions and keeps its structure; new code follows the principles and patterns without breaking existing behaviour.
argument-hint: "[greenfield|brownfield] [client-slug]"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Task
---

# Repo init

Run only when the user asks to initialize, set up or onboard a project. Do not
start it from another stage on your own.

Outputs, in both modes:

| File | Purpose |
|---|---|
| `AGENTS.md` | single source every agent reads; carries the non-negotiables |
| `CLAUDE.md` | adapter: imports AGENTS.md and the coding standards |
| `docs/CODING-STANDARDS.md` | the project's standards, from `templates/CODING-STANDARDS.md` |
| `docs/implementation/README.md` | implementation log index, from `templates/implementation-log.md` |
| `docs/adr/` | architecture decisions (greenfield: ADR-0001 records the stack) |
| lint, format, import-sort config | greenfield always; brownfield only as agreed |
| `.claude/settings.json` | repo command permissions and context denies |

## 0. Decide the mode

- An explicit `greenfield` or `brownfield` argument wins.
- Otherwise: no application source beyond a README, licence or empty scaffold
  is greenfield; anything else is brownfield.
- State the mode and the evidence, and get confirmation before writing.
- If AGENTS.md, CLAUDE.md or CODING-STANDARDS.md already exist, show the diff
  and ask before overwriting.

## 1. Greenfield

1. **Establish the architecture and technologies.** Use, in order: an
   architecture document, ADR or `solution-architect` output the user names;
   the current run's artifacts; then ask. You need the deployables (API, web,
   worker, agent service), language and framework for each, data stores,
   external systems, cloud target and architecture style (layered, clean or
   hexagonal, modular monolith, microservices). Do not guess a stack. Ask once
   for everything missing.
2. **Choose the layout** from `references/stack-layouts.md` for each stack and
   adapt it to the architecture style. More than one deployable means a
   monorepo with `apps/` and `packages/` (or a .NET solution), not one merged
   tree.
3. **Show the proposed tree** with a one-line purpose per folder and get
   confirmation.
4. **Create it.** Folders get a `.gitkeep` until they hold code. Write real
   code only for the foundations every rule depends on: typed configuration
   loaded from the environment, the constants module, the logger factory
   emitting the 4 Ws, and the base error type. No placeholder features.
5. **Add tooling** for the stack: linter, formatter, alphabetical import
   sorting, type checker, test runner, plus `lint`, `format` and `test`
   commands. Run them once against the scaffold.
6. **Record ADR-0001** with the architecture style, stack and the patterns
   chosen for the known variation points.

## 2. Brownfield

1. **Survey through `repo-cartographer`.** Do not read the tree yourself. Ask
   for the standard map plus convention evidence, each item with one or two
   `file:line` examples: naming of files, types, functions and variables;
   folder and layering pattern; configuration handling; logging library and
   format; error-handling style; test framework and layout; import ordering;
   existing lint and format config; dependency-injection approach; patterns
   already in use (factory, repository, adapter, strategy, events).
2. **Classify every convention:**
   - *keep*: consistent and sound; all code follows it.
   - *match locally*: weak but pervasive; edits inside existing modules match
     it, for consistency.
   - *improve in new code*: new modules follow the baseline; existing code is
     left alone until a planned refactor.
3. **Keep the existing structure.** Map the baseline's locations (config,
   constants, adapters, logging) onto folders that already exist. Add a new
   folder only when no equivalent exists, and say which.
4. **Do not move, rename or reformat existing files, and do not mass-fix
   lint.** If adding lint, format or import-sort config would flag existing
   code, propose a changed-files-only setup (pre-commit or lint-staged on the
   diff) and let the user decide.
5. **Write the brownfield section** of CODING-STANDARDS.md: the classified
   conventions with examples, known traps, and the safe-change rules below.

Safe-change rules for brownfield:

- Characterization tests before changing behaviour you did not write.
- A refactor and a behaviour change never share a commit.
- Public contracts (APIs, schemas, events, config keys) stay compatible
  unless the plan says otherwise.
- Introduce patterns at seams: put an adapter in front of legacy code and
  move callers over gradually. Never rewrite a working module in place to
  "fix" its style.

## 3. Write the files

- **`docs/CODING-STANDARDS.md`**: fill `templates/CODING-STANDARDS.md`. Fill
  every `<…>` with project facts and delete sections that do not apply. Keep
  it under ~200 lines, because CLAUDE.md imports it into every session. For
  depth, cite the shared standards (`standards show <n>`) rather than copying
  them.
- **`AGENTS.md`**: fill `templates/AGENTS.md`. The non-negotiables block is
  copied as-is, so Codex and Gemini get the rules without loading anything.
- **`CLAUDE.md`**:

  ```markdown
  @AGENTS.md
  @docs/CODING-STANDARDS.md
  @~/.claude-shared/CLAUDE.md
  @~/.claude-shared/shared/clients/<client-slug>.md

  Run the AGENTS.md commands through `quiet`: `quiet <test cmd>`, `quiet <lint cmd>`.
  ```

  Drop the client line when there is no client file.
- **`docs/implementation/README.md`**: the index plus the entry format, from
  `templates/implementation-log.md`.
- **`.claude/settings.json`**:

  ```json
  {
    "permissions": {
      "allow": ["Bash(quiet:*)", "Bash(rtk:*)", "Bash(<test cmd>:*)", "Bash(<lint cmd>:*)"],
      "deny": [
        "Read(./.env)", "Read(./.env.*)", "Read(./**/secrets/**)",
        "Read(./**/node_modules/**)", "Read(./**/dist/**)", "Read(./**/build/**)",
        "Read(./**/.next/**)", "Read(./**/bin/**)", "Read(./**/obj/**)",
        "Read(./**/*-lock.json)", "Read(./**/*.lock)", "Read(./**/__pycache__/**)",
        "Read(./**/*.min.js)", "Read(./**/*.map)"
      ]
    }
  }
  ```

  Tune the deny list to the build outputs this repo actually has.
- **`.mcp.json`**: only servers specific to this repo. Shared servers come
  from the toolkit.
- **`.gitignore`**: add `.claude/settings.local.json` and `.env` if missing.

## 4. Verify and report

Run every command you wrote into AGENTS.md, bare, once. A command that fails
or was not run gets `# unverified`. Report:

- the mode
- the files and folders created
- the verified commands
- the decisions you made (layout, patterns, logging library)
- what you could not determine

## Rules

- Never invent a command, a stack or a convention. Unverified means unverified.
- Brownfield never breaks existing behaviour: no structural moves, no mass
  reformatting, no contract changes.
- AGENTS.md and CODING-STANDARDS.md are client-facing and tool-neutral. Keep
  personal working preferences in the shared user layer.
- Apply a design pattern only where the architecture has the variation it
  solves. Record which pattern is used where; do not scaffold patterns
  speculatively.
