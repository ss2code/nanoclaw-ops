import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';
import { computeBalances } from './balances';
import { settlementPlan } from './settle';

export interface NudgeEdge { from: number; to: number; amount: number; currency: string }
export function outstandingEdges(db: Database): NudgeEdge[] {
  const out: NudgeEdge[] = []; for (const [currency, balances] of computeBalances(db)) for (const edge of settlementPlan(balances)) out.push({ ...edge, currency });
  return out.sort((a, b) => a.currency.localeCompare(b.currency) || a.from - b.from || a.to - b.to || a.amount - b.amount);
}
function normal(edges: NudgeEdge[]): string { return JSON.stringify([...edges].sort((a,b) => a.currency.localeCompare(b.currency) || a.from-b.from || a.to-b.to || a.amount-b.amount)); }
export function recordNudge(db: Database, at: string, actorId: number | null): number {
  const edges = outstandingEdges(db); const id = Number(db.query('INSERT INTO settlement_nudges (at,edges_json) VALUES ($at,$edges)').run({ $at: at, $edges: normal(edges) }).lastInsertRowid);
  appendJournal(db, { at, actorId, action: 'settlement.nudge.record', entity: `settlement_nudge:${id}`, before: null, after: { edges } }); return id;
}
export function nudgeStatus(db: Database): { count: number; lastNudgeAt: string | null; edgesChangedSinceLastNudge: boolean; edges: NudgeEdge[] } {
  const last = db.query('SELECT * FROM settlement_nudges ORDER BY id DESC LIMIT 1').get() as { at: string; edges_json: string } | null; const edges = outstandingEdges(db);
  return { count: Number((db.query('SELECT COUNT(*) AS n FROM settlement_nudges').get() as any).n), lastNudgeAt: last?.at ?? null, edgesChangedSinceLastNudge: !last || normal(edges) !== normal(JSON.parse(last.edges_json)), edges };
}
