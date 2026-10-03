#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

MODE=dry-run
RENDER_ROOT=
OPERATOR=nanoclaw
PUBLIC_KEY_FILE=
BOOTSTRAP_CIDR=
TIMEZONE=UTC
SWAP_GB=4

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--dry-run | --apply | --render-root DIR]
                    --public-key-file FILE --bootstrap-cidr ADDRESS/32
                    [--operator NAME] [--timezone ZONE] [--swap-gb 4]

Defaults to --dry-run. Apply mode is supported only as root on Ubuntu 24.04
x86_64. The bootstrap CIDR must name one trusted host (/32 or /128).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift ;;
    --apply) MODE=apply; shift ;;
    --render-root) [ "$#" -ge 2 ] || die "--render-root needs a directory"; MODE=render; RENDER_ROOT="$2"; shift 2 ;;
    --operator) [ "$#" -ge 2 ] || die "--operator needs a value"; OPERATOR="$2"; shift 2 ;;
    --public-key-file) [ "$#" -ge 2 ] || die "--public-key-file needs a path"; PUBLIC_KEY_FILE="$2"; shift 2 ;;
    --bootstrap-cidr) [ "$#" -ge 2 ] || die "--bootstrap-cidr needs a value"; BOOTSTRAP_CIDR="$2"; shift 2 ;;
    --timezone) [ "$#" -ge 2 ] || die "--timezone needs a value"; TIMEZONE="$2"; shift 2 ;;
    --swap-gb) [ "$#" -ge 2 ] || die "--swap-gb needs a value"; SWAP_GB="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

validate_operator "$OPERATOR"
[ -n "$PUBLIC_KEY_FILE" ] || die "--public-key-file is required"
[ -n "$BOOTSTRAP_CIDR" ] || die "--bootstrap-cidr is required"
validate_public_key "$PUBLIC_KEY_FILE"
validate_single_host_cidr "$BOOTSTRAP_CIDR"
validate_timezone "$TIMEZONE"
validate_swap_gb "$SWAP_GB"

print_plan() {
  local fingerprint
  fingerprint="$(ssh-keygen -l -f "$PUBLIC_KEY_FILE" | awk '{ print $2 }')"
  cat <<EOF
mode=dry-run
target=Ubuntu 24.04 LTS x86_64/amd64
operator=$OPERATOR
authorized_key_fingerprint=$fingerprint
bootstrap_cidr=$BOOTSTRAP_CIDR
timezone=$TIMEZONE
swap_gb=$SWAP_GB
docker_repository=https://download.docker.com/linux/ubuntu
docker_precondition=conflicting Docker packages removed before official install
tailscale_repository=https://pkgs.tailscale.com/stable/ubuntu/noble
security=key-only SSH; UFW deny inbound; Hetzner Cloud Firewall remains authoritative
staging=root SSH remains key-only until finalize.sh runs from a verified tailnet session
application_state=none; this step does not install or migrate NanoClaw, OneCLI, WhatsApp, or agent data
installed_tool_path=/usr/local/lib/nanoclaw-vps-hardening
EOF
}

if [ "$MODE" = dry-run ]; then
  print_plan
  exit 0
fi

if [ "$MODE" = render ]; then
  validate_render_root "$RENDER_ROOT"
  render_common_config "$RENDER_ROOT" "$OPERATOR" "$PUBLIC_KEY_FILE"
  write_managed_file "$RENDER_ROOT" /etc/ssh/sshd_config.d/60-nanoclaw-vps.conf 0644 \
    "$(ssh_bootstrap_config "$OPERATOR")
"
  render_bootstrap_state "$RENDER_ROOT" "$OPERATOR" "$BOOTSTRAP_CIDR" "$TIMEZONE" "$SWAP_GB"
  echo "rendered_root=$RENDER_ROOT"
  exit 0
fi

require_root
validate_ubuntu_host
export DEBIAN_FRONTEND=noninteractive

install -d -m 0755 /usr/local/lib/nanoclaw-vps-hardening
install -m 0644 "$SCRIPT_DIR/common.sh" /usr/local/lib/nanoclaw-vps-hardening/common.sh
install -m 0755 "$SCRIPT_DIR/bootstrap.sh" /usr/local/lib/nanoclaw-vps-hardening/bootstrap.sh
install -m 0755 "$SCRIPT_DIR/finalize.sh" /usr/local/lib/nanoclaw-vps-hardening/finalize.sh
install -m 0755 "$SCRIPT_DIR/audit.sh" /usr/local/lib/nanoclaw-vps-hardening/audit.sh

apt-get update
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg git jq rsync ufw unattended-upgrades openssh-server

if ! id "$OPERATOR" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$OPERATOR"
fi
usermod -aG sudo "$OPERATOR"
passwd -l "$OPERATOR" >/dev/null

render_common_config / "$OPERATOR" "$PUBLIC_KEY_FILE"
write_managed_file / /etc/ssh/sshd_config.d/60-nanoclaw-vps.conf 0644 \
  "$(ssh_bootstrap_config "$OPERATOR")
"
render_bootstrap_state / "$OPERATOR" "$BOOTSTRAP_CIDR" "$TIMEZONE" "$SWAP_GB"
visudo -cf /etc/sudoers.d/90-nanoclaw-operator >/dev/null
sshd -t
systemctl reload ssh.service

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF

install -m 0755 -d /usr/share/keyrings
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
  -o /etc/apt/sources.list.d/tailscale.list

CONFLICTING_DOCKER_PACKAGES=()
for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
  if dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null | grep -q '^ii'; then
    CONFLICTING_DOCKER_PACKAGES+=("$package")
  fi
done
if [ "${#CONFLICTING_DOCKER_PACKAGES[@]}" -gt 0 ]; then
  apt-get remove -y "${CONFLICTING_DOCKER_PACKAGES[@]}"
fi

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin tailscale
systemctl enable --now docker.service containerd.service tailscaled.service
usermod -aG docker "$OPERATOR"
systemctl restart docker.service

if [ ! -e /swapfile ]; then
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
elif ! file /swapfile | grep -q 'swap file'; then
  die "/swapfile exists but is not swap; refusing to overwrite it"
fi
swapon --show=NAME | grep -qx /swapfile || swapon /swapfile
grep -q '^/swapfile none swap sw 0 0$' /etc/fstab \
  || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
sysctl --system >/dev/null

timedatectl set-timezone "$TIMEZONE"
timedatectl set-ntp true
loginctl enable-linger "$OPERATOR"

ufw default deny incoming
ufw default allow outgoing
ufw allow from "$BOOTSTRAP_CIDR" to any port 22 proto tcp
ufw allow in on tailscale0 to any port 22 proto tcp
ufw --force enable

cat <<EOF
bootstrap=complete
operator=$OPERATOR
next_1=keep this root SSH session open
next_2=run: tailscale up
next_3=open a second terminal and SSH as $OPERATOR over the Tailscale IP or MagicDNS name
next_4=from that tailnet session run: sudo /usr/local/lib/nanoclaw-vps-hardening/finalize.sh --apply --operator $OPERATOR
note=fail2ban is intentionally omitted because public SSH is single-host during bootstrap and removed at finalization
EOF
