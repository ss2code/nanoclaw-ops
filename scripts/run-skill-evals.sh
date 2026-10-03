#!/usr/bin/env bash
# Unattended validation for the Trip Companion skills (trip-*).
#
# Drives each skill's eval through the REAL NanoClaw pipeline (cli.sock → router →
# container → skill CLI → store) and writes a consolidated report. Designed to be
# run overnight with NO user intervention (launchd / cron / nohup).
#
# SAFE: every trip eval targets the ag-trip-goa TEST group — never your live trips.
# COST: it makes real Claude API calls. Nightly runs accrue usage — size the
#       cadence accordingly (nightly vs weekly vs on-demand).
#
#   Run now:   bash scripts/run-skill-evals.sh
#   Schedule:  see docs/local/apps/trip-companion/skill-validation-runbook.html (private overlay)
set -uo pipefail

# launchd/cron give a minimal PATH — make bun/node/pnpm findable (portable via $HOME).
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
STAMP="$(date +%Y-%m-%d_%H%M)"
RUN_ID="${STAMP//[^A-Za-z0-9]/-}"
OUT="$ROOT/logs/skill-evals/$STAMP"
mkdir -p "$OUT"
REPORT="$OUT/REPORT.txt"

log() { echo "$@" | tee -a "$REPORT"; }

log "═══ Trip Companion skill-eval batch · $STAMP ═══"
if [ ! -S "$ROOT/data/cli.sock" ]; then
  log "ABORT: data/cli.sock missing — the NanoClaw service is not running."
  exit 2
fi
if ! command -v bun >/dev/null 2>&1; then
  log "ABORT: bun not on PATH ($PATH)."
  exit 2
fi

pass=0; fail=0; skip=0
run_eval() {
  local skill="$1"; shift
  local logf="$OUT/$skill.log" rc
  log ""
  log "── $skill ──"
  bun "$@" > "$logf" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then log "  RESULT: PASS (exit 0)"; pass=$((pass+1))
  else log "  RESULT: FAIL (exit $rc)"; fail=$((fail+1)); fi
  tail -n 14 "$logf" | sed 's/^/    /' >> "$REPORT"
}

# trip-docs: K-run variance score. Others: their existing pipeline gate.
run_eval trip-docs     container/skills/trip-companion-skills/trip-docs/eval/score.ts --runs 5 --run "$RUN_ID-trip-docs"
run_eval trip-core     container/skills/trip-companion-skills/trip-core/eval/simulate.ts --run "$RUN_ID-trip-core"
run_eval trip-finance  container/skills/trip-companion-skills/trip-finance/eval/simulate.ts --run "$RUN_ID-trip-finance" --fresh
run_eval trip-planning container/skills/trip-companion-skills/trip-planning/eval/simulate.ts --run "$RUN_ID-trip-planning" --fresh

log ""
log "═══ batch done · pass=$pass fail=$fail skipped=$skip ═══"
log "Full logs + report: $OUT"
exit "$fail"
