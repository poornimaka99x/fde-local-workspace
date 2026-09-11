#!/usr/bin/env bash
# SessionStart hook: state plainly which account and provider this session bills.
# The operator switches between Bedrock and personal accounts; the failure mode this
# prevents is a long agentic run landing on the wrong one.
set -uo pipefail

profile="${CLAUDE_PROFILE:-default}"
cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

if [[ "${CLAUDE_CODE_USE_BEDROCK:-}" == "1" || "${CLAUDE_CODE_USE_BEDROCK:-}" == "true" ]]; then
  provider="Amazon Bedrock (${AWS_REGION:-region unset}, profile ${AWS_PROFILE:-default})"
  note="WebSearch is unavailable on Bedrock."
elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  provider="Anthropic API key"
  note=""
else
  provider="claude.ai subscription login"
  note=""
fi

printf 'Claude profile: %s | provider: %s | config: %s' "$profile" "$provider" "$cfg"
[[ -n "$note" ]] && printf ' | %s' "$note"
printf '\n'
exit 0
