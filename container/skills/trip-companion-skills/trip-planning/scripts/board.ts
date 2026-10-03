import type { Database } from 'bun:sqlite';

// The live plan board (§8): a DETERMINISTIC render of current trip.db state,
// available from the first turn. Because it's projected from the DB (not
// narrated from memory) it's always consistent, works mid-build, and the same
// projection drives the completeness %. Feasibility errors are passed in
// (computed by feasibility.ts) and overlaid as ⚠️ — the board never asserts
// viability itself (§10).

export const BADGE = { open: '⬜', shortlisted: '🟡', deciding: '⏳', committed: '✅', warning: '⚠️' } as const;

export interface BoardSection {
  label: string;
  badge: string;
  detail: string;
  day?: number;
}

export interface FeasibilityError {
  section: string;
  day?: number;
  message: string;
}

export interface Board {
  text: string;
  completeness: number;
  sections: BoardSection[];
}

function statusBadge(statuses: string[]): string {
  if (statuses.length === 0) return BADGE.open;
  if (statuses.every((s) => s === 'committed')) return BADGE.committed;
  if (statuses.some((s) => s === 'committed' || s === 'shortlisted')) return BADGE.shortlisted;
  return BADGE.open;
}

function activeMemberCount(db: Database): number {
  return (db.query('SELECT COUNT(*) AS n FROM members WHERE left_at IS NULL').get() as { n: number }).n;
}

export function renderBoard(db: Database, opts?: { errors?: FeasibilityError[] }): Board {
  const sections: BoardSection[] = [];

  // Where (route)
  const dests = db
    .query(
      `SELECT d.status AS status, COALESCE(p.name, 'destination ' || d.id) AS name
       FROM destinations d LEFT JOIN places p ON p.id = d.place_id ORDER BY d.order_index, d.id`,
    )
    .all() as { status: string; name: string }[];
  sections.push({
    label: 'Where',
    badge: statusBadge(dests.map((d) => d.status)),
    detail: dests.filter((d) => d.status === 'committed').map((d) => d.name).join(', ') || 'not started',
  });

  // Stay
  const stays = db
    .query(
      `SELECT s.status AS status, COALESCE(p.name, 'stay ' || s.id) AS name
       FROM stays s LEFT JOIN places p ON p.id = s.place_id ORDER BY s.id`,
    )
    .all() as { status: string; name: string }[];
  sections.push({
    label: 'Stay',
    badge: statusBadge(stays.map((s) => s.status)),
    detail: stays.filter((s) => s.status === 'committed').map((s) => s.name).join(', ') || 'not chosen',
  });

  // Flights (per-person legs): need inbound + outbound per active member
  const needed = activeMemberCount(db) * 2;
  const committedLegs = (db.query("SELECT COUNT(*) AS n FROM legs WHERE status = 'committed'").get() as { n: number }).n;
  const anyLegs = (db.query('SELECT COUNT(*) AS n FROM legs').get() as { n: number }).n;
  sections.push({
    label: 'Flights',
    badge: committedLegs === 0 ? (anyLegs ? BADGE.shortlisted : BADGE.open) : committedLegs >= needed ? BADGE.committed : BADGE.shortlisted,
    detail: `${committedLegs}/${needed} legs committed`,
  });

  // One section per day
  const days = db.query('SELECT id, date FROM days ORDER BY date, id').all() as { id: number; date: string }[];
  days.forEach((d, i) => {
    const items = db.query('SELECT status FROM itinerary_items WHERE day_id = $d').all({ $d: d.id }) as {
      status: string;
    }[];
    const committed = items.filter((it) => it.status === 'committed').length;
    sections.push({
      label: `Day ${i + 1} (${d.date})`,
      badge: statusBadge(items.map((it) => it.status)),
      detail: items.length ? `${committed}/${items.length} items committed` : 'not started',
      day: d.id,
    });
  });

  // Meals (across all days)
  const meals = db.query('SELECT status FROM meals').all() as { status: string }[];
  sections.push({
    label: 'Meals',
    badge: statusBadge(meals.map((m) => m.status)),
    detail: meals.length ? `${meals.filter((m) => m.status === 'committed').length}/${meals.length} picked` : 'not picked yet',
  });

  // Overlay feasibility errors as ⚠️ on matching sections
  for (const e of opts?.errors ?? []) {
    const sec =
      sections.find((s) => (e.day != null && s.day === e.day) || s.label === e.section) ??
      sections.find((s) => s.label.startsWith(e.section));
    if (sec) {
      sec.badge = BADGE.warning;
      sec.detail = sec.detail === 'not started' || !sec.detail ? e.message : `${e.message}`;
    }
  }

  const total = sections.length;
  const done = sections.filter((s) => s.badge === BADGE.committed).length;
  const completeness = total ? Math.round((100 * done) / total) : 0;

  const trip = db.query('SELECT name, pace_cap_minutes FROM trip WHERE id = 1').get() as { name: string; pace_cap_minutes: number | null } | null;
  const alternates = db.query(`SELECT a.title,p.title AS primary_title FROM itinerary_items a JOIN itinerary_items p ON p.id=a.alternate_for_item_id WHERE a.status != 'rejected' ORDER BY a.id`).all() as { title: string; primary_title: string }[];
  const header = `${trip?.name ?? 'Trip'} — plan so far · ${completeness}% set${trip?.pace_cap_minutes ? ` · pace cap ${trip.pace_cap_minutes}m` : ''}`;
  const body = sections.map((s) => `  ${s.badge} ${s.label}: ${s.detail}`).join('\n');
  const altLines = alternates.map((a) => `  ↩ alt: ${a.title} (for ${a.primary_title})`).join('\n');
  return { text: `${header}\n${body}${altLines ? `\n${altLines}` : ''}`, completeness, sections };
}
