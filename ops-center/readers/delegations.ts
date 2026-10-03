/**
 * a2a delegation ledger reader. The host writes one row per cross-group
 * agent route into `a2a_delegations` in the central DB (migration 022,
 * src/modules/agent-to-agent/agent-route.ts). This reader pairs request and
 * reply legs (`reply.in_reply_to = request.a2a_msg_id`) into exchanges and
 * computes the aggregate effectiveness stats the Delegations panel shows.
 *
 * The table is the durable historical record for "is delegation working?" —
 * host logs rotate, transcripts get archived, but these rows persist.
 */
import { withCentral } from './central.js';

export interface DelegationLedgerRow {
  id: number;
  ts: string;
  from_group: string;
  to_group: string;
  from_session: string;
  to_session: string;
  a2a_msg_id: string;
  in_reply_to: string | null;
  tier: string | null;
  escalation: string | null;
  summary: string;
  file_count: number;
}

export interface DelegationExchange {
  request: DelegationLedgerRow;
  reply: DelegationLedgerRow | null;
  outcome: 'answered' | 'escalated' | 'pending';
  latencyMs: number | null;
}

export interface DelegationStats {
  windowDays: number;
  total: number;
  answered: number;
  escalated: number;
  pending: number;
  byTier: Record<string, { total: number; escalated: number }>;
}

export interface A2aRunTag {
  direction: 'sent' | 'received';
  ts: string;
  a2aMsgId: string;
  inReplyTo: string | null;
  sourceGroupId: string;
  destinationGroupId: string;
  sourceSessionId: string;
  destinationSessionId: string;
  tier: string | null;
  escalation: string | null;
  summary: string;
  fileCount: number;
}

export const A2A_TOOL_TAG_WINDOW_MS = 120_000;

/** Return a nearby durable A2A send tag, never an arbitrarily old one. */
export function nearestA2aSentTag(
  tags: A2aRunTag[],
  at: number,
  maxDistanceMs = A2A_TOOL_TAG_WINDOW_MS,
): A2aRunTag | null {
  if (!Number.isFinite(at) || !Number.isFinite(maxDistanceMs) || maxDistanceMs < 0) return null;
  return (
    tags
      .filter((tag) => tag.direction === 'sent')
      .map((tag) => ({ tag, distance: Math.abs(Date.parse(tag.ts) - at) }))
      .filter(({ distance }) => Number.isFinite(distance) && distance <= maxDistanceMs)
      .sort((a, b) => a.distance - b.distance)[0]?.tag ?? null
  );
}

function readRows(limit: number): DelegationLedgerRow[] {
  try {
    return withCentral(
      (db) => db.prepare('SELECT * FROM a2a_delegations ORDER BY id DESC LIMIT ?').all(limit) as DelegationLedgerRow[],
    );
  } catch {
    // Table absent until the host has run migration 022 — render as empty.
    return [];
  }
}

/**
 * Build stable per-run A2A tags from the durable ledger. The host log is only
 * a secondary debug source: it rotates and can disappear before Runs renders.
 */
export function indexA2aRunTags(rows: DelegationLedgerRow[]): Map<string, A2aRunTag[]> {
  const indexed = new Map<string, A2aRunTag[]>();
  const add = (key: string, tag: A2aRunTag): void => {
    const list = indexed.get(key) ?? [];
    list.push(tag);
    indexed.set(key, list);
  };
  for (const row of rows) {
    const common = {
      ts: row.ts,
      a2aMsgId: row.a2a_msg_id,
      inReplyTo: row.in_reply_to,
      sourceGroupId: row.from_group,
      destinationGroupId: row.to_group,
      sourceSessionId: row.from_session,
      destinationSessionId: row.to_session,
      tier: row.tier,
      escalation: row.escalation,
      summary: row.summary,
      fileCount: row.file_count,
    };
    add(`${row.from_group}:${row.from_session}`, { direction: 'sent', ...common });
    add(`${row.to_group}:${row.to_session}`, { direction: 'received', ...common });
  }
  return indexed;
}

export function readA2aRunTags(limit = 5000): Map<string, A2aRunTag[]> {
  return indexA2aRunTags(readRows(limit));
}

/**
 * Pair request and reply legs into exchanges, newest first. A row is a reply
 * leg when its `in_reply_to` points at another ledger row's `a2a_msg_id`;
 * every other row is a request. Requests without a reply yet are `pending`,
 * replies carrying an `[escalate: …]` block mark the exchange `escalated`.
 */
export function readDelegationExchanges(limit = 50): DelegationExchange[] {
  const rows = readRows(Math.max(limit * 4, 200));
  const byMsgId = new Map(rows.map((r) => [r.a2a_msg_id, r]));
  const replies = new Map<string, DelegationLedgerRow>();
  const requests: DelegationLedgerRow[] = [];
  for (const row of rows) {
    if (row.in_reply_to && byMsgId.has(row.in_reply_to)) {
      // Keep the earliest reply per request (rows are newest-first).
      replies.set(row.in_reply_to, row);
    } else {
      requests.push(row);
    }
  }
  return requests.slice(0, limit).map((request) => {
    const reply = replies.get(request.a2a_msg_id) ?? null;
    const latencyMs = reply ? Date.parse(reply.ts) - Date.parse(request.ts) : null;
    return {
      request,
      reply,
      outcome: reply ? (reply.escalation ? 'escalated' : 'answered') : 'pending',
      latencyMs: latencyMs != null && Number.isFinite(latencyMs) ? latencyMs : null,
    };
  });
}

export function delegationStats(windowDays = 30): DelegationStats {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const exchanges = readDelegationExchanges(1000).filter((x) => x.request.ts >= cutoff);
  const stats: DelegationStats = {
    windowDays,
    total: exchanges.length,
    answered: 0,
    escalated: 0,
    pending: 0,
    byTier: {},
  };
  for (const x of exchanges) {
    if (x.outcome === 'answered') stats.answered++;
    else if (x.outcome === 'escalated') stats.escalated++;
    else stats.pending++;
    const tier = x.request.tier ?? '(none)';
    const t = (stats.byTier[tier] ??= { total: 0, escalated: 0 });
    t.total++;
    if (x.outcome === 'escalated') t.escalated++;
  }
  return stats;
}
