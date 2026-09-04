# FDE Control Center

A local workspace for the `fde` controller and configured Claude Code accounts.

It shows projects, runs, plans, roles, approvals, checkpoints, events, input
attachments, artifacts and output-hygiene evidence. It can create a project,
edit one, create a run and attach a file — each one a controller command, with
the console writing nothing itself.

It can also resume a Claude-led run: Resume starts exactly
`fde-start --resume <run-id>` in an embedded terminal, one process per run, and
streams it to the tab. A Codex-led run is labelled honestly instead — it is
driven from its own Codex task.

General chats are deliberately separate from FDE runs. A chat stores its own
metadata and messages under `~/.claude-shared/chats`, resumes one opaque Claude
conversation, and starts Claude in bare print mode with all tools disabled.
Account status comes from `claude auth status`; the Login action opens an
isolated `claude auth login` terminal for only the selected profile. The GUI
never receives a password, OAuth token or credential file.

Both New run and New chat expose the selected Claude profile, model and the
effort levels supported by that model. Run choices are persisted in the run
manifest and reapplied by `fde-start` on every resume.

Approving is still yours. Assigning roles, approving a plan, granting a Codex
write, deploying and publishing all happen in that conversation, typed by you —
the console adds no button for any of them.

## Run it

```bash
cd fde-gui
npm install          # once — see the note below if it was installed elsewhere
npm start            # builds the UI, then serves it on 127.0.0.1:7317
```

> `node_modules` holds platform-specific binaries (esbuild, rollup, node-pty). A
> tree installed on one OS or architecture will not run on another — if
> `npm test` or `npm start` fails with a missing or invalid binary, delete
> `node_modules` and reinstall on this machine.
>
> `node-pty` is an **optional** dependency: it is native, and where a platform
> has no prebuild and no toolchain the install still succeeds. The console then
> reports that it has no terminal backend and refuses to start a session, rather
> than falling back to pipes and calling that a terminal. The launch banner says
> which case you are in.

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
| `CLAUDE_SHARED`, `FDE_RUNS_DIR`, `FDE_PROJECTS_DIR`, `FDE_CHATS_DIR`, `CLAUDE_PROFILES_DIR` | as the controller's | which FDE roots to use |
| `FDE_CLAUDE_BIN` | `claude` from `PATH` | native Claude Code CLI used for status, login and chat |

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
  services/accounts.ts  profile discovery and auth status
  services/chats.ts   durable, tool-disabled Claude conversations
  routes/             health, projects, runs, files, sessions, Claude and chats
web/src/              React UI: projects, runs, chats, sessions and health
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
- **Changes are narrow and honest.** FDE mutations map to controller commands;
  chat and account actions have their own validated stores and fixed commands.
  A change needs an `Origin` as well as the token; uploads go
  to `fde attach --stdin --name`, so a browser filename never becomes a path; and
  a per-run lock means two changes cannot race. A controller refusal is shown in
  its own words and never retried automatically.
- **A session is one command, not a shell.** Resume runs
  `fde-start --resume <validated run id>` through node-pty — no shell, no command
  from the caller, one process per run, and the working directory is the
  project's first repository or the server's own. The stream is authenticated by
  a single-use ticket checked before the WebSocket handshake. Closing a tab
  detaches; Stop interrupts; Force stop is a second, confirmed action. The last
  256 KiB of screen is kept in memory only, never on disk.
- **Login is one command, not a credential form.** The server can start exactly
  `claude auth login` for a configured, validated profile. Its PTY uses the same
  one-time WebSocket tickets as run sessions. Bedrock remains externally
  authenticated through AWS credentials.
- **General chat has no FDE authority.** Claude starts with `--bare`,
  `--tools ""`, `--no-chrome`, disabled slash commands and plan-only
  permissions. No run-scoped MCP configuration is loaded.
- **Terminal changes show up.** The server watches the run and project roots
  (falling back to the nearest directory that exists, so a fresh install is
  covered) and keeps a change counter; the console polls that counter and
  reloads. Where the platform cannot watch, the counter still moves after every
  change the console makes and each view keeps its own slower poll.

## Deliberate implementation choices

- **Markdown is rendered by a small element-building renderer**, not a Markdown
  library with an HTML sanitizer. Nothing in it can emit markup, which is a
  stronger guarantee than sanitizing after the fact. Links render as text.
- **`fde doctor` is not invoked automatically.** System health reports resolved roots, binary
  presence and profile *names* only: running doctor touches the Keychain, the AWS
  CLI and the network, which a page must not do on a timer.

## When the console says the controller is too old

The console talks to the **installed** controller at `~/.claude-shared/bin/fde`,
not to the copy in this checkout. Editing the checkout changes nothing until it
is installed. If a screen reports *"The installed controller is older than this
console"*, update it:

```bash
cd <your fde-setup checkout>
./install.sh --update --dry-run   # see exactly what would change
./install.sh --update             # backs up every file it replaces
```

Update mode leaves your runs, `env.sh`, profiles, credentials and client context
exactly as they are. System health shows which contracts the installed
controller speaks, and `fde version` says the same thing from a terminal.

## Tests

```bash
npm run typecheck
npm test
```

Server tests run against a temporary FDE root and a stub controller; component
tests run in jsdom. Nothing in the suite reads or writes the operator's real
`~/.claude-shared`, profiles, credentials or runs, and no real `fde`, `claude` or
`codex` process is ever started.
