# NanoClaw VPS hardening

This directory prepares an empty Ubuntu 24.04 x86_64 Hetzner host for a later
v2-to-v2 NanoClaw migration. It does **not** install NanoClaw, initialize a new
fleet, pair WhatsApp, or copy any application state.

The workflow is deliberately staged to prevent SSH lockout:

1. `bootstrap.sh` creates the non-root operator, installs Docker and Tailscale,
   adds 4 GiB swap, enables automatic security updates, and enables UFW. Root
   remains available by SSH key only during this phase.
2. The operator authenticates Tailscale and opens a second SSH session through
   the tailnet.
3. `finalize.sh` verifies that the current SSH client is a Tailscale identity,
   then disables root SSH and removes the temporary public SSH rule from UFW.
4. `audit.sh` proves the guest-side acceptance card. The Hetzner Cloud Firewall
   is checked separately in the provider console.

Bootstrap installs an operator-readable copy of the tools at
`/usr/local/lib/nanoclaw-vps-hardening/`. If the audit reports a pending reboot,
reboot, prove a new tailnet SSH login, and run the audit again.

All mutation scripts default to dry-run. Applying requires an explicit
`--apply`. See `docs/local/vps-deployment.html` for the complete operator guide,
provider-console settings, rollback path, Definition of Done, and migration
sequence.
