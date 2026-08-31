# claude-profiles.sh — one Claude Code install, several identities.
# Source this from ~/.zshrc or ~/.bashrc:
#     source ~/.claude-shared/shell/claude-profiles.sh
#
# Why separate config dirs rather than just env vars: /setup-bedrock writes its
# provider settings into $CLAUDE_CONFIG_DIR/settings.json, and each claude.ai
# login owns the auth state in its config dir. Sharing one dir means the last
# thing you configured silently wins in every repo. Separate dirs keep each
# identity self-contained; the shared skills, agents and context are symlinked
# into all of them, so they stay identical without being copied.

export CLAUDE_SHARED="${CLAUDE_SHARED:-$HOME/.claude-shared}"

_claude_profile() {
  local name="$1"; shift
  local dir="$HOME/.claude-profiles/$name"
  if [[ ! -d "$dir" ]]; then
    printf 'claude: profile "%s" not found at %s\n' "$name" "$dir" >&2
    printf 'run: %s/bin/claude-profile-new %s\n' "$CLAUDE_SHARED" "$name" >&2
    return 1
  fi
  CLAUDE_CONFIG_DIR="$dir" CLAUDE_PROFILE="$name" "$@"
}

# --- subscription profiles (three personal accounts) ------------------------
# Each is a separate claude.ai login. Run `claude` once in each to sign in.
cc()      { _claude_profile work    claude "$@"; }   # default: main personal account
cc-work() { _claude_profile work    claude "$@"; }
cc-msc()  { _claude_profile msc     claude "$@"; }
cc-alt()  { _claude_profile alt     claude "$@"; }

# --- Bedrock profile --------------------------------------------------------
# One source of truth: ~/.claude-profiles/bedrock/settings.json, which carries
#     env.AWS_PROFILE = bedrock-dev
#     env.AWS_REGION  = eu-west-1
# and whatever model pins /setup-bedrock wrote. This wrapper deliberately sets
# nothing but the provider flag. It used to export AWS_PROFILE and AWS_REGION
# from MAXEDA_* shell variables, which silently overrode the profile's own
# settings with a `maxeda` AWS profile that does not exist — a wrong region and
# a missing profile, discovered only when a long run failed to authenticate.
# If you need to change the account or region, change settings.json.
cc-bedrock() {
  _claude_profile bedrock env \
    CLAUDE_CODE_USE_BEDROCK=1 \
    claude "$@"
}

# --- helpers ----------------------------------------------------------------
# Which profiles exist and which one is active.
cc-which() {
  printf 'active : %s\n' "${CLAUDE_PROFILE:-none (plain \`claude\` uses ~/.claude)}"
  printf 'shared : %s\n' "$CLAUDE_SHARED"
  printf 'profiles:\n'
  for d in "$HOME"/.claude-profiles/*/; do
    [[ -d "$d" ]] || continue
    local n; n="$(basename "$d")"
    if [[ -f "$d/settings.json" ]] && grep -qE 'BEDROCK|AWS_' "$d/settings.json" 2>/dev/null; then
      printf '  %-10s bedrock (configured)\n' "$n"
    elif [[ -d "$d/projects" || -f "$d/.credentials.json" ]]; then
      printf '  %-10s subscription (signed in)\n' "$n"
    else
      printf '  %-10s not set up yet — run cc-%s once\n' "$n" "$n"
    fi
  done
}

# Run the same prompt headlessly in a chosen profile, e.g.
#   cc-run bedrock "summarise the open threads in this repo"
cc-run() {
  local p="$1"; shift
  _claude_profile "$p" claude -p "$@"
}
