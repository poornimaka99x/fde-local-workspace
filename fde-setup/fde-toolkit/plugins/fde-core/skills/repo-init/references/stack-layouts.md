# Stack layouts and tooling

These are starting points. Adapt them to the agreed architecture style and
keep only the folders the architecture needs. Before writing a tool's config,
check its current documentation for the version you install.

## Python service (FastAPI or worker)

```
src/<package>/
  api/            routes and request/response schemas; translate errors to HTTP
  application/    use cases; orchestrate domain + ports
  domain/         entities, value objects, domain errors; no I/O
  adapters/       db, http clients, queues, LLM providers (implement ports)
  config/         settings.py (pydantic-settings), one place for all config
  constants.py
  logging.py      logger factory + 4W context (contextvars)
  errors.py       BaseError
  main.py         composition root: build adapters, inject, start app
tests/unit/  tests/integration/
docs/implementation/  docs/adr/
```

- Lint, format and imports: `ruff check` and `ruff format`. Rules include `I`
  for isort-compatible alphabetical, grouped imports.
- Types: `mypy --strict` or `pyright`. Tests: `pytest`.
- Logger: `structlog` (or stdlib `logging` with a JSON formatter). Bind the
  correlation id and actor in middleware.

### Agentic AI variant

Add `agents/` (agent definitions and orchestration), `tools/` (tool
functions; each calls an adapter), `prompts/` (versioned prompt templates as
files, not strings in code) and `evals/`. The LLM provider sits behind an
adapter, chosen by a Factory from config. Interchangeable models or
retrieval approaches are Strategies.

## NestJS API

```
src/
  modules/<feature>/
    <feature>.controller.ts  <feature>.service.ts  <feature>.module.ts
    dto/  entities/  <feature>.repository.ts
  common/         filters (exception → response), interceptors, guards, pipes
  config/         @nestjs/config namespaces + validation schema
  constants/
  adapters/       external clients behind injected interfaces (provider tokens)
  logging/        nestjs-pino module, 4W fields via request context
  errors/         BaseError hierarchy
  main.ts
test/  (e2e)    *.spec.ts beside source for unit
```

- Lint: ESLint flat config with typescript-eslint. Format: Prettier.
- Imports: `eslint-plugin-simple-import-sort`, or `import/order` with
  `alphabetize`.
- Logger: `nestjs-pino`. Tests: Jest.

## Next.js (App Router)

```
src/
  app/            routes, layouts, server actions (thin)
  components/     ui/ (presentational) and feature components
  features/<feature>/  components, hooks, server logic for one feature
  lib/            adapters/ (API clients), config.ts, constants.ts, logger.ts, errors.ts
  hooks/  types/  styles/
tests/ or __tests__/ beside source
```

- Lint: ESLint with the Next config. Format: Prettier. Imports:
  `simple-import-sort`.
- Logger: `pino` on the server; a thin client logger wrapper in the browser.
- Tests: Vitest or Jest with Testing Library; Playwright for end to end.
- Config: validate env in `lib/config.ts` (for example with zod). Only
  `NEXT_PUBLIC_*` reaches the client.

## React SPA (Vite)

Same as Next.js without `app/`: `src/{components,features,hooks,lib,routes,types}`.

## .NET (ASP.NET Core, clean architecture)

```
src/<App>.Api/             controllers/minimal APIs, middleware (exception → ProblemDetails)
src/<App>.Application/     use cases, interfaces (ports), DTOs, validators
src/<App>.Domain/          entities, value objects, domain errors
src/<App>.Infrastructure/  EF Core, external clients (adapters), DI registration
tests/<App>.UnitTests/  tests/<App>.IntegrationTests/
<App>.sln  Directory.Build.props  .editorconfig
```

- Config: `appsettings*.json` bound to typed Options classes (`IOptions<T>`),
  validated on start-up. Constants go in a static `Constants` class per
  bounded context.
- Lint and format: `dotnet format`, .NET analyzers and
  `TreatWarningsAsErrors` in `Directory.Build.props`.
- Imports: in `.editorconfig`, set `dotnet_sort_system_directives_first = true`
  and enforce IDE0005 (unused usings).
- Logger: Serilog with enrichers for correlation id, actor, machine and
  source context. Tests: xUnit.

## Monorepo (more than one deployable)

```
apps/<api>/  apps/<web>/  apps/<worker>/
packages/<shared-config>/  packages/<shared-types>/  packages/<logger>/
docs/implementation/  docs/adr/
```

Shared lint and format config sits at the root. Each app keeps its own layout
from above.
