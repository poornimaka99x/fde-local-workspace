# FDE Control Center

A local operator console for the `fde` controller. Phase 3: **read, and four
safe changes**.

It shows projects, runs, plans, roles, approvals, checkpoints, events, input
attachments, artifacts and output-hygiene evidence. It can create a project,
edit one, create a run and attach a file — each one a controller command, with
the console writing nothing itself.

It still starts no process and approves nothing. Assigning roles, approving a
plan, granting a Codex write, deploying and publishing stay where they were: in
a terminal, typed by you. The embedded resume terminal arrives in Phase 4.

## Run it

```bash
cd fde-gui
npm install          # once — see the note below if it was installed elsewhere
npm start            # builds the UI, then serves it on 127.0.0.1:7317
```

> `node_modules` holds platform-specific binaries (esbuild, rollup). A tree
> installed on one OS or architecture will not run on another — if `npm test` or
> `npm start` fails with a missing or invalid binary, delete `node_modules` and
> reinstall on this machine.

Open the link the server prints. It looks like:

```text
http://127.0.0.1:7317/#token=<per-launch token>
```

The token is generated per launch and travels in the URL **fragment**, which a
browser never sends to a server — so it stays out of request logs, `Referer`
headers and browser history sync. The page keeps it in `sessionStorage` for that
tab and sends it as a bearer header. A new launch invalidates the old link.

| Variable | Default | Meaning |
|---|---|---|
| `FDE_GUI_PORT` | `7317` | loopback port |
| `FDE_GUI_HOST` | `127.0.0.1` | loopback only; any other value is refused |
| `FDE_GUI_TOKEN` | random | fixed token, for tests and scripted launches |
| `FDE_CONTROLLER` | `$CLAUDE_SHARED/bin/fde` | the controller binary |
| `CLAUDE_SHARED`, `FDE_RUNS_DIR`, `FDE_PROJECTS_DIR`, `CLAUDE_PROFILES_DIR` | as the controller's | which FDE roots to read |

For UI work, `npm run dev:web` runs Vite on `127.0.0.1:5199` and proxies `/api`
to a server you start separately with `npm run dev:server`.

## How it is put together

```text
server/src/
  index.ts            launch, banner, shutdown
  app.ts              routes, static assets, error mapping
  config.ts           roots, port, per-launch token
  security/           response headers, token and origin enforcement
  services/controller.ts   spawns `fde` with an argument array
  services/files.ts   run-scoped, symlink-refusing file access
  schemas/            zod validation of every controller answer
  routes/             health, projects, runs, events, files
web/src/              React UI: projects, runs, run detail, health
tests/                server tests (stub controller) and component tests
```

The rules it is built to:

- **The controller owns the workflow.** Every run fact comes from
  `fde … --json` (`docs/FDE-CONTROLLER-CONTRACTS.md`). The server has no state
  machine, no cache of approvals, and no opinion about whether a run is finished.
- **Spawn, never shell.** `execFile` with an argument array. Run and project ids
  are pattern-checked before they go anywhere near `argv`, and the child gets
  only the environment the FDE profiles need.
- **Loopback only, token on every API call**, plus `Origin`/`Sec-Fetch-Site`
  checks. There is no CORS.
- **Files are read inside one run or not at all.** The run directory itself must
  be a real directory directly inside the runs root — a symlinked run is refused,
  not followed. Within it, paths are resolved and then re-checked against that
  root, symlinks are never followed, and the approval ledger, the session id and
  run-scoped MCP configuration are never served as files.
- **Controller output is checked twice.** `schemaVersion` is pinned to 1, and
  every structure the UI dereferences must be the right kind of thing or the
  response is refused as an unexpected shape. Only documented controller exit
  codes have their stderr forwarded; an undocumented failure never sends its
  text — or a traceback — to the browser.
- **Nothing active is rendered.** Text, Markdown, JSON, PNG/JPEG/WebP/GIF and PDF
  preview; everything else downloads as `application/octet-stream`. Markdown is
  rendered by building React elements — the app contains no `innerHTML` anywhere.
- **Malformed data is shown, not swallowed.** A half-written JSONL line becomes a
  warning banner; the rest of the run still renders.
- **Changes are narrow and honest.** Four mutating routes, each mapping to one
  controller command; a change needs an `Origin` as well as the token; uploads go
  to `fde attach --stdin --name`, so a browser filename never becomes a path; and
  a per-run lock means two changes cannot race. A controller refusal is shown in
  its own words and never retried automatically.
- **Terminal changes show up.** The server watches the run and project roots
  (falling back to the nearest directory that exists, so a fresh install is
  covered) and keeps a change counter; the console polls that counter and
  reloads. Where the platform cannot watch, the counter still moves after every
  change the console makes and each view keeps its own slower poll.

## Deviations from the build brief, and why

- **Playwright, `node-pty` and xterm.js are not installed yet.** They belong to
  the phases that need them (4 and 5); adding them now would ship an unused
  terminal dependency into a read-only console.
- **No `POST` routes.** The brief lists them under the API; they arrive with
  Phase 3 so that this phase cannot mutate anything by accident.
- **Markdown is rendered by a small element-building renderer**, not a Markdown
  library with an HTML sanitizer. Nothing in it can emit markup, which is a
  stronger guarantee than sanitizing after the fact. Links render as text.
- **No Active Sessions view.** The brief lists it in the global navigation, but
  a session only exists once the console can start one, which is Phase 4. A nav
  entry that can only ever say "none" is worse than not having it yet.
- **`fde doctor` is not invoked.** System health reports resolved roots, binary
  presence and profile *names* only: running doctor touches the Keychain, the AWS
  CLI and the network, which a page must not do on a timer.

## Tests

```bash
npm run typecheck
npm test
```

Server tests run against a temporary FDE root and a stub controller; component
tests run in jsdom. Nothing in the suite reads or writes the operator's real
`~/.claude-shared`, profiles, credentials or runs, and no real `fde`, `claude` or
`codex` process is ever started.
