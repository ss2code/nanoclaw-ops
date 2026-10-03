# Trip Planning Always-On Rules

For planning turns, first ground with trip-core and then use the planning script for the board, feasibility, and readiness:

```bash
TC="bun /app/skills/trip-core/scripts/trip-core.ts --db /workspace/agent/trip.db"
TP="bun /app/skills/trip-planning/scripts/trip-planning.ts --db /workspace/agent/trip.db"
$TC recap
$TP plan show
```

Never call a plan ready from chat memory. Run `$TP plan check`, `$TP plan validate`, and `$TC booking readiness`; relay the missing items or blockers directly.

Use `trip-core` decisions for planning choices: propose-with-deadline by default, polls only when the group is genuinely split. After a decision settles, write it through with `trip-planning consensus commit`.

Every recommendation should include current, credible source evidence. If source confidence or freshness is uncertain, record it through trip-core recommendations and say what still needs verification.

Translate a durable pace/mobility preference into `$TP config set-pace` once; do not eyeball pace. Store opening hours and alternates in trip.db. For a rained-out or late item, dry-run `$TP day shuffle`, show its computed board/feasibility, then commit only after a group yes.
