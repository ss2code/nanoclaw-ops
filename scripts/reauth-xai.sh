#!/usr/bin/env bash
set -euo pipefail

# Refresh the xAI/SuperGrok OAuth credential used by the Pi-backed grok agent
# group. Unlike Claude and Codex, this credential is owned by Pi, not stored as
# a OneCLI secret.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
export NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT"
# shellcheck source=scripts/reauth-common.sh
source "$SCRIPT_DIR/reauth-common.sh"
# shellcheck source=setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"

print_help() {
  cat <<'EOF'
reauth-xai.sh — refresh NanoClaw's Pi/SuperGrok OAuth credential over SSH

WHY THIS SCRIPT EXISTS
  NanoClaw's grok agent uses Pi's native xAI provider. Pi owns the refreshable
  OAuth credential in the group's private ~/.pi/agent state directory. OneCLI
  does not currently have an xAI OAuth provider, so this script does NOT create
  a OneCLI secret and never copies auth.json into OneCLI.

REMOTE / HEADLESS WORKFLOW
  You do NOT need desktop access on the remote machine.
  Run this script on the remote machine that runs NanoClaw:
    1. SSH to that machine and run this script from the NanoClaw checkout.
    2. Enter /login xai in Pi and open the xAI device URL in a browser on any machine.
    3. Enter the one-time code shown in the SSH terminal.
    4. Exit the Pi prompt after login and wait for this script to confirm that Pi saved the credential.

  The browser location does not determine where the credential is saved. The
  credential is written on the machine running this script, which is why the
  script must run on the remote NanoClaw host.

GROUP SELECTION
  With no group option, the script finds the one agent group named "grok" (or
  whose folder is "grok") in data/v2.db. If the name is ambiguous, it stops.
  Use --group-id to select the exact agent group safely.

OPS CENTER EXPIRY DISPLAY
  After a successful refresh, the script writes only a timestamp, method label,
  and provider-managed expiry note to data/provider-auth-status.json. The OAuth
  credential itself remains in the grok group's private Pi state directory.

OPTIONS
  --group-id <ID>
      Use this exact agent-group ID instead of resolving the grok group.
  --group-name <NAME>
      Resolve this agent-group name/folder instead of "grok".
  --image <IMAGE>
      Use a specific NanoClaw agent image instead of this checkout's default.
  --runtime <RUNTIME>
      Use a specific container runtime command instead of docker.
  -h, --help
      Show this help and exit without changing anything.

EXAMPLES
  ./scripts/reauth-xai.sh
  ./scripts/reauth-xai.sh --group-id 6d243c8d-111b-4c3d-9364-53691af9b696
  ./scripts/reauth-xai.sh --group-name grok --image nanoclaw-agent:latest

REQUIREMENTS
  Run from the NanoClaw checkout on the remote host. The host must have:
    - docker (or the runtime supplied with --runtime)
    - Node 22.19+ and the checkout's better-sqlite3 dependency
    - the NanoClaw agent image containing Pi
    - a real interactive SSH terminal for the device-code prompts

This script does not restart NanoClaw. Pi reads its saved credential on the next
request; retry the failed operation after the success message. Authentication
does not require a session reset.
EOF
}

GROUP_ID=""
GROUP_NAME="grok"
IMAGE="${CONTAINER_IMAGE:-}"
RUNTIME="${CONTAINER_RUNTIME:-docker}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --group-id)
      [ "$#" -ge 2 ] || reauth_die "--group-id needs an ID. Run -h for examples."
      GROUP_ID="$2"
      shift 2
      ;;
    --group-name)
      [ "$#" -ge 2 ] || reauth_die "--group-name needs a name. Run -h for examples."
      GROUP_NAME="$2"
      shift 2
      ;;
    --image)
      [ "$#" -ge 2 ] || reauth_die "--image needs an image reference. Run -h for examples."
      IMAGE="$2"
      shift 2
      ;;
    --runtime)
      [ "$#" -ge 2 ] || reauth_die "--runtime needs a command. Run -h for examples."
      RUNTIME="$2"
      shift 2
      ;;
    -h|--help) print_help; exit 0 ;;
    *) reauth_die "unknown argument '$1'. Run ./scripts/reauth-xai.sh -h" ;;
  esac
done

umask 077
reauth_require_command "$RUNTIME"
reauth_require_node

cd "$PROJECT_ROOT"
if [ -z "$IMAGE" ]; then
  IMAGE="$(container_image_base):latest"
fi

if [ -z "$GROUP_ID" ]; then
  [ -s "$PROJECT_ROOT/data/v2.db" ] || reauth_die "central DB not found at $PROJECT_ROOT/data/v2.db"
  GROUP_ID="$(reauth_node - "$PROJECT_ROOT/data/v2.db" "$GROUP_NAME" <<'NODE'
const Database = require('better-sqlite3');

const [dbPath, groupName] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db
  .prepare('SELECT id FROM agent_groups WHERE name = ? OR folder = ? ORDER BY id')
  .all(groupName, groupName);
if (rows.length !== 1) {
  console.error(`expected exactly one agent group named/foldered ${groupName}, found ${rows.length}`);
  db.close();
  process.exit(2);
}
process.stdout.write(String(rows[0].id));
db.close();
NODE
  )" || reauth_die "could not resolve agent group '$GROUP_NAME'"
fi

case "$GROUP_ID" in
  ""|*[!a-zA-Z0-9_-]*) reauth_die "invalid agent-group ID '$GROUP_ID'" ;;
esac

PI_DIR="$PROJECT_ROOT/data/v2-sessions/$GROUP_ID/.pi-shared"
AUTH_FILE="$PI_DIR/auth.json"
mkdir -p "$PI_DIR"
chmod 700 "$PI_DIR"

"$RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1 \
  || reauth_die "agent image '$IMAGE' is not available on this host; build/deploy NanoClaw there first"

cat <<EOF
Starting Pi's xAI subscription login on this host.

At the Pi prompt, enter /login xai. Open the device URL printed by Pi in a
browser on any machine, enter the one-time code, then exit Pi. The credential
will be saved on this host at:
  $AUTH_FILE

EOF

if ! "$RUNTIME" run --rm -it \
  --volume "$PI_DIR:/home/node/.pi/agent" \
  --entrypoint pi "$IMAGE"; then
  reauth_die "Pi xAI login did not complete; no Ops Center receipt was written."
fi

[ -s "$AUTH_FILE" ] || reauth_die "Pi reported success but did not create auth.json"
chmod 600 "$AUTH_FILE" || reauth_die "could not restrict auth.json permissions"

NOW="$(reauth_now)"
reauth_record_status "$PROJECT_ROOT" "xai" "Pi xAI SuperGrok subscription OAuth" "$NOW" "" "provider-managed" "Pi owns and refreshes this OAuth credential in the selected group's private .pi-shared state."
echo "Pi xAI/SuperGrok authentication refresh complete for agent group $GROUP_ID. Retry NanoClaw now."
