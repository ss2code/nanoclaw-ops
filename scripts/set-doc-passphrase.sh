#!/usr/bin/env bash
#
# set-doc-passphrase.sh — set or rotate the passphrase that encrypts documents
# hosted via the artifact-deploy skill.
#
# Hosted documents (artifact-deploy → Netlify) are AES-encrypted client-side: the
# deployed page asks for a passphrase and decrypts in the browser. This script
# stores that passphrase in each group's deploy state (the deploy_state.netlify.
# passphrase key in whatever state DB that group's skill uses — e.g. trip-docs
# uses groups/<name>/trip.db), which artifact-deploy reads at deploy time. One
# passphrase is shared across every target by default, so a single generic
# password unlocks every document.
#
# After running this, ask that document's agent to "update the page" so the new
# passphrase takes effect on the next deploy. Share the passphrase privately —
# never in a shared group chat.
#
# Each write is bounded by a hard timeout: if a target DB is momentarily held by
# a running container it is reported as BUSY and skipped (re-run later) instead
# of hanging.
#
# Usage:
#   ./scripts/set-doc-passphrase.sh                        # generate a passphrase, apply to every known target
#   ./scripts/set-doc-passphrase.sh "my chosen passphrase" # set a chosen passphrase on every known target
#   ./scripts/set-doc-passphrase.sh --db <path/to/state.db>          # one target only (repeatable)
#   ./scripts/set-doc-passphrase.sh "my pass" --db <path/to/state.db>
#
# With no --db, targets are discovered automatically: every *.db directly under
# groups/*/ that already has artifact-deploy's deploy_state table (i.e. has been
# used for hosting before) — regardless of what it's named. Example: a trip
# group's document store is conventionally groups/sample-trip/trip.db, so
# `--db groups/sample-trip/trip.db` targets just that one. For a brand-new
# group that has never deployed, pass --db explicitly the first time.
#
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root
SKILL="container/skills/artifact-deploy/scripts/artifact-deploy.ts"
WRITE_TIMEOUT="${WRITE_TIMEOUT:-15}"       # seconds per DB write before we treat it as busy
DISCOVER_TIMEOUT="${DISCOVER_TIMEOUT:-5}"  # seconds per DB probed during auto-discovery

print_help() {
  cat <<'EOF'
set-doc-passphrase.sh — set or rotate the passphrase that encrypts documents
hosted via the artifact-deploy skill.

Hosted documents (artifact-deploy -> Netlify) are AES-encrypted client-side:
the deployed page asks for a passphrase and decrypts in the browser. This
script stores that passphrase in each group's deploy state (the
deploy_state.netlify.passphrase key in whatever state DB that group's skill
uses), which artifact-deploy reads at deploy time. One passphrase is shared
across every target by default, so a single generic password unlocks every
document.

After running this, ask that document's agent to "update the page" so the new
passphrase takes effect on the next deploy. Share the passphrase privately —
never in a shared group chat.

Usage:
  set-doc-passphrase.sh                          generate a passphrase, apply
                                                   to every known target
  set-doc-passphrase.sh "my chosen passphrase"   set a chosen passphrase on
                                                   every known target
  set-doc-passphrase.sh --db <path>              one target only (repeatable)
  set-doc-passphrase.sh "my pass" --db <path>

Examples (trip groups conventionally name their state DB trip.db):
  set-doc-passphrase.sh --db groups/sample-trip/trip.db
  set-doc-passphrase.sh "goa-sunrise-42" --db groups/trip-goa/trip.db

Options:
  --db <path>   Target one state DB explicitly. Repeatable. Overrides
                auto-discovery.
  -h, --help    Show this help.

With no --db, targets are discovered automatically: every *.db directly under
groups/*/ that already has artifact-deploy's deploy_state table (i.e. has been
used for hosting before) — regardless of what it's named. For a brand-new
group that has never deployed, pass --db explicitly the first time.
EOF
}

command -v bun >/dev/null 2>&1 || { echo "error: 'bun' is not on PATH." >&2; exit 1; }

# Run a command with a hard wall-clock timeout (macOS has no `timeout`; perl's alarm does).
# Exit 142 == killed by SIGALRM (timed out).
run_timeout() { local s="$1"; shift; perl -e 'alarm(shift @ARGV); exec @ARGV or exit 127' "$s" "$@"; }

PASS=""
DBS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)      DBS+=("$2"); shift 2 ;;
    -h|--help) print_help; exit 0 ;;
    --*)       echo "unknown flag: $1" >&2; exit 2 ;;
    *)         if [ -z "$PASS" ]; then PASS="$1"; shift; else echo "unexpected argument: $1" >&2; exit 2; fi ;;
  esac
done

# Auto-discover targets: any *.db under groups/*/ that already has a
# deploy_state table. Schema-based, not name-based, so it works whatever the
# calling skill named its state DB (trip-docs happens to use trip.db; another
# skill could use anything). A DB that hangs on open (e.g. held exclusively by
# a running container) is skipped from auto-discovery rather than blocking.
has_deploy_state() {
  run_timeout "$DISCOVER_TIMEOUT" bun -e '
    const { Database } = require("bun:sqlite");
    const db = new Database(process.argv[1], { readonly: true });
    const row = db.query("SELECT name FROM sqlite_master WHERE type=\x27table\x27 AND name=\x27deploy_state\x27").get();
    process.exit(row ? 0 : 1);
  ' "$1" >/dev/null 2>&1
}

if [ "${#DBS[@]}" -eq 0 ]; then
  for f in groups/*/*.db; do
    [ -f "$f" ] && has_deploy_state "$f" && DBS+=("$f")
  done
fi
if [ "${#DBS[@]}" -eq 0 ]; then
  echo "No document deploy database found under groups/*/. Pass one explicitly," >&2
  echo "e.g. --db groups/<name>/trip.db." >&2
  exit 1
fi

# Decide the passphrase once so every document shares the SAME one.
if [ -z "$PASS" ]; then
  OUT=$(run_timeout 20 bun "$SKILL" netlify set-password --generate --json 2>/dev/null) \
    || { echo "error: could not generate a passphrase (bun failed or timed out)." >&2; exit 1; }
  PASS=$(printf '%s' "$OUT" | sed -n 's/.*"password":"\([^"]*\)".*/\1/p')
  [ -n "$PASS" ] || { echo "error: could not parse the generated passphrase." >&2; exit 1; }
fi

failed=0; ok=0
for db in "${DBS[@]}"; do
  if [ ! -f "$db" ]; then echo "  skip (not found): $db" >&2; failed=1; continue; fi
  if run_timeout "$WRITE_TIMEOUT" bun "$SKILL" netlify set-password --set "$PASS" --state-db "$db" --json >/dev/null 2>&1; then
    echo "  set: $db"; ok=$((ok + 1))
  else
    rc=$?
    if [ "$rc" -eq 142 ]; then
      echo "  BUSY — a container is using it; re-run later: $db" >&2
    else
      echo "  FAILED (exit $rc): $db" >&2
    fi
    failed=1
  fi
done

echo
if [ "$ok" -gt 0 ]; then
  echo "Passphrase (shown once — share privately, never in a group chat):"
  echo "    $PASS"
  echo
  echo 'Next: ask each affected document'\''s agent to "update the page" so the new passphrase takes effect.'
fi
if [ "$failed" -ne 0 ]; then
  echo
  echo "Some targets were not updated (see above). Re-run when the affected agent isn't mid-message." >&2
  exit 1
fi
