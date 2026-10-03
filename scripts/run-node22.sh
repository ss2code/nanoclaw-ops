#!/usr/bin/env bash
# Execute a host-side Node tool with NanoClaw's supported Node 22 runtime.
# This keeps pnpm scripts safe when the interactive shell currently exposes a
# newer Node whose native-module ABI does not match better-sqlite3.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_PATH" != /* ]]; then
  SCRIPT_PATH="$PWD/$SCRIPT_PATH"
fi
SCRIPT_DIR="${SCRIPT_PATH%/*}"
PROJECT_ROOT="${SCRIPT_DIR%/*}"
NODE="$(/bin/bash "$PROJECT_ROOT/scripts/resolve-node.sh")"

exec "$NODE" "$@"
