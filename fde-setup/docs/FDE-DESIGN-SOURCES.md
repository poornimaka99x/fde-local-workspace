# Vendored design sources — provenance and audit

Four third-party repositories feed the design panel. All four are **data**:
pinned to an immutable commit, filtered against an explicit allowlist, hashed,
and imported without executing anything from them. Instructions written inside
an upstream document have no authority here; the sealed context says so to the
model, and the toolkit's plan, role and approval gates say so to everything
else.

Everything below is recorded machine-readably in
`fde-toolkit/plugins/fde-core/vendor/design-sources.lock.json`.

## What is pinned

| Source | Licence | Commit | Commit date | Imported | Reviewed |
|---|---|---|---|---|---|
| [voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md) | MIT | `8147538b4226ae41e2487a9179e3bcc1f68e8554` | 2026-07-31 | 76 files, 2.2 MB | 2026-09-06 |
| [leonxlnx/taste-skill](https://github.com/leonxlnx/taste-skill) | MIT | `ccbc15639c97057cbfcf32ecebc38ef716e4bb37` | 2026-08-24 | 5 files, 144 KB | 2026-09-06 |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 | `831cabee8b4bc1a2b66e5ae22003e9a19b57d464` | 2026-09-05 | 9 files, 95 KB | 2026-09-06 |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT | `d16ebe60d09a5ba2afcb7054ede9d0a10c9f6128` | 2026-09-24 | 10 files | 2026-09-25 |

Licences were verified **at those commits**, not from a README claim: each
upstream `LICENSE` is vendored beside the content it covers, Impeccable's
`NOTICE.md` is vendored as `NOTICE-upstream.md`, and every adapted file carries
a modification notice naming the source, the commit and what was changed.

The user supplied four links; two were the same Impeccable repository, so three
unique sources were integrated.

## What was found, and what was therefore imported

### awesome-design-md — a catalog, not a skill

Markdown only: 74 entries under `design-md/<name>/`, no `package.json`, no
scripts, no CI workflows, no binaries, no hooks. The only non-content files are
a funding config and an issue template.

Imported: the upstream `LICENSE` and every entry's `DESIGN.md`, verbatim, plus a
generated `catalog.json` index carrying each entry's name, description, upstream
URL, size and SHA-256.

Not imported: per-entry `README.md` files, `.github/`, `CONTRIBUTING.md`.

These documents are third-party analyses of other companies' **public** design
languages. The catalog carries a warning that travels into the sealed context:
they are inspiration for an original, project-specific direction, never
authorisation to impersonate a brand or reuse protected assets. Existing project
`DESIGN.md`, stated requirements and existing tokens outrank them.

### taste-skill — markdown skills, no executables

Markdown skill documents plus a `skill.sh` that is a shell associative-array
lookup of file paths, and a `scripts/` directory of README-asset builders
(sponsor badges, WebP conversion). No lifecycle scripts, no package manifest, no
binary, no hook manifest, no network use at load time.

Imported: `LICENSE`, and three skill documents adapted (YAML frontmatter
stripped, notice prepended):

- `skills/taste-skill/SKILL.md` → `guidance/design-taste-frontend.md`
- `skills/redesign-skill/SKILL.md` → `guidance/redesign-existing-projects.md`
- `skills/image-to-code-skill/SKILL.md` → `guidance/image-to-code.md`

Not imported: `skill.sh`, `scripts/`, `assets/`, `research/`, `examples/`, the
plugin manifests, and the nine other style skills — none are needed by this
workflow.

Upstream's own CHANGELOG and README describe the default `design-taste-frontend`
as **v2 (experimental)**, a pre-release that iterates between releases. It is
therefore exposed as an optional, versioned guidance pack with the three dials
(`variance`, `motion`, `density`, integers 1–10, validated and recorded in the
panel manifest) — never as an unconditional rule, and never overriding
accessibility, product requirements, the existing design system or a
user-selected visual direction.

`redesign-existing-projects` applies only to an existing UI, and `image-to-code`
only when the workflow actually includes images and implementation. Neither is
enabled by simply enabling the pack.

### impeccable — guidance imported, detector deliberately not

The relevant findings:

- `cli/bin/cli.js` is an npm shim that locates a **platform engine binary** and,
  failing that, downloads one from the project's GitHub release channel into
  `~/.impeccable/bin/<version>/`. It verifies the download against a `.sha256`
  sidecar and fails closed when the sidecar is missing — good behaviour, and
  still a network fetch of an executable.
- `skill/scripts/impeccable` is a launcher shell script with the same
  responsibility, plus `impeccable.cmd` for Windows and several browser-driving
  JavaScript files.
- `plugin/hooks/hooks.json` registers a `PostToolUse` hook on `Edit|Write` and a
  `Stop` hook, both running that launcher.
- `package.json` publishes only `cli/bin/` and `LICENSE`, declares five
  platform engine packages as `optionalDependencies` pinned to `0.1.2`
  (`ENGINE_VERSION` agrees), and has **no** `preinstall`, `install`,
  `postinstall` or `prepare` script.
- The upstream skill's frontmatter grants itself `Bash(npx impeccable *)`.

Imported: `LICENSE`, `NOTICE.md`, and guidance markdown only —
`skill/SKILL.src.md` adapted into `guidance/impeccable-core.md` (frontmatter and
the launcher `## Setup` section removed, notice prepended) plus the verbatim
`shape`, `critique`, `audit`, `polish` and `craft-floor` references.

Not imported, and not installed anywhere: the launcher, the engine binary, the
platform packages, the browser bundle, the hook manifest, the plugin manifests,
`.claude/`, `.codex/`, and every other agent-runtime directory in that
repository.

So in default mode FDE uses reviewed guidance text that needs no executable and
no download. If detector support is ever added it must be its own settings page
showing the pinned engine version, the expected files and hashes, the exact
commands, the network behaviour and the hook files affected, behind an explicit
confirmation — and a one-shot, no-hook, no-shell, timed, bounded-output
invocation at the audit or polish stage, with no secret-bearing environment.
An upstream hook could never bypass FDE plan, write, publication or deployment
approval, because those are typed by a person and recorded in the run ledger.

Impeccable's `PRODUCT.md` (product truth) and `DESIGN.md` (visual direction) stay
separate concepts, and FDE overwrites neither if a project already has one.

### emilkowalski/skills — design-panel guidance, not an execution layer

Imported as an optional `emil-design` guidance pack: `emil-design-eng`,
`animate`, `apple-design`, `find-animation-opportunities`,
`improve-animations`, `mobile-native`, `prototype`, and `review-animations`.
Their YAML frontmatter is removed and an FDE authority notice is prepended.
They contribute UI-polish and motion judgement during solutioning, focused
motion review during review, and a bounded polish reminder during
reconciliation.

Not imported: the Sonner- and Swift-specific skills, setup tooling, or any
executable content. The pack can advise a panel but cannot write a repository,
publish to Figma, or widen the panel's connector scope.

## Supply-chain rules this integration follows

- Pinned to an immutable commit SHA in a checked-in lock. No moving branch, and
  nothing is ever executed from a GitHub URL at runtime.
- Fetched with `git clone` into a private temporary directory with
  `core.hooksPath=/dev/null`, `protocol.file.allow=never`, no submodules, and a
  single detached checkout that is verified to be the requested commit.
- Filtered against a per-source allowlist. Every imported file must decode as
  UTF-8, contain no NUL byte, and stay under 256 KiB; the tool refuses to write
  anything with an executable, installer or hook-manifest name.
- Written with mode `0644`. Nothing in the vendor tree is executable except the
  audit tool itself, and the audit fails if that ever changes.
- Recorded per file: upstream path, size, SHA-256, and whether it was adapted.
- Never `curl | sh`, never unpinned `npx`, never a remote script, never a
  lifecycle script, never a force flag.
- Nothing installed globally. `~/.claude`, `~/.codex`, the Claude profile
  directories, shell startup files and global MCP configuration are untouched.
- No hooks, browser extensions, telemetry, network services or binary downloads
  are enabled by default — or at all, in this integration.

## Using the tool

```bash
cd ~/.claude-shared/fde-toolkit/plugins/fde-core/vendor   # or your checkout
bin/design-sources list                    # what is vendored, from where, at which commit
bin/design-sources audit                   # every file against the lock; nonzero on drift
bin/design-sources update --dry-run        # fetch to a temp dir, show the diff, write nothing
bin/design-sources update --source impeccable --to-head
```

`update` fetches, re-imports into a staging directory, shows you a unified diff
against what is vendored, and replaces nothing until you type
`REPLACE VENDORED SOURCES`. It then re-runs the audit and exits nonzero if
anything does not match. `--dry-run` never writes; `--yes` is for an update you
have already reviewed in a dry run.

`fde doctor` runs the same audit and reports the pinned commits, so drift shows
up without anyone remembering to look. `install.sh --update` carries the vendor
tree with its usual backup-and-diff behaviour, treats
`design-sources.lock.json` as a file you may have changed (so a pin you moved is
never replaced silently), and re-runs the audit afterwards.

## Attribution

- Awesome DESIGN.md © VoltAgent, MIT. Catalog entries vendored verbatim.
- Taste Skill © Leonxlnx, MIT. Skill documents vendored with frontmatter removed
  and a modification notice added.
- Impeccable © Paul Bakaus, Apache-2.0. Guidance documents vendored; the core
  skill document adapted as described above. Impeccable's own `NOTICE.md`
  (covering platform-design material derived from ehmo's
  `platform-design-skills`, MIT) is vendored alongside it.
- Emil Kowalski Skills © Emil Kowalski, MIT. Selected design and motion skill
  documents are vendored with frontmatter removed and an FDE notice added.
