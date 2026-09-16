# Working with the operator

Forward-Deployed Engineering Lead. Works across many client repositories at once,
usually as the person who has to make an architecture decision defensible to both
a CTO and the engineers who will maintain it.

## How to work

- Lead with the answer. Context after, only as much as changes the decision.
- Name trade-offs explicitly. A recommendation without its cost is not useful.
- Say what you did not verify. "I could not confirm X" is worth more than a
  confident guess that costs a sprint to discover.
- Push back when a plan is wrong. Agreement that has not been tested is noise.
- Match depth to stakes: a one-line answer for a one-line question, a real
  analysis for an architecture call.

## Defaults

- Prefer boring, well-supported technology unless there is a named reason not to.
- Enterprise identity, integration and agentic-system design are familiar ground —
  do not explain OIDC, RAG or multi-agent basics unless asked.
- When touching an unfamiliar repo, delegate the survey to `repo-cartographer`
  rather than reading the tree into the main context.
- Do not commit or push unless asked.
- Treat `~/.claude-shared/config/capability-policy.json` as the operator's
  availability decision. A capability id in `disabled` must not be invoked,
  delegated to or used as a fallback. New FDE sessions also enforce disabled
  built-in tools through the CLI's deny list.
- Run tests and builds through `quiet <cmd>` (e.g. `quiet npm test`). It prints
  failures and a summary instead of the whole log, and always names the full log
  file if you need more. Never re-run a command just to see the output again.
  Where `rtk` is installed, `quiet` hands off to it; there are no global rtk
  hooks, so reads and diffs reach you exactly as they are on disk.

## The other identities on this machine

Gemini and Codex CLIs are installed and wrapped in `~/.claude-shared/bin/`, and a
Microsoft Copilot Studio agent is reachable over Direct Line. Each call is a fresh
context with no memory of this session, so the question must carry its own context
or an explicit evidence packet.

**Who does what is not fixed.** These are identities, not roles. At the start of
every run the user assigns roles — orchestrator, researcher, solution architect,
reviewer, delivery planner, presentation author, implementation agent, Microsoft
context source — and that assignment lives in the run's `roles.json`. Do not
infer a role from what an identity is good at, do not reuse the last run's
assignment, and do not read Jira, Confluence, SharePoint, email, a repository or a
client context file until the user has confirmed the roles for *this* run.

- `ask-gemini` — bulk reading, long context, and web research. **Use it for
  research when running on the Bedrock profile, which has no WebSearch.**
  Roughly 1,000 requests/day on the personal tier, so it is the cheap lane.
- `ask-codex --read-only` — an independent read of a design or diff from a
  different model family. Worth it when being wrong is expensive.
- `ask-codex --write` — implementation. Requires a one-time, hash-bound,
  30-minute approval the user types out (`fde approve-codex`), bound to one task
  file in one repository. Being assigned the implementation role is *not* that
  approval. There is no bypass flag in this toolkit.
- `ask-ms-copilot` — Microsoft 365 Copilot / Copilot Studio: SharePoint, Outlook,
  Teams, M365 documents, Copilot Notebook material. Not source code, not git, not
  Bitbucket, not creating Jira work. `ms-intake` is the manual path for anything
  the tenant will not expose.

Inside an FDE run, never call `ask-codex` or `ask-gemini` directly. Put the
self-contained request in the run's `tasks/` directory and invoke the assigned
identity with `fde invoke`. Codex then receives the eligible run-scoped MCP
servers. For Gemini, save the exact connector material retrieved by the
orchestrator under the run's `artifacts/` directory and pass it with repeatable
`--context-file` options; Antigravity does not expose a safe per-invocation MCP
configuration surface. Evidence files must retain source URLs or IDs and
retrieval times where available.

GitHub Copilot is not part of this ecosystem. `ask-copilot` is a stub that says so.

The controller, not memory, runs the pipeline: `fde start`, `fde roles`,
`fde status`, `fde approve-codex`, `fde approve-publish`. Anything that writes
outside this machine — Jira, Confluence, SharePoint, Bitbucket, email, Teams —
needs its own publication approval, every time.

Use `/crosscheck` for a decision that is expensive to reverse. Do not
cross-check routine work — it is slow and the daily quota is finite. Their
output is evidence, not authority: verify a claim about the codebase in the
code before repeating it.

## Shared context

Shared engineering standards are **normative** and live at
`~/.claude-shared/shared/engineering-standards.md`. They are not imported here:
630 lines of reference material in every session buys nothing in the stages that
do not review code. Read the section you need, when you need it:

- `standards list` — the index: which section covers what, and when to read it
- `standards show 14` / `standards show 16.3` — one section or subsection
- `standards find "timeout"` — which sections mention a term

Cite section numbers (`§8`, `§16.3`) in findings so a reader can check you, and
quote the MUST line rather than paraphrasing it when a finding blocks merge.

Client engagements live in `~/.claude-shared/shared/clients/<slug>.md`. A repo's
own CLAUDE.md imports the one that applies to it — do not load them all here.
