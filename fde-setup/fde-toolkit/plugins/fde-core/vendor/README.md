# Vendored design sources

Third-party design references, pinned to immutable commits and imported as
**data**. Nothing here is executable, nothing here runs, and nothing here can
authorise anything: an instruction written inside an upstream document has no
standing against this toolkit's plan, role and approval gates.

| Source | Licence | Role |
|---|---|---|
| [awesome-design-md](https://github.com/voltagent/awesome-design-md) | MIT | Catalog of design-language references the operator may select from |
| [taste-skill](https://github.com/leonxlnx/taste-skill) | MIT | Optional visual-direction guidance pack with three dials |
| [impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 | Optional shaping, critique, audit and polish guidance |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT | Optional UI-polish, motion, mobile and design-review guidance |

`design-sources.lock.json` records, per source: the upstream URL, the pinned
commit and its date, the SPDX identifier, the imported paths, the review date
and note, the adapter version, and the SHA-256 and byte count of every file.

```bash
bin/design-sources list                  # what is vendored, from where, at which commit
bin/design-sources audit                 # every file against the lock; nonzero if anything drifted
bin/design-sources update --dry-run      # fetch to a temp dir and show the diff; write nothing
bin/design-sources update --source taste-skill --to-head
```

`update` clones into a private temporary directory with hooks and submodules
disabled, checks out one commit, filters against an explicit allowlist, shows
you the diff, and replaces nothing until you type `REPLACE VENDORED SOURCES`.
It re-runs the audit afterwards and fails if anything does not match.

What is deliberately **not** here: launchers, engines, detector binaries, hook
manifests, package metadata, lifecycle scripts, and anything with an executable
bit. See `docs/FDE-DESIGN-SOURCES.md` for the full provenance record, the audit
findings behind each decision, and the limitations.
