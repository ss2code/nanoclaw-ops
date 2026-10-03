#!/usr/bin/env bash

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_operator() {
  local operator="$1"
  [[ "$operator" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "invalid operator account: $operator"
  [ "$operator" != root ] || die "the operator account must not be root"
}

validate_public_key() {
  local key_file="$1"
  [ -f "$key_file" ] || die "public key file not found: $key_file"
  local key_type
  key_type="$(awk 'NR == 1 { print $1 }' "$key_file")"
  case "$key_type" in
    ssh-ed25519|sk-ssh-ed25519@openssh.com) ;;
    *) die "the operator key must be an Ed25519 public key" ;;
  esac
  ssh-keygen -l -f "$key_file" >/dev/null 2>&1 || die "invalid SSH public key: $key_file"
}

validate_single_host_cidr() {
  local cidr="$1" address prefix octet
  if [[ "$cidr" == *:* ]]; then
    [[ "$cidr" =~ ^[0-9A-Fa-f:]+/128$ ]] || die "bootstrap CIDR must identify one IPv6 host (/128)"
    return
  fi
  [[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]] \
    || die "bootstrap CIDR must identify one IPv4 host (/32)"
  address="${cidr%/32}"
  IFS=. read -r -a octets <<< "$address"
  for octet in "${octets[@]}"; do
    (( 10#$octet >= 0 && 10#$octet <= 255 )) || die "invalid bootstrap IPv4 address: $address"
  done
}

validate_timezone() {
  local timezone="$1"
  [[ "$timezone" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] || die "invalid timezone: $timezone"
  if [ -d /usr/share/zoneinfo ]; then
    [ -f "/usr/share/zoneinfo/$timezone" ] || die "unknown timezone: $timezone"
  fi
}

validate_swap_gb() {
  local swap_gb="$1"
  [[ "$swap_gb" =~ ^[0-9]+$ ]] || die "swap size must be an integer GiB value"
  (( swap_gb >= 4 && swap_gb <= 16 )) || die "swap size must be between 4 and 16 GiB"
}

validate_render_root() {
  local render_root="$1" resolved
  [ -n "$render_root" ] || die "render root is empty"
  mkdir -p "$render_root"
  resolved="$(cd "$render_root" && pwd -P)"
  [ "$resolved" != / ] || die "refusing to render into the live filesystem root"
}

validate_ubuntu_host() {
  [ -r /etc/os-release ] || die "cannot read /etc/os-release"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] \
    || die "apply mode requires Ubuntu 24.04 LTS"
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    amd64|x86_64) ;;
    *) die "apply mode requires an x86_64/amd64 host" ;;
  esac
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "--apply must be run as root"
}

root_path() {
  local root="$1" path="$2"
  if [ "$root" = / ]; then
    printf '%s\n' "$path"
  else
    printf '%s%s\n' "${root%/}" "$path"
  fi
}

write_managed_file() {
  local root="$1" path="$2" mode="$3" content="$4" owner="${5:-}"
  local target tmp
  target="$(root_path "$root" "$path")"
  mkdir -p "$(dirname "$target")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/nanoclaw-vps-file.XXXXXX")"
  printf '%s' "$content" > "$tmp"
  if [ ! -f "$target" ] || ! cmp -s "$tmp" "$target"; then
    install -m "$mode" "$tmp" "$target"
  else
    chmod "$mode" "$target"
  fi
  rm -f "$tmp"
  if [ "$root" = / ] && [ -n "$owner" ]; then
    chown "$owner" "$target"
  fi
}

ssh_bootstrap_config() {
  local operator="$1"
  cat <<EOF
# Managed by NanoClaw VPS hardening. Re-run finalize.sh from a verified
# tailnet SSH session to disable the temporary root key-recovery path.
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
PermitRootLogin prohibit-password
AllowUsers root $operator
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
PermitTunnel no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
DebianBanner no
EOF
}

ssh_final_config() {
  local operator="$1"
  cat <<EOF
# Managed by NanoClaw VPS hardening. Public SSH is blocked by UFW and the
# Hetzner Cloud Firewall; conventional key-only SSH is carried over Tailscale.
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
AllowUsers $operator
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
PermitTunnel no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
DebianBanner no
EOF
}

render_common_config() {
  local root="$1" operator="$2" key_file="$3"
  local key_content
  key_content="$(sed -n '1p' "$key_file")"

  write_managed_file "$root" "/home/$operator/.ssh/authorized_keys" 0600 "$key_content
" "$operator:$operator"
  if [ "$root" = / ]; then
    chmod 0700 "/home/$operator/.ssh"
    chown "$operator:$operator" "/home/$operator/.ssh"
  else
    chmod 0700 "$(root_path "$root" "/home/$operator/.ssh")"
  fi

  write_managed_file "$root" /etc/sudoers.d/90-nanoclaw-operator 0440 \
    "$operator ALL=(ALL:ALL) NOPASSWD: ALL
"
  write_managed_file "$root" /etc/apt/apt.conf.d/20auto-upgrades 0644 \
    'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
'
  write_managed_file "$root" /etc/apt/apt.conf.d/60nanoclaw-unattended-upgrades 0644 \
    'Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
'
  write_managed_file "$root" /etc/sysctl.d/60-nanoclaw-vps.conf 0644 \
    'vm.swappiness=10
vm.vfs_cache_pressure=50
'
  write_managed_file "$root" /etc/docker/daemon.json 0644 \
    '{
  "log-driver": "local",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
'
}

render_bootstrap_state() {
  local root="$1" operator="$2" bootstrap_cidr="$3" timezone="$4" swap_gb="$5"
  write_managed_file "$root" /var/lib/nanoclaw-vps-hardening/bootstrap.env 0600 \
    "OPERATOR=$operator
BOOTSTRAP_CIDR=$bootstrap_cidr
TIMEZONE=$timezone
SWAP_GB=$swap_gb
"
}
