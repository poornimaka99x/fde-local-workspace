# <repo name>

## What this is
<two sentences: what it does, who uses it>

## Layout
<one line per top-level folder, only where the name is not self-explanatory>

## Commands
- install: <cmd>
- lint: <cmd>
- format: <cmd>
- type-check: <cmd>
- test: <cmd>
- run locally: <cmd>

## Non-negotiables
Full rules: `docs/CODING-STANDARDS.md`.
- Single responsibility per function, class and module. Testable: dependencies are injected and logic is free of I/O.
- SOLID, DRY, KISS, YAGNI. Use Strategy, Factory, Adapter or Observer only where the architecture needs them.
- Configuration (database, external tools, flags) lives in `<config path>`. Constants live in `<constants path>`. External systems sit behind adapters.
- Search before writing a helper. No duplicated logic.
- Typed errors. Never swallow an error. Log once, where it is handled.
- Structured logs through the shared logger, with who, what, when and where on every entry. No secrets.
- No comments except a non-obvious why.
- Imports sorted alphabetically. Lint, format and type checks are clean before you finish.
- After every implementation, add an entry to `docs/implementation/` and update its index.
<brownfield: - Keep the existing structure. No reformatting outside the change. Characterization tests before changing existing behaviour.>
