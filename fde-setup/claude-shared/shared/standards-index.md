# Engineering standards — index

`shared/engineering-standards.md` is normative and ~630 lines. It is deliberately
**not** loaded into every session. Read the section you need, not the document.

    standards list              # this index
    standards show 14           # section 14 only
    standards show 16.3         # one subsection
    standards find "timeout"    # which sections mention it

`standards` is `~/.claude-shared/bin/standards`. It prints from the installed
file, so a local amendment to the standards is what you get.

## Which section

| § | Covers | Read it when |
|---|---|---|
| 0 | RFC 2119 levels, precedence over platform idiom | interpreting a MUST/SHOULD, or a rule conflicts with the language |
| 1 | Purpose, scope, the five goals | framing a standards argument to a client |
| 2 | SRP, SOLID, DRY, SoC, KISS/YAGNI, explicitness, composition, immutability | reviewing structure or arguing a design |
| 3 | Greenfield: 3.1 front-end Atomic Design, 3.2 back-end layering, 3.3 non-negotiable separations | starting a new app, service or module |
| 4 | Brownfield and legacy | changing code you did not write and cannot rewrite |
| 5 | Naming, file/module layout, public surface | naming review, module boundaries |
| 6 | Complexity budgets, writing functions, testability as design | a function is too long or untestable |
| 7 | Types, contracts, data modelling | API shapes, DTOs, validation boundaries |
| 8 | Error handling and resilience | swallowed errors, retries, fallbacks, timeouts |
| 9 | Logging, observability, diagnostics | instrumentation review, incident readiness |
| 10 | Security baseline | secrets, authz, input handling, dependencies |
| 11 | API and interface contracts | versioning, breaking changes, contract tests |
| 12 | Performance and scalability | load, data volume, N+1, caching |
| 13 | Documentation and comments | comment noise, missing ADR or README |
| 14 | Testing: 14.1 suite shape, 14.2 rules | test plans, coverage arguments, TDD evidence |
| 15 | Version control | branch and commit hygiene |
| 16 | PRs and review: 16.1 author, 16.2 reviewer, 16.3 checklist | opening or reviewing a PR |
| 17 | CI quality gates | wiring or diagnosing a gate |
| 18 | AI-assisted development | agent-written code, provenance, review burden |
| 19 | Definition of Done | is this shippable |
| 20 | Anti-patterns — automatic review rejections | fastest path to a blocking finding |
| 21 | Adoption | rolling this into a client team |

## Rules for using this

- Cite section numbers in findings (`§8`, `§16.3`) so a reader can check you.
- Quote the MUST/MUST NOT line, not a paraphrase, when a finding blocks merge.
- Do not paste whole sections into a summary. The reader has the file.
