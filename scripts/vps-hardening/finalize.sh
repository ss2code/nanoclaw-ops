#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

MODE=dry-run
RENDER_ROOT=
OPERATOR=nanoclaw
BOOTSTRAP_CIDR=

usage() {
  cat <<'EOF'
Usage: finalize.sh [--dry-run | --apply | --render-root DIR]
                   [--operator NAME] [--bootstrap-cidr ADDRESS/32]

Apply mode refuses to run unless the current SSH client is verified by
`tailscale whois`. It then disables root SSH and removes the temporary public
bootstrap rule from UFW.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --apply) MODE=apply; shift ;;
    --render-root) [ "$#" -ge 2 ] || die "--render-root needs a directory"; MODE=render; RENDER_ROOT="$2"; shift 2 ;;
    --operator) [ "$#" -ge 2 ] || die "--operator needs a value"; OPERATOR="$2"; shift 2 ;;
    --bootstrap-cidr) [ "$#" -ge 2 ] || die "--bootstrap-cidr needs a value"; BOOTSTRAP_CIDR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_operator "$OPERATOR"

load_state() {
  local root="$1" state
  state="$(root_path "$root" /var/lib/nanoclaw-vps-hardening/bootstrap.env)"
  [ -r "$state" ] || return 0
  local saved_operator saved_cidr
  saved_operator="$(sed -n 's/^OPERATOR=//p' "$state")"
  saved_cidr="$(sed -n 's/^BOOTSTRAP_CIDR=//p' "$state")"
  [ -z "$saved_operator" ] || [ "$saved_operator" = "$OPERATOR" ] \
    || die "operator does not match bootstrap state"
  [ -n "$BOOTSTRAP_CIDR" ] || BOOTSTRAP_CIDR="$saved_cidr"
}

if [ "$MODE" = render ]; then
  validate_render_root "$RENDER_ROOT"
  load_state "$RENDER_ROOT"
  write_managed_file "$RENDER_ROOT" /etc/ssh/sshd_config.d/60-nanoclaw-vps.conf 0644 \
    "$(ssh_final_config "$OPERATOR")
"
  echo "rendered_root=$RENDER_ROOT"
  exit 0
fi

load_state /
[ -n "$BOOTSTRAP_CIDR" ] || die "bootstrap CIDR missing; pass --bootstrap-cidr"
validate_single_host_cidr "$BOOTSTRAP_CIDR"

if [ "$MODE" = dry-run ]; then
  cat <<EOF
mode=dry-run
operator=$OPERATOR
bootstrap_cidr=$BOOTSTRAP_CIDR
precondition=current SSH client must pass tailscale whois
action=disable root SSH; keep key-only $OPERATOR SSH; remove temporary UFW public SSH rule
EOF
  exit 0
fi

require_root
validate_ubuntu_host
require_command tailscale
REMOTE_IP="${SSH_CONNECTION%% *}"
[ -n "$REMOTE_IP" ] || die "SSH_CONNECTION is absent; run finalization from the second tailnet SSH session"
tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null \
  || die "Tailscale is not connected"
tailscale whois "$REMOTE_IP" >/dev/null 2>&1 \
  || die "current SSH client $REMOTE_IP is not a verified tailnet identity"

id "$OPERATOR" >/dev/null 2>&1 || die "operator account does not exist: $OPERATOR"
runuser -u "$OPERATOR" -- sudo -n true \
  || die "operator passwordless sudo is not working"
runuser -u "$OPERATOR" -- docker info >/dev/null \
  || die "operator Docker access is not working"

write_managed_file / /etc/ssh/sshd_config.d/60-nanoclaw-vps.conf 0644 \
  "$(ssh_final_config "$OPERATOR")
"
sshd -t
systemctl reload ssh.service

ufw --force delete allow from "$BOOTSTRAP_CIDR" to any port 22 proto tcp >/dev/null
touch /var/lib/nanoclaw-vps-hardening/finalized
chmod 0600 /var/lib/nanoclaw-vps-hardening/finalized

cat <<EOF
finalize=complete
verified_tailnet_client=$REMOTE_IP
root_ssh=disabled
public_ufw_ssh=removed
next_1=keep both existing sessions open while audit.sh runs
next_2=remove the temporary TCP/22 inbound rule from the Hetzner Cloud Firewall
next_3=prove a new $OPERATOR tailnet SSH session still opens
EOF
