# Governed MCP servers

One catalogue, one lifecycle, and three client configurations generated from it.
This is the reference; `README.md` carries the short version, `RUNBOOK.md` the
per-engagement procedure, and the GUI operator guide the console equivalents.

## Four words that mean four different things

| Word | What it means | Where you see it |
| --- | --- | --- |
| **catalogue** | FDE knows how to run this server. Nothing more. | `claude-shared/mcp/mcp-servers.json` |
| **configured** | You have supplied the settings and credentials it declares. | `fde mcp status <name>` |
| **ready** | Configured, its executable is installed, and a bounded verification succeeded. | `fde mcp list` |
| **active** | Part of a specific run's or chat's effective set, because that run's approved stages, roles and profile call for it. | `fde mcp effective --run <id>` |

A catalogue entry is **not** a grant. A role is not a grant either. Access is
computed per run, from the plan the user approved, and it is regenerated — not
inherited — every time the plan or the roles change.

## Lifecycle states

```
unavailable              the required executable or runtime is not on this machine
not_configured           required settings or credentials are absent, or its tool
                         list has not been verified yet
authentication_required  it needs a sign-in FDE does not hold
ready                    available, configured and verified
active                   included in the current run or chat effective set
unhealthy                initialization or tool listing failed
blocked                  policy prevents activation — most often because no
                         enforceable read-only tool subset exists
```

`fde doctor` reports every one of these, per server, with the reason and the
exact next action. No command in this system prints a stored credential.

## Read-only is enforced, or it is not claimed

A system prompt is not a control, and neither is a server's own description of
itself. FDE will only activate a server whose write surface it can actually
close, and it closes it in the client's own mechanism:

| Client | Mechanism | Scope |
| --- | --- | --- |
| Claude Code | `permissions.allow` / `permissions.deny` in a generated settings file, loaded with `--settings` beside `--mcp-config` | exact `mcp__<server>__<tool>` names — wildcards are not accepted for MCP specifiers, which is *why* an unverified server cannot be allow-listed |
| Codex CLI | `enabled_tools` on the `[mcp_servers.<name>]` table | exact tool names |
| Gemini / Antigravity | workspace-local `.agents/mcp_config.json` plus isolated app-data permissions | eligible servers are bound to the run workspace, remote transports use `serverUrl`, disallowed discovered tools are listed in `disabledTools`, and headless access is limited to read-only web and exact MCP tool permissions |

How a server's safe subset is established is declared per entry as
`readOnlyPolicy`:

- `server-flag` — the server is started in its own read-only mode (DBHub's
  `readonly = true`, the AWS proxy's `--read-only`, Azure's `--read-only`). There
  is nothing to filter, because the write tools are never offered by the process.
- `annotations` — the allowlist is exactly the tools that `tools/list` reported
  with `readOnlyHint: true`, recorded when you ran `fde mcp verify`.
- `patterns` — the catalogue's `allowTools` / `denyTools` narrow the *verified*
  tool list. Patterns alone are never enough: a pattern is not something a client
  can enforce, so a server stays unverified-and-inactive until its real tool
  names are known.
- `none` — nothing constrains the tool set. A mutation-capable server with this
  policy is `blocked`, permanently, and says so.

**If a provider cannot expose a verified read-only subset, the server stays
inactive and reports `blocked` with the reason.** It is never described as
read-only in a prompt instead.

## Mutations

Every mutation-capable entry names the approval its writes belong behind:

- `mutationApproval.targets` — an FDE publication target, so the write needs
  `fde approve-publish <run-id> <target>` first: unexpired, target-specific, one
  use, recorded.
- `mutationApproval.gate: implementation-write` — the write would land in the
  repository, so it belongs behind the run's existing one-time Codex write
  approval, not behind a publication approval. Serena is this case.
- `mutationApproval.gate: denied` — the mutation tools are not enabled in this
  phase by any approval. Chrome DevTools' script evaluation and form interaction
  are this case; driving a page is Playwright's job.

Treat all of these as external mutations: a browser submission, a Jira or
Confluence update, a Figma canvas change, a cloud resource change or deployment,
a database write, a prompt update, a message, an email, and a repository-provider
write.

An approval does not leave a permanent configuration behind. The only thing it
changes is that a specific server's own read-only flag is dropped for the
invocation it covers; when the approval expires or is consumed, the generated
configuration is the read-only one again.

## Profiles

A profile is a named slice of the catalogue for a kind of work.

| Profile | Servers | Docker profile |
| --- | --- | --- |
| `coding` | context7, serena | `coding` |
| `frontend-testing` | context7, playwright, chrome-devtools | `frontend-testing` |
| `client-delivery` | context7, atlassian, figma | `client-delivery` |
| `data` | context7, dbhub | `data` |
| `observability` | context7, langfuse, aws, azure | `observability` |

Selecting a profile narrows the effective set; it never widens it. Role, stage
and readiness still all have to agree.

## Per-server setup

### Context7 — ready, no setup
Hosted, read-only, no tenant data, global to all three CLIs. Use it for
version-specific framework, dependency, SDK and API documentation. Do not call it
for anything about this repository.

### Serena — needs installing
```bash
uv tool install -p 3.13 serena-agent
fde mcp verify serena
```
FDE detects it; it never installs it. Claude gets `--context claude-code`, Codex
gets `--context codex`, from one catalogue entry. Its editing and shell tools are
denied; symbol lookup, references and navigation are allowed.

### Playwright — ready once verified
```bash
fde mcp configure playwright --set allowedOrigins='http://localhost:3000'
fde mcp verify playwright
```
Pinned to `@playwright/mcp@0.0.80`. Headless and isolated by default: no browser
profile is written to disk and no signed-in session is reused. Script evaluation,
file upload and installation tools are denied.

### Chrome DevTools — ready once verified
```bash
fde mcp verify chrome-devtools
```
Pinned to `chrome-devtools-mcp@1.9.0`, run `--slim --headless --isolated`. It
never attaches to your normal signed-in Chrome. Attaching to a running browser is
an explicit setting with a warning attached, and clearing it is your job.

### Atlassian and Figma — sign in, then verify
Endpoints and OAuth ownership are unchanged: OAuth lives in the MCP client, and
FDE stores no token. Both stay run-scoped rather than global. Sign in inside the
assigned client (`/mcp` in a Claude session), then `fde mcp verify atlassian`.
Rovo does not give unrestricted Bitbucket repository operations — use local git
or the Bitbucket REST connection for repository files.

The orchestrator and an assigned reviewer can use these connectors when the
approved stage and profile require them. Codex receives eligible connectors as
per-invocation configuration. Gemini does not: the orchestrator must save the
exact retrieved material, including source URLs or IDs, inside the run and pass
it with `fde invoke --context-file`. The controller logs each evidence path and
hash, caps the total handoff at 512 KiB, and refuses paths outside the run.

### DBHub — configure first
```bash
fde mcp configure dbhub \
  --set connectionMode=parts --set host=<host> --set database=<db> \
  --set username=<read-only user> --set readOnlyAccount=yes
printf '%s' '<password>' | fde mcp set-secret dbhub password
fde mcp verify dbhub
```
PostgreSQL only in this phase. Read-only is enforced twice — DBHub's own
`readonly = true` in the generated TOML, and a database account with SELECT and
nothing else, which FDE makes you confirm before it will activate. Rows are
capped (default 1,000) and queries time-bounded (default 30s). The generated TOML
contains `dsn = "${FDE_MCP_DBHUB_DSN}"`; the value is composed at launch and put
only in the child process's environment. Write SQL is not implemented at all.

### AWS — configure first
```bash
fde mcp configure aws --set awsProfile=<profile> \
  --set endpointRegion=us-east-1 --set operationRegion=<region>
fde mcp verify aws
```
Runs the official `mcp-proxy-for-aws-cli` (pinned) with `--read-only`, so write
tools are absent from the process. Authentication is your local AWS credential
chain; no AWS credential is copied into FDE metadata. Anything that creates,
changes, deletes, deploys or costs money needs
`fde approve-publish <run-id> deployment`.

### Azure — needs the Azure CLI
```bash
brew install azure-cli && az login
fde mcp configure azure --set tenantId=<tenant> --set subscriptionId=<sub> \
  --set namespaces=subscription,group,monitor
fde mcp verify azure
```
The maintained `microsoft/mcp` server, not the archived `Azure/azure-mcp`. Starts
in namespace mode with only the namespaces you allow, and with `--read-only`.
Start narrow: every namespace multiplies the tool count.

### Langfuse — configure first
```bash
fde mcp configure langfuse --set region=eu \
  --set endpoint=https://cloud.langfuse.com/api/public/mcp
printf '%s' '<public key>' | fde mcp set-secret langfuse publicKey
printf '%s' '<secret key>' | fde mcp set-secret langfuse secretKey
fde mcp verify langfuse
```
Regions: EU `cloud.langfuse.com`, US `us.cloud.langfuse.com`, Japan
`jp.cloud.langfuse.com`, HIPAA `hipaa.cloud.langfuse.com`; self-hosted is your own
HTTPS host with the same `/api/public/mcp` path, and local development may use
`http://localhost:3000/api/public/mcp`. Keys are project-scoped. The Basic
credential is composed at launch and the composed header is never persisted.
Langfuse ships write tools by default, so it activates only once verification has
found an enforceable read-only subset; if it has not, it reports `blocked` and
says why.

## OAuth versus locally stored credentials

| Server | Credential | Who holds it |
| --- | --- | --- |
| Atlassian, Figma | OAuth 2.1 | the MCP client, per that provider's supported model. FDE stores nothing. |
| Langfuse, DBHub | a key pair / a database password | an owner-only file under `~/.claude-shared/secrets/mcp/<server>/<field>`, injected into one child process |
| AWS, Azure | the local CLI credential chain | your machine's existing `~/.aws` / `az login` session. FDE copies nothing. |
| Context7, Serena, Playwright, Chrome DevTools | none | — |

No credential appears in a tracked file, a generated README, an argument list, a
log line, an event, browser metadata or an API response. Migration never reads or
displays an existing secret.

## Docker is optional

Docker is not installed on this machine, and nothing in FDE requires it. When it
is present with the MCP Gateway plugin, `mcp-sync --gateway-plan` shows which
direct entries the gateway would take over and which Docker profile each FDE
profile maps to. A server is never configured both directly and through the
gateway in the same effective configuration. FDE remains the policy authority for
roles, stages and approval gates; the gateway only adds container isolation,
lifecycle and container-side allowlists.

## Commands

```bash
fde mcp list                       every entry with its lifecycle state
fde mcp status <server>            one server in detail
fde mcp profiles                   the declared profiles and their servers
fde mcp configure <server> --set name=value
fde mcp set-secret <server> <field>    reads stdin, echoes nothing
fde mcp clear-secret <server> <field>
fde mcp enable|disable <server>
fde mcp verify <server>            bounded initialize + tools/list; the only
                                   command here that starts a server
fde mcp effective --run <run-id>   what this run may actually reach
fde mcp effective --profile data --role research --stage research
fde mcp gateway                    Docker gateway routing; changes nothing
fde mcp migrate                    rewrite the catalogue in the current schema

mcp-sync                           global targets only
mcp-sync --run <run-id>            the run's role-scoped bindings
mcp-sync --dry-run                 show changes; write, start and download nothing
mcp-sync --gateway-plan            migration preview
mcp-sync --profile <name>          restrict the effective set to one profile
fde doctor                         the whole lifecycle, per server
```

## Updating a pinned version

Generated production configuration never runs `@latest`. To move a pin, edit the
`package.version` field in `claude-shared/mcp/mcp-servers.json`, then:

```bash
mcp-sync --dry-run     # see what changes
mcp-sync               # apply
fde mcp verify <server>
```

`uv`-installed tools have their own update command, shown in the entry's
`package.update`. Nothing installs itself, and neither `npx` nor `uvx` is invoked
merely because you opened the Configuration page or ran a dry run.

## Troubleshooting

| Symptom | What it means | What to do |
| --- | --- | --- |
| `unavailable` | the executable is not on this machine | run the setup command the status names; FDE will not install it for you |
| `not_configured`, naming fields | required settings or credentials are missing | `fde mcp configure` / `fde mcp set-secret` |
| `not_configured`, "tool list has not been verified" | the read-only subset is not yet a fact | `fde mcp verify <server>` |
| `authentication_required` | the OAuth sign-in has not happened, or a stored credential was refused | sign in inside the assigned MCP client (`/mcp`), then verify |
| `blocked`, "cannot be governed" | the provider offers no verified read-only subset | leave it inactive; this is the control working |
| `unhealthy` | initialize or tools/list failed | `fde mcp verify <server>` and read the detail; check the pinned version |
| a run sees nothing | roles are not confirmed, or the plan's stages do not call for it | `fde mcp effective --run <id>` names the reason per server |
| Claude has the server but not its tools | `--mcp-config` was loaded without its `--settings` sibling | always pass both; the run's `mcp/README.md` shows the exact command |

## How an operator confirms what a run can reach

```bash
fde mcp effective --run <run-id>          # the computed answer, with refusals
cat ~/.claude-shared/runs/<run-id>/mcp/effective.json
cat ~/.claude-shared/runs/<run-id>/mcp/README.md
cat ~/.claude-shared/runs/<run-id>/mcp/claude-<profile>.settings.json
fde status <run-id> --json | jq .mcp
```

The combined plan approval shows the same set before anything is generated, and
`fde approve-plan --reapprove` shows it again whenever the plan or the roles
change. Access is never widened silently: a widened plan supersedes the frozen
route and re-asks.

The isolated Playwright server is eligible for the run's orchestrator in every
approved stage and profile. It supplies browser navigation and web research when
Claude runs on Bedrock, where native WebSearch is unavailable. FDE subagents do
not declare narrower tool allowlists, so they inherit the orchestrator's active
built-ins and run-scoped MCP servers. Readiness, stage selection, MCP scopes and
publication/mutation approvals still apply; inheritance is not a gate bypass.

## Sample effective configuration per profile

What `fde mcp effective --profile <name>` reports on this machine today, with
every role held and every stage planned — so what you see is readiness deciding,
not scope. Serena, the AWS CLI and the Azure CLI are not installed here; DBHub
and Langfuse have not been configured.

```
### coding
  context7         read-only         public-documentation   every tool
  playwright       mutation-capable  browser-session        18 governed tool(s)
  serena           unavailable       missing on this machine: serena. uv tool install -p 3.13 serena-agent

### frontend-testing
  chrome-devtools  mutation-capable  browser-session        19 read tool(s)
  context7         read-only         public-documentation   every tool
  playwright       mutation-capable  browser-session        18 read tool(s)

### client-delivery
  atlassian        mutation-capable  tenant-data            every tool   ← unscoped, see below
  context7         read-only         public-documentation   every tool
  figma            mutation-capable  tenant-data            every tool   ← unscoped, see below
  playwright       mutation-capable  browser-session        18 governed tool(s)

### data
  context7         read-only         public-documentation   every tool
  dbhub            not_configured    Read-only PostgreSQL DSN, The database account itself is read-only
  playwright       mutation-capable  browser-session        18 governed tool(s)

### observability
  context7         read-only         public-documentation   every tool
  aws              unavailable       missing on this machine: aws
  azure            unavailable       missing on this machine: az
  langfuse         not_configured    Langfuse deployment, MCP endpoint, Public key, Secret key
  playwright       mutation-capable  browser-session        18 governed tool(s)
```

Those tool counts are not estimates. Playwright 0.0.80 reports 24 tools and 18
survive the allowlist; `browser_evaluate`, `browser_install`,
`browser_file_upload`, `browser_pdf_save` and the tracing pair are denied. Chrome
DevTools 1.9.0 reports 29 and 19 survive; every interaction tool
(`click`, `fill`, `fill_form`, `hover`, `drag`, `press_key`, `type_text`,
`handle_dialog`), plus `evaluate_script` and `upload_file`, is denied — which is
what makes "Playwright drives, DevTools diagnoses" a rule rather than a
suggestion.

**One deviation from the original brief, on the evidence.** Chrome DevTools was
specified to run `--slim` by default. Verified against 1.9.0, `--slim` exposes
exactly three tools — `evaluate`, `navigate`, `screenshot` — so the console,
network and performance tools this server exists for are absent, and `evaluate`
is the one tool we most want denied. FDE therefore runs it non-slim and controls
scope with the verified allowlist above, which is a stricter limit than `--slim`,
not a looser one. `--slim` remains available as an operator setting when tool
count matters more than capability.
