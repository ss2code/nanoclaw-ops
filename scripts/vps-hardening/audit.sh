#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

OPERATOR=nanoclaw
LIST_CHECKS=0
FORMAT=text

CHECK_IDS=(
  ubuntu-24.04 amd64 operator-access ssh-key-only root-ssh-disabled
  unattended-upgrades docker-service docker-operator docker-no-published-ports
  tailscale-connected ufw-tailnet-only swap-4g swappiness time-sync disk-headroom
  public-listeners public-udp-listeners docker-api-closed reboot-clear
)

usage() {
  cat <<'EOF'
Usage: audit.sh [--operator NAME] [--format text|jsonl] [--list-checks]

Run the live audit as root after finalization. Exit 0 means every mandatory
Step 2 host check passed. Hetzner Cloud Firewall state is verified separately
from the provider console because it is outside the guest OS.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --operator) [ "$#" -ge 2 ] || die "--operator needs a value"; OPERATOR="$2"; shift 2 ;;
    --format) [ "$#" -ge 2 ] || die "--format needs a value"; FORMAT="$2"; shift 2 ;;
    --list-checks) LIST_CHECKS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_operator "$OPERATOR"
case "$FORMAT" in text|jsonl) ;; *) die "format must be text or jsonl" ;; esac

if [ "$LIST_CHECKS" -eq 1 ]; then
  printf '%s\n' "${CHECK_IDS[@]}"
  exit 0
fi

require_root
validate_ubuntu_host
FAILURES=0

record() {
  local status="$1" id="$2" detail="$3"
  detail="${detail//$'\n'/; }"
  detail="${detail//$'\t'/ }"
  if [ "$FORMAT" = jsonl ]; then
    jq -nc --arg status "$status" --arg id "$id" --arg detail "$detail" \
      '{status:$status,id:$id,detail:$detail}'
  else
    printf '%-4s %-28s %s\n' "$status" "$id" "$detail"
  fi
  [ "$status" = PASS ] || FAILURES=$((FAILURES + 1))
}

# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ]; then
  record PASS ubuntu-24.04 "Ubuntu $VERSION_ID"
else
  record FAIL ubuntu-24.04 "found ${ID:-unknown} ${VERSION_ID:-unknown}"
fi

ARCH="$(dpkg --print-architecture)"
[ "$ARCH" = amd64 ] && record PASS amd64 "$ARCH" || record FAIL amd64 "$ARCH"

if id "$OPERATOR" >/dev/null 2>&1 \
  && id -nG "$OPERATOR" | tr ' ' '\n' | grep -qx sudo \
  && runuser -u "$OPERATOR" -- sudo -n true; then
  record PASS operator-access "$OPERATOR has non-interactive sudo"
else
  record FAIL operator-access "$OPERATOR account or sudo access is incomplete"
fi

SSHD_EFFECTIVE="$(sshd -T 2>/dev/null || true)"
if grep -q '^passwordauthentication no$' <<< "$SSHD_EFFECTIVE" \
  && grep -q '^kbdinteractiveauthentication no$' <<< "$SSHD_EFFECTIVE"; then
  record PASS ssh-key-only "password and keyboard-interactive authentication disabled"
else
  record FAIL ssh-key-only "effective sshd policy still permits non-key authentication"
fi
if grep -q '^permitrootlogin no$' <<< "$SSHD_EFFECTIVE"; then
  record PASS root-ssh-disabled "PermitRootLogin no"
else
  record FAIL root-ssh-disabled "effective PermitRootLogin is not no"
fi

if grep -q 'APT::Periodic::Unattended-Upgrade "1";' /etc/apt/apt.conf.d/20auto-upgrades \
  && systemctl is-enabled apt-daily-upgrade.timer >/dev/null 2>&1; then
  record PASS unattended-upgrades "daily timer enabled"
else
  record FAIL unattended-upgrades "daily unattended security updates not enabled"
fi

if systemctl is-active docker.service >/dev/null 2>&1 \
  && systemctl is-enabled docker.service >/dev/null 2>&1; then
  record PASS docker-service "$(docker --version)"
else
  record FAIL docker-service "Docker service not active and enabled"
fi
if id -nG "$OPERATOR" | tr ' ' '\n' | grep -qx docker \
  && runuser -u "$OPERATOR" -- docker info >/dev/null 2>&1; then
  record PASS docker-operator "$OPERATOR can access Docker"
else
  record FAIL docker-operator "$OPERATOR cannot access Docker"
fi

PUBLISHED="$(docker ps --format '{{.ID}} {{.Ports}}' 2>/dev/null | grep -- '->' || true)"
if [ -z "$PUBLISHED" ]; then
  record PASS docker-no-published-ports "no host-published container ports"
else
  record FAIL docker-no-published-ports "$PUBLISHED"
fi

if tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null; then
  record PASS tailscale-connected "$(tailscale ip -4 | head -1)"
else
  record FAIL tailscale-connected "Tailscale backend is not Running"
fi

UFW_STATUS="$(ufw status 2>/dev/null || true)"
UFW_BAD_RULES="$(awk '/ALLOW IN/ && ($0 !~ /22\/tcp( \(v6\))? on tailscale0/) { print }' <<< "$UFW_STATUS")"
if grep -q '^Status: active$' <<< "$UFW_STATUS" \
  && grep -Eq '22/tcp( \(v6\))? on tailscale0.*ALLOW IN' <<< "$UFW_STATUS" \
  && [ -z "$UFW_BAD_RULES" ]; then
  record PASS ufw-tailnet-only "only tailnet SSH is allowed inbound"
else
  record FAIL ufw-tailnet-only "unexpected UFW inbound policy: ${UFW_BAD_RULES:-tailnet rule absent}"
fi

SWAP_BYTES="$(swapon --show=SIZE --bytes --noheadings | awk '{ total += $1 } END { print total + 0 }')"
if (( SWAP_BYTES >= 4294967296 )); then
  record PASS swap-4g "$SWAP_BYTES bytes"
else
  record FAIL swap-4g "$SWAP_BYTES bytes"
fi

SWAPPINESS="$(sysctl -n vm.swappiness)"
if (( SWAPPINESS <= 10 )); then
  record PASS swappiness "$SWAPPINESS"
else
  record FAIL swappiness "$SWAPPINESS"
fi

if timedatectl show -p NTPSynchronized --value | grep -qx yes; then
  record PASS time-sync "$(timedatectl show -p Timezone --value), NTP synchronized"
else
  record FAIL time-sync "NTP is not synchronized"
fi

DISK_PERCENT="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if (( DISK_PERCENT < 20 )); then
  record PASS disk-headroom "$DISK_PERCENT% used"
else
  record FAIL disk-headroom "$DISK_PERCENT% used; Step 2 ceiling is below 20%"
fi

PUBLIC_TCP="$(ss -H -lnt | awk '$4 ~ /^0\.0\.0\.0:/ || $4 ~ /^\[::\]:/ || $4 ~ /^\*:/ { print $4 }')"
UNEXPECTED_TCP="$(awk -F: '$NF != 22 { print }' <<< "$PUBLIC_TCP")"
if [ -z "$UNEXPECTED_TCP" ]; then
  record PASS public-listeners "only SSH may bind wildcard TCP; UFW restricts it to tailscale0"
else
  record FAIL public-listeners "$UNEXPECTED_TCP"
fi
PUBLIC_UDP="$(ss -H -lnu | awk '$4 ~ /^0\.0\.0\.0:/ || $4 ~ /^\[::\]:/ || $4 ~ /^\*:/ { print $4 }')"
UNEXPECTED_UDP="$(awk -F: '$NF != 41641 { print }' <<< "$PUBLIC_UDP")"
if [ -z "$UNEXPECTED_UDP" ]; then
  record PASS public-udp-listeners "only Tailscale UDP/41641 may bind wildcard UDP"
else
  record FAIL public-udp-listeners "$UNEXPECTED_UDP"
fi
if ss -H -lnt | awk '{ print $4 }' | grep -Eq ':(2375|2376)$'; then
  record FAIL docker-api-closed "Docker TCP API is listening"
else
  record PASS docker-api-closed "no Docker TCP API listener"
fi

if [ -e /var/run/reboot-required ]; then
  record FAIL reboot-clear "security updates require a reboot"
else
  record PASS reboot-clear "no pending reboot"
fi

if [ "$FORMAT" = jsonl ]; then
  jq -nc --arg status "$([ "$FAILURES" -eq 0 ] && echo PASS || echo FAIL)" \
    --argjson failures "$FAILURES" '{status:$status,id:"summary",failures:$failures}'
else
  printf '\nStep 2 host audit: %s (%d failure(s))\n' \
    "$([ "$FAILURES" -eq 0 ] && echo PASS || echo FAIL)" "$FAILURES"
fi
exit "$([ "$FAILURES" -eq 0 ] && echo 0 || echo 1)"
