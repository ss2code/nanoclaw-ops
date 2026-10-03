import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

// The seven-stage lifecycle machine (§11). Transitions are agent-proposed,
// owner-confirmed (the caller decides; the core enforces legal adjacency),
// journaled, and regressible. A pre-trip trip can be cancelled → archived.
//
// The script owns "what transitions are legal" (deterministic, §10); the LLM
// owns "should we move now" (judgment).

/** The forward sequence. `cancelled` is an off-path branch, not in this list. */
export const STAGES = [
  'planning',
  'plan_ready',
  'start_trip',
  'on_trip',
  'trip_complete',
  'post_trip',
  'archived',
] as const;

export type Stage = (typeof STAGES)[number] | 'cancelled';

/** Stages from which a trip may still be cancelled (before travel begins). */
const PRE_TRIP: Stage[] = ['planning', 'plan_ready', 'start_trip'];

/** Legal target stages from `from`: one step forward, one step back (regress), and cancel when pre-trip. */
export function legalTransitions(from: Stage): Stage[] {
  if (from === 'archived') return [];
  if (from === 'cancelled') return ['archived'];
  const i = STAGES.indexOf(from);
  if (i < 0) return [];
  const out: Stage[] = [];
  if (i + 1 < STAGES.length) out.push(STAGES[i + 1]); // forward
  if (i - 1 >= 0) out.push(STAGES[i - 1]); // regress
  if (PRE_TRIP.includes(from)) out.push('cancelled');
  return out;
}

export function getStage(db: Database): Stage {
  const row = db.query('SELECT stage FROM trip WHERE id = 1').get() as { stage: string } | null;
  if (!row) throw new Error('trip not configured — run setup ensure first');
  return row.stage as Stage;
}

export interface TransitionCheck {
  ok: boolean;
  from: Stage;
  to: Stage;
  legal: Stage[];
}

/** Pure legality probe — never mutates. */
export function canTransition(db: Database, to: Stage): TransitionCheck {
  const from = getStage(db);
  const legal = legalTransitions(from);
  return { ok: legal.includes(to), from, to, legal };
}

/**
 * Record an agent proposal to move stage (audit only — does not change state).
 * The owner confirms via `transition`.
 */
export function proposeTransition(db: Database, to: Stage, actorId: number | null, at: string): TransitionCheck {
  const check = canTransition(db, to);
  appendJournal(db, {
    at,
    actorId,
    action: 'lifecycle.propose',
    entity: 'trip:1',
    before: { stage: check.from },
    after: { stage: to, legal: check.ok },
  });
  return check;
}

/** Confirm + apply a transition. Throws if illegal; journals before/after stage. */
export function transition(db: Database, to: Stage, actorId: number | null, at: string): void {
  const from = getStage(db);
  if (from === 'archived') throw new Error(`'${from}' is terminal — no transitions allowed`);
  if (!legalTransitions(from).includes(to)) {
    throw new Error(`illegal transition ${from} → ${to} (legal: ${legalTransitions(from).join(', ') || 'none'})`);
  }
  db.query('UPDATE trip SET stage = $s WHERE id = 1').run({ $s: to });
  appendJournal(db, {
    at,
    actorId,
    action: 'lifecycle.transition',
    entity: 'trip:1',
    before: { stage: from },
    after: { stage: to },
  });
}

/** Step back one stage along the forward path. */
export function regress(db: Database, actorId: number | null, at: string): void {
  const from = getStage(db);
  const i = STAGES.indexOf(from as (typeof STAGES)[number]);
  if (i <= 0) throw new Error(`cannot regress from '${from}'`);
  transition(db, STAGES[i - 1], actorId, at);
}

/** Cancel a pre-trip trip (→ cancelled). */
export function cancel(db: Database, actorId: number | null, at: string): void {
  const from = getStage(db);
  if (!PRE_TRIP.includes(from)) throw new Error(`cannot cancel from '${from}' — travel has begun`);
  transition(db, 'cancelled', actorId, at);
}
