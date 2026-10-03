#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$ROOT/node_modules/tsx/dist/cli.mjs"
ENTRY="$ROOT/templates/education/knowledge-graph-tutor/ops-center/index.ts"
STATE_DIR="$ROOT/data/knowledge-graph-tutor-console"
PID_FILE="$STATE_DIR/console.pid"
LOG_FILE="$ROOT/logs/knowledge-graph-tutor-console.log"
PORT="${TUTOR_CONSOLE_PORT:-10335}"

resolve_tutor_node() {
  local candidate version
  candidate="$($ROOT/scripts/resolve-node.sh)"
  version="$($candidate --version 2>/dev/null || true)"
  if [[ "$version" =~ ^v22\.([0-9]+)\. ]] && (( BASH_REMATCH[1] >= 19 )); then
    printf '%s\n' "$candidate"
    return
  fi
  shopt -s nullglob
  for candidate in "$HOME"/.nvm/versions/node/v22*/bin/node "$HOME"/.local/opt/node-v22*/bin/node; do
    version="$($candidate --version 2>/dev/null || true)"
    if [[ "$version" =~ ^v22\.([0-9]+)\. ]] && (( BASH_REMATCH[1] >= 19 )); then
      printf '%s\n' "$candidate"
      return
    fi
  done
  echo "error: Tutor Foundry requires Node 22.19 or newer within the Node 22 line" >&2
  exit 1
}

NODE="$(resolve_tutor_node)"

mkdir -p "$STATE_DIR" "$ROOT/logs"

running_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(tr -cd '0-9' < "$PID_FILE")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      printf '%s' "$pid"
      return 0
    fi
    rm -f "$PID_FILE"
  fi
  return 1
}

start_console() {
  local pid
  if pid="$(running_pid)"; then
    echo "Tutor Foundry is already running (pid $pid) at http://127.0.0.1:$PORT"
  else
    cd "$ROOT"
    TUTOR_CONSOLE_PORT="$PORT" nohup "$NODE" "$TSX" "$ENTRY" >> "$LOG_FILE" 2>&1 &
    pid=$!
    printf '%s\n' "$pid" > "$PID_FILE"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
        echo "Tutor Foundry started at http://127.0.0.1:$PORT"
        if [ "${1:-}" != "--no-open" ]; then
          if [ "$(uname -s)" = "Darwin" ]; then open "http://127.0.0.1:$PORT"; fi
        fi
        return
      fi
      sleep 0.4
    done
    echo "Tutor Foundry did not become ready. Inspect $LOG_FILE" >&2
    return 1
  fi
}

stop_console() {
  local pid
  if ! pid="$(running_pid)"; then
    echo "Tutor Foundry is not running"
    return
  fi
  kill "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  rm -f "$PID_FILE"
  echo "Tutor Foundry stopped. Tutor classes were not changed."
}

case "${1:-start}" in
  start) start_console "${2:-}" ;;
  foreground)
    cd "$ROOT"
    exec env TUTOR_CONSOLE_PORT="$PORT" "$NODE" "$TSX" "$ENTRY"
    ;;
  stop) stop_console ;;
  restart) stop_console; start_console "${2:-}" ;;
  status)
    if pid="$(running_pid)"; then
      echo "running pid=$pid url=http://127.0.0.1:$PORT log=$LOG_FILE"
    else
      echo "stopped url=http://127.0.0.1:$PORT log=$LOG_FILE"
      exit 1
    fi
    ;;
  *) echo "usage: $0 [start [--no-open]|foreground|stop|restart [--no-open]|status]" >&2; exit 64 ;;
esac
