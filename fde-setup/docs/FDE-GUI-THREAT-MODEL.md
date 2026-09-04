# FDE Control Center — threat model (Phase 2, read-only)

What the console is: a Node process on the operator's own Mac, bound to
loopback, that reads FDE runs through the `fde` controller and serves a local
web page. What it is not: a service, a shared tool, or anything with an account.

## Assets

1. Client material inside run directories — requirements, artifacts, attachments.
2. The approval ledger: evidence that a human typed a specific phrase.
3. Credentials that live near, but never inside, the console — Claude profile
   credentials, MCP tokens, Direct Line secrets, Keychain entries, `.env.sh`.
4. The operator's ability to trust what the console shows.

## Boundaries

| Boundary | Control |
|---|---|
| Network → server | Binds `127.0.0.1` only; a non-loopback `FDE_GUI_HOST` is refused at startup. |
| Browser → API | Per-launch random token (32 bytes, base64url) on every `/api` request, compared in constant time; `Origin` must match the console's own origin when present; `Sec-Fetch-Site` must be `same-origin` or `none`. No CORS headers are ever sent. |
| Token exposure | Handed over in the URL fragment, which browsers do not send to servers; stripped from the address bar on load; held in `sessionStorage` for the tab. It is printed once in the launch banner and never logged — request logging is off entirely. |
| Server → controller | `execFile` with an argument array. No shell, no `bash -c`, no string building. Run ids (`[A-Za-z0-9][A-Za-z0-9._-]{0,119}`) and project ids (`[a-z0-9][a-z0-9-]{0,79}`) are validated before a process is spawned; a rejected id spawns nothing. |
| Controller environment | The child receives `HOME`, `PATH`, `CLAUDE_SHARED`, `FDE_RUNS_DIR`, `FDE_PROJECTS_DIR`, `CLAUDE_PROFILES_DIR`, `LANG` and nothing else. API keys, Direct Line secrets and Confluence tokens in the operator's shell are not passed on. |
| Server → run directory | A run id is a name, never a path: no separators, no `.`/`..`. `<runsRoot>/<runId>` must be a real directory — a symlink there is refused — and its resolved path must sit *directly* in the resolved runs root, so a planted or re-pointed run cannot become a window onto the rest of the disk. |
| Server → filesystem | Reads are confined to that verified run directory: the path is normalised (no absolute paths, no `..`, no empty segments), joined to the resolved run root, and then re-checked with `realpath`; a symlink anywhere in the chain fails the check. `lstat` must report a regular file. |
| Withheld files | `approvals.jsonl`, `orchestrator-session-id` and `mcp/` are never served as files. Approvals are rendered as a structured view; the session id appears only as a resume token in the Session tab; run-scoped MCP configuration can contain connector headers, so it is not browsable at all. |
| Browser → file content | Preview allowlist by extension. HTML, SVG, JavaScript and Office documents are served as `application/octet-stream` with `Content-Disposition: attachment`. Every file response carries `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`. Text previews stop at 1 MiB with a visible notice. |
| Page → page | Strict CSP (`default-src 'none'`, `script-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on everything. The UI never uses `innerHTML`; Markdown is rendered as React elements, so artifact content cannot become markup. |
| Controller output → browser | Only *documented* controller exit codes (2–10) have their stderr shown, because that text is a written refusal and is the evidence the operator needs. An undocumented failure — an unhandled exception, say — becomes a bare `502`: no stderr, no traceback, no detail field. |
| Controller output → UI | Every response is validated against a pinned `schemaVersion: 1`. Structure the UI dereferences (`roles.assignments`, `artifacts.expected`, `requirement`, `events`) must be the right kind of thing or the response is refused as an unexpected shape; individual scalars fall back to defaults so one thin record degrades a row instead of blanking a page. |
| Mutation surface | Four routes, and no others: create a project, change a project, create a run, attach a file. There is no delete, approve, publish, deploy or session route; any other non-`GET` request is answered `405`. |
| Mutation → CSRF | A change must present the launch token **and** an `Origin` header matching this console. A same-origin `fetch` always sends one; a cross-site form post never sends a matching one, and cannot set the token header at all. |
| Upload → disk | The request body is streamed to `fde attach --stdin --name <name>`. The console never writes into a run directory itself, and a browser-supplied filename is a label the controller sanitizes — it never becomes a path or a command line here. Size is capped by a per-route body limit and counted again while streaming; the controller receives the same ceiling as `--max-bytes`. |
| Concurrent changes | A per-run and per-project advisory lock. A second change on a busy target is told the target is busy rather than racing it; the lock is released even when the controller refuses. A controller refusal is shown, never retried automatically. |
| Input that becomes argv | Project names, descriptions, requirements, shape names and upload filenames are rejected outright if they contain control characters, and are bounded in length. Identifiers are pattern-checked. Everything is passed as an argument array. |

## What an attacker would have to do

- **Another site in the operator's browser:** must guess a 256-bit token *and*
  defeat the `Origin`/`Sec-Fetch-Site` checks. A `<form>` or `<img>` cross-site
  request carries no bearer header and is refused before any code runs.
- **Another user on the machine:** the port is loopback, but a local process can
  reach it. It still needs the launch token, which is only in the launching
  terminal and the operator's tab. This is the same trust level as being able to
  read `~/.claude-shared` directly.
- **A malicious run artifact:** cannot execute. It is either inert text rendered
  as elements, an image or PDF in a sandboxed response, or an opaque download.
- **A symlink planted in a run:** listed as a symlink, never followed, never
  readable through the API. A symlink planted *as* a run is refused outright by
  both the controller and the server, and never appears in a listing.
- **A poisoned record:** a `project.json` whose `projectId` names a different
  project, or a manifest whose `projectId` is a path, is refused or ignored with
  a warning — neither can redirect a write or a read. A JSONL line that is valid
  JSON but not an object (`null`, `"text"`, `[]`) is classified as malformed
  rather than handed to a reader that would crash on it.
- **A poisoned filename** (`../../etc/passwd`, `run; rm -rf /`): never reaches a
  path or a command line — attachments are named by the controller, and ids are
  pattern-checked before spawning.

## Accepted, and stated plainly

- Anyone who can read the launch banner or the operator's browser tab can use the
  API for that launch. This is a single-operator local tool; it has no accounts.
- The console shows client material on screen. Screen sharing shows it too.
- A local process running as the operator can already read every run directly.
  The console does not widen that; it does not add a network surface beyond
  loopback, and it does not hold credentials of its own.
- The console can now create projects and runs and attach files. Every one of
  those is a controller command with validated arguments; the console still has
  no way to assign a role, approve a plan, grant a Codex write, deploy or
  publish, and adds none.
- Phase 4 will add a PTY that runs exactly `fde-start --resume <validated run id>`.
  That is a new and larger surface — one process per run, no shell, no arbitrary
  command endpoint — and this note will be revised with it.
