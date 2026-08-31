# Engineering standards

Applies to every repository unless that repo's own CLAUDE.md overrides a specific
rule. These are the standards `standards-reviewer` reviews against, so keep them
falsifiable — a rule nobody can be shown to have broken does not belong here.

## Change scope

- A change does one thing. Refactors ride in their own commit, never inside a
  behaviour change.
- Touch the minimum surface that solves the problem. Opportunistic cleanup in an
  unrelated file makes the diff unreviewable.
- Delete code rather than commenting it out. Version control is the archive.

## Correctness

- Every error path is either handled or deliberately propagated. Swallowed
  exceptions are a defect, not a style choice.
- Anything crossing a process boundary is validated at the boundary, not deeper in.
- Concurrency, retries and idempotency are designed, not assumed. If an operation
  can be delivered twice, say what happens the second time.

## Security

- No secrets in source, config committed to git, logs, or error messages.
- Authorization is checked server-side at the point of use, never only in the UI.
- External input is untrusted input, including input from another internal service.

## Tests

- New behaviour ships with a test that fails without the change.
- Test the contract, not the implementation. A test that breaks on every refactor
  is a liability.
- Fixing a bug means first writing the test that reproduces it.

## Naming and structure

- Use the client's own vocabulary for domain objects — their nouns, not synonyms.
- Module boundaries follow the domain, not the technical layer, unless the repo
  has already committed to layers.
- Public interfaces are documented where the behaviour is not obvious from the
  signature; private ones are not documented at all.

## Documentation

- A README explains how to run and how to contribute. Architecture rationale goes
  in an ADR, dated, with the alternatives that were rejected and why.
- When a decision is reversed, the old ADR stays and the new one references it.
