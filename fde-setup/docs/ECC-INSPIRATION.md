# ECC inspiration audit

Source reviewed: [affaan-m/ECC](https://github.com/affaan-m/ECC), commit
`ca185ef5f7667078a1e70a763bd3a9c71c48acf0` (ECC 2.2.1 preparation,
2026-08-31). ECC is MIT licensed. This FDE update is an original adaptation of
selected system patterns; ECC source files were not copied into the toolkit.

## Adopted

- **Evidence, not completion claims:** stage checkpoints record immutable file
  hashes, status and commands. Verification and observability evidence gate
  release progression.
- **TDD as a traceable loop:** behavior maps to RED and GREEN evidence, while
  repository and strict FDE standards determine tools and coverage policy.
- **Bounded context:** deterministic static context auditing, durable stage
  artifacts before compaction, and an explicit `FDE_RUN_ID` session brief.
- **Memory with trust boundaries:** lessons are create-only, run-local and
  `unreviewed`; human review promotes accepted knowledge into governed sources.
- **Agent-harness evals:** capability, regression, adversarial and safety cases
  distinguish first-attempt reliability from retry-assisted success.
- **Configuration defense in depth:** a deterministic scanner checks manifests,
  identity-role separation, MCP scoping, embedded secrets and bypass flags.
- **Reliability/test lenses:** PR review now checks behavioral test coverage and
  delegates silent-failure analysis for boundary-heavy changes.

## Deliberately not adopted

- ECC's full agent/skill/language-rule catalog; it would duplicate the FDE's
  focused roles and increase discovery/context overhead.
- GitHub Copilot support; this estate uses Microsoft Copilot for Microsoft 365,
  not GitHub Copilot as a coding surface.
- Automatic session-memory and continuous-learning hooks; unreviewed output must
  not silently become future policy or consume every session's context.
- Automatic formatting/typechecking Stop hooks; repository CI and the strict
  engineering standard remain authoritative, and brownfield work must avoid
  broad incidental rewrites.
- Blanket 80% coverage and mandatory checkpoint commits; coverage is governed
  by repository/risk policy, while evidence lives in the FDE run independent of
  the team's commit strategy.
- Always-on MCP expansion; Atlassian remains run-scoped and simple local/provider
  CLIs are preferred when they avoid schema/context overhead.
