#!/usr/bin/env bash
# Print an absolute supported Node executable without assuming interactive shell
# startup has placed Node on PATH. This must remain shell-only: lifecycle
# recovery uses it precisely when Node-based tooling cannot start.
set -euo pipefail

node_is_supported() {
  local candidate="$1"
  local version major minor
  [ -x "$candidate" ] || return 1
  version="$("$candidate" --version 2>/dev/null)" || return 1
  [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  # better-sqlite3 and the host service are pinned to the Node 22 ABI. A newer
  # major may satisfy package.json's broad floor but is not a supported NanoClaw
  # runtime until the native dependency contract is deliberately upgraded.
  (( major == 22 && minor >= 19 ))
}

checked_candidates=()
describe_candidate() {
  local candidate="$1"
  local version
  if [ ! -x "$candidate" ]; then
    checked_candidates+=("$candidate=missing")
    return
  fi
  if version="$("$candidate" --version 2>/dev/null)"; then
    checked_candidates+=("$candidate=$version")
  else
    checked_candidates+=("$candidate=unreadable")
  fi
}

if command -v node >/dev/null 2>&1; then
  path_node="$(command -v node)"
  if node_is_supported "$path_node"; then
    printf '%s\n' "$path_node"
    exit 0
  fi
  describe_candidate "$path_node"
fi

shopt -s nullglob
# Tests can override this list to keep candidate resolution independent of the host.
if [[ -n "${NANOCLAW_NODE_FALLBACKS:-}" ]]; then
  IFS=: read -r -a candidates <<< "$NANOCLAW_NODE_FALLBACKS"
else
  candidates=(
    "$HOME/.local/bin/node"
    "$HOME"/.local/opt/node-v*/bin/node
    "$HOME"/.nvm/versions/node/v*/bin/node
    "$HOME/node/bin/node"
    "$HOME/.node/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
    /usr/bin/node
  )
fi

for candidate in "${candidates[@]}"; do
  [ "${candidate:-}" = "${path_node:-}" ] && continue
  if node_is_supported "$candidate"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
  describe_candidate "$candidate"
done

printf '%s\n' \
  'error: NanoClaw requires Node 22.19.0 through Node 22.x, but no supported executable was found.' \
  'Run ./nanoclaw.sh setup or install Node 22, then retry.' >&2
printf 'launchd PATH: %s\n' "${PATH:-<unset>}" >&2
printf 'checked Node candidates: %s\n' "${checked_candidates[*]:-none}" >&2
exit 1
