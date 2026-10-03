import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

// Consensus record (§14). Two modes:
//  - propose: a recommendation with a commit_by deadline; silence = assent.
//    A scheduled wake calls dueForAutoCommit() and commits the un-objected ones.
//  - poll: numbered options, agent-tallied, closed at a deadline.
// The mechanics + tally + outcome are DETERMINISTIC and authoritative here;
// the distilled *insight* rolls into memory.db separately (the planning layer).

interface TallyBlob {
  votes?: Record<string, string>; // memberId -> chosen option (poll)
  objections?: number[]; // memberIds who objected (propose)
}

export interface DecisionRow {
  id: number;
  question: string;
  mode: string;
  options_json: string | null;
  tally_json: string | null;
  outcome: string | null;
  commit_by: string | null;
  stage: string | null;
  opened_by: number | null;
  opened_at: string;
  closed_at: string | null;
  status: string;
}

function readTally(db: Database, id: number): TallyBlob {
  const row = db.query('SELECT tally_json FROM decisions WHERE id = $id').get({ $id: id }) as
    | { tally_json: string | null }
    | null;
  if (!row) throw new Error(`decision ${id} not found`);
  return row.tally_json ? (JSON.parse(row.tally_json) as TallyBlob) : {};
}

function writeTally(db: Database, id: number, t: TallyBlob): void {
  db.query('UPDATE decisions SET tally_json = $t WHERE id = $id').run({ $t: JSON.stringify(t), $id: id });
}

export function openDecision(
  db: Database,
  d: {
    question: string;
    mode?: 'propose' | 'poll';
    options?: string[];
    commitBy?: string | null;
    stage?: string | null;
    openedBy?: number | null;
  },
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO decisions (question, mode, options_json, tally_json, commit_by, stage, opened_by, opened_at, status)
       VALUES ($q, $mode, $opts, $tally, $cb, $stage, $by, $at, 'open')`,
    )
    .run({
      $q: d.question,
      $mode: d.mode ?? 'propose',
      $opts: d.options ? JSON.stringify(d.options) : null,
      $tally: JSON.stringify({}),
      $cb: d.commitBy ?? null,
      $stage: d.stage ?? null,
      $by: d.openedBy ?? null,
      $at: at,
    });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, {
    at,
    actorId: d.openedBy ?? null,
    action: 'decision.open',
    entity: `decision:${id}`,
    before: null,
    after: { id, question: d.question, mode: d.mode ?? 'propose', commit_by: d.commitBy ?? null },
  });
  return id;
}

/** Poll: record (or change) a member's vote. Upsert per voter — a re-vote replaces. */
export function recordVote(db: Database, decisionId: number, memberId: number, choice: string, at: string): void {
  const t = readTally(db, decisionId);
  t.votes ??= {};
  t.votes[String(memberId)] = choice;
  writeTally(db, decisionId, t);
  appendJournal(db, {
    at,
    actorId: memberId,
    action: 'decision.vote',
    entity: `decision:${decisionId}`,
    before: null,
    after: { member_id: memberId, choice },
  });
}

export interface TallyResult {
  counts: Record<string, number>;
  votes: number;
  leader: string | null;
}

/** Deterministic count. Ties broken by option order (first listed wins). */
export function tally(db: Database, decisionId: number): TallyResult {
  const row = db.query('SELECT options_json, tally_json FROM decisions WHERE id = $id').get({ $id: decisionId }) as
    | { options_json: string | null; tally_json: string | null }
    | null;
  if (!row) throw new Error(`decision ${decisionId} not found`);
  const blob: TallyBlob = row.tally_json ? JSON.parse(row.tally_json) : {};
  const votes = blob.votes ?? {};
  const counts: Record<string, number> = {};
  for (const choice of Object.values(votes)) counts[choice] = (counts[choice] ?? 0) + 1;

  const order: string[] = row.options_json ? (JSON.parse(row.options_json) as string[]) : Object.keys(counts);
  let leader: string | null = null;
  let best = 0;
  for (const opt of order) {
    const c = counts[opt] ?? 0;
    if (c > best) {
      best = c;
      leader = opt;
    }
  }
  return { counts, votes: Object.keys(votes).length, leader };
}

/** Propose: record an objection (silence = assent, so an objection blocks auto-commit). */
export function recordObjection(db: Database, decisionId: number, memberId: number, at: string): void {
  const t = readTally(db, decisionId);
  t.objections ??= [];
  if (!t.objections.includes(memberId)) t.objections.push(memberId);
  writeTally(db, decisionId, t);
  appendJournal(db, {
    at,
    actorId: memberId,
    action: 'decision.objection',
    entity: `decision:${decisionId}`,
    before: null,
    after: { member_id: memberId },
  });
}

export function closeDecision(db: Database, decisionId: number, outcome: string, at: string): void {
  const before = db.query('SELECT * FROM decisions WHERE id = $id').get({ $id: decisionId });
  if (!before) throw new Error(`decision ${decisionId} not found`);
  db.query("UPDATE decisions SET status = 'closed', outcome = $o, closed_at = $at WHERE id = $id").run({
    $o: outcome,
    $at: at,
    $id: decisionId,
  });
  appendJournal(db, {
    at,
    actorId: null,
    action: 'decision.close',
    entity: `decision:${decisionId}`,
    before,
    after: db.query('SELECT * FROM decisions WHERE id = $id').get({ $id: decisionId }),
  });
}

/**
 * Open propose-mode decisions whose commit_by deadline has passed (≤ nowIso) and
 * which carry no logged objection — ready to auto-commit ("locked unless you object").
 */
export function dueForAutoCommit(db: Database, nowIso: string): DecisionRow[] {
  const rows = db
    .query(
      `SELECT * FROM decisions
       WHERE status = 'open' AND mode = 'propose' AND commit_by IS NOT NULL AND commit_by <= $now
       ORDER BY id`,
    )
    .all({ $now: nowIso }) as DecisionRow[];
  return rows.filter((r) => {
    const blob: TallyBlob = r.tally_json ? JSON.parse(r.tally_json) : {};
    return !blob.objections || blob.objections.length === 0;
  });
}

export function openDecisions(db: Database): DecisionRow[] {
  return db.query("SELECT * FROM decisions WHERE status = 'open' ORDER BY id").all() as DecisionRow[];
}

export function closedDecisions(db: Database): DecisionRow[] {
  return db.query("SELECT * FROM decisions WHERE status = 'closed' ORDER BY id").all() as DecisionRow[];
}
