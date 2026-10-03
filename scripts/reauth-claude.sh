#!/usr/bin/env bash
set -euo pipefail

# Refresh the Claude credential used by NanoClaw's OneCLI vault.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
export NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT"
# shellcheck source=scripts/reauth-common.sh
source "$SCRIPT_DIR/reauth-common.sh"

print_help() {
  cat <<'EOF'
reauth-claude.sh — refresh NanoClaw's Claude credential over SSH

WHY THIS SCRIPT EXISTS
  NanoClaw sends Claude requests through its local OneCLI gateway. This script
  obtains a fresh Claude credential and updates the matching OneCLI secret.
  The credential is never put in the NanoClaw container or in the Ops Center
  status file.

DEFAULT MODE: CLAUDE SUBSCRIPTION / setup-token
  Running without options starts:

    claude setup-token

  You do NOT need desktop access on the remote machine. The normal workflow is:
    1. SSH to the remote machine.
    2. Run this script.
    3. If Claude prints a sign-in URL, copy it into a browser on your own
       computer and complete the Claude login there.
    4. Return to the SSH terminal and wait for the script to finish.
    5. The script captures the token and updates OneCLI automatically.

  The script runs Claude with a temporary CLAUDE_CONFIG_DIR and captures the
  terminal through script(1). This prevents the re-auth flow from overwriting
  your ordinary Claude CLI state and lets it work from SSH.

  Claude documents setup-token as a one-year OAuth token for Pro, Max, Team,
  and Enterprise subscriptions. The Ops Center therefore shows an estimated
  expiry one year after this script finishes. It is an estimate, not a live
  provider introspection result.

API-KEY MODE
  Use --api-key if you intentionally want Claude Console/API-key billing:

    ./scripts/reauth-claude.sh --api-key

  The key is read with hidden terminal input and sent directly to OneCLI. It is
  not printed, saved by this script, or put in the Ops Center status file.
  API-key mode has no expiry recorded by this script.

WHICH ONECLI SECRET IS UPDATED?
  If exactly one plausible Anthropic secret exists, this script updates it in
  place, preserving its ID and any agent assignment. If none exists, it creates
  one. If several exist, it stops rather than guessing. Inspect the non-secret
  metadata with:

    onecli secrets list

  Then select the intended record explicitly:

    ./scripts/reauth-claude.sh --secret-id <ID>

  You can combine --secret-id with --api-key. The ID is metadata, not a secret.

OPS CENTER EXPIRY DISPLAY
  After a successful refresh, the script writes only timestamps and method
  labels to data/provider-auth-status.json. The Ops Center System page shows
  the last refresh and the next estimated expiry. It also shows the exact SSH
  command to run again when the date becomes convenient.

OPTIONS
  --subscription, --setup-token
      Use Claude subscription setup-token authentication. This is the default.
  --api-key
      Use a hidden prompt for an Anthropic API key instead.
  --secret-id <ID>
      Update this exact OneCLI secret instead of auto-selecting one.
  -h, --help
      Show this help and exit without checking credentials or changing anything.

EXAMPLES
  ./scripts/reauth-claude.sh
  ./scripts/reauth-claude.sh --subscription
  ./scripts/reauth-claude.sh --api-key
  ./scripts/reauth-claude.sh --secret-id 1234 --subscription

REQUIREMENTS
  Run from this NanoClaw checkout on the remote host. The host must have:
    - onecli, connected to the local OneCLI gateway
    - claude, for subscription/setup-token mode
    - script(1), used to provide a real PTY and capture the token
    - pnpm, because NanoClaw's existing safe token parser is TypeScript
    - node, which NanoClaw already requires

This script does not restart NanoClaw. OneCLI credentials are read at request
time; after the success message, retry the failed agent operation.
EOF
}

MODE="subscription"
SECRET_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --subscription|--setup-token) MODE="subscription"; shift ;;
    --api-key) MODE="api"; shift ;;
    --secret-id)
      [ "$#" -ge 2 ] || reauth_die "--secret-id needs an ID. Run -h for examples."
      SECRET_ID="$2"
      shift 2
      ;;
    -h|--help) print_help; exit 0 ;;
    *) reauth_die "unknown argument '$1'. Run ./scripts/reauth-claude.sh -h" ;;
  esac
done

umask 077
reauth_require_command onecli
reauth_require_node
if ! onecli version >/dev/null 2>&1; then
  reauth_die "OneCLI is not responding. Start its gateway, then rerun this script."
fi

if [ "$MODE" = "api" ]; then
  printf 'Paste the Anthropic API key (input hidden): '
  IFS= read -r -s API_KEY
  printf '\n'
  [ -n "${API_KEY:-}" ] || reauth_die "no API key was entered; nothing was changed"
  SELECTED_ID="$(reauth_select_secret_id claude "$SECRET_ID")"
  reauth_upsert_value_secret "$SELECTED_ID" "Anthropic" "anthropic" "$API_KEY" "api.anthropic.com"
  unset API_KEY
  NOW="$(reauth_now)"
  reauth_record_status "$PROJECT_ROOT" "claude" "Anthropic API key" "$NOW" "" "no-known-expiry" "API keys have no expiry recorded by this script; rotate them manually when needed."
  echo "Claude authentication refresh complete. Retry NanoClaw now."
  exit 0
fi

reauth_require_command claude
reauth_require_command script
reauth_require_command pnpm

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nanoclaw-claude-login.XXXXXX")"
chmod 700 "$WORK_DIR"
CAPTURE_FILE="$WORK_DIR/terminal.log"
export CLAUDE_CONFIG_DIR="$WORK_DIR/claude-config"
cleanup() { unset CLAUDE_CONFIG_DIR; rm -rf "$WORK_DIR"; }
trap cleanup EXIT HUP INT TERM

cat <<'EOF'
Starting Claude setup-token in a temporary private directory.

If Claude prints a sign-in URL, open it in a browser on your own computer.
The remote machine does not need a desktop or browser.

EOF

if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c 'claude setup-token' "$CAPTURE_FILE"
else
  # macOS/BSD script(1) takes the command after the capture-file argument.
  script -q "$CAPTURE_FILE" claude setup-token
fi

TOKEN="$(pnpm exec tsx "$PROJECT_ROOT/setup/lib/captured-token.ts" claude "$CAPTURE_FILE" 2>/dev/null || true)"
[ -n "$TOKEN" ] || reauth_die "Claude login did not produce a recognizable token; the OneCLI vault was not changed."
SELECTED_ID="$(reauth_select_secret_id claude "$SECRET_ID")"
reauth_upsert_value_secret "$SELECTED_ID" "Anthropic" "anthropic" "$TOKEN" "api.anthropic.com"
unset TOKEN
NOW="$(reauth_now)"
EXPIRES="$(reauth_plus_days 365)"
reauth_record_status "$PROJECT_ROOT" "claude" "Claude setup-token subscription login" "$NOW" "$EXPIRES" "estimated" "Estimated from Claude's documented one-year setup-token lifetime."
echo "Claude authentication refresh complete. Estimated expiry: $EXPIRES"
