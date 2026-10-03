import type { Database } from 'bun:sqlite';
import { getStage, type Stage } from './lifecycle';
import { participantsForStage, type ParticipationRow } from './participation';
import { openNotes } from './scratchpad';
import { closedDecisions, openDecisions } from './decisions';

// Deterministic grounding (§13). The agent NEVER holds working state in its head
// between wakes — it write-throughs to trip.db (tier 1) and reads it back here.
// A restart reloads the identical state because this is a pure projection of the
// DB: stage, per-stage roster, candidates + statuses, open/closed decisions, the
// scratchpad. No invented rows; nothing remembered from chat.

export interface Recap {
  stage: Stage;
  roster: ParticipationRow[];
  decisions: {
    open: { id: number; question: string; mode: string; commit_by: string | null }[];
    closed: { id: number; question: string; outcome: string | null }[];
  };
  scratchpad: { id: number; topic: string | null; note: string }[];
  /** Planning candidates with their status — empty until trip-planning's tables exist. */
  candidates: { table: string; id: number; label: string; status: string }[];
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $n").get({ $n: name }) != null;
}

/**
 * Read candidate/shortlisted/committed planning rows from whichever planning
 * tables are present. Feature-detected so trip-core works standalone (Phase 1)
 * and richer once trip-planning has migrated its tables into the same DB.
 */
function readCandidates(db: Database): Recap['candidates'] {
  const out: Recap['candidates'] = [];
  // destinations: label via the linked place name when places exists.
  if (tableExists(db, 'destinations')) {
    const hasPlaces = tableExists(db, 'places');
    const rows = hasPlaces
      ? (db
          .query(
            `SELECT d.id AS id, COALESCE(p.name, 'destination ' || d.id) AS label, d.status AS status
             FROM destinations d LEFT JOIN places p ON p.id = d.place_id ORDER BY d.id`,
          )
          .all() as { id: number; label: string; status: string }[])
      : (db.query('SELECT id, id AS label, status FROM destinations ORDER BY id').all() as {
          id: number;
          label: string | number;
          status: string;
        }[]);
    for (const r of rows) out.push({ table: 'destinations', id: r.id, label: String(r.label), status: r.status });
  }
  if (tableExists(db, 'itinerary_items')) {
    const rows = db.query('SELECT id, title, status FROM itinerary_items ORDER BY id').all() as {
      id: number;
      title: string;
      status: string;
    }[];
    for (const r of rows) out.push({ table: 'itinerary_items', id: r.id, label: r.title, status: r.status });
  }
  return out;
}

export function buildRecap(db: Database): Recap {
  const stage = getStage(db);
  return {
    stage,
    roster: participantsForStage(db, stage),
    decisions: {
      open: openDecisions(db).map((d) => ({ id: d.id, question: d.question, mode: d.mode, commit_by: d.commit_by })),
      closed: closedDecisions(db).map((d) => ({ id: d.id, question: d.question, outcome: d.outcome })),
    },
    scratchpad: openNotes(db).map((n) => ({ id: n.id, topic: n.topic, note: n.note })),
    candidates: readCandidates(db),
  };
}

function whatsappMentionHandle(platformId: string | null): string | null {
  const match = platformId?.match(/^whatsapp:(\d+)@s\.whatsapp\.net$/);
  return match ? `@${match[1]}` : null;
}

/** Stable text render for the agent to read at the top of a turn. */
export function renderRecap(recap: Recap): string {
  const lines: string[] = [];
  lines.push(`Stage: ${recap.stage}`);
  lines.push(
    `Roster (${recap.stage}): ` +
      (recap.roster.length ? recap.roster.map((r) => `${r.display_name} [${r.status}]`).join(', ') : '(none recorded)'),
  );
  const mentionHandles = recap.roster
    .map((r) => ({ name: r.display_name, mention: whatsappMentionHandle(r.platform_id) }))
    .filter((r): r is { name: string; mention: string } => r.mention != null);
  if (mentionHandles.length) {
    lines.push('Mention handles (internal; use only when directly tagging people, omit from summaries):');
    for (const r of mentionHandles) lines.push(`  · ${r.name}: ${r.mention}`);
  }
  if (recap.candidates.length) {
    lines.push('Candidates:');
    for (const c of recap.candidates) lines.push(`  · ${c.label} — ${c.status} (${c.table})`);
  }
  if (recap.decisions.open.length) {
    lines.push('Open decisions:');
    for (const d of recap.decisions.open) {
      lines.push(`  ⏳ ${d.question}${d.commit_by ? ` (locks ${d.commit_by})` : ''}`);
    }
  }
  if (recap.decisions.closed.length) {
    lines.push('Settled:');
    for (const d of recap.decisions.closed) lines.push(`  ✅ ${d.question} → ${d.outcome ?? '—'}`);
  }
  if (recap.scratchpad.length) {
    lines.push('Scratchpad (open):');
    for (const n of recap.scratchpad) lines.push(`  • ${n.topic ? `[${n.topic}] ` : ''}${n.note}`);
  }
  return lines.join('\n');
}
