# Build instructions: local FDE Control Center GUI

Use this document as the implementation brief for Claude. Build the smallest
complete, secure vertical slice first; do not replace or bypass the existing FDE
controller.

## Objective

Build a local GUI called **FDE Control Center** that lets an operator:

- browse and search previous FDE runs;
- see each run's state, plan, roles, approvals, checkpoints, events and output
  hygiene evidence;
- see whether a run has a resumable Claude orchestrator session;
- resume a Claude-led run in an embedded terminal;
- view, download and safely preview run inputs and artifacts;
- attach files to a run with hashes and an append-only audit record;
- create projects and group runs under them;
- create a new run inside a project without bypassing the existing scoping,
  role-selection or approval workflow.

This is a local operator console, not a cloud service. The existing `fde`
controller and files under `~/.claude-shared/` remain the source of truth.

## Read before changing anything

Read these files completely:

1. `README.md`
2. `START-HERE.md`
3. `RUNBOOK.md`
4. `claude-shared/bin/fde`
5. `claude-shared/bin/fde-start`
6. `claude-shared/bin/mcp-sync`
7. `claude-shared/config/agents.json`
8. `tests/test_fde.py`
9. `tests/test_fde_start.py`
10. `tests/test_fde_v03.py`

Also read any `AGENTS.md` or `CLAUDE.md` governing a directory before editing
it. Preserve unrelated working-tree changes.

## Non-negotiable boundaries

- Do not create a second workflow state machine in the GUI.
- Do not mutate `manifest.json`, `plan.json`, `roles.json`, approvals,
  checkpoints or event logs directly from the web server. All workflow writes
  must go through new or existing `fde` commands.
- Read-only indexing may read run files directly, but must tolerate missing,
  malformed, legacy and partially written files.
- Never use `shell=True`, string-concatenated commands or `bash -c` for user
  input. Spawn binaries with argument arrays.
- Bind only to `127.0.0.1` by default. Do not expose the GUI to the LAN.
- Require an unguessable per-launch bearer/CSRF token for every mutating API and
  WebSocket connection. Do not put the token in logs.
- Never expose credentials, `.env.sh`, profile credentials, MCP tokens, API
  keys, Keychain contents or arbitrary files outside the allowed FDE roots.
- Resolve and validate every filesystem path after symlink resolution. A path
  must remain inside the intended run/project root.
- Do not follow symlinks when listing, previewing, downloading or attaching
  files.
- Do not add delete, archive, publish, deploy or approval shortcuts in the MVP.
- Existing explicit gates remain exact: plan approval, Codex write approval,
  deployment approval and publication approval may never be inferred.
- Do not scrape undocumented Claude transcript storage. Treat
  `orchestrator-session-id` only as an opaque resume identifier.
- Do not remove watermarks, C2PA/content credentials, creator/copyright fields
  or ownership metadata. Existing output hygiene behavior must remain intact.

## Recommended architecture

Create a local TypeScript application under `fde-gui/`:

```text
fde-gui/
  package.json
  README.md
  server/
    src/
      index.ts
      config.ts
      routes/
      services/
      schemas/
      security/
  web/
    src/
      app/
      components/
      features/
      lib/
  tests/
```

Use:

- Node.js 22 or later;
- TypeScript with strict mode;
- Fastify for the loopback API;
- React and Vite for the UI;
- Zod for validation at every file/API boundary;
- `node-pty` for the embedded Claude session terminal;
- xterm.js for terminal rendering;
- Vitest and Testing Library for unit/component tests;
- Playwright for critical end-to-end flows.

Do not add a database in the first version. The GUI may keep a rebuildable
in-memory index, but persisted FDE data stays in the controller-owned JSON and
JSONL files.

If repository constraints make one of these libraries unsuitable, document the
reason in `fde-gui/README.md` before selecting an equivalent. Do not silently
change the architecture.

## Existing run model

By default, runs live under:

```text
~/.claude-shared/runs/<run-id>/
```

The root can be overridden by `FDE_RUNS_DIR`. Relevant files include:

```text
manifest.json
requirement.md
plan.json
roles.json
events.jsonl
approvals.jsonl
checkpoints.jsonl
orchestrator-session-id
publication-manifest.json
inputs/
tasks/
artifacts/
```

The GUI must display absent files as “not created yet,” not as fatal errors.
Malformed JSON/JSONL records should produce a visible warning while leaving the
rest of the run usable. Never discard malformed lines.

## Add stable controller contracts first

The GUI must not parse human-formatted command output. Extend
`claude-shared/bin/fde` with machine-readable contracts and acceptance tests.

### JSON views

Add:

```bash
fde list --json
fde status <run-id> --json
fde projects --json
fde project show <project-id> --json
fde attachments <run-id> --json
```

JSON output requirements:

- include `schemaVersion`;
- write only JSON to stdout in JSON mode;
- send diagnostics to stderr;
- never include secret values;
- represent missing optional records as `null` or empty arrays consistently;
- return a nonzero status for an unknown run/project;
- keep current human output backward compatible.

`fde status --json` should include:

- manifest and current state;
- requirement summary;
- plan and computed next legal action;
- assigned roles using agent IDs and display labels;
- approvals with status but without secret material;
- checkpoints;
- the latest bounded event page and total count;
- expected and discovered artifacts;
- input attachments;
- output-hygiene status and evidence path;
- session metadata described below;
- optional `projectId`.

### Project model

Add a controller-owned project registry:

```text
~/.claude-shared/projects/<project-id>/project.json
```

Use this versioned shape:

```json
{
  "schemaVersion": 1,
  "projectId": "returns-modernisation-a1b2",
  "name": "Returns modernisation",
  "description": "Improve store and web returns workflows",
  "repoPaths": ["/absolute/path/to/repository"],
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp"
}
```

Add controller commands:

```bash
fde project create --name <name> [--description <text>] [--repo <path> ...]
fde project update <project-id> [--name <name>] [--description <text>] [--repo <path> ...]
fde project show <project-id> [--json]
fde projects [--json]
fde start [requirement] --project <project-id>
```

Rules:

- project IDs are generated by the controller from a slug plus random suffix;
- names need not be unique, IDs must be unique;
- repository paths must exist, be absolute after resolution and be directories;
- do not initialize, clone, modify or delete repositories;
- `fde start --project` records `projectId` in `manifest.json`;
- legacy runs without `projectId` appear under an “Unassigned” group;
- updating a project never rewrites old run events;
- append project creation/update events to a project-local `events.jsonl`;
- do not implement project deletion in the MVP.

### Attachment model

Store attached files under:

```text
<run-dir>/inputs/files/<safe-generated-name>
<run-dir>/inputs/attachments.jsonl
```

Add:

```bash
fde attach <run-id> <source-path>
fde attach <run-id> --stdin --name <original-name>
fde attachments <run-id> [--json]
```

Each append-only attachment record must contain:

```json
{
  "schemaVersion": 1,
  "attachmentId": "random stable ID",
  "runId": "run ID",
  "originalName": "requirements.pdf",
  "storedName": "requirements-<suffix>.pdf",
  "relativePath": "inputs/files/requirements-<suffix>.pdf",
  "mediaType": "application/pdf",
  "size": 12345,
  "sha256": "hex digest",
  "attachedAt": "ISO-8601 timestamp"
}
```

Rules:

- reject empty files only if product requirements explicitly require it;
- default maximum file size is 100 MiB and is configurable downward;
- sanitize the display/stored filename and generate collision-resistant names;
- copy bytes; never move or modify the source file;
- refuse source symlinks, directories, devices and sockets;
- use an atomic temporary sibling plus rename;
- hash the bytes actually stored;
- append an `attachment.added` event to the run event log;
- attachment records are immutable in the MVP;
- uploads from the GUI must use the `--stdin --name` controller path so browser
  filenames can never become shell or filesystem paths.

## Session behavior

Claude-led runs store an opaque ID in `orchestrator-session-id`. Determine the
orchestrator from `roles.json`.

Expose this derived session view:

```json
{
  "provider": "claude",
  "profile": "work|msc|alt|bedrock",
  "sessionId": "opaque value or null",
  "resumable": true,
  "activeInGui": false,
  "resumeReason": null
}
```

For a Codex-led run, show:

```json
{
  "provider": "codex",
  "sessionId": null,
  "resumable": false,
  "resumeReason": "Resume this run in its original Codex task"
}
```

Never invent or derive a Codex task ID from the FDE run ID.

### Embedded resume terminal

For Claude-led runs, the Resume button starts exactly:

```bash
fde-start --resume <validated-run-id>
```

Requirements:

- spawn `fde-start` directly through `node-pty`; do not invoke a shell;
- validate the run ID against an existing run directory first;
- use the first configured project repository as the working directory; if no
  repository is configured, use the GUI server's safe startup directory;
- inherit only the environment needed by the installed FDE/Claude profiles;
- redact known secret-named environment variables from diagnostics;
- allow at most one active PTY per run;
- stream terminal bytes through an authenticated WebSocket;
- support terminal resize;
- show exit code and preserve the final screen buffer in memory while the GUI
  server remains running;
- do not persist the terminal transcript by default;
- closing a browser tab must not silently kill an active process; present an
  explicit Stop action;
- Stop sends an interrupt, waits briefly, then offers a force-stop confirmation;
- a GUI/server restart may lose the live terminal attachment, but the durable
  FDE run remains resumable through `fde-start --resume`.

The terminal is for the specific `fde-start` process, not a general-purpose
shell endpoint.

## Local API

Implement at least these routes:

```text
GET    /api/health
GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:projectId
GET    /api/projects/:projectId
GET    /api/runs?projectId=&state=&query=
POST   /api/runs
GET    /api/runs/:runId
GET    /api/runs/:runId/events?cursor=&limit=
GET    /api/runs/:runId/files
GET    /api/runs/:runId/files/content?path=<relative-path>
POST   /api/runs/:runId/attachments
POST   /api/runs/:runId/session/resume
POST   /api/runs/:runId/session/stop
WS     /api/runs/:runId/session/terminal
```

API rules:

- Zod-validate params, query, body and controller JSON responses;
- use direct process spawning for controller mutations;
- enforce request and upload size limits;
- disable directory listings outside project/run views;
- set `Cache-Control: no-store` on run, file and session responses;
- set a strict CSP and deny framing;
- accept requests only from the exact local UI origin;
- no permissive CORS;
- return stable problem-details JSON errors;
- never include raw stack traces in client responses;
- paginate events; do not load an unbounded JSONL file into the browser;
- watch filesystem changes with debouncing and fall back to polling;
- treat service restart and partially written JSONL lines as recoverable.

## File preview policy

The file browser must show filename, relative path, size, modified time and
SHA-256 when already available.

Safe inline previews:

- UTF-8 text and Markdown: render escaped text; sanitize rendered Markdown;
- JSON: structured viewer with raw-text fallback;
- PNG/JPEG/WebP/GIF: image preview using a same-origin object URL;
- PDF: browser PDF viewer with download fallback;
- DOCX/XLSX/PPTX and unknown binaries: metadata plus download only in MVP.

Limits:

- text preview defaults to the first 1 MiB with a truncation notice;
- never execute HTML, SVG, JavaScript, macros or embedded document content;
- serve downloads as attachments unless the allowlisted preview type requires
  inline display;
- set `X-Content-Type-Options: nosniff`;
- validate the resolved file is a regular non-symlink within the selected run;
- do not display the contents of approval ledgers as downloadable files; show a
  redacted structured view instead.

## User interface

Create an accessible, responsive desktop-first interface with these views.

### Global layout

- left navigation: Projects, All Runs, Active Sessions, System Health;
- top bar: current FDE root, search and connection status;
- main content with clear loading, empty, warning and error states;
- keyboard navigation, visible focus and WCAG AA contrast;
- light and dark themes using semantic design tokens.

### Projects

- project cards/list with name, description, repository count, run counts and
  last activity;
- create/edit project form;
- project detail showing repositories and grouped runs;
- “New run” action that creates the controller record, then opens the run page;
- an Unassigned section for legacy runs.

### Runs list

- columns/cards for run ID, requirement, project, orchestrator, state, next
  action, created/updated time and session availability;
- filters by project, state, orchestrator and resumability;
- search by run ID, requirement and Jira key;
- newest activity first by default;
- never infer completion from artifact presence; use controller state.

### Run detail

- header with run ID, project, requirement, state and Resume action;
- stage timeline generated from the confirmed plan;
- tabs: Overview, Session, Inputs, Artifacts, Events, Approvals & Evidence;
- roles show both role names and assigned identity labels;
- approval records show valid/expired/consumed/revoked status without enabling a
  bypass action;
- events use an incremental timeline with raw JSON available behind a disclosure;
- hygiene evidence prominently states what was changed and what provenance was
  preserved;
- malformed or legacy data appears as a warning banner, not a blank page.

### New run flow

Collect only:

- project;
- requirement text or Jira key;
- orchestrator: work, msc, alt, bedrock or Codex;
- optional named shape.

Call the controller to create the run. Do not assign specialist roles or approve
the plan in this form. For Claude orchestrators, offer Resume Session to continue
the interactive scoping workflow. For Codex, explain that the run must be driven
from its Codex task until a supported task-link contract exists.

## Concurrency and consistency

- Controller commands remain the only workflow writers.
- Add a per-run advisory lock for GUI-triggered mutations. If the CLI reports a
  state conflict, refresh and show the current state rather than retrying a
  mutation automatically.
- Use atomic writes in new controller commands.
- Never rewrite append-only JSONL ledgers.
- Do not cache approvals as authoritative; recompute their current status.
- Watch for changes made by terminal/CLI sessions and refresh the UI.
- Prevent duplicate session processes for one run across browser tabs.

## System health view

Run `fde doctor` on demand and show its human output in a fixed-width panel.
If you add `fde doctor --json`, preserve the existing output and tests. Health
checks must be user-triggered or conservatively cached; do not continuously
invoke credential or network checks.

Show:

- resolved FDE shared/run roots;
- whether `fde`, `fde-start` and `claude` are available;
- configured Claude profiles without credential contents;
- optional watermark inspection service status;
- GUI version and API version.

## Error handling

Design explicit UI states for:

- no runs yet;
- unknown or deleted-on-disk run;
- malformed manifest or JSONL line;
- session ID absent;
- unsupported Codex resume;
- Claude profile unavailable;
- another session already active;
- attachment too large or unsafe;
- file changed while being read;
- controller command rejected by an approval/state gate;
- optional inspection service unavailable;
- PTY exited unexpectedly.

Controller rejection text is useful evidence. Display it safely, but never turn
a rejection into an automatic workaround.

## Testing requirements

Add controller tests using temporary homes, following the existing `Sandbox`
pattern, for:

- project create/list/show/update;
- `fde start --project` and legacy unassigned runs;
- JSON output stability and absence of secret values;
- attachment copy, stdin upload, hashing and event logging;
- filename traversal, source symlink, device and oversize rejection;
- backward compatibility of existing human commands.

Add server tests for:

- path traversal and symlink escape attempts;
- origin and mutation-token enforcement;
- command injection characters in every identifier and filename;
- controller nonzero exits mapped to safe API errors;
- JSONL partial-line recovery and pagination;
- content-type, CSP, no-store and nosniff headers;
- upload size enforcement;
- one active PTY per run;
- Codex-led runs refusing fake resume behavior;
- `/clean`, watermark removal and unapproved publication never being invoked.

Add UI tests for:

- empty, loading, malformed-data and error states;
- project creation and run creation;
- filtering/searching runs;
- attachment upload progress and failure;
- keyboard navigation and focus management;
- terminal connect/reconnect/stop behavior;
- clear rendering of approval and hygiene evidence.

Add Playwright flows for:

1. Create a project, create a run and see it grouped under the project.
2. Attach a file and verify its name, size and digest in the run view.
3. Load a synthetic previous run and inspect its plan, roles and events.
4. Resume a stubbed Claude session in the embedded terminal.
5. Attempt a traversal download and receive a refusal.
6. Observe a controller gate rejection without any state mutation.

All tests must use temporary FDE roots and stub executables. They must not read
or modify the operator's real `~/.claude-shared`, profiles, credentials or runs.

## Delivery phases

Implement in these independently usable phases.

### Phase 1: controller contracts

- project commands and schema;
- run `projectId` support;
- attachment commands and manifest;
- JSON list/status views;
- complete isolated tests and documentation.

Do not begin the GUI until these contracts pass.

### Phase 2: read-only control center

- local authenticated server;
- Projects and Runs navigation;
- run detail, events, roles, approvals, checkpoints and file browsing;
- robust malformed/legacy-data behavior;
- unit, API and component tests.

### Phase 3: safe mutations

- create/edit project;
- create run;
- upload attachment through controller stdin;
- filesystem refresh and concurrency handling.

### Phase 4: interactive sessions

- authenticated PTY lifecycle;
- xterm.js view;
- one session per run;
- Claude resume flow and Codex limitation messaging;
- stubbed PTY integration tests.

### Phase 5: polish and packaging

- accessibility pass;
- responsive layout and themes;
- Playwright flows;
- `fde-gui` launcher script;
- installation/update integration that preserves user data;
- operator documentation and screenshots.

Stop after each phase, run its tests and summarize evidence before proceeding.
Do not claim the whole GUI is complete when only an earlier phase is working.

## Required deliverables

- `fde-gui/` application and tests;
- controller changes and tests;
- `fde-gui` launcher installed through the existing safe installer;
- updated `README.md`, `START-HERE.md` and `RUNBOOK.md`;
- API/schema documentation;
- a threat-model note covering local HTTP, file access, PTY execution, uploads,
  CSRF/origin enforcement and secret handling;
- a verification report listing exact commands, results and unavailable checks;
- no changes to real run history during tests.

## Definition of done

The feature is done only when:

- a fresh install can launch the GUI with one documented command;
- previous and legacy runs appear without migration or data loss;
- projects group runs through controller-owned persistent records;
- attachments are copied, hashed and audited through the controller;
- Claude-led runs resume through the existing `fde-start --resume` path in an
  embedded, non-general-purpose terminal;
- Codex-led runs are labelled honestly and are not given a fabricated resume
  flow;
- file previews cannot escape the run directory or execute active content;
- approvals and controller gates cannot be bypassed from the GUI;
- publication/completion still triggers provenance-preserving output hygiene;
- all deterministic controller, server, UI and end-to-end tests pass;
- the active installer preserves credentials, profiles, client context, runs
  and local customizations exactly as it does today.

## Suggested Claude invocation

From the repository root, start with:

```text
Read docs/FDE-GUI-BUILD-INSTRUCTIONS.md completely and implement Phase 1 only.
Follow every repository instruction file, preserve unrelated changes, add the
specified isolated tests, run the relevant existing regression suite, and stop
with a concise evidence report. Do not start Phase 2 until I approve it.
```

After reviewing Phase 1, repeat for one phase at a time. This keeps controller
contracts, GUI behavior and safety boundaries reviewable instead of combining
them into one difficult-to-verify change.
