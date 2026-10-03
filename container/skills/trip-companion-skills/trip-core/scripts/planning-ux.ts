import type { Database } from 'bun:sqlite';
import { appendJournal, getMember } from './db';
import { type DecisionRow, openDecisions, closedDecisions, recordVote, tally } from './decisions';

type JsonMap = Record<string, unknown>;

interface VoteProxyRow {
  id: number;
  from_member_id: number;
  to_member_id: number;
  decision_id: number | null;
  scope: string;
  note: string | null;
  active: number;
  set_by: number | null;
  set_at: string;
}

export interface DecisionBoardItem {
  id: number;
  question: string;
  status: 'open' | 'closed';
  mode: string;
  stage: string | null;
  outcome: string | null;
  locksAt: string | null;
  openedAt: string;
  pending: string[];
  tally?: ReturnType<typeof tally>;
  tied?: string[];
  stale: boolean;
  proxyHints: string[];
}

export interface DecisionBoard {
  text: string;
  open: DecisionBoardItem[];
  closed: DecisionBoardItem[];
  nextActions: string[];
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: name }) != null;
}

function activePlanningMembers(db: Database): { id: number; display_name: string }[] {
  return db
    .query(
      `SELECT m.id, m.display_name
         FROM members m
    LEFT JOIN stage_participation p
           ON p.member_id = m.id AND p.stage = 'planning'
        WHERE m.left_at IS NULL
          AND COALESCE(p.status, 'in') != 'out'
        ORDER BY m.id`,
    )
    .all() as { id: number; display_name: string }[];
}

function memberName(db: Database, id: number): string {
  return getMember(db, id)?.display_name ?? `member#${id}`;
}

function daysBetween(a: string, b: string): number {
  return Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function voteIds(d: DecisionRow): Set<number> {
  const blob = parseJson<{ votes?: Record<string, string> }>(d.tally_json, {});
  return new Set(Object.keys(blob.votes ?? {}).map((v) => Number(v)).filter(Number.isSafeInteger));
}

function tiedOptions(t: ReturnType<typeof tally>): string[] {
  const values = Object.values(t.counts);
  const best = values.length ? Math.max(...values) : 0;
  if (best === 0) return [];
  return Object.entries(t.counts).filter(([, c]) => c === best).map(([option]) => option);
}

function proxyRows(db: Database, decisionId?: number): VoteProxyRow[] {
  const rows = db
    .query(
      `SELECT * FROM vote_proxies
        WHERE active = 1
          AND (decision_id IS NULL OR decision_id = $decision)
        ORDER BY decision_id IS NOT NULL DESC, id`,
    )
    .all({ $decision: decisionId ?? null }) as VoteProxyRow[];
  return decisionId == null ? rows : rows.filter((r) => r.decision_id == null || r.decision_id === decisionId);
}

function proxyHints(db: Database, decisionId: number): string[] {
  return proxyRows(db, decisionId).map((p) => `${memberName(db, p.from_member_id)} follows ${memberName(db, p.to_member_id)}`);
}

export function buildDecisionBoard(db: Database, nowIso: string, opts?: { staleDays?: number }): DecisionBoard {
  const members = activePlanningMembers(db);
  const staleDays = opts?.staleDays ?? 3;
  const open = openDecisions(db).map((d): DecisionBoardItem => {
    const voted = voteIds(d);
    const pending = d.mode === 'poll' ? members.filter((m) => !voted.has(m.id)).map((m) => m.display_name) : [];
    const t = d.mode === 'poll' ? tally(db, d.id) : undefined;
    const tied = t ? tiedOptions(t) : [];
    return {
      id: d.id,
      question: d.question,
      status: 'open',
      mode: d.mode,
      stage: d.stage,
      outcome: null,
      locksAt: d.commit_by,
      openedAt: d.opened_at,
      pending,
      tally: t,
      tied: tied.length > 1 ? tied : [],
      stale: daysBetween(d.opened_at, nowIso) >= staleDays,
      proxyHints: proxyHints(db, d.id),
    };
  });
  const closed = closedDecisions(db).map((d): DecisionBoardItem => ({
    id: d.id,
    question: d.question,
    status: 'closed',
    mode: d.mode,
    stage: d.stage,
    outcome: d.outcome,
    locksAt: d.commit_by,
    openedAt: d.opened_at,
    pending: [],
    stale: false,
    proxyHints: [],
  }));

  const nextActions: string[] = [];
  for (const d of open) {
    if (d.tied?.length) nextActions.push(`break tie on #${d.id}: ${d.tied.join(' / ')}`);
    else if (d.pending.length) nextActions.push(`ask ${d.pending.join(', ')} for #${d.id}`);
    else if (d.mode === 'poll') nextActions.push(`close #${d.id} if the group agrees`);
    if (d.stale) nextActions.push(`refresh stale decision #${d.id}`);
  }
  if (open.length === 0) nextActions.push('no open decisions; move to booking readiness or plan validation');

  const lines = ['Decision cockpit'];
  if (open.length) {
    lines.push('Open:');
    for (const d of open) {
      const voteText = d.tally
        ? Object.entries(d.tally.counts).map(([o, c]) => `${o} ${c}`).join(', ') || 'no votes'
        : d.locksAt
          ? `locks ${d.locksAt}`
          : 'proposal open';
      const bits = [
        `#${d.id} ${d.question}`,
        voteText,
        d.pending.length ? `pending: ${d.pending.join(', ')}` : '',
        d.tied?.length ? `tied: ${d.tied.join(' / ')}` : '',
        d.stale ? 'stale' : '',
        d.proxyHints.length ? `proxy: ${d.proxyHints.join('; ')}` : '',
      ].filter(Boolean);
      lines.push(`  - ${bits.join(' · ')}`);
    }
  }
  if (closed.length) {
    lines.push('Locked:');
    for (const d of closed.slice(-5)) lines.push(`  - #${d.id} ${d.question} -> ${d.outcome ?? 'closed'}`);
  }
  lines.push(`Next: ${nextActions.join('; ')}`);
  return { text: lines.join('\n'), open, closed, nextActions };
}

export interface CatchupCard {
  text: string;
  stage: string;
  trip: string;
  members: string[];
  openDecisions: number;
  lockedDecisions: number;
  notes: string[];
  assets: string[];
}

export function buildCatchupCard(db: Database, nowIso: string): CatchupCard {
  const trip = db.query('SELECT name, stage FROM trip WHERE id = 1').get() as { name: string; stage: string } | null;
  const members = activePlanningMembers(db).map((m) => m.display_name);
  const board = buildDecisionBoard(db, nowIso);
  const notes = db
    .query("SELECT note FROM scratchpad WHERE status = 'open' ORDER BY id DESC LIMIT 5")
    .all() as { note: string }[];
  const assets = db
    .query('SELECT COALESCE(label, path) AS label FROM assets ORDER BY id DESC LIMIT 5')
    .all() as { label: string }[];

  const lines = [
    `${trip?.name ?? 'Trip'} catch-up`,
    `Stage: ${trip?.stage ?? 'planning'}`,
    `People: ${members.join(', ') || 'not set'}`,
    `Decisions: ${board.closed.length} locked, ${board.open.length} open`,
  ];
  if (board.open.length) lines.push(`Open now: ${board.open.map((d) => `#${d.id} ${d.question}`).join('; ')}`);
  if (notes.length) lines.push(`Notes: ${notes.map((n) => n.note).join(' | ')}`);
  if (assets.length) lines.push(`Docs: ${assets.map((a) => a.label).join(', ')}`);
  lines.push(`Next: ${board.nextActions.join('; ')}`);

  return {
    text: lines.join('\n'),
    stage: trip?.stage ?? 'planning',
    trip: trip?.name ?? 'Trip',
    members,
    openDecisions: board.open.length,
    lockedDecisions: board.closed.length,
    notes: notes.map((n) => n.note),
    assets: assets.map((a) => a.label),
  };
}

export interface BookingReadiness {
  ok: boolean;
  missing: string[];
  ready: string[];
  text: string;
}

export function bookingReadiness(db: Database): BookingReadiness {
  const missing: string[] = [];
  const ready: string[] = [];
  if (openDecisions(db).length) missing.push(`${openDecisions(db).length} open decision(s) still need closure`);

  const checkPlanningTable = (table: string, label: string, dateColumn: string) => {
    if (!hasTable(db, table)) return;
    const rows = db
      .query(`SELECT id, title, ${dateColumn} AS deadline FROM ${table} WHERE status = 'committed' AND booking_required = 1 ORDER BY id`)
      .all() as { id: number; title: string; deadline: string | null }[];
    for (const r of rows) {
      if (r.deadline) ready.push(`${label} #${r.id}: ${r.title} by ${r.deadline}`);
      else missing.push(`${label} #${r.id}: ${r.title} needs a booking deadline`);
    }
  };
  checkPlanningTable('itinerary_items', 'item', 'ticket_deadline');
  checkPlanningTable('events', 'event', 'ticket_deadline');

  if (hasTable(db, 'stays')) {
    const stays = db.query("SELECT id, status FROM stays WHERE status IN ('shortlisted', 'deciding') ORDER BY id").all() as {
      id: number;
      status: string;
    }[];
    for (const s of stays) missing.push(`stay #${s.id} is ${s.status}; confirm availability before booking`);
  }

  const staleSources = db
    .query(
      `SELECT id, title, confidence, source_checked_at
         FROM recommendations
        WHERE status != 'rejected'
          AND (confidence IN ('unknown', 'low') OR source_checked_at IS NULL)
        ORDER BY id`,
    )
    .all() as { id: number; title: string; confidence: string; source_checked_at: string | null }[];
  for (const r of staleSources) missing.push(`recommendation #${r.id}: ${r.title} needs source confidence/freshness`);

  if (ready.length === 0 && missing.length === 0) ready.push('no booking blockers found in trip-core');
  const text = [`Booking readiness: ${missing.length ? 'not ready' : 'ready'}`];
  if (missing.length) text.push('Missing:', ...missing.map((m) => `  - ${m}`));
  if (ready.length) text.push('Ready/known:', ...ready.map((r) => `  - ${r}`));
  return { ok: missing.length === 0, missing, ready, text: text.join('\n') };
}

export function setVoteProxy(
  db: Database,
  proxy: { fromMemberId: number; toMemberId: number; decisionId?: number | null; scope?: string; note?: string | null },
  actorId: number | null,
  at: string,
): number {
  const from = getMember(db, proxy.fromMemberId);
  const to = getMember(db, proxy.toMemberId);
  if (!from) throw new Error(`member ${proxy.fromMemberId} not found`);
  if (!to) throw new Error(`member ${proxy.toMemberId} not found`);
  const res = db
    .query(
      `INSERT INTO vote_proxies (from_member_id, to_member_id, decision_id, scope, note, active, set_by, set_at)
       VALUES ($from, $to, $decision, $scope, $note, 1, $by, $at)`,
    )
    .run({
      $from: proxy.fromMemberId,
      $to: proxy.toMemberId,
      $decision: proxy.decisionId ?? null,
      $scope: proxy.scope ?? 'all',
      $note: proxy.note ?? null,
      $by: actorId,
      $at: at,
    });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, {
    at,
    actorId,
    action: 'proxy.set',
    entity: `proxy:${id}`,
    before: null,
    after: { id, ...proxy },
  });
  return id;
}

export function listVoteProxies(db: Database): VoteProxyRow[] {
  return db.query('SELECT * FROM vote_proxies WHERE active = 1 ORDER BY id').all() as VoteProxyRow[];
}

export function applyVoteProxies(db: Database, decisionId: number, at: string): { applied: JsonMap[]; skipped: JsonMap[] } {
  const row = openDecisions(db).find((d) => d.id === decisionId);
  if (!row) throw new Error(`open decision ${decisionId} not found`);
  if (row.mode !== 'poll') throw new Error(`decision ${decisionId} is ${row.mode}, not poll`);
  const blob = parseJson<{ votes?: Record<string, string> }>(row.tally_json, {});
  const votes = blob.votes ?? {};
  const applied: JsonMap[] = [];
  const skipped: JsonMap[] = [];
  for (const p of proxyRows(db, decisionId)) {
    const sourceChoice = votes[String(p.to_member_id)];
    if (!sourceChoice) {
      skipped.push({ proxy: p.id, reason: `${memberName(db, p.to_member_id)} has not voted` });
      continue;
    }
    if (votes[String(p.from_member_id)]) {
      skipped.push({ proxy: p.id, reason: `${memberName(db, p.from_member_id)} already voted` });
      continue;
    }
    recordVote(db, decisionId, p.from_member_id, sourceChoice, at);
    applied.push({ proxy: p.id, member: memberName(db, p.from_member_id), choice: sourceChoice });
  }
  appendJournal(db, {
    at,
    actorId: null,
    action: 'proxy.apply',
    entity: `decision:${decisionId}`,
    before: null,
    after: { applied, skipped },
  });
  return { applied, skipped };
}

export function addRecommendation(
  db: Database,
  r: {
    category: string;
    title: string;
    status?: string;
    sourceUrl?: string | null;
    sourceCheckedAt?: string | null;
    confidence?: string;
    freshnessDays?: number | null;
    note?: string | null;
  },
  actorId: number | null,
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO recommendations
       (category, title, status, source_url, source_checked_at, confidence, freshness_days, note, created_by, created_at)
       VALUES ($category, $title, $status, $url, $checked, $confidence, $freshness, $note, $by, $at)`,
    )
    .run({
      $category: r.category,
      $title: r.title,
      $status: r.status ?? 'researching',
      $url: r.sourceUrl ?? null,
      $checked: r.sourceCheckedAt ?? null,
      $confidence: r.confidence ?? 'unknown',
      $freshness: r.freshnessDays ?? null,
      $note: r.note ?? null,
      $by: actorId,
      $at: at,
    });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, { at, actorId, action: 'recommendation.add', entity: `recommendation:${id}`, before: null, after: { id, ...r } });
  return id;
}

export function listRecommendations(db: Database): JsonMap[] {
  return db.query('SELECT * FROM recommendations ORDER BY id').all() as JsonMap[];
}

export function setActivitySignup(
  db: Database,
  s: { activity: string; memberId: number; status?: string; note?: string | null },
  actorId: number | null,
  at: string,
): void {
  if (!getMember(db, s.memberId)) throw new Error(`member ${s.memberId} not found`);
  db
    .query(
      `INSERT INTO activity_signups (activity, member_id, status, note, updated_by, updated_at)
       VALUES ($activity, $member, $status, $note, $by, $at)
       ON CONFLICT(activity, member_id) DO UPDATE SET
         status = excluded.status, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run({
      $activity: s.activity,
      $member: s.memberId,
      $status: s.status ?? 'interested',
      $note: s.note ?? null,
      $by: actorId,
      $at: at,
    });
  appendJournal(db, { at, actorId, action: 'activity.signup', entity: `activity:${s.activity}`, before: null, after: s });
}

export function listActivitySignups(db: Database): JsonMap[] {
  return db
    .query(
      `SELECT a.activity, a.status, a.note, a.updated_at, m.display_name
         FROM activity_signups a
         JOIN members m ON m.id = a.member_id
        ORDER BY a.activity, m.display_name`,
    )
    .all() as JsonMap[];
}

export function renderProxyList(db: Database): string {
  const rows = listVoteProxies(db);
  if (!rows.length) return '(no vote proxies)';
  return rows
    .map((p) => `#${p.id} ${memberName(db, p.from_member_id)} follows ${memberName(db, p.to_member_id)}${p.decision_id ? ` for decision #${p.decision_id}` : ''}${p.note ? ` — ${p.note}` : ''}`)
    .join('\n');
}

export function renderRecommendationList(db: Database): string {
  const rows = listRecommendations(db);
  if (!rows.length) return '(no recommendations)';
  return rows
    .map((r) => `#${r.id} [${r.category}] ${r.title} · ${r.status} · confidence ${r.confidence}${r.source_checked_at ? ` · checked ${r.source_checked_at}` : ''}${r.note ? ` — ${r.note}` : ''}`)
    .join('\n');
}

export function renderActivitySignups(db: Database): string {
  const rows = listActivitySignups(db);
  if (!rows.length) return '(no activity signups)';
  const byActivity = new Map<string, string[]>();
  for (const r of rows) {
    const line = `${r.display_name} [${r.status}]${r.note ? ` — ${r.note}` : ''}`;
    byActivity.set(String(r.activity), [...(byActivity.get(String(r.activity)) ?? []), line]);
  }
  return [...byActivity.entries()].map(([activity, people]) => `${activity}: ${people.join(', ')}`).join('\n');
}
