# Design panel

Two or three Claude accounts, the same sealed project context, one reconciled
recommendation. It is a normal FDE run in a named shape — not a second
orchestration system, and not three unrelated chats.

## What it is

```text
intake  →  solution architecture  →  adversarial review  →  reconciliation  →  presentation
             ^ the panel works here                          ^ and here
```

The `design-panel` shape is ordinary FDE stages. What is new is that
`uiUxDesign` may be held by **several** identities in one run, and that the
controller seals one set of context bytes and gives every one of them exactly
those bytes.

Everything else is unchanged and deliberately so:

- **Identities are not roles.** Which accounts design is decided per run, by
  you, in that run's `roles.json`.
- **Nothing starts before the combined approval.** You still type
  `APPROVE PLAN <run-id>` in the run session. The console has no button for it.
- **Project and run boundaries stay explicit.** A panel belongs to one project
  and one run, and shows up in both histories.
- **Credentials never move.** Each participant runs under its own
  `CLAUDE_CONFIG_DIR`; no profile's environment is merged with another's.
- **Concept generation writes nothing but the run.** Participants have no
  built-in file or shell tools. When the approved run generated Figma and
  Playwright MCP bindings, they receive only those tools for design evidence
  and isolated browser inspection. Implementation remains a separate stage
  behind its own approval.

## Starting one

From the console: **Start design panel** on a project, or the link on the
new-run form. It is two steps, because a panel has two moments:

1. **Create the run.** Project, design brief, and the orchestrator account.
2. **Seal the context and configure the panel.** Attach the shared inputs,
   choose participants, lenses, model and effort per account, the output
   target, an optional design-language reference, optional guidance packs, and
   independent-first or collaborative.

Between those two steps you can attach files to the run. After the second, the
context is sealed: participants receive exactly those bytes, and the only way
to change them is a new panel on a new run.

Creating the panel proposes the plan and *selects* the designers. It approves
nothing. The panel page then tells you which roles the plan still needs and the
exact phrase to type.

From a terminal the same thing, one command at a time:

```bash
fde start --json --orchestrator work --project <project-id> --shape design-panel -- "Rework returns"
fde design-panel create <run-id> --brief-file brief.md --propose-plan \
    --participant work:flow --participant msc:visual:high --participant alt:system
fde roles <run-id> --set solutioning=work --set review=msc --set presentation=work
fde approve-plan <run-id>            # type: APPROVE PLAN <run-id>
fde resume <run-id> --next           # into solutioning
fde design-panel start <run-id> claude_work --print-prompt
```

`--participant` is `<agent>:<lens>[:<effort>[:<model>]]`. The model is last so a
provider model id containing a colon still parses.

## The sealed context

Built once, written to `artifacts/design-panel/common-context.md`, and reused
byte-for-byte. `artifacts/design-panel/context-manifest.json` records what went
into it:

| Field | What it pins |
|---|---|
| `schemaVersion` | the manifest contract |
| `projectId`, `repositories` | the project and its repository roots, each with its Git HEAD when it has one |
| `brief` | SHA-256 and size of the design brief |
| `inputFiles` | each selected attachment: media type, size, SHA-256, whether it was inlined or passed as a file, and for a file the sealed copy's path inside the run |
| `productMd`, `designMd` | the selected project documents, with digests, or the reason one was not included |
| `designReferences` | the selected catalog documents, their upstream commit, licence and digest |
| `guidancePacks` | each enabled pack, its pinned commit, licence, dial settings, and exactly which document bytes were used |
| `commonContextBytes`, `contextSha256` | the size and digest of the shared bytes |

Every participant's prompt is **the shared bytes, then the handoff it was given
if the panel is collaborative, then its own lens block**. The shared context is a
strict prefix of every prompt, the controller asserts it, and the test suite
proves it — that is what makes "everyone got the same context" checkable rather
than merely intended.

Images are sealed by their bytes, not by the path they arrived on. A selected
image is copied into `artifacts/design-panel/media/`, and that copy — never the
uploaded attachment, which stays writable — is what participants are handed. The
copy is re-hashed against the manifest at *every* start, so an image that
changed between two participants refuses the second start rather than quietly
giving two accounts different bytes under one context digest.

## Independent-first and collaborative

**Independent-first** is the default: no participant sees another's proposal
until every one of them has finished or failed, and the controller refuses a
prompt that contains one.

**Collaborative** is a staged handoff, and the stages are enforced. Participants
work in the order they were configured — `handoffOrder` in the panel view — and:

- a participant cannot start until every participant ahead of it is finished,
  failed, stopped or interrupted;
- when it starts, the succeeded proposals ahead of it are appended after the
  shared context, in a `<handoff>` block carrying each proposal's digest, and its
  lens block tells it to say what it adopts, changes and rejects;
- the run log records a `design-panel.handoff` event naming who received which
  proposals by digest, and `design-panel.barrier-opened` with `reason: handoff`
  the first time anything is handed over;
- an earlier participant cannot be retried once a later one has worked, because
  that would replace a proposal somebody was already given. Start a new run.

A failed predecessor hands nothing on and does not block: the next participant
starts with an empty handoff and is told it is working first.

## Output targets

`recommendation` is a document. `design-to-code` adds a handoff section to the
reconciliation.

`prototype` produces an artifact, not a description of one. Each participant's
proposal must carry a `## Prototype` section containing exactly one ```html
fenced block holding a complete, self-contained HTML document — everything
inline, nothing fetched over the network — and the reconciliation must produce
one more, reconciled from theirs. The controller extracts each into
`artifacts/design-panel/prototypes/` (`<participant>.html` and
`final-prototype.html`) and refuses a proposal or an answer that describes a
prototype instead of delivering one: nothing is recorded, and the participant
stays running and retryable. The console previews them with scripts off and
links to the file.

The selection is explicit and bounded. No repository is traversed and no folder
is inlined: at most 12 attachments, 256 KiB each, 64 KiB inlined each, 512 KiB
of context in total. Guidance and references are cut on whole section
boundaries and the manifest records how many bytes of each document were used.

Symlinks are refused. Sensitive paths are refused. An attachment whose bytes no
longer match its recorded digest is refused. A file that is not UTF-8 text and
is not an image type the installed CLI can accept is refused **before** the
panel starts, rather than turned into prompt text.

Images are never inlined. The console feature-detects whether the installed
Claude CLI documents a way to take a file; if it does not, an image selection is
refused with a clear reason.

## Running it

Participants are started one at a time from the panel page. Each one:

- runs under its own profile environment and nothing else;
- runs with `--tools ''`, `--restricted`, `--strict-mcp-config` and plan-only
  permissions, so it cannot write a repository even if something in its context
  told it to;
- has a wall-clock ceiling (15 minutes by default), an output ceiling, and a
  Stop that actually kills the process;
- at most three run at once, in this console and in the controller.

**Independent first** (the default) means no participant's prompt may contain
another participant's proposal. The controller enforces the barrier rather than
trusting the prompt builder, and refuses to start a participant if it would be
broken. The barrier opens exactly once, at reconciliation, and the opening is an
event in the run log.

A partial failure is normal and is not fatal: successful proposals stay
available, a failed participant carries a safe reason, and Retry starts it again
as a new attempt.

## Reconciliation

Reconciliation runs in the `reconciliation` stage, with the run's orchestrator
account, and needs **two** successful proposals. With one, it refuses — unless
you explicitly approve a degraded reconciliation in a terminal:

```bash
fde design-panel approve-degraded <run-id>
# type: APPROVE DEGRADED RECONCILIATION <run-id>
```

That is a typed approval on purpose. A recommendation nothing argued with is a
decision, not a default, and the final design says so.

The answer must arrive in exactly these sections, or it is refused and nothing
is written:

```text
## Comparison
## Reconciliation
## Final design recommendation
## Design-to-code handoff      (only when the output target is design-to-code)
```

They become governed artifacts:

```text
artifacts/design-panel/
  context-manifest.json
  common-context.md
  references/<reference-id>.md
  proposals/claude_work.md
  proposals/claude_msc.md
  proposals/claude_alt.md
  media/
  comparison.md
  reconciliation.md
  final-design.md
  design-to-code-handoff.md
```

The comparison covers user flow, hierarchy, visual language, components,
accessibility, responsive behaviour, motion, risks and implementation cost. The
reconciliation lists accepted and rejected ideas explicitly, attributed, with
reasons.

## Guidance packs and references

Optional, off by default, and shown with what each one changes.

- **Taste** — visual-direction guidance with three dials (variance, motion,
  density), each an integer 1–10 recorded in the panel manifest. Upstream
  describes its current default as an experimental pre-release, so it is offered
  as a versioned pack, never as a global rule.
- **Impeccable** — shaping guidance during concept generation, critique and
  audit during review, polish only after reconciliation. Guidance layer only:
  no launcher, no engine binary, no hooks. See `docs/FDE-DESIGN-SOURCES.md`.
- **Design-language references** — a catalog of reviewed `DESIGN.md` documents.
  Pick at most one primary and one secondary. They are copied into the sealed
  run context and hashed. They are inspiration for an original, project-specific
  direction — never authorisation to impersonate a brand or reuse its assets.

Taste and Impeccable give conflicting stylistic direction. Enabling both is
possible, but only after the conflict has been shown and you have chosen.

When guidance disagrees, this order decides:

1. your stated requirements and acceptance criteria;
2. existing product truth, accessibility obligations, design system and code
   conventions;
3. approved project `PRODUCT.md` and `DESIGN.md`;
4. the selected design-language reference — inspiration only;
5. selected Taste guidance;
6. Impeccable's generic guidance and any detector findings.

That order is written into every sealed context, so it travels with the work.

## Recovery

| What happened | What you see | What to do |
|---|---|---|
| The console restarted mid-run | participants become `interrupted` with a reason | Retry them |
| An account hit a usage limit | that participant is `failed`, the others are untouched | Retry it later, or reconcile with the rest |
| Only one proposal succeeded | reconciliation refuses | Retry, or approve a degraded reconciliation |
| The model answered without the required sections | the answer is refused, nothing is written | Reconcile again |
| A vendored source no longer matches its lock | the panel refuses to use it | `design-sources audit`, then `design-sources update` |
| `fde` is older than the console | the console says so | `./install.sh --update` |

Orphaned work is turned into a retryable interruption the first time the panel
is read after a restart. Nothing is silently resumed, and no proposal is lost:
what was recorded stays recorded.

## Limitations, stated plainly

- A panel is Claude accounts. Codex, Gemini and Copilot are not participants:
  the point is separately authenticated Claude accounts reading identical
  context, and the isolation guarantee is a Claude-profile one.
- **Collaborative** mode is a staged handoff: each participant is given the
  proposals of the ones before it, and the order is enforced. It does not make
  the accounts talk to each other live — there is no shared session, and a
  participant sees a predecessor's finished proposal, not its reasoning.
- A prototype is a single self-contained HTML file with no network access. It
  is a design artifact to look at and click through, not a build of the product,
  and it authorises no repository write.
- The console runs the accounts; the controller owns the record. If the console
  is not running, nothing progresses — and nothing is lost.
- Participants have no built-in file or shell tools. They cannot read or modify
  the repository themselves; they see the sealed context and may inspect only
  the run-scoped Figma/Playwright evidence surfaces when available. That is the
  trade for the guarantee that concept generation writes nothing.
- The reconciliation is one model call with a required shape. It is evidence
  and a recommendation, not an approval: implementation, publication and
  deployment keep their own gates.
- An image reaches a participant only if the installed CLI can take a file. The
  console detects that; it does not assume it.
