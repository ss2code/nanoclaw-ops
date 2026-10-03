#!/bin/bash
# NanoClaw wake-cycler — periodic full-wake + queue-drain + sleep-back.
#
# While the Mac is awake it keeps one RTC wake armed ~interval ahead. When the
# Mac sleeps (lid close or idle), that wake fires as a full RTC wake (the
# display stays off with the lid closed). The daemon then holds the machine
# awake with a power assertion, gives the NanoClaw host time to reconnect
# (Baileys drains
# WhatsApp's server-side queue) and lets any agent containers finish, then
# forces sleep again. It NEVER forces sleep after a human wake (lid / keys /
# display on). Every cycle is appended to logs/wake-cycler.jsonl.
#
# Subcommands:
#   run      daemon loop (root, via LaunchDaemon — see install.sh)
#   status   daemon state, kill switch, armed wakes, recent cycles
#   stats    summary of the JSONL stats log
#   on|off   enable / disable cycling (kill switch file; daemon stays loaded)
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
PMSET_BIN="${PMSET_BIN:-pmset}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
SQLITE_BIN="${SQLITE_BIN:-sqlite3}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATS_FILE="$REPO/logs/wake-cycler.jsonl"
DISABLE_FLAG="$REPO/data/wake-cycler.disabled"
LABEL="com.nanoclaw.wakecycler"
WAKE_OWNER="$LABEL"
WAKE_EVENT_TYPE="wakeorpoweron"
PLIST_FILE="${PLIST_FILE:-/Library/LaunchDaemons/$LABEL.plist}"

# ---- tunables ----
INTERVAL_AC=540        # wake every 9 min on AC power
INTERVAL_BATT=1200     # wake every 20 min on battery
GRACE_SECS=90          # after a wake, before the first quiet check; must exceed
                       # the host sweep's 60s tick so due scheduled messages get
                       # noticed (and their container spawned) before we check
QUIET_SECS=45          # no session-DB writes for this long = drained
STALE_WORK_SECS=120    # processing claim + heartbeat both older than this:
                       # stop only that session's container so host retry wins
RECOVERY_GRACE_SECS=90 # stay awake after a watchdog stop for host sweep+retry
MAX_AWAKE_SECS=1800    # hard cap per cycle, then sleep-back anyway
LOOP_SECS=15           # daemon poll interval
WAKE_LATE_TOLERANCE_SECS=120  # acceptable lateness beyond the desired target
WAKE_LEAD_SECS=120     # wake this far AHEAD of a due scheduled task, so the
                       # network + host have time to fully reconnect before the
                       # task fires. A container spawned into a not-yet-ready
                       # network (typical seconds after a dark-wake) stalls on
                       # its first model call and dies at the host's 30-min
                       # ceiling. Widened from the old hard-coded 60s, which left
                       # the host still reconnecting when the 06:00 brief fired.
                       # Raise toward 180 if scheduled turns still land early.

# ---- helpers ----
now_epoch() {
  if [ -n "${WAKE_CYCLER_NOW_EPOCH:-}" ]; then
    echo "$WAKE_CYCLER_NOW_EPOCH"
  else
    date +%s
  fi
}

waketime() { sysctl -n kern.waketime | awk '{print $4}' | tr -d ','; }

power_source() {
  "$PMSET_BIN" -g batt | head -1 | grep -q "AC Power" && echo ac || echo battery
}

batt_pct() { "$PMSET_BIN" -g batt | grep -o '[0-9]*%' | head -1 | tr -d '%'; }

interval() { [ "$(power_source)" = ac ] && echo $INTERVAL_AC || echo $INTERVAL_BATT; }

# Future wake rows owned by this daemon, as epoch|display-date|event-type. The
# explicit owner keeps us from treating unrelated user-created `pmset` wakes
# as ours. Reading legacy `wake` rows lets an updated daemon cancel/migrate its
# previously armed event to `wakeorpoweron` without touching foreign events.
owned_wake_rows() {
  local now type d owner e
  now=$(now_epoch)
  while IFS='|' read -r type d owner; do
    [ "$owner" = "$WAKE_OWNER" ] || continue
    e=$(date -j -f '%m/%d/%Y %H:%M:%S' "$d" +%s 2>/dev/null) || continue
    [ "$e" -gt "$now" ] || continue
    printf '%s|%s|%s\n' "$e" "$d" "$type"
  done < <("$PMSET_BIN" -g sched | sed -En "s/.*(wake|wakeorpoweron) at ([0-9/]* [0-9:]*) by '([^']*)'.*/\1|\2|\3/p") \
    | sort -n -t '|' -k1,1
}

cancel_owned_wakes() {
  local rows="$1" type d cancel_date
  while IFS='|' read -r type d; do
    [ -n "$d" ] || continue
    cancel_date=$(date -j -f '%m/%d/%Y %H:%M:%S' "$d" '+%m/%d/%y %H:%M:%S') || return 1
    "$PMSET_BIN" schedule cancel "$type" "$cancel_date" "$WAKE_OWNER" >/dev/null 2>&1 || return 1
  done < <(printf '%s\n' "$rows" | awk -F'|' 'NF > 2 && !seen[$2 FS $3]++ { print $3 FS $2 }')
}

# soonest future process_after across all session inbound DBs (epoch), or empty.
# Same predicate as the host's countDueMessages, restricted to the future.
# macOS ships /usr/bin/sqlite3; session DBs use journal_mode=DELETE so a
# read-only peek is safe — busy/locked errors just skip that DB this round.
next_due_epoch() {
  local soonest="" e db
  while IFS= read -r db; do
    e=$("$SQLITE_BIN" -readonly "$db" \
      "SELECT CAST(strftime('%s', MIN(datetime(process_after))) AS INTEGER)
       FROM messages_in
       WHERE status='pending' AND trigger=1 AND kind!='system'
         AND datetime(process_after) > datetime('now');" 2>/dev/null) || continue
    if [[ "$e" =~ ^[0-9]+$ ]] && { [ -z "$soonest" ] || [ "$e" -lt "$soonest" ]; }; then
      soonest=$e
    fi
  done < <(find "$REPO/data/v2-sessions" -type f -name 'inbound.db' 2>/dev/null)
  echo "$soonest"
}

ensure_armed() {
  local now target next_due owned count armed armed_type
  now=$(now_epoch)
  target=$((now + $(interval)))
  # if a nanoclaw scheduled message is due before the normal interval, wake
  # WAKE_LEAD_SECS ahead of it so the network + host are fully reconnected by
  # the time the sweep fires it (a longer lead than the old 60s gives a
  # dark-wake room to settle before the task actually runs).
  next_due=$(next_due_epoch)
  if [[ "$next_due" =~ ^[0-9]+$ ]] && [ $((next_due - WAKE_LEAD_SECS)) -lt "$target" ]; then
    target=$((next_due - WAKE_LEAD_SECS))
    [ "$target" -lt $((now + 60)) ] && target=$((now + 60))
  fi
  owned=$(owned_wake_rows)
  count=$(printf '%s\n' "$owned" | awk 'NF { count++ } END { print count + 0 }')

  # Repeated calls must be idempotent: one suitable future wake is enough.
  if [ "$count" -eq 1 ]; then
    armed=$(printf '%s\n' "$owned" | cut -d'|' -f1)
    armed_type=$(printf '%s\n' "$owned" | cut -d'|' -f3)
    # An earlier wake is useful and must be allowed to fire. In particular,
    # never add a replacement merely because the existing wake is imminent;
    # after it fires, the next poll will arm the following wake.
    if [ "$armed_type" = "$WAKE_EVENT_TYPE" ] && [ "$armed" -le $((target + WAKE_LATE_TOLERANCE_SECS)) ]; then
      return
    fi
  fi

  # Replace stale or duplicate wakes before arming a new target. This is also
  # what lets an earlier scheduled task move the wake forward safely.
  if [ "$count" -gt 0 ]; then
    cancel_owned_wakes "$owned" || {
      echo "$LABEL: could not cancel existing owned wake(s); not adding another" >&2
      return
    }
    if [ -n "$(owned_wake_rows)" ]; then
      echo "$LABEL: existing owned wake(s) remain after cancellation; not adding another" >&2
      return
    fi
  fi

  "$PMSET_BIN" schedule "$WAKE_EVENT_TYPE" "$(date -r "$target" '+%m/%d/%y %H:%M:%S')" "$WAKE_OWNER" >/dev/null 2>&1
}

# A disabled runtime must not retain an already-armed NanoClaw wake. This runs
# inside the root daemon loop, so it can cancel pmset rows even though the
# unprivileged Ops Center only creates the kill-switch file.
reconcile_disabled_wakes() {
  local owned
  owned=$(owned_wake_rows)
  [ -z "$owned" ] || cancel_owned_wakes "$owned" || {
    echo "$LABEL: could not cancel owned wake(s) while disabled" >&2
    return 1
  }
}

# last real Wake/DarkWake event line (field 4 of pmset -g log is the domain)
wake_line() {
  "$PMSET_BIN" -g log | awk '$4 == "Wake" || $4 == "DarkWake"' | tail -1
}

# rtc | dark | human | unknown
classify_wake() {
  local line="$1"
  case "$line" in
    *rtc*)      echo rtc ;;
    *UserActivity*|*HID*|*" lid "*|*multi-touch*|*FullWake*|*powerbutton*) echo human ;;
    *DarkWake*) echo dark ;;
    *)          echo unknown ;;
  esac
}

display_on() { "$PMSET_BIN" -g assertions 2>/dev/null | grep -q 'Prevent sleep while display is on'; }

# newest mtime across session DBs (0 if none)
newest_session_mtime() {
  local m
  m=$(find "$REPO/data/v2-sessions" -type f -name '*.db*' -exec stat -f %m {} + 2>/dev/null | sort -n | tail -1)
  echo "${m:-0}"
}

# Count agent containers that are ACTIVELY streaming a turn, via their
# per-session .heartbeat files (the container touches /workspace/.heartbeat on
# every SDK stream event — see agent-runner poll-loop). We deliberately do NOT
# use `docker ps` here: this daemon runs as root, but Docker Desktop's socket is
# per-user (~/.docker/run/docker.sock) while root's default context points at a
# nonexistent /var/run/docker.sock, so `docker ps` as root always returns 0 —
# which is why every logged cycle showed containers:0 even with live agents.
# A heartbeat fresher than QUIET_SECS = a live, streaming turn. Stalled turns
# are handled separately by recover_stale_work; they are never treated as safe
# to sleep merely because their heartbeat went stale.
containers_running() {
  local now m count=0
  now=$(now_epoch)
  while IFS= read -r m; do
    [ -n "$m" ] && [ $((now - m)) -le "$QUIET_SECS" ] && count=$((count + 1))
  done < <(find "$REPO/data/v2-sessions" -type f -name '.heartbeat' -exec stat -f %m {} + 2>/dev/null)
  echo "$count"
}

docker_socket() {
  local owner
  owner=$(stat -f %Su "$REPO")
  printf '/Users/%s/.docker/run/docker.sock\n' "$owner"
}

docker_cmd() {
  local socket="${DOCKER_SOCKET:-$(docker_socket)}"
  [ -S "$socket" ] || return 1
  "$DOCKER_BIN" -H "unix://$socket" "$@"
}

install_slug() {
  local PROJECT_ROOT="$REPO"
  # shellcheck source=../../setup/lib/install-slug.sh
  source "$REPO/setup/lib/install-slug.sh"
  _nanoclaw_install_slug
}

container_for_session_dir() {
  local session_dir="$1" name mounted slug
  slug=$(install_slug)
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    mounted=$(docker_cmd inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$name" 2>/dev/null) || continue
    if [ "$mounted" = "$session_dir" ]; then
      printf '%s\n' "$name"
      return 0
    fi
  done < <(docker_cmd ps --filter "label=nanoclaw-install=$slug" --format '{{.Names}}' 2>/dev/null)
  return 1
}

session_has_stale_work() {
  local session_dir="$1" outbound="$session_dir/outbound.db" heartbeat="$session_dir/.heartbeat"
  local now hb_mtime stale_claims
  [ -f "$outbound" ] || return 1
  now=$(now_epoch)
  hb_mtime=0
  [ -f "$heartbeat" ] && hb_mtime=$(stat -f %m "$heartbeat" 2>/dev/null || echo 0)
  [ $((now - hb_mtime)) -gt "$STALE_WORK_SECS" ] || return 1
  stale_claims=$("$SQLITE_BIN" -readonly "$outbound" \
    "SELECT COUNT(*) FROM processing_ack
     WHERE status='processing'
       AND status_changed <= datetime('now', '-${STALE_WORK_SECS} seconds');" 2>/dev/null) || return 1
  [ "${stale_claims:-0}" -gt 0 ]
}

# Stop only containers whose exact /workspace mount belongs to a session with
# both an old processing claim and an old heartbeat. The host remains the owner
# of retry bookkeeping: its next sweep observes the exit, clears the orphan
# claim, and reschedules the inbound row. This is deliberately fork-local power
# recovery policy, not a change to NanoClaw's shared host SLA.
recover_stale_work() {
  local session_dir container recovered=0
  while IFS= read -r session_dir; do
    session_has_stale_work "$session_dir" || continue
    container=$(container_for_session_dir "$session_dir") || continue
    if docker_cmd stop -t 1 "$container" >/dev/null 2>&1; then
      recovered=$((recovered + 1))
      log_json "{\"ts\":\"$(ts)\",\"event\":\"watchdog_recovery\",\"session\":\"$(basename "$session_dir")\",\"container\":\"$container\",\"stale_secs\":$STALE_WORK_SECS}"
    fi
  done < <(session_dirs)
  echo "$recovered"
}

session_dirs() {
  local outbound
  while IFS= read -r outbound; do dirname "$outbound"; done \
    < <(find "$REPO/data/v2-sessions" -mindepth 3 -maxdepth 3 -type f -name 'outbound.db' 2>/dev/null)
}

log_json() {
  mkdir -p "$(dirname "$STATS_FILE")"
  printf '%s\n' "$1" >> "$STATS_FILE"
  chmod 644 "$STATS_FILE" 2>/dev/null
}

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

# ---- wake handler ----
handle_wake() {
  local wake_epoch="$1" caf_pid="" line kind power batt decision db_active=false
  local containers=0 awake_secs recovered=0 last_recovery=0

  line=$(wake_line)
  kind=$(classify_wake "$line")
  power=$(power_source)
  batt=$(batt_pct)

  if [ "$kind" = human ] || [ "$kind" = unknown ] || display_on; then
    decision="stay_human"
  else
    # wakeorpoweron enters a full system wake. -i keeps that full wake from
    # idling back to sleep; -s strengthens it on AC (macOS ignores -s on
    # battery). Unlike the old dark-wake + -im combination, this does not rely
    # on an assertion macOS discards when a battery maintenance wake ends.
    caffeinate -ims -t $MAX_AWAKE_SECS & caf_pid=$!

    # grace: let the host reconnect + start draining; bail if a human shows up
    local waited=0
    while [ $waited -lt $GRACE_SECS ]; do
      sleep 5; waited=$((waited + 5))
      display_on && break
    done

    # quiet loop: sleep back once DBs are quiet and no agent containers run
    decision="sleepback_forced"
    while :; do
      if display_on; then decision="stay_human"; break; fi
      local now m
      now=$(now_epoch)
      m=$(newest_session_mtime)
      recovered=$(recover_stale_work)
      [ "$recovered" -gt 0 ] && last_recovery=$now
      containers=$(containers_running)
      [ "$m" -gt "$((wake_epoch - 5))" ] && db_active=true
      if [ $((now - m)) -gt $QUIET_SECS ] && [ "$containers" -eq 0 ] \
        && { [ "$last_recovery" -eq 0 ] || [ $((now - last_recovery)) -gt $RECOVERY_GRACE_SECS ]; }; then
        decision="sleepback"; break
      fi
      if [ $((now - wake_epoch)) -gt $MAX_AWAKE_SECS ]; then break; fi
      sleep 10
    done
  fi

  awake_secs=$(( $(now_epoch) - wake_epoch ))
  log_json "{\"ts\":\"$(ts)\",\"event\":\"cycle\",\"kind\":\"$kind\",\"power\":\"$power\",\"batt\":${batt:-0},\"awake_secs\":$awake_secs,\"db_activity\":$db_active,\"containers\":${containers:-0},\"decision\":\"$decision\"}"

  [ -n "$caf_pid" ] && kill "$caf_pid" 2>/dev/null

  if [ "$decision" != stay_human ]; then
    ensure_armed
    "$PMSET_BIN" sleepnow >/dev/null 2>&1
  fi
}

# ---- daemon loop ----
cmd_run() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "run must be executed as root (via the LaunchDaemon)" >&2; exit 1
  fi
  log_json "{\"ts\":\"$(ts)\",\"event\":\"daemon_start\",\"power\":\"$(power_source)\"}"
  local last_wake w
  last_wake=$(waketime)
  while :; do
    if [ -f "$DISABLE_FLAG" ]; then
      reconcile_disabled_wakes || true
      last_wake=$(waketime)   # swallow wakes while disabled
      sleep $LOOP_SECS; continue
    fi
    ensure_armed
    w=$(waketime)
    if [ "$w" != "$last_wake" ]; then
      last_wake=$w
      handle_wake "$w"
    fi
    sleep $LOOP_SECS
  done
}

# ---- user-facing subcommands ----
format_duration() {
  local total="${1:-0}" days hours mins secs out=""
  [[ "$total" =~ ^[0-9]+$ ]] || total=0
  days=$((total / 86400))
  hours=$(((total % 86400) / 3600))
  mins=$(((total % 3600) / 60))
  secs=$((total % 60))
  [ "$days" -gt 0 ] && out="${days}d "
  [ "$hours" -gt 0 ] && out="${out}${hours}h "
  [ "$mins" -gt 0 ] && out="${out}${mins}m "
  if [ -z "$out" ] || { [ "$days" -eq 0 ] && [ "$hours" -eq 0 ] && [ "$secs" -gt 0 ]; }; then
    out="${out}${secs}s"
  fi
  printf '%s\n' "${out% }"
}

relative_to_now() {
  local epoch="$1" now delta
  now=$(now_epoch)
  delta=$((epoch - now))
  if [ "$delta" -ge 0 ]; then
    printf 'in %s\n' "$(format_duration "$delta")"
  else
    printf '%s ago\n' "$(format_duration $((-delta)))"
  fi
}

json_string_field() {
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

json_scalar_field() {
  printf '%s\n' "$1" | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p"
}

describe_cycle() {
  local line="$1" timestamp kind decision awake activity kind_text decision_text activity_text
  timestamp=$(json_string_field "$line" ts)
  kind=$(json_string_field "$line" kind)
  decision=$(json_string_field "$line" decision)
  awake=$(json_scalar_field "$line" awake_secs)
  activity=$(json_scalar_field "$line" db_activity)

  case "$kind" in
    rtc)   kind_text="scheduled RTC wake" ;;
    dark)  kind_text="macOS maintenance wake" ;;
    human) kind_text="human wake (lid, keyboard, or display)" ;;
    *)     kind_text="${kind:-unclassified wake}" ;;
  esac
  case "$decision" in
    sleepback)        decision_text="queue became quiet, then the Mac was put back to sleep" ;;
    sleepback_forced) decision_text="the awake-time cap was reached, then sleep-back was forced" ;;
    stay_human)       decision_text="the Mac stayed awake because human/display activity was detected" ;;
    *)                decision_text="decision: ${decision:-unknown}" ;;
  esac
  if [ "$activity" = true ]; then
    activity_text="message/session activity occurred"
  else
    activity_text="no message/session activity was observed"
  fi

  printf '  %s — %s; awake %s; %s; %s.\n' \
    "${timestamp:-unknown time}" "$kind_text" "$(format_duration "${awake:-0}")" "$activity_text" "$decision_text"
}

detect_daemon() {
  local output rc state pid
  DAEMON_STATUS="unknown"
  DAEMON_DETAIL="launchd state could not be read"
  if output=$("$LAUNCHCTL_BIN" print "system/$LABEL" 2>&1); then rc=0; else rc=$?; fi
  if [ "$rc" -eq 0 ]; then
    state=$(printf '%s\n' "$output" | awk -F'= ' '/^[[:space:]]*state = / { print $2; exit }')
    pid=$(printf '%s\n' "$output" | awk -F'= ' '/^[[:space:]]*pid = / { print $2; exit }')
    DAEMON_STATUS="loaded"
    DAEMON_DETAIL="loaded${state:+; state $state}${pid:+; pid $pid}"
    [ "$state" = running ] && DAEMON_STATUS="running"
  elif printf '%s\n' "$output" | grep -qiE 'Could not find service|service .* not found|No such process'; then
    if [ -f "$PLIST_FILE" ]; then
      DAEMON_STATUS="not_loaded"
      DAEMON_DETAIL="not loaded or running (plist is installed)"
    else
      DAEMON_STATUS="not_installed"
      DAEMON_DETAIL="not installed"
    fi
  elif [ -f "$PLIST_FILE" ]; then
    DAEMON_DETAIL="unknown (plist is installed, but launchd could not be queried: $(printf '%s' "$output" | tail -1))"
  else
    DAEMON_DETAIL="unknown (no plist found; launchd query failed: $(printf '%s' "$output" | tail -1))"
  fi
}

cmd_status() {
  local power batt interval_secs owned owned_count next_owned next_epoch next_date next_type
  local schedule other_count log_epoch cycle_lines line overall
  detect_daemon
  power=$(power_source)
  batt=$(batt_pct)
  interval_secs=$(interval)
  owned=$(owned_wake_rows)
  owned_count=$(printf '%s\n' "$owned" | awk 'NF { count++ } END { print count + 0 }')
  schedule=$("$PMSET_BIN" -g sched 2>/dev/null)
  other_count=$(printf '%s\n' "$schedule" | awk -v owner="$WAKE_OWNER" \
    '/ at .* by / && index($0, "by '\''" owner "'\''") == 0 { count++ } END { print count + 0 }')

  if [ "$DAEMON_STATUS" != running ] && [ "$DAEMON_STATUS" != loaded ]; then
    overall="INACTIVE — the daemon is not running, so it will not arm new wakes or perform sleep-back cycles"
  elif [ -f "$DISABLE_FLAG" ]; then
    overall="PAUSED — the daemon is running, but the kill switch disables new wakes and sleep-back cycles"
  elif [ "$owned_count" -eq 1 ]; then
    overall="HEALTHY — the daemon is running, cycling is enabled, and exactly one owned wake is armed"
  elif [ "$owned_count" -eq 0 ]; then
    overall="CHECK — the daemon is enabled but no future owned wake is armed; the next ${LOOP_SECS}s poll should add one"
  else
    overall="CHECK — $owned_count owned wakes are armed; the next ${LOOP_SECS}s poll should reconcile them to one"
  fi

  echo "wake-cycler status"
  echo "------------------"
  echo "overall:   $overall"
  echo "daemon:    $DAEMON_DETAIL"
  if [ -f "$DISABLE_FLAG" ]; then
    echo "cycling:   OFF — kill switch is set; '$0 on' removes $DISABLE_FLAG"
  else
    echo "cycling:   ON — kill switch is absent (this does not by itself mean the daemon is running)"
  fi
  echo "power:     $power (${batt:-unknown}%)"
  echo "policy:    when active, keep one wake armed about $(format_duration "$interval_secs") ahead on $power;"
  echo "           a pending NanoClaw task may move it to ${WAKE_LEAD_SECS}s before that task"

  echo "owned wake:"
  if [ "$owned_count" -eq 0 ]; then
    echo "  none — there is currently no future wake owned by $WAKE_OWNER"
  else
    next_owned=$(printf '%s\n' "$owned" | head -1)
    IFS='|' read -r next_epoch next_date next_type <<< "$next_owned"
    echo "  next: $next_date ($(relative_to_now "$next_epoch")); type $next_type; owner $WAKE_OWNER"
    [ "$owned_count" -gt 1 ] && echo "  plus $((owned_count - 1)) duplicate/stale owned wake(s), which the daemon should remove"
  fi
  if [ "$other_count" -gt 0 ]; then
    echo "other events: $other_count scheduled power event(s) belong to macOS or other tools; wake-cycler leaves them untouched"
  else
    echo "other events: none"
  fi

  echo "activity log:"
  if [ -s "$STATS_FILE" ]; then
    log_epoch=$(stat -f %m "$STATS_FILE" 2>/dev/null || echo 0)
    echo "  last write: $(date -r "$log_epoch" '+%Y-%m-%d %H:%M:%S %z') ($(relative_to_now "$log_epoch"))"
    if [ "$DAEMON_STATUS" != running ] && [ "$DAEMON_STATUS" != loaded ]; then
      echo "  note: these entries are historical and do not mean the daemon is running now"
    fi
    cycle_lines=$(grep '"event":"cycle"' "$STATS_FILE" | tail -3 || true)
    if [ -n "$cycle_lines" ]; then
      echo "recent cycles:"
      while IFS= read -r line; do describe_cycle "$line"; done <<< "$cycle_lines"
    else
      echo "recent cycles: none completed yet"
    fi
  else
    echo "  no activity recorded yet ($STATS_FILE)"
  fi

  if [ "$DAEMON_STATUS" = not_loaded ]; then
    echo "action:     load the installed daemon with: sudo launchctl bootstrap system '$PLIST_FILE'"
  elif [ "$DAEMON_STATUS" = not_installed ]; then
    echo "action:     install it with: sudo bash scripts/wake-cycler/install.sh"
  fi
}

cmd_stats() {
  if [ ! -s "$STATS_FILE" ]; then echo "no stats yet ($STATS_FILE)"; exit 0; fi
  awk '
    /"event":"cycle"/ {
      cycles++
      if (/"kind":"rtc"/)   rtc++
      if (/"kind":"dark"/)  dark++
      if (/"kind":"human"/) human++
      if (/"decision":"sleepback"/)        sb++
      if (/"decision":"sleepback_forced"/) sbf++
      if (/"decision":"stay_human"/)       sh++
      if (/"db_activity":true/)            active++
      if (match($0, /"awake_secs":[0-9]+/)) {
        s = substr($0, RSTART+13, RLENGTH-13); total += s
      }
    }
    /"event":"daemon_start"/ { starts++ }
    END {
      printf "cycles: %d  (rtc %d, dark %d, human %d)\n", cycles, rtc, dark, human
      printf "slept back: %d  (forced: %d)   stayed awake for human: %d\n", sb, sbf, sh
      printf "cycles with message/DB activity: %d\n", active
      if (cycles > 0) printf "avg awake per cycle: %.0fs\n", total / cycles
      printf "daemon starts: %d\n", starts
    }' "$STATS_FILE"
  echo
  echo "last 5 cycles:"
  grep '"event":"cycle"' "$STATS_FILE" | tail -5 | sed 's/^/  /'
}

cmd_on()  { rm -f "$DISABLE_FLAG"; echo "wake-cycler: cycling ENABLED"; }
cmd_off() { mkdir -p "$(dirname "$DISABLE_FLAG")"; touch "$DISABLE_FLAG"; echo "wake-cycler: cycling DISABLED (daemon stays loaded, no wakes armed, no sleep-backs)"; }

if [ "${WAKE_CYCLER_SOURCE_ONLY:-0}" != 1 ]; then
  case "${1:-}" in
    run)    cmd_run ;;
    status) cmd_status ;;
    stats)  cmd_stats ;;
    on)     cmd_on ;;
    off)    cmd_off ;;
    *)      echo "usage: $0 run|status|stats|on|off"; exit 1 ;;
  esac
fi
