import { Database } from 'bun:sqlite';
import { dueForAutoCommit } from './decisions';
import { readinessDue, checklistBoard } from './checklists';
import { dayOf } from './dayof';
import { diaryEntries } from './diary';
import { allMembers } from './db';
import { migratePlanning } from '../../trip-planning/scripts/db';
import { migrateFinance } from '../../trip-finance/scripts/db';
import { computeBalances } from '../../trip-finance/scripts/balances';
import { settlementPlan } from '../../trip-finance/scripts/settle';
import { formatMinor } from '../../trip-finance/scripts/money';
import { nudgeStatus } from '../../trip-finance/scripts/nudge';
import { budgetBurn } from '../../trip-finance/scripts/burn';
import { existsSync } from 'node:fs';

export type HeartbeatProducer = (db: Database, at: string) => unknown | null;
const extensions: Record<string, HeartbeatProducer[]> = { planning: [], morning: [], evening: [], settlement: [] };
export function registerHeartbeatSection(edition: keyof typeof extensions, producer: HeartbeatProducer): void { extensions[edition].push(producer); }
const day = (at: string) => at.slice(0, 10);
function safe<T>(f: () => T, fallback: T): T { try { return f(); } catch { return fallback; } }
function rows(db: Database, sql: string, bind: Record<string, unknown> = {}): any[] { return safe(() => db.query(sql).all(bind) as any[], []); }
function editionFor(stage: string, requested: string): 'planning' | 'morning' | 'evening' | 'settlement' { if (requested !== 'auto') return requested as any; return ['planning', 'plan_ready'].includes(stage) ? 'planning' : ['start_trip', 'on_trip'].includes(stage) ? 'morning' : 'settlement'; }

export function heartbeat(db: Database, at: string, requested = 'auto', memoryPath?: string): { wakeAgent: boolean; data: any } {
  migratePlanning(db); migrateFinance(db);
  const trip = db.query('SELECT * FROM trip WHERE id=1').get() as any;
  if (!trip) return { wakeAgent: false, data: { at, reason: 'trip not configured' } };
  const stage = trip.stage ?? 'planning'; const edition = editionFor(stage, requested); const sections: Record<string, unknown> = {};
  if (['archived', 'cancelled'].includes(stage)) return { wakeAgent: false, data: { stage, edition, at, sections } };
  if (edition === 'planning') {
    const due = dueForAutoCommit(db, at).map((d) => ({ id: d.id, question: d.question, commitBy: d.commit_by })); if (due.length) sections.decisionsDue = due;
    const voters = rows(db, "SELECT * FROM decisions WHERE status='open' AND mode='poll'").map((d) => { const votes = d.tally_json ? JSON.parse(d.tally_json).votes ?? {} : {}; const pending = rows(db, `SELECT m.id AS memberId,m.display_name AS name FROM members m LEFT JOIN stage_participation p ON p.member_id=m.id AND p.stage=$stage WHERE m.joined_at <= $at AND (m.left_at IS NULL OR m.left_at > $at) AND COALESCE(p.status,'in')!='out'`, { $stage: d.stage ?? stage, $at: at }).filter((m) => !votes[String(m.memberId)]); return pending.length ? { decisionId: d.id, question: d.question, pending } : null; }).filter(Boolean); if (voters.length) sections.pendingVoters = voters;
    const until = new Date(`${day(at)}T00:00:00Z`); until.setUTCDate(until.getUTCDate() + 7); const d7 = until.toISOString().slice(0, 10);
    const deadlines = rows(db, `SELECT title,ticket_deadline AS deadline FROM itinerary_items WHERE status='committed' AND booking_required=1 AND ticket_deadline BETWEEN $now AND $d7 UNION ALL SELECT title,ticket_deadline AS deadline FROM events WHERE status='committed' AND booking_required=1 AND ticket_deadline BETWEEN $now AND $d7`, { $now: day(at), $d7: d7 }); if (deadlines.length) sections.deadlinesSoon = deadlines;
    const stale = rows(db, "SELECT id,title,source_checked_at AS checkedAt FROM recommendations WHERE status='researching' AND source_checked_at IS NOT NULL AND source_checked_at < $cut", { $cut: new Date(new Date(at).getTime() - 14 * 86400000).toISOString() }); if (stale.length) sections.staleSources = stale;
    const scratch = rows(db, "SELECT topic FROM scratchpad WHERE status='open' AND at < $cut ORDER BY at LIMIT 1", { $cut: new Date(new Date(at).getTime() - 14 * 86400000).toISOString() });
    if (scratch.length) sections.staleScratchpad = { count: rows(db, "SELECT id FROM scratchpad WHERE status='open' AND at < $cut", { $cut: new Date(new Date(at).getTime() - 14 * 86400000).toISOString() }).length, oldestTopic: scratch[0].topic ?? null };
    const readiness = (stage === 'plan_ready' || (trip.start_date && day(at) >= new Date(new Date(`${trip.start_date}T00:00:00Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10))) ? readinessDue(db, at) : []; if (readiness.length) sections.readinessDue = readiness;
    if (trip.start_date && day(at) >= new Date(new Date(`${trip.start_date}T00:00:00Z`).getTime() - 3 * 86400000).toISOString().slice(0, 10)) { const gear = checklistBoard(db, 'gear').filter((i) => i.status === 'open' && i.claimed_by == null); if (gear.length) sections.gearUnclaimed = gear; }
  } else if (edition === 'morning') {
    const date = day(at); const today = rows(db, `SELECT d.*,p.name AS place_name FROM days d LEFT JOIN places p ON p.id=d.base_place_id WHERE d.date=$date AND d.status='committed'`, { $date: date })[0];
    if (today) sections.today = { ...today, items: rows(db, `SELECT i.slot,i.start,i.title,p.name AS placeName,i.travel_minutes AS travelMinutes FROM itinerary_items i LEFT JOIN places p ON p.id=i.place_id WHERE i.day_id=$id AND i.status='committed' ORDER BY CASE i.slot WHEN 'dawn' THEN 0 WHEN 'morning' THEN 1 WHEN 'midday' THEN 2 WHEN 'afternoon' THEN 3 WHEN 'evening' THEN 4 ELSE 5 END`, { $id: today.id }), meals: rows(db, `SELECT m.slot,p.name AS placeName,m.status FROM meals m LEFT JOIN places p ON p.id=m.place_id WHERE m.day_id=$id AND m.status IN ('committed','shortlisted') ORDER BY m.slot,m.id`, { $id: today.id }) }; else sections.todayGap = true;
    const departures = dayOf(db, date); if (departures.length) sections.departures = departures;
    const bookings = rows(db, `SELECT title,ticket_deadline AS deadline FROM itinerary_items WHERE status='committed' AND booking_required=1 AND ticket_deadline=$date UNION ALL SELECT title,ticket_deadline AS deadline FROM events WHERE status='committed' AND booking_required=1 AND ticket_deadline=$date`, { $date: date }); if (bookings.length) sections.bookingsToday = bookings;
  } else if (edition === 'evening') {
    const spend = rows(db, `SELECT currency,SUM(amount) AS amount,COUNT(*) AS count FROM expenses WHERE voided_at IS NULL AND substr(logged_at,1,10)=$date GROUP BY currency`, { $date: day(at) }); if (spend.length) sections.spendToday = { count: spend.reduce((n, r) => n + Number(r.count), 0), totals: spend.map((r) => ({ ...r, formatted: formatMinor(r.amount, r.currency) })) };
    const tomorrow = new Date(`${day(at)}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); const t = tomorrow.toISOString().slice(0, 10); const next = rows(db, "SELECT d.*,i.title AS firstItem FROM days d LEFT JOIN itinerary_items i ON i.day_id=d.id AND i.status='committed' WHERE d.date=$date AND d.status='committed' ORDER BY i.id LIMIT 1", { $date: t })[0]; sections.tomorrow = next ?? { gap: true };
    sections.diaryPrompt = { hasEntryToday: diaryEntries(db, day(at)).length > 0 };
    sections.burn = budgetBurn(db, at);
  } else {
    const members = allMembers(db); const balanceByCurrency = computeBalances(db); const edges: any[] = [];
    for (const [currency, net] of balanceByCurrency) for (const e of settlementPlan(net)) edges.push({ fromName: members.find((m) => m.id === e.from)?.display_name ?? String(e.from), toName: members.find((m) => m.id === e.to)?.display_name ?? String(e.to), amountMinor: e.amount, currency, formatted: formatMinor(e.amount, currency) });
    const nudge = nudgeStatus(db);
    sections.nudgeCount = nudge.count; sections.lastNudgeAt = nudge.lastNudgeAt; sections.edgesChangedSinceLastNudge = nudge.edgesChangedSinceLastNudge;
    sections.balances = edges.length ? edges : undefined; if (!edges.length) sections.allSettled = true;
    sections.burn = budgetBurn(db, at);
    if (memoryPath && existsSync(memoryPath)) {
      const mem = safe(() => new Database(memoryPath, { readonly: true }), null as Database | null);
      if (mem) {
        const distilled = safe(() => mem.query("SELECT 1 FROM memories WHERE tags LIKE '%distilled%' AND status='active' LIMIT 1").get(), null);
        if (!distilled) sections.distillPending = true;
        safe(() => { mem.close(); return null; }, null);
      }
    }
  }
  for (const producer of extensions[edition]) { const value = safe(() => producer(db, at), null); if (value && typeof value === 'object') Object.assign(sections, value); }
  for (const key of Object.keys(sections)) if (sections[key] == null || (Array.isArray(sections[key]) && !sections[key].length)) delete sections[key];
  let wakeAgent = edition === 'morning' ? ['start_trip', 'on_trip'].includes(stage) : Object.keys(sections).length > 0;
  if (edition === 'evening') wakeAgent = Boolean((sections.spendToday as any)?.count || (sections.tomorrow as any));
  if (edition === 'settlement' && sections.balances) {
    const last = sections.lastNudgeAt as string | null; const overdue = !last || new Date(at).getTime() - new Date(last).getTime() >= 3 * 86400000;
    wakeAgent = Boolean(sections.edgesChangedSinceLastNudge) || overdue;
  }
  return { wakeAgent, data: { stage, edition, at, sections } };
}
