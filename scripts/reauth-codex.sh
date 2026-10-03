#!/usr/bin/env bash
set -euo pipefail

# Refresh the Codex credential used by NanoClaw's OneCLI vault.
# This is deliberately separate from the user's personal ~/.codex login.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
export NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT"
# shellcheck source=scripts/reauth-common.sh
source "$SCRIPT_DIR/reauth-common.sh"

print_help() {
  cat <<'EOF'
reauth-codex.sh — refresh NanoClaw's Codex/OpenAI credential over SSH

WHY THIS SCRIPT EXISTS
  NanoClaw does not use your personal ~/.codex login directly. It keeps a
  separate Codex login in the OneCLI vault so the agent container can use it
  without receiving a real credential. This script refreshes that vault entry.

  You do NOT need desktop access on the remote machine. The normal workflow is:
    1. SSH to the remote machine.
    2. Run this script.
    3. Copy the URL printed by Codex into a browser on your own computer.
    4. Enter the one-time code shown in the SSH terminal, if Codex asks for it.
    5. Wait for this terminal to say that OneCLI was updated.

DEFAULT MODE: CHATGPT SUBSCRIPTION / DEVICE CODE
  Running without options starts:

    CODEX_HOME=<temporary-private-directory> codex login --device-auth

  The temporary CODEX_HOME is important. Do not replace it with ~/.codex and
  do not copy your personal ~/.codex/auth.json into NanoClaw. NanoClaw needs a
  dedicated refresh-token session for the gateway.

  Codex may require device-code login to be enabled in your ChatGPT account or
  workspace settings. If the command says device authentication is disabled,
  an administrator must enable it, or you must use --api-key.

API-KEY MODE
  Use --api-key only if you intentionally want pay-per-use OpenAI API billing:

    ./scripts/reauth-codex.sh --api-key

  The key is read with hidden terminal input and sent directly to OneCLI. It is
  not printed, saved by this script, or put in the Ops Center status file.
  API-key mode changes the matching OneCLI secret to host api.openai.com.
  Subscription/device mode changes it to host chatgpt.com.

WHICH ONECLI SECRET IS UPDATED?
  If exactly one plausible Codex/OpenAI secret exists, this script updates it
  in place, preserving its ID and any agent assignment. If none exists, it
  creates one. If several exist, it stops rather than guessing. Inspect the
  non-secret metadata with:

    onecli secrets list

  Then run this script again with the exact ID:

    ./scripts/reauth-codex.sh --secret-id <ID>

  You can combine --secret-id with --api-key. The ID is metadata, not a secret.

OPS CENTER EXPIRY DISPLAY
  After a successful refresh, the script writes only timestamps and method
  labels to data/provider-auth-status.json. The Ops Center System page uses it.
  Claude has an estimated one-year expiry; Codex is shown as provider-managed
  because Codex refreshes its credentials and does not expose one simple fixed
  expiry in this workflow.

OPTIONS
  --device-code, --device-auth
      Explicitly select ChatGPT device-code login. This is the default.
  --api-key
      Use a hidden prompt for an OpenAI API key instead of ChatGPT login.
  --secret-id <ID>
      Update this exact OneCLI secret instead of auto-selecting one.
  -h, --help
      Show this help and exit without checking credentials or changing anything.

EXAMPLES
  ./scripts/reauth-codex.sh
  ./scripts/reauth-codex.sh --device-code
  ./scripts/reauth-codex.sh --api-key
  ./scripts/reauth-codex.sh --secret-id 1234 --device-code

REQUIREMENTS
  Run from this NanoClaw checkout on the remote host. The host must have:
    - onecli, connected to the local OneCLI gateway
    - codex, for subscription/device-code mode
    - node, which NanoClaw already requires
    - a real interactive SSH terminal for the login prompts

This script does not restart NanoClaw. OneCLI credentials are read at request
time; after the success message, retry the failed agent operation.
EOF
}

MODE="device"
SECRET_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --device-code|--device-auth) MODE="device"; shift ;;
    --api-key) MODE="api"; shift ;;
    --secret-id)
      [ "$#" -ge 2 ] || reauth_die "--secret-id needs an ID. Run -h for examples."
      SECRET_ID="$2"
      shift 2
      ;;
    -h|--help) print_help; exit 0 ;;
    *) reauth_die "unknown argument '$1'. Run ./scripts/reauth-codex.sh -h" ;;
  esac
done

umask 077
reauth_require_command onecli
reauth_require_node
if ! onecli version >/dev/null 2>&1; then
  reauth_die "OneCLI is not responding. Start its gateway, then rerun this script."
fi

if [ "$MODE" = "api" ]; then
  printf 'Paste the OpenAI API key (input hidden): '
  IFS= read -r -s API_KEY
  printf '\n'
  [ -n "${API_KEY:-}" ] || reauth_die "no API key was entered; nothing was changed"
  SELECTED_ID="$(reauth_select_secret_id codex "$SECRET_ID")"
  reauth_upsert_value_secret "$SELECTED_ID" "Codex" "openai" "$API_KEY" "api.openai.com"
  unset API_KEY
  NOW="$(reauth_now)"
  reauth_record_status "$PROJECT_ROOT" "codex" "OpenAI API key" "$NOW" "" "no-known-expiry" "API keys have no expiry recorded by this script; rotate them manually when needed."
  echo "Codex authentication refresh complete. Retry NanoClaw now."
  exit 0
fi

reauth_require_command codex
LOGIN_HOME="$(mktemp -d "${TMPDIR:-/tmp}/nanoclaw-codex-login.XXXXXX")"
chmod 700 "$LOGIN_HOME"
cleanup() { rm -rf "$LOGIN_HOME"; }
trap cleanup EXIT HUP INT TERM

cat <<'EOF'
Starting Codex device-code login in a temporary private directory.

When Codex prints a sign-in URL, open that URL in a browser on your own
computer. The remote machine does not need a desktop or browser.

EOF

if ! CODEX_HOME="$LOGIN_HOME" codex login --device-auth; then
  reauth_die "Codex login did not complete. The OneCLI vault was not changed."
fi

AUTH_FILE="$LOGIN_HOME/auth.json"
[ -s "$AUTH_FILE" ] || reauth_die "Codex reported success but did not create auth.json; the vault was not changed."
SELECTED_ID="$(reauth_select_secret_id codex "$SECRET_ID")"
reauth_upsert_file_secret "$SELECTED_ID" "Codex" "openai" "$AUTH_FILE" "chatgpt.com"
NOW="$(reauth_now)"
reauth_record_status "$PROJECT_ROOT" "codex" "ChatGPT device-code login" "$NOW" "" "provider-managed" "Codex refreshes ChatGPT credentials automatically; no fixed expiry is recorded for this workflow."
echo "Codex authentication refresh complete. Retry NanoClaw now."
