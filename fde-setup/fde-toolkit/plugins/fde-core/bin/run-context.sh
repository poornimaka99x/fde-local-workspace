#!/usr/bin/env bash
# SessionStart hook: inject only a bounded FDE run brief when the operator
# explicitly launches the session with FDE_RUN_ID. No run is inferred.
set -uo pipefail

run_id="${FDE_RUN_ID:-}"
[[ -n "$run_id" ]] || exit 0

shared="${CLAUDE_SHARED:-$HOME/.claude-shared}"
controller="$shared/bin/fde"
if [[ ! -x "$controller" ]]; then
  printf 'FDE run context unavailable: controller not executable at %s\n' "$controller" >&2
  exit 0
fi

"$controller" brief "$run_id" || {
  printf 'FDE run context unavailable for %s; use fde status to diagnose.\n' "$run_id" >&2
  exit 0
}
