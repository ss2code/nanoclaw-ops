#!/bin/bash
# Install the wake-cycler LaunchDaemon. Run with sudo:
#   sudo bash scripts/wake-cycler/install.sh
set -eu

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.nanoclaw.wakecycler"
PLIST="/Library/LaunchDaemons/$LABEL.plist"

mkdir -p "$REPO/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO/scripts/wake-cycler/wake-cycler.sh</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$REPO/logs/wake-cycler.out.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO/logs/wake-cycler.error.log</string>
</dict>
</plist>
EOF

chown root:wheel "$PLIST"
chmod 644 "$PLIST"

launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"

echo "installed + started: $LABEL"
launchctl print "system/$LABEL" | grep -E "state|pid" | head -3
echo
echo "check anytime with: bash $REPO/scripts/wake-cycler/wake-cycler.sh status"
