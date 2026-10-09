# Coding standards — <project name>

Mode: <greenfield | brownfield>. Stack: <languages / frameworks>. Architecture: <style>.

**MUST** blocks merge. **SHOULD** needs a written reason in the PR.

## 1. Principles

- MUST follow SOLID, DRY, KISS and YAGNI. Build for today's requirement and
  leave a seam for the known next one, nothing more.
- MUST give every function, class and module a single responsibility. If you
  need "and" to describe it, split it.
- MUST keep code testable. Pass dependencies in (constructor or parameter
  injection), keep business logic free of I/O, and give side effects one
  owner.
- SHOULD keep functions to ≤ <30> lines, ≤ <4> parameters and ≤ 3 levels of
  nesting. Use a parameter object instead of a long argument list.

## 2. Reuse and separation

- MUST keep reusable configuration in `<config path>`: database, cache, queues,
  external tools and APIs, feature flags, timeouts. Configuration is typed,
  loaded from environment or secret store, validated at start-up and injected.
  Code never reads environment variables directly.
- MUST keep reusable values as named constants in `<constants path>`. No magic
  numbers or strings in logic.
- MUST put every external system (database, SDK, HTTP API, LLM provider, queue)
  behind an adapter in `<adapters path>`. Business code depends on the
  interface, not the vendor.
- MUST NOT duplicate logic. Search the repo before writing a helper; extract
  on the second occurrence when the two copies would change together.
- Shared helpers live in `<shared path>`. Nothing lands in a catch-all `utils`
  without a named purpose.

## 3. Design patterns

Use a pattern where the architecture has the variation it solves:

| Pattern | Use when | Here |
|---|---|---|
| Strategy | interchangeable algorithms or providers chosen at runtime | <e.g. pricing rules, LLM provider> |
| Factory | which implementation to build depends on config or input | <e.g. adapter factory from config> |
| Adapter | wrapping an external system or legacy module behind our interface | <every integration> |
| Observer / events | side effects that must not couple to the trigger | <e.g. audit, notifications> |
| Repository | data access behind a domain-shaped interface | <persistence layer> |

MUST NOT introduce a pattern without its variation point (YAGNI).

## 4. Error handling

- MUST use typed errors derived from `<BaseError>`, carrying a code and context.
- MUST NOT swallow errors. Catch only to add context, translate, retry or
  recover, and rethrow with the original as the cause.
- MUST translate errors to responses at the boundary only (controller,
  handler, job runner). Domain code does not know about HTTP.
- MUST put timeouts on every external call. Retry only transient failures,
  with backoff and a limit.

## 5. Logging — the 4 Ws

- MUST log through the logger from `<logger factory path>`. No `print`,
  `console.log` or `Console.WriteLine`.
- MUST produce structured logs, and every entry MUST carry:
  - **Who**: actor (user or service id) and correlation/request id
  - **What**: event name, outcome and key identifiers
  - **When**: UTC ISO-8601 timestamp, set by the logger
  - **Where**: service, module/class and function, plus environment
- MUST log an error once, where it is handled, with the stack trace. Do not
  log and rethrow at every layer.
- MUST NOT log secrets, tokens or personal data.
- Levels: `error` needs action; `warn` is degraded but working; `info` is a
  business event; `debug` is diagnostic and off in production.

## 6. Comments

- MUST NOT add comments that restate the code. Use names, types and small
  functions to explain instead.
- A comment is allowed only for a non-obvious *why*, such as a workaround,
  an external constraint or a deliberate trade-off.

## 7. Imports, linting and formatting

- MUST sort imports alphabetically within groups (standard library, then
  third party, then local), enforced by `<import-sort tool>`. No unused or
  wildcard imports.
- MUST pass `<lint cmd>` and `<format cmd>` with zero warnings on changed code.
  CI enforces both.
- MUST pass the type checker: `<type-check cmd>`.

## 8. Testing

- MUST give every behaviour change a test that fails without it.
- Unit tests cover business logic with adapters faked. Integration tests cover
  adapters against real or contained dependencies.
- Tests mirror the source layout in `<tests path>`.

## 9. Documentation

- MUST add an entry to `docs/implementation/` after every implementation (see
  its README for the format), and update its index.
- MUST record changed architectural decisions as an ADR in `docs/adr/`.
- MUST update the README or API docs when a command, configuration key or
  contract changes.

## 10. Existing code (brownfield only)

<Classified conventions: keep / match locally / improve in new code, each with
a file:line example. Known traps. Then the safe-change rules:>

- Characterization tests before changing behaviour you did not write.
- A refactor and a behaviour change never share a commit.
- Public contracts stay compatible unless the plan says otherwise.
- Introduce new patterns at seams (adapter or strangler), never by rewriting
  working code in place.
- Do not reformat or restructure existing files outside the change.

## 11. Stack specifics

| Concern | Choice |
|---|---|
| Linter / formatter | <…> |
| Import sorting | <…> |
| Type checking | <…> |
| Logger | <…> |
| Test runner | <…> |
| Config loading | <…> |
