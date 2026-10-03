#!/bin/bash
# Remove the wake-cycler LaunchDaemon. Run with sudo:
#   sudo bash scripts/wake-cycler/uninstall.sh
set -eu

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

LABEL="com.nanoclaw.wakecycler"
PLIST="/Library/LaunchDaemons/$LABEL.plist"

launchctl bootout "system/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "removed $LABEL. Stats log (logs/wake-cycler.jsonl) kept."
echo "Note: any already-armed pmset wake will fire once more, harmlessly."
