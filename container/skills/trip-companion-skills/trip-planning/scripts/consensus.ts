import type { Database } from 'bun:sqlite';
import { appendJournal } from '../../trip-core/scripts/db';
import { closeDecision } from '../../trip-core/scripts/decisions';
import { setStatus } from './items';
import type { PlanTable } from './db';

// Consensus write-through (§14). The DECISION record (mechanics, tally, outcome,
// commit_by) is authoritative in trip-core. When a decision settles — via a poll
// close or a propose-with-deadline auto-commit (trip-core dueForAutoCommit lists
// the ready ones) — the outcome is written THROUGH to structured plan state:
// the linked item(s) flip to committed. The agent supplies the outcome→item
// mapping (LLM judgment); the flip + close + journal are scripted (deterministic).

export function commitDecision(
  db: Database,
  c: { decisionId: number; outcome: string; items: { table: PlanTable; id: number }[] },
  actorId: number | null,
  at: string,
): void {
  db.transaction(() => {
    closeDecision(db, c.decisionId, c.outcome, at);
    for (const it of c.items) setStatus(db, it.table, it.id, 'committed', actorId, at);
    appendJournal(db, {
      at,
      actorId,
      action: 'consensus.commit',
      entity: `decision:${c.decisionId}`,
      before: null,
      after: { outcome: c.outcome, items: c.items },
    });
  })();
}
