#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"
TSX="$REPO/node_modules/tsx/dist/cli.mjs"

[ -n "$NODE" ] || { echo "error: node not found on PATH" >&2; exit 1; }
[ -f "$TSX" ] || { echo "error: tsx not found at $TSX — run pnpm install first" >&2; exit 1; }

exec "$NODE" "$TSX" "$REPO/ops-center/install-service.ts" "$@"
