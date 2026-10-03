#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
  echo "wake-cycler reconciliation tests require macOS date semantics; skipped"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wake-cycler-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

SCHED_FILE="$TMP_DIR/sched"
OPS_FILE="$TMP_DIR/ops"
NOW_EPOCH=1700000000
export SCHED_FILE OPS_FILE WAKE_CYCLER_NOW_EPOCH=$NOW_EPOCH

fake_pmset() {
  if [ "${1:-}" = -g ] && [ "${2:-}" = sched ]; then
    cat "$SCHED_FILE"
    return 0
  fi

  if [ "${1:-}" = schedule ] && [ "${2:-}" = cancel ]; then
    printf 'cancel|%s|%s|%s\n' "$3" "$4" "$5" >> "$OPS_FILE"
    local display_date
    display_date=$(date -j -f '%m/%d/%y %H:%M:%S' "$4" '+%m/%d/%Y %H:%M:%S')
    local needle="$3 at $display_date by '$5'"
    grep -vF "$needle" "$SCHED_FILE" > "$SCHED_FILE.tmp" || true
    mv "$SCHED_FILE.tmp" "$SCHED_FILE"
    return 0
  fi

  if [ "${1:-}" = schedule ] && { [ "${2:-}" = wake ] || [ "${2:-}" = wakeorpoweron ]; }; then
    printf '%s|%s|%s\n' "$2" "$3" "$4" >> "$OPS_FILE"
    printf " [new] %s at %s by '%s'\n" "$2" "$3" "$4" >> "$SCHED_FILE"
    return 0
  fi

  if [ "${1:-}" = -g ] && [ "${2:-}" = batt ]; then
    echo "Now drawing from 'AC Power'"
    return 0
  fi

  return 0
}
export -f fake_pmset

PMSET_BIN=fake_pmset
export PMSET_BIN
WAKE_CYCLER_SOURCE_ONLY=1
export WAKE_CYCLER_SOURCE_ONLY
# shellcheck source=/dev/null
source "$SCRIPT_DIR/wake-cycler.sh"

# Never let the operator's live pause/resume choice change test semantics.
DISABLE_FLAG="$TMP_DIR/wake-cycler.disabled"

interval() { echo 540; }
next_due_epoch() { :; }

date_for() { date -r "$1" '+%m/%d/%Y %H:%M:%S'; }

reset_case() {
  printf '%s\n' "$1" > "$SCHED_FILE"
  : > "$OPS_FILE"
}

count_ops() {
  local kind="$1"
  awk -F'|' -v kind="$kind" '$1 == kind { count++ } END { print count + 0 }' "$OPS_FILE"
}

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label (expected $expected, got $actual)" >&2
    cat "$OPS_FILE" >&2
    exit 1
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label (missing: $needle)" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

TARGET_DATE="$(date_for $((NOW_EPOCH + 540)))"
SOON_DATE="$(date_for $((NOW_EPOCH + 60)))"
NEAR_DATE="$(date_for $((NOW_EPOCH + 500)))"

reset_case "Scheduled power events:"
ensure_armed
assert_eq 1 "$(count_ops wakeorpoweron)" "arms one full wake when none exists"
assert_eq 0 "$(count_ops wake)" "does not arm a maintenance-only wake"
assert_eq 0 "$(count_ops cancel)" "does not cancel when none exists"

reset_case "Scheduled power events:
 [0]  wakeorpoweron at $TARGET_DATE by '$WAKE_OWNER'"
ensure_armed
assert_eq 0 "$(count_ops wakeorpoweron)" "keeps one suitable full wake"
assert_eq 0 "$(count_ops cancel)" "does not re-arm a suitable wake"

reset_case "Scheduled power events:
 [0]  wakeorpoweron at $SOON_DATE by '$WAKE_OWNER'"
ensure_armed
ensure_armed
assert_eq 0 "$(count_ops wakeorpoweron)" "does not duplicate an imminent wake"
assert_eq 0 "$(count_ops cancel)" "does not cancel a usable imminent wake"

reset_case "Scheduled power events:
 [0]  wakeorpoweron at $TARGET_DATE by '$WAKE_OWNER'
 [1]  wakeorpoweron at $NEAR_DATE by '$WAKE_OWNER'"
ensure_armed
assert_eq 1 "$(count_ops wakeorpoweron)" "replaces duplicate wakes with one"
assert_eq 2 "$(count_ops cancel)" "cancels every duplicate wake date"

next_due_epoch() { echo $((NOW_EPOCH + 240)); }
reset_case "Scheduled power events:
 [0]  wakeorpoweron at $TARGET_DATE by '$WAKE_OWNER'"
ensure_armed
assert_eq 1 "$(count_ops wakeorpoweron)" "moves a wake earlier for a scheduled task"
assert_eq 1 "$(count_ops cancel)" "cancels the superseded wake"
next_due_epoch() { :; }

reset_case "Scheduled power events:
 [0]  wake at $TARGET_DATE by '$WAKE_OWNER'"
ensure_armed
assert_eq 1 "$(count_ops wakeorpoweron)" "migrates a legacy maintenance wake to a full wake"
assert_eq 1 "$(count_ops cancel)" "cancels the daemon's legacy wake"
assert_eq "wake" "$(awk -F'|' '$1 == "cancel" { print $2 }' "$OPS_FILE")" "cancels using the legacy event type"

reset_case "Scheduled power events:
 [0]  wake at $TARGET_DATE by 'pmset'"
ensure_armed
assert_eq 1 "$(count_ops wakeorpoweron)" "does not reuse a foreign pmset wake"
assert_eq 0 "$(count_ops cancel)" "does not cancel a foreign pmset wake"

reset_case "Scheduled power events:
 [0]  wakeorpoweron at $TARGET_DATE by '$WAKE_OWNER'
 [1]  wake at $NEAR_DATE by 'com.apple.test'"
reconcile_disabled_wakes
assert_eq 1 "$(count_ops cancel)" "disabled cycling cancels its already-armed wake"
assert_contains "$(cat "$SCHED_FILE")" "by 'com.apple.test'" "disabled cycling leaves foreign wakes untouched"

# Watchdog selection is exact: it resolves a container by the session directory
# mounted at /workspace, then stops only that container.
WATCHDOG_SESSION="$TMP_DIR/data/v2-sessions/ag-1/sess-1"
mkdir -p "$WATCHDOG_SESSION"
touch "$WATCHDOG_SESSION/outbound.db"

docker_cmd() {
  if [ "$1" = ps ]; then
    printf 'wrong-container\nright-container\n'
  elif [ "$1" = inspect ]; then
    [ "${@: -1}" = right-container ] && printf '%s\n' "$WATCHDOG_SESSION" || printf '/other/session\n'
  elif [ "$1" = stop ]; then
    printf 'stop|%s\n' "${@: -1}" >> "$OPS_FILE"
  fi
}
assert_eq right-container "$(container_for_session_dir "$WATCHDOG_SESSION")" "matches the exact /workspace mount"

session_dirs() { printf '%s\n' "$WATCHDOG_SESSION"; }
session_has_stale_work() { [ "$1" = "$WATCHDOG_SESSION" ]; }
log_json() { :; }
: > "$OPS_FILE"
assert_eq 1 "$(recover_stale_work)" "recovers one stale session"
assert_eq right-container "$(awk -F'|' '$1 == "stop" { print $2 }' "$OPS_FILE")" "stops only the stale session container"

assert_eq rtc "$(classify_wake 'Wake DarkWake to FullWake : due to rtc/Maintenance')" "scheduled full RTC wake is not mistaken for human activity"
assert_eq human "$(classify_wake 'Wake DarkWake to FullWake : due to Notification')" "non-RTC full wake remains human"

# Status is an interpretation, not a raw dump: distinguish effective daemon
# state from the kill-switch preference and explain owned versus foreign wakes.
fake_launchctl_running() {
  printf 'system/%s = {\n    state = running\n    pid = 4321\n}\n' "$WAKE_OWNER"
}
fake_launchctl_missing() {
  echo "Could not find service '$WAKE_OWNER' in domain for system" >&2
  return 3
}

printf "Now drawing from 'AC Power'\n -InternalBattery-0\t87%%; charged; present: true\n" > "$TMP_DIR/batt"
fake_pmset() {
  if [ "${1:-}" = -g ] && [ "${2:-}" = sched ]; then cat "$SCHED_FILE"; return 0; fi
  if [ "${1:-}" = -g ] && [ "${2:-}" = batt ]; then cat "$TMP_DIR/batt"; return 0; fi
  return 0
}
PMSET_BIN=fake_pmset
LAUNCHCTL_BIN=fake_launchctl_running
PLIST_FILE="$TMP_DIR/$WAKE_OWNER.plist"
STATS_FILE="$TMP_DIR/stats.jsonl"
touch "$PLIST_FILE"
reset_case "Scheduled power events:
 [0]  wakeorpoweron at $TARGET_DATE by '$WAKE_OWNER'
 [1]  wake at $NEAR_DATE by 'com.apple.test'"
printf '%s\n' '{"ts":"2023-11-14T22:10:00+0000","event":"cycle","kind":"rtc","power":"ac","batt":87,"awake_secs":75,"db_activity":true,"containers":0,"decision":"sleepback"}' > "$STATS_FILE"
status_out=$(cmd_status)
assert_contains "$status_out" "overall:   HEALTHY" "status gives a healthy effective verdict"
assert_contains "$status_out" "exactly one owned wake is armed" "status explains the owned-wake invariant"
assert_contains "$status_out" "other events: 1 scheduled power event" "status separates foreign scheduled events"
assert_contains "$status_out" "scheduled RTC wake; awake 1m 15s" "status translates cycle JSON"

LAUNCHCTL_BIN=fake_launchctl_missing
status_out=$(cmd_status)
assert_contains "$status_out" "overall:   INACTIVE" "status reports an installed but unloaded daemon as inactive"
assert_contains "$status_out" "plist is installed" "status distinguishes installation from runtime state"
assert_contains "$status_out" "historical and do not mean the daemon is running now" "status labels stale history"

echo "wake-cycler reconciliation tests: PASS"
