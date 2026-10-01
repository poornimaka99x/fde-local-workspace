# FDE setup development

This repository contains the FDE controller, capability policy, specialist
workflows and local console. Keep deterministic authorization and capability
resolution in `claude-shared/lib` and the controller; the GUI consumes them.

- Preserve existing local changes and operator-owned installed configuration.
- Read the relevant contract in `docs/` before changing its implementation.
- Run affected Python checks with `claude-shared/bin/quiet python3 -m unittest
  discover -s tests -p '<affected-test-file>.py'`. Use isolated fixtures rather
  than live client systems for tests.
- Keep requirement IDs and evidence through implementation and verification.
- Never describe a static audit, a declared tool list or a passing test as proof
  that an unrelated client/session enforces the same permissions.
- Use `fde config provenance` to compare this checkout with an installation.
  Source edits do not activate themselves in installed clients or running chats.
- No commit, push, publication or deployment is implied by local development.
