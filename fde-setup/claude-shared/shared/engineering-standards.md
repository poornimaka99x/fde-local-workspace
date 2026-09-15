# Engineering Coding Standards

**Language-agnostic. Framework-agnostic. Enterprise-grade.**

| | |
|---|---|
| **Version** | 1.0 |
| **Applies to** | All application code, services, libraries, infrastructure-as-code and automation |
| **Status** | Normative |

---

## 0. How to read this document

Requirement levels follow RFC 2119:

- **MUST** / **MUST NOT** — non-negotiable. A violation blocks merge.
- **SHOULD** / **SHOULD NOT** — strong default. Deviation is allowed only with a written justification in the pull request.
- **MAY** — permitted at the team's discretion.

Every rule here is intended to be **checkable** — by a linter, a static analyser, a CI gate, or a reviewer answering yes/no. Rules that cannot be checked are guidance, not standards, and are marked as such.

Where a language, framework or platform convention conflicts with this document, **the platform idiom wins for syntax and naming**, and this document wins for **structure, responsibility and quality**. Never fight the language.

---

## 1. Purpose and scope

This document defines how we write, structure, test, review and ship code, independent of language or framework. It exists to make code:

1. **Understandable** — a competent engineer new to the codebase can follow any file in minutes.
2. **Changeable** — a requirement change touches a small, predictable number of places.
3. **Testable** — behaviour can be verified without standing up the world.
4. **Scalable** — in traffic, in data volume, in feature count, and in team size.
5. **Consistent** — the codebase reads as if written by one disciplined author.

Consistency is a first-class goal. A codebase where every file follows a slightly worse convention *uniformly* is more maintainable than one where every file follows a slightly better convention *differently*.

---

## 2. Core principles

These are the principles every other section derives from.

### 2.1 Single Responsibility

Every module, class, function, component, file and service **MUST** have exactly one reason to change.

Practical test: describe what the unit does in one sentence. If the sentence needs "and", "also", or a comma-separated list of unrelated actions, split it.

- A function either **decides**, **transforms**, or **performs an effect** — it SHOULD NOT do all three.
- A UI component either **renders** or **orchestrates** — not both, once it exceeds trivial size.
- A class that talks to a database, formats output and applies business rules is three classes.

### 2.2 SOLID

Applied to any paradigm — object-oriented, functional or procedural. Read "type" as class, module, or set of related functions.

| Principle | Rule | Practical signal it is broken |
|---|---|---|
| **S** — Single Responsibility | One reason to change per unit | The file changes for unrelated tickets |
| **O** — Open/Closed | Extend behaviour by adding code, not by editing existing branching logic | Every new case adds a branch to the same `switch` |
| **L** — Liskov Substitution | Any implementation MUST be usable wherever the abstraction is declared, without special-casing | Callers check the concrete type before calling |
| **I** — Interface Segregation | Consumers depend only on the operations they use | Implementations throw `NotSupported` for half the interface |
| **D** — Dependency Inversion | High-level policy depends on abstractions; low-level detail is injected | Business logic imports the database driver directly |

**Dependency Inversion is the highest-leverage of the five.** Business logic MUST NOT import infrastructure (HTTP clients, ORMs, SDKs, file systems, clocks, random sources) directly. Infrastructure is passed in. This single rule is what makes code testable without mocking frameworks fighting the design.

### 2.3 Minimum duplication (DRY, with judgement)

Duplicated **knowledge** — a business rule, a validation constraint, a status value, a calculation, an endpoint path — **MUST** exist in exactly one place.

Duplicated **shape** — two pieces of code that look similar today but serve different concepts — MAY remain duplicated.

**The Rule of Three:** the first occurrence is written inline; the second is noted; on the **third** occurrence it is extracted — unless the duplication is of a business rule, in which case it is extracted on the **second**.

> A wrong abstraction is more expensive than duplication. Duplication is cheap to fix; a leaky shared abstraction couples unrelated features together and is paid for on every change.

Signal that an abstraction is wrong: it takes boolean flags or a "mode" parameter that changes what it fundamentally does. Split it instead.

### 2.4 Separation of concerns

Code is organised into distinct layers with a one-directional dependency flow:

```
  Presentation / Interface  ->  Application / Orchestration  ->  Domain / Business rules
                                                                        ^
                                            Infrastructure / Adapters ---|
```

- Dependencies **MUST** point inward. The domain knows nothing about HTTP, SQL, queues, or the UI framework.
- Crossing a layer boundary MUST happen through an explicit contract (interface, port, type), never by reaching through.

### 2.5 KISS, YAGNI and the least-astonishment rule

- **KISS** — the simplest solution that satisfies the requirement and the known non-functional constraints wins.
- **YAGNI** — build for requirements that exist or are committed. Do not build extension points for hypothetical futures. *Design* so a future is cheap; do not *implement* it.
- **Least astonishment** — code SHOULD do what its name says and nothing more. No hidden side effects, no surprising mutations of inputs, no I/O behind an innocent-looking getter.

### 2.6 Explicit over implicit

- Prefer explicit dependencies over globals, singletons, service locators and ambient state.
- Prefer explicit types and contracts over duck-typed assumptions at boundaries.
- Prefer explicit error returns or typed exceptions over silent failure.
- Magic — implicit conventions, reflection-based wiring, auto-discovery — is permitted only where the framework mandates it.

### 2.7 Composition over inheritance

Behaviour is assembled from small independent pieces. Inheritance is reserved for genuine "is-a" relationships and SHOULD NOT exceed **two levels** deep. Shared behaviour is a collaborator, a mixin of pure functions, or a decorator — not a base class that accumulates unrelated helpers.

### 2.8 Immutability by default

- Function inputs **MUST NOT** be mutated. Return new values.
- Shared state is immutable unless there is a measured performance reason.
- Mutation, where required, is local, contained, and confined to the smallest possible scope.

---

## 3. Greenfield projects

When we control the structure, we use it deliberately.

### 3.1 Front end — Atomic Design

Front-end code **MUST** be organised on Atomic Design, with a strict dependency direction:

| Level | Contains | May depend on | MUST NOT |
|---|---|---|---|
| **Atoms** | Smallest indivisible UI elements — button, input, label, icon, badge | Design tokens only | Know about business domain, fetch data, hold app state |
| **Molecules** | Small groups of atoms that do one job — form field with label and error, search box, card header | Atoms, tokens | Fetch data, know routing |
| **Organisms** | Self-contained composite sections — header, data table, checkout summary, filter panel | Molecules, atoms | Own global state, call APIs directly |
| **Templates** | Layout and slot arrangement, no real data | Organisms | Contain business logic |
| **Pages / Screens** | Route-level composition, data binding, orchestration | Everything below | Contain reusable presentational markup that belongs lower down |

Rules:

1. **Dependencies flow downward only.** An atom **MUST NOT** import a molecule. Circular imports between levels are a build failure.
2. **Presentational components MUST be pure** with respect to the application: props in, markup out, events out. No data fetching, no direct store access, no navigation side effects below the page level.
3. **Data access, state orchestration and side effects live at page/container level** or in dedicated hooks/services/view-models — never inside atoms or molecules.
4. A component **MUST NOT** be created at a level higher than necessary. If it is used by two features, it belongs to shared, not to a feature folder.
5. Every reusable component **MUST** be documented with its props/inputs contract and rendered in the component workbench (Storybook or equivalent) before it is considered done.
6. **Styling** uses design tokens (colour, spacing, typography, radius, elevation, z-index, breakpoints) defined once. Hard-coded colour, spacing or font values in components are a review rejection.
7. Accessibility is part of the component contract, not a later pass — semantic elements, keyboard operability, labels, focus management and contrast are acceptance criteria for every interactive component.

A representative greenfield front-end structure (names adapt to the ecosystem):

```
src/
  assets/
  components/
    atoms/
    molecules/
    organisms/
    templates/
  pages/                  # or screens/, routes/
  features/               # feature-scoped composition, state and logic
  hooks/                  # or composables/, view-models/
  services/               # API clients — transport only, no business rules
  api/
    endpoints.<ext>       # ALL endpoint paths, centralised
    client.<ext>          # configured transport, interceptors, retry
  state/                  # global store, slices, selectors
  utils/                  # pure, reusable, side-effect-free helpers
  constants/              # enums, keys, magic values, route names, messages
  config/                 # environment-driven configuration, read once
  types/                  # shared contracts, DTOs, models
  styles/                 # tokens, themes, global styles
  tests/                  # shared test utilities, fixtures, builders
```

### 3.2 Back end — layered / modular

Back-end code **MUST** be organised by **feature or bounded context first**, and by technical layer second. Package-by-feature keeps changes local; package-by-layer-only spreads one change across the codebase.

Within each feature, the layering is:

| Layer | Responsibility | MUST NOT |
|---|---|---|
| **Interface / Controller / Handler** | Accept the request, validate shape, map to a command, map the result to a response, map errors to status codes | Contain business rules, touch the database, build queries |
| **Application / Service / Use case** | Orchestrate one use case: sequence steps, manage transaction boundaries, coordinate domain and ports | Contain transport concerns, know about HTTP/JSON/queues |
| **Domain** | Entities, value objects, invariants, business rules, domain-level calculations | Import any framework, ORM, or I/O library |
| **Infrastructure / Adapter / Repository** | Persistence, external APIs, messaging, cache, files, clock — implementations of the ports the inner layers declare | Contain business rules |

Representative structure:

```
src/
  modules/                        # or features/, contexts/
    <feature>/
      interface/                  # controllers, handlers, routes, DTOs
      application/                # use cases, orchestration, transactions
      domain/                     # entities, value objects, domain services, rules
      infrastructure/             # repositories, external clients, mappers
      <feature>.constants.<ext>
      <feature>.errors.<ext>
      tests/
  shared/
    utils/                        # pure helpers reused across features
    errors/                       # error taxonomy, base error types
    middleware/                   # cross-cutting request concerns
    logging/
    validation/
  config/                         # typed configuration, loaded and validated at startup
  constants/                      # cross-cutting constants and enums
  routes/                         # route registration and endpoint definitions
  db/                             # migrations, seeds, connection management
```

### 3.3 Non-negotiable separations (both tiers)

These four separations apply to every project, greenfield or brownfield.

**1. Constants MUST be separated out.**

- No magic numbers or magic strings in logic. Every repeated or meaningful literal is a named constant.
- Constants are grouped by domain (`order.constants`, `auth.constants`), not dumped in one global file.
- Fixed sets of values are enums or equivalent frozen structures — never loose strings compared with `==`.
- Constants files contain values only: **no logic, no I/O, no environment reads at import time**.
- User-facing text is externalised (i18n catalogue or message constants), never inlined in components or handlers.

**2. Reusable logic MUST be moved to utilities.**

- A utility is **pure**: same input, same output, no I/O, no global state, no time or randomness unless injected.
- Utilities are grouped by subject (`date.utils`, `currency.utils`, `string.utils`) — never a single `helpers` or `common` dumping ground.
- Every utility **MUST** have unit tests. A utility without tests is not done.
- If a "utility" needs a network call, a database, or configuration, it is a **service**, not a utility. Move it.

**3. Configuration MUST be separated out and externalised.**

- All environment-dependent values (URLs, timeouts, feature flags, limits, credentials references) come from configuration, never from inline literals.
- Configuration is **read and validated once at startup**, into a typed object, and fails fast with a clear message when invalid or missing. Never scatter raw environment lookups through the codebase.
- The same build artefact **MUST** run in every environment; only configuration changes.
- **Secrets MUST NOT** be committed, logged, printed, or placed in front-end bundles. They come from a secret manager or the platform's injected environment.
- A committed example configuration file documents every required key with a safe placeholder.

**4. Endpoints MUST be separated out.**

- Endpoint paths and route definitions live in a dedicated module. No URL string literals inside components, services, or business logic.
- Path parameters are built through a helper or template function, never string-concatenated ad hoc at call sites.
- The client transport layer (base URL, headers, auth, retry, timeout, error normalisation) is configured once and reused. Individual features **MUST NOT** create their own HTTP clients.
- Server-side, route registration is declarative and centralised per module, so the full API surface can be read in one place.

---

## 4. Brownfield and legacy projects

Where the folder structure and conventions are inherited and **cannot** be changed, the standards adapt but do not disappear.

**Rules:**

1. **Follow the existing structure and conventions.** Do not introduce a competing architecture inside an established codebase. Two half-applied architectures are worse than one imperfect one. Placement, naming and style follow what is already there.
2. **Standards apply at the unit level regardless.** Every function, class or component you add or touch **MUST** satisfy single responsibility, low complexity, testability and no duplication — even if its neighbours do not.
3. **Leave it better (Boy Scout Rule), within the blast radius of your change.** Improve what you touch — extract a magic value, name a condition, split a function, add the missing test. Do not launch unrelated refactors inside a feature or fix PR.
4. **New logic goes into new, isolated, testable units.** Rather than adding a fifth branch to a 400-line function, extract the new behaviour into its own well-tested function or module in the existing structure and call it. New code is written to this standard even inside legacy files.
5. **Separate refactor commits from behaviour commits.** A pull request either changes behaviour or restructures code — not both. This keeps review honest and rollback safe.
6. **Characterisation tests before refactoring.** Untested legacy code is pinned with tests that capture current behaviour *before* it is restructured, so the refactor can be proven behaviour-preserving.
7. **Isolate the legacy.** Where legacy code must be integrated with, wrap it behind a clean interface (anti-corruption layer) so new code depends on a good contract and the legacy can be replaced later without ripple.
8. **Record deviations.** Where an existing convention conflicts with this document, note it once in the repository's own standards file rather than re-arguing it in every review.
9. **Never mass-reformat.** Whitespace or style churn across untouched files destroys history and code review. Formatting changes are their own commit, ideally repo-wide and one time only.

---

## 5. Structure, naming and files

### 5.1 Naming

Names are the primary documentation. They **MUST** be precise.

- Use the **domain's vocabulary** (ubiquitous language). If the business says "booking", the code says `booking`, never `reservation` in one place and `order` in another.
- **Intention-revealing.** `getActiveSubscribersSince(date)` over `getData(d)`.
- **No abbreviations** except universally understood ones (`id`, `url`, `http`, `db`, `api`). Never invent abbreviations.
- **Booleans** read as assertions: `isActive`, `hasPermission`, `canRetry`, `shouldRefresh`.
- **Functions** begin with a verb: `calculate`, `validate`, `fetch`, `map`, `build`, `resolve`. The verb tells the truth: `get*` MUST be cheap and side-effect free; anything doing I/O is `fetch*`, `load*`, or `retrieve*`.
- **Collections are plural**; single items are singular.
- **Units and currency are in the name** where ambiguity is possible: `timeoutMs`, `sizeBytes`, `amountMinorUnits`, `distanceKm`.
- **No noise words**: `data`, `info`, `manager`, `helper`, `util`, `handler`, `processor`, `stuff`, `temp`, `obj` as a whole name. `UserManager` almost always means "a class with no defined responsibility".
- **No type-encoding prefixes** (`strName`, `IUserInterface`) unless the ecosystem genuinely conventions it.
- Follow the **language's casing idiom** consistently. Casing style is chosen once per repo and enforced by a linter, never debated per PR.

### 5.2 Files and modules

- **One primary export per file**, named after the file. Supporting private helpers may live alongside it.
- **File name matches the thing it contains**, in the repository's chosen casing convention.
- **Soft limit: 300 lines per file, 400 hard.** Beyond that, the file has more than one responsibility. (Generated code, migrations, fixtures and lock files are exempt.)
- **Directory depth SHOULD NOT exceed four levels** below the source root. Deeper nesting is a sign the structure is describing itself instead of the domain.
- **No circular dependencies between modules.** Enforced in CI.
- **Imports are ordered and grouped** — standard library, third party, internal, relative — with the order enforced by a linter, not by hand.
- **Barrel/index re-export files** are permitted for a module's public API, but MUST NOT create import cycles or pull the whole application graph into a single import.

### 5.3 Public surface

- Every module has a deliberate **public API**. Everything else is private/internal to it.
- Consumers **MUST NOT** reach into another module's internals; they use the declared entry point.
- Anything exported is a contract: it needs a name you can live with, a stable signature, and tests.

---

## 6. Functions and complexity

Small, single-purpose, testable functions are the unit of quality.

### 6.1 Budgets

These are enforced by static analysis. Exceeding one is a code smell to be justified in review, not a routine occurrence.

| Metric | Target | Hard limit |
|---|---|---|
| Cyclomatic complexity per function | ≤ 5 | **10** |
| Cognitive complexity per function | ≤ 8 | **15** |
| Function length (executable lines) | ≤ 30 | **50** |
| Parameters | ≤ 3 | **5** (beyond that, pass a named object/struct) |
| Nesting depth | ≤ 2 | **3** |
| Return points | Consistent within a function | — |
| File length | ≤ 300 lines | **400** |
| Class/module public methods | ≤ 10 | **15** |

### 6.2 Writing functions

- **Do one thing.** A function's body should operate at a single level of abstraction — do not mix high-level orchestration with low-level string manipulation in the same body.
- **Guard clauses over nesting.** Validate and return early; keep the happy path at the leftmost indentation.
- **No boolean flag parameters** that switch behaviour. `render(true)` tells the reader nothing. Write two functions.
- **No output parameters.** Return the result.
- **Command/Query Separation:** a function either returns a value **or** changes state — not both, where avoidable.
- **Pure by default.** Push side effects (I/O, logging, mutation, time, randomness) to the edges; keep the core decision logic pure and trivially testable.
- **Inject non-determinism.** Clocks, UUID generators, random sources and environment access are passed in, never called directly from business logic. This is the single most common cause of untestable code.
- **Name the condition.** Replace `if (u.a > 18 && u.s === 'A' && !u.b)` with `if (isEligibleForCheckout(user))`.
- **Fail fast.** Validate inputs at the boundary; assume validity inside.

### 6.3 Testability is a design property

Code is not "tested later"; it is **written to be testable**. A function is testable when:

- Its dependencies are visible in its signature or constructor.
- It has no hidden global or static state.
- It does not construct its own collaborators (`new HttpClient()` inside a use case is a defect).
- Its output is observable through a return value or an injected collaborator, not only through a log line or a database side effect.

> If a test requires heavy mocking, patching of internals, or a real database to verify a rule, the design is wrong — fix the design, not the test.

---

## 7. Types, contracts and data

- Use the strongest typing the language offers, in its strictest reasonable mode. Where the language is dynamic, use type annotations or schemas at all boundaries.
- **Never use an escape hatch type** (`any`, `object`, untyped map, raw dictionary) at a public boundary. Where an external payload is genuinely unknown, parse and validate it into a known type immediately.
- **Validate at the boundary, trust inside.** All external input — HTTP requests, queue messages, file contents, third-party responses, user input — is validated and normalised at the edge against an explicit schema. Internal code assumes validated data.
- **Separate wire models from domain models.** DTOs/API contracts and domain entities are distinct types with an explicit mapper. Never let an ORM entity or an external vendor's payload shape leak into the domain or the UI.
- **Make illegal states unrepresentable** where the type system allows: prefer a union of valid shapes over a bag of optional fields with implicit rules.
- **Model absence explicitly.** Do not overload `null`, `0`, `-1` and `""` to mean different things. Distinguish "absent", "empty" and "invalid".
- **Nullability is deliberate** and handled at the point it arises, not propagated deep into the codebase.

---

## 8. Error handling and resilience

- **Never swallow errors.** An empty catch block, or one that only logs and continues with corrupt state, is a defect.
- **Define an error taxonomy** — validation, not-found, unauthorised, conflict, dependency-failure, unexpected — and map it once, at the boundary, to transport-level responses. Business logic throws or returns domain errors, not HTTP status codes.
- **Fail fast and loudly at startup** (bad config, missing dependency); **fail gracefully and contained at runtime** (degrade the feature, not the system).
- **Errors carry context**: what operation, which identifiers, which correlation ID — never secrets, credentials, tokens or personal data.
- **Do not use exceptions for control flow** in expected paths (an unauthenticated user is an expected outcome, not an exception).
- **Every external call MUST have an explicit timeout.** No unbounded waits, ever.
- **Retries** apply only to idempotent operations, with exponential backoff and jitter and a bounded attempt count. Non-idempotent operations use idempotency keys.
- **Apply circuit breakers or bulkheads** to dependencies that can fail, so one slow downstream cannot exhaust the whole service.
- **Clean up resources deterministically** — connections, file handles, locks, subscriptions, listeners, timers — using the language's scoped disposal construct.
- **User-facing messages are actionable and safe.** No stack traces, internal identifiers, SQL, or system paths surfaced to end users.

---

## 9. Logging, observability and diagnostics

- **Structured logging only** (key-value / JSON). No string-concatenated log messages.
- **Every log entry carries a correlation/trace ID** propagated across service and async boundaries.
- **Levels are used consistently:** `ERROR` — needs human attention; `WARN` — degraded but handled; `INFO` — significant business or lifecycle events; `DEBUG` — developer diagnostics, off in production.
- **MUST NOT log** secrets, tokens, credentials, full payment data, or personal data. Sensitive fields are masked by a shared, tested redaction helper — not by ad-hoc string edits at each call site.
- **No `print`/`console` debugging statements in committed code.** Enforced by lint.
- **Instrument what matters:** the four golden signals (latency, traffic, errors, saturation) for services, plus key business events. New endpoints and jobs ship with metrics and, where relevant, alerts.
- **Health endpoints** distinguish liveness (is the process up) from readiness (can it serve traffic, are its dependencies reachable).

---

## 10. Security baseline

Security is a coding standard, not a phase.

- **Validate and sanitise all input** at the boundary; encode all output for its destination context (HTML, SQL, shell, URL, log).
- **Parameterised queries only.** String-built SQL or command lines with user input is a hard block.
- **Never hard-code secrets.** No credentials, tokens or keys in source, config committed to the repo, front-end bundles, log output or error messages. Secret scanning runs in CI.
- **Authenticate and authorise on the server, at every entry point.** UI-level hiding is not authorisation. Authorisation is checked against the resource, not only the route (no insecure direct object references).
- **Least privilege** for every credential, service account, database user, token scope and IAM role.
- **Encrypt in transit and at rest.** Modern TLS only; certificate validation is never disabled.
- **Dependencies:** pinned versions, committed lock files, automated vulnerability scanning, and a defined SLA for patching critical findings.
- **Personal data** is minimised, access-controlled, retained only as long as required and excluded from logs and analytics payloads.
- **Deny by default** — new endpoints, permissions and network rules start closed and are opened deliberately.

---

## 11. API and interface contracts

- API design is **contract-first**: the schema (OpenAPI, GraphQL SDL, protobuf, AsyncAPI) is defined and reviewed before implementation, and is the source of truth.
- Contracts are **versioned**, and changes are **backwards compatible** by default: add optional fields, never repurpose or silently remove existing ones. Breaking changes require a new version and a documented deprecation window.
- **Consistency across the surface:** naming, casing, pagination, filtering, sorting, error envelope, date/time format (ISO 8601, UTC) and identifier format are uniform across all endpoints.
- **Idempotency** is defined for every mutating operation that can be retried.
- **Pagination is mandatory** for any collection that can grow unbounded. No endpoint returns "everything".
- Contract changes are validated in CI against consumers (contract tests) before release.

---

## 12. Performance and scalability

- **Measure before optimising.** Optimisation without a profile or a benchmark is speculation, and speculative optimisation that harms readability is rejected.
- **But do not design in a known bottleneck**: N+1 queries, unbounded result sets, per-item network calls in a loop, and synchronous work inside request paths are design defects, not optimisations to defer.
- **Set explicit limits** on payload size, page size, upload size, concurrency, queue depth and request rate.
- **Statelessness:** services hold no in-process session state, so they scale horizontally. Shared state lives in a store built for it.
- **Cache deliberately** — with an explicit key strategy, TTL, invalidation rule and a documented staleness tolerance. An undocumented cache is a future incident.
- **Long-running work is asynchronous**, with progress visibility, retry semantics and dead-letter handling.
- **Front end:** ship the minimum bundle needed to render — code-split by route, lazy-load below the fold, virtualise long lists, avoid layout thrash, and define performance budgets that CI enforces.

---

## 13. Documentation and comments

- **The code is the primary documentation. Do not add code comments by default.** Prefer precise names, small functions and clear structure that make the implementation self-explanatory.
- Add a comment only when information required to understand or safely change the code cannot be expressed clearly in the code itself. Valid cases include non-obvious business or regulatory rationale, a workaround for an upstream bug (with a link), a deliberate trade-off, or an algorithmic constraint.
- Comments **MUST NOT** narrate the implementation, restate what the code does, label obvious sections, preserve development notes, or explain changes that belong in version control or the pull request. Delete such comments.
- **No commented-out code.** Version control holds history. Delete it.
- **`TODO`/`FIXME` MUST reference a ticket** (`TODO(PROJ-123): ...`). Untracked TODOs are rejected — they are permanent, invisible debt.
- Add doc comments to public APIs only when required by repository tooling or conventions, or when a non-obvious contract cannot be communicated through the name and type signature. Do not generate boilerplate doc comments for self-explanatory exports.
- **Every repository has a README** that states what the service does, how to run it locally, how to test it, how to configure it, and how to deploy it — kept accurate as part of Definition of Done.
- **Significant technical decisions are recorded as ADRs** (Architecture Decision Records): context, options considered, decision, consequences. One short file per decision, in the repo, immutable once accepted.

---

## 14. Testing standards

Tests are production code. They are held to the same standards of clarity and structure.

### 14.1 Shape of the suite

| Level | Proportion | Characteristics |
|---|---|---|
| **Unit** | Majority | No I/O, no network, no database, no clock. Milliseconds. Test one unit's behaviour. |
| **Integration** | Meaningful minority | Real adapters against real dependencies (containers/in-memory equivalents): repositories, clients, migrations. |
| **Contract** | Every published/consumed API | Verifies producer and consumer agree on the schema. |
| **End-to-end** | Few, high value | Critical user journeys only. Deliberately small — they are slow and brittle. |

### 14.2 Rules

- **Test behaviour, not implementation.** A refactor that preserves behaviour MUST NOT break tests. Tests that assert on private internals or call counts of internal helpers are brittle by construction.
- **Structure: Arrange–Act–Assert**, visibly separated.
- **One logical assertion per test.** Multiple physical assertions verifying one outcome are fine.
- **Test names state the scenario and expectation**: `returns_conflict_when_booking_already_cancelled`.
- **Deterministic.** No dependency on real time, timezone, locale, random values, execution order, network or leftover state. Flaky tests are fixed or deleted, never re-run until green.
- **Isolated.** Each test sets up and tears down its own state and can run in parallel.
- **Cover the edges**: empty, null/absent, zero, negative, boundary values, maximum size, duplicates, unicode, concurrent access, and every failure path — not only the happy path.
- **No logic in tests.** No conditionals or loops driving assertions; a test with branching needs to be several tests.
- **Use builders/factories with sensible defaults** for test data, so each test states only what is relevant to it.
- **Mock only what you own or what is genuinely external and slow.** Do not mock the language, the framework, or value objects. Prefer real objects and fakes over mock frameworks.
- **Every bug fix ships with a regression test** that fails before the fix and passes after. Non-negotiable.
- **Coverage is a signal, not a target.** A minimum line/branch threshold is enforced in CI (typically 80% for new and changed code), but high coverage with weak assertions is worse than honest lower coverage. Mutation testing is the better measure where available.

---

## 15. Version control

- **Trunk-based or short-lived branches.** A branch lives days, not weeks. Long-lived branches produce painful merges and hide risk.
- **Small, focused, atomic commits.** Each commit compiles, passes tests, and represents one coherent change.
- **Conventional Commits** for messages: `type(scope): imperative summary` — `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`. The body explains **why**; the footer references the ticket and flags breaking changes.
- **Never commit**: secrets, credentials, build output, dependency directories, IDE settings, local environment files, large binaries.
- **Never force-push a shared branch.**
- **The main branch is always releasable.** Incomplete work is hidden behind a feature flag, not held in a branch.
- **Feature flags are removed** once the feature is stable — a flag is temporary by definition and its removal is tracked.

---

## 16. Pull requests and code review

### 16.1 Author responsibilities

- **Keep it small.** Target under ~400 changed lines. Review quality collapses beyond that.
- **One purpose per PR.** Behaviour change or refactor — not both.
- **Self-review first.** Read your own diff before requesting review; most findings are caught here.
- **Describe the change**: what, why, how to verify, screenshots for UI, and any risk or rollback note.
- **Green before review** — all automated gates pass before a human is asked to look.

### 16.2 Reviewer responsibilities

- Review promptly; a blocked PR blocks a person.
- **Review the design first**, then correctness, then details. Formatting is the linter's job, not the reviewer's.
- **Comment on the code, not the coder.** Ask questions rather than issue verdicts. Mark non-blocking suggestions clearly (`nit:`).
- **Approval means you accept responsibility for the change.** If you do not understand it, do not approve it — ask.

### 16.3 Reviewer checklist

**Design and responsibility**
- [ ] Does each new unit have a single, clearly nameable responsibility?
- [ ] Do dependencies point inward — is business logic free of framework and I/O concerns?
- [ ] Is this the simplest design that meets the requirement (no speculative generality)?

**Duplication and reuse**
- [ ] Does this duplicate existing logic that should have been reused or extracted?
- [ ] Is the new abstraction justified, or is it a premature/wrong abstraction with flag parameters?

**Separation**
- [ ] Magic values extracted into constants?
- [ ] Reusable pure logic moved into utils, with tests?
- [ ] Configuration externalised and validated, nothing environment-specific inlined?
- [ ] Endpoints/paths centralised, not string-literal at call sites?

**Complexity and readability**
- [ ] Are functions within complexity, length, parameter and nesting budgets?
- [ ] Do names reveal intent in the domain's language?
- [ ] Can a new engineer follow this without the author explaining it?

**Correctness and safety**
- [ ] Are edge cases and failure paths handled — not just the happy path?
- [ ] Are errors handled meaningfully, with context, and never silently swallowed?
- [ ] Timeouts on all external calls; retries only where idempotent?
- [ ] Input validated at the boundary; output encoded for its context?
- [ ] Any secrets, personal data or sensitive values at risk of being logged or exposed?
- [ ] Any authorisation check missing at the entry point?

**Testing**
- [ ] Do tests cover the behaviour, including failure modes?
- [ ] Would these tests survive a refactor that preserves behaviour?
- [ ] Regression test included for a bug fix?

**Operability**
- [ ] Is it observable — logs, metrics, correlation IDs?
- [ ] Is it backwards compatible, or is the migration/deprecation path documented?
- [ ] Is there a rollback path?

---

## 17. Automation and CI quality gates

Standards that are not automated are opinions. The pipeline enforces the following on every pull request; a failure blocks merge.

| Gate | Requirement |
|---|---|
| **Formatter** | A single automated formatter, zero configuration debate, applied repo-wide |
| **Linter / static analysis** | Zero errors; warnings capped and never increasing |
| **Type check** | Strict mode, zero errors |
| **Complexity check** | Section 6.1 budgets enforced |
| **Duplication check** | Copy-paste detection threshold enforced; no new duplication introduced |
| **Unit + integration tests** | All pass; coverage threshold met on new and changed code |
| **Contract tests** | Pass against consumers/providers |
| **Dependency vulnerability scan** | No new critical or high findings |
| **Secret scanning** | Zero findings |
| **SAST** | No new high-severity findings |
| **Build** | Reproducible; artefact built once and promoted across environments |
| **Migrations** | Apply and roll back cleanly |

Additional rules:

- **Pre-commit hooks** run format, lint and fast tests locally so the pipeline is a safety net, not the first line of feedback.
- **A red pipeline on the main branch is the team's highest priority.** No new work merges until it is green.
- **Quality gates are never bypassed** to hit a deadline. If a gate is wrong, the gate is changed deliberately, in its own PR, with a reason.
- **Build once, promote the same artefact** through environments; never rebuild per environment.

---

## 18. AI-assisted development

AI-generated code is subject to every rule in this document without exception.

- **The author is accountable**, not the tool. "The assistant wrote it" is never an explanation for a defect, a licence issue, or a security hole.
- **Read and understand every generated line before committing it.** Code you cannot explain in review must not be merged.
- **Verify, do not assume**: generated code commonly invents APIs, uses outdated patterns, ignores the project's abstractions, duplicates existing utilities, and omits error handling and edge cases.
- **Check for duplication explicitly** — assistants tend to regenerate helpers that already exist in the codebase.
- **Never paste secrets, credentials, personal data or proprietary code** into a tool that is not approved for it.
- **Give the assistant the standards.** Point it at this document and the repository's conventions so output matches the codebase rather than a generic style.
- **Tests are reviewed with extra care** — generated tests frequently assert implementation detail or restate the implementation's bugs as expected behaviour.

---

## 19. Definition of Done

A change is done when **all** of the following are true:

- [ ] Acceptance criteria met and verified.
- [ ] Code follows this standard: single responsibility, within complexity budgets, no duplicated knowledge, constants/utils/config/endpoints separated.
- [ ] Unit tests written for new logic; integration tests for new adapters; regression test for any fix.
- [ ] All automated gates green (format, lint, types, complexity, duplication, tests, coverage, security).
- [ ] Errors handled; timeouts set; failure paths covered.
- [ ] No secrets or personal data in code, logs or config.
- [ ] Logging, metrics and correlation IDs in place for new paths.
- [ ] API/contract changes are backwards compatible or versioned and documented.
- [ ] Accessibility verified for UI work (semantics, keyboard, labels, contrast, focus).
- [ ] Documentation updated: README, API docs, ADR for significant decisions.
- [ ] Peer reviewed and approved.
- [ ] Deployable and rollback-able; migrations reversible; feature flag in place if partial.
- [ ] No new `TODO` without a ticket, no commented-out code, no debug statements.

---

## 20. Anti-patterns — automatic review rejections

| Anti-pattern | Why it is rejected |
|---|---|
| God object / god component / 500-line function | No single responsibility; untestable; every change is risky |
| Business logic inside a controller, UI component or ORM entity | Cannot be tested or reused; couples policy to transport or rendering |
| Magic numbers and string literals in logic | Unsearchable, undocumented, silently duplicated |
| `utils`/`helpers`/`common` catch-all module | Becomes a dependency magnet with no cohesion |
| Copy-pasted business rule | Guarantees divergence and a future defect |
| Empty or log-only catch block | Hides failure; corrupts state silently |
| Boolean flag parameter that switches behaviour | Two responsibilities in one function; unreadable at call sites |
| Deep nesting / arrow code | Complexity that hides logic errors |
| Direct instantiation of infrastructure inside business logic | Untestable; violates dependency inversion |
| Hard-coded environment values or URLs | Breaks environment parity; forces rebuilds |
| Secrets in code, config or logs | Security incident waiting to happen |
| Unbounded query, loop of network calls, N+1 access | Fails at production scale |
| External call without a timeout | One slow dependency takes down the service |
| Mutating input parameters | Action at a distance; unpredictable behaviour |
| Commented-out code, untracked TODOs, debug prints | Permanent noise and invisible debt |
| Tests asserting implementation detail | Blocks refactoring; provides false confidence |
| Skipped/ignored failing test | Silently removes the safety net |
| Speculative generality for imagined future needs | Complexity paid for now, value never realised |
| Circular dependency between modules | Structure is wrong; nothing can be reasoned about in isolation |

---

## 21. Adoption

1. **Adopt the automation first.** Formatter, linter, type checker, complexity and duplication rules, security scans — configured in the repository and wired into CI and pre-commit. Most of this document then enforces itself.
2. **Apply to new and changed code immediately.** Do not attempt a repo-wide retrofit.
3. **Ratchet, don't rewrite.** Set current metrics as the baseline and forbid regression; improve the threshold as the codebase improves.
4. **Add a repository-level supplement** for language, framework and project-specific rules, plus any documented deviations from this standard.
5. **Review the standard periodically.** It changes by pull request against this file, with rationale — the same discipline as the code it governs.

---

*This document is normative. Deviations are permitted where justified, but the justification is written down — in the pull request for a one-off, or in the repository's standards supplement for a recurring one.*
