#!/usr/bin/env bash
set -euo pipefail

# OpenRouter is not an OAuth subscription in this NanoClaw setup. It is an API
# key held by OneCLI. This script can validate the existing key through the
# gateway or replace it using hidden input, then records a non-secret receipt.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT"
# shellcheck source=reauth-common.sh
source "$SCRIPT_DIR/reauth-common.sh"

usage() {
  cat <<'EOF'
reauth-openrouter.sh — check or replace NanoClaw's OpenRouter OneCLI key

OpenRouter uses an API key here, not OAuth. The key remains in OneCLI and is
never written to the status receipt or printed by this script.
You do NOT need desktop access; run the check over SSH on the NanoClaw host.
The non-secret receipt is written to data/provider-auth-status.json.

OPTIONS
  --check              Validate the existing OpenRouter key through OneCLI.
  --api-key            Replace the key using hidden terminal input, then check it.
  --secret-id <ID>    Update this exact OneCLI secret instead of auto-selecting.
  -h, --help           Show this help.

EXAMPLES
  ./scripts/reauth-openrouter.sh --check
  ./scripts/reauth-openrouter.sh --api-key
  ./scripts/reauth-openrouter.sh --api-key --secret-id 1234
EOF
}

MODE="check"
SECRET_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --api-key) MODE="api"; shift ;;
    --secret-id)
      [ "$#" -ge 2 ] || reauth_die "--secret-id needs an ID"
      SECRET_ID="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) reauth_die "unknown argument '$1'. Run ./scripts/reauth-openrouter.sh -h" ;;
  esac
done

umask 077
reauth_require_command onecli
reauth_require_node
if ! onecli version >/dev/null 2>&1; then
  reauth_die "OneCLI is not responding. Start its gateway, then rerun this script."
fi

if [ "$MODE" = "api" ]; then
  printf 'Paste the OpenRouter API key (input hidden): '
  IFS= read -r -s API_KEY
  printf '\n'
  [ -n "${API_KEY:-}" ] || reauth_die "no API key was entered; nothing was changed"
  SELECTED_ID="$(reauth_select_secret_id openrouter "$SECRET_ID")"
  reauth_upsert_value_secret "$SELECTED_ID" "OpenRouter" "generic" "$API_KEY" "openrouter.ai"
  unset API_KEY
fi

PROBE_FILE="$(mktemp "${TMPDIR:-/tmp}/nanoclaw-openrouter.XXXXXX")"
chmod 600 "$PROBE_FILE"
cleanup() { rm -f "$PROBE_FILE"; }
trap cleanup EXIT HUP INT TERM

if ! onecli run curl -fsS --max-time 20 -o "$PROBE_FILE" "https://openrouter.ai/api/v1/models" >/dev/null 2>&1; then
  reauth_die "OpenRouter models request failed through OneCLI; the key was not confirmed"
fi

NOW="$(reauth_now)"
reauth_record_status "$PROJECT_ROOT" "openrouter" "OpenRouter OneCLI API-key connectivity check" "$NOW" "" "no-known-expiry" "OpenRouter API keys have no expiry recorded by this script; rotate them manually when needed."
echo "OpenRouter authentication check passed through OneCLI."
