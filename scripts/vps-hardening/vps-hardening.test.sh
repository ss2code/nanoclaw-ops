#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP="$SCRIPT_DIR/bootstrap.sh"
FINALIZE="$SCRIPT_DIR/finalize.sh"
AUDIT="$SCRIPT_DIR/audit.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nanoclaw-vps-hardening-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

for script in "$BOOTSTRAP" "$FINALIZE" "$AUDIT"; do
  [ -x "$script" ] || fail "missing executable: $script"
  bash -n "$script" || fail "shell syntax: $script"
done

ssh-keygen -q -t ed25519 -N '' -f "$TMP_DIR/operator-key"
PUBLIC_KEY="$TMP_DIR/operator-key.pub"

DRY_RUN="$($BOOTSTRAP \
  --operator nanoclaw \
  --public-key-file "$PUBLIC_KEY" \
  --bootstrap-cidr 198.51.100.10/32 \
  --timezone UTC \
  --swap-gb 4)"
assert_contains "$DRY_RUN" "mode=dry-run" "bootstrap defaults to dry-run"
assert_contains "$DRY_RUN" "operator=nanoclaw" "dry-run records operator"
assert_contains "$DRY_RUN" "bootstrap_cidr=198.51.100.10/32" "dry-run records narrow source"
assert_contains "$DRY_RUN" "swap_gb=4" "dry-run records swap"
assert_contains "$DRY_RUN" "download.docker.com/linux/ubuntu" "uses Docker's official repository"
assert_contains "$DRY_RUN" "conflicting Docker packages removed before official install" "Docker repository precondition is explicit"
assert_contains "$DRY_RUN" "pkgs.tailscale.com/stable/ubuntu/noble" "uses Tailscale's Noble repository"
assert_contains "$DRY_RUN" "root SSH remains key-only until finalize.sh" "lockout-safe staging is explicit"
assert_contains "$DRY_RUN" "installed_tool_path=/usr/local/lib/nanoclaw-vps-hardening" "operator-reachable tool path is explicit"

if "$BOOTSTRAP" --operator root --public-key-file "$PUBLIC_KEY" \
  --bootstrap-cidr 198.51.100.10/32 >/dev/null 2>&1; then
  fail "bootstrap accepted root as the operator"
fi

if "$BOOTSTRAP" --operator nanoclaw --public-key-file "$PUBLIC_KEY" \
  --bootstrap-cidr 0.0.0.0/0 >/dev/null 2>&1; then
  fail "bootstrap accepted a world-open SSH source"
fi

RENDER_ROOT="$TMP_DIR/render-root"
"$BOOTSTRAP" \
  --render-root "$RENDER_ROOT" \
  --operator nanoclaw \
  --public-key-file "$PUBLIC_KEY" \
  --bootstrap-cidr 198.51.100.10/32 \
  --timezone UTC \
  --swap-gb 4 >/dev/null

SSH_CONFIG="$RENDER_ROOT/etc/ssh/sshd_config.d/60-nanoclaw-vps.conf"
AUTHORIZED_KEYS="$RENDER_ROOT/home/nanoclaw/.ssh/authorized_keys" # Generic target account. pii-lint-allow
AUTO_UPGRADES="$RENDER_ROOT/etc/apt/apt.conf.d/20auto-upgrades"
SYSCTL="$RENDER_ROOT/etc/sysctl.d/60-nanoclaw-vps.conf"
DOCKER_CONFIG="$RENDER_ROOT/etc/docker/daemon.json"
SUDOERS="$RENDER_ROOT/etc/sudoers.d/90-nanoclaw-operator"

grep -q '^PermitRootLogin prohibit-password$' "$SSH_CONFIG" || fail "bootstrap must preserve root key recovery"
grep -q '^PasswordAuthentication no$' "$SSH_CONFIG" || fail "password SSH must be disabled"
grep -q '^KbdInteractiveAuthentication no$' "$SSH_CONFIG" || fail "interactive SSH auth must be disabled"
grep -q '^AllowUsers root nanoclaw$' "$SSH_CONFIG" || fail "bootstrap allow-list is wrong"
cmp -s "$PUBLIC_KEY" "$AUTHORIZED_KEYS" || fail "rendered authorized key differs"
grep -q 'Unattended-Upgrade "1"' "$AUTO_UPGRADES" || fail "daily unattended upgrades missing"
grep -q '^vm.swappiness=10$' "$SYSCTL" || fail "conservative swappiness missing"
grep -q '"log-driver": "local"' "$DOCKER_CONFIG" || fail "bounded Docker logging missing"
grep -q '^nanoclaw ALL=(ALL:ALL) NOPASSWD: ALL$' "$SUDOERS" || fail "operator sudo policy missing"

first_hashes="$(find "$RENDER_ROOT" -type f -print0 | sort -z | xargs -0 shasum -a 256)"
"$BOOTSTRAP" \
  --render-root "$RENDER_ROOT" \
  --operator nanoclaw \
  --public-key-file "$PUBLIC_KEY" \
  --bootstrap-cidr 198.51.100.10/32 \
  --timezone UTC \
  --swap-gb 4 >/dev/null
second_hashes="$(find "$RENDER_ROOT" -type f -print0 | sort -z | xargs -0 shasum -a 256)"
[ "$first_hashes" = "$second_hashes" ] || fail "config rendering is not idempotent"

"$FINALIZE" --render-root "$RENDER_ROOT" --operator nanoclaw >/dev/null
grep -q '^PermitRootLogin no$' "$SSH_CONFIG" || fail "finalize must disable root SSH"
grep -q '^AllowUsers nanoclaw$' "$SSH_CONFIG" || fail "final SSH allow-list is wrong"
if grep -q 'prohibit-password' "$SSH_CONFIG"; then
  fail "final SSH config retained bootstrap root access"
fi

CHECKS="$($AUDIT --list-checks --operator nanoclaw)"
for check in \
  ubuntu-24.04 amd64 operator-access ssh-key-only root-ssh-disabled \
  unattended-upgrades docker-service docker-operator docker-no-published-ports \
  tailscale-connected ufw-tailnet-only swap-4g swappiness time-sync disk-headroom \
  public-listeners public-udp-listeners docker-api-closed reboot-clear; do
  assert_contains "$CHECKS" "$check" "audit registry"
done

echo "VPS hardening tests: PASS"
