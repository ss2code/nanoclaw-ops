import type Database from 'better-sqlite3';
import { sumWindow } from './opsdb.js';
import type { MessageJourney } from './readers/sessiondbs.js';

export interface GroupSlo {
  windowDays: number;
  messagesIn: number;
  messagesOut: number;
  responseRatio: number | null;
  latencyP95ProxyMs: number | null;
  tokensPerResponse: number | null;
  unansweredSamples: number;
  passiveCanary: {
    status: 'healthy' | 'stale' | 'unknown';
    lastDeliveredAt: string | null;
    ageMs: number | null;
  };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Baselines use the existing bounded samples. Latency is explicitly a proxy:
 * p95 of per-minute maxima, because v1 did not persist individual latencies.
 */
export function calculateGroupSlo(
  db: Database.Database,
  groupId: string,
  journeys: MessageJourney[],
  now: Date = new Date(),
  windowDays = 7,
  passiveCanaryMaxAgeMs = 24 * 3_600_000,
): GroupSlo {
  const fromIso = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const messagesIn = sumWindow(db, groupId, 'msgs_in', fromIso, now);
  const messagesOut = sumWindow(db, groupId, 'msgs_out', fromIso, now);
  const tokenOut = sumWindow(db, groupId, 'tokens_out.%', fromIso, now, true);
  const latencyRows = db
    .prepare(
      `SELECT value FROM samples
       WHERE group_id = ? AND metric = 'latency_ms_max' AND ts >= ? AND ts <= ?`,
    )
    .all(groupId, fromIso, now.toISOString()) as { value: number }[];
  const unansweredSamples = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM samples
         WHERE group_id = ? AND metric = 'unanswered' AND value > 0 AND ts >= ? AND ts <= ?`,
      )
      .get(groupId, fromIso, now.toISOString()) as { n: number }
  ).n;
  const delivered = journeys.filter((j) => j.deliveredAt).sort((a, b) => (a.deliveredAt! < b.deliveredAt! ? 1 : -1))[0];
  const lastDeliveredAt = delivered?.deliveredAt ?? null;
  const ageMs = lastDeliveredAt ? Math.max(0, now.getTime() - new Date(lastDeliveredAt).getTime()) : null;
  return {
    windowDays,
    messagesIn,
    messagesOut,
    responseRatio: messagesIn > 0 ? Math.min(1, messagesOut / messagesIn) : null,
    latencyP95ProxyMs: percentile(
      latencyRows.map((r) => r.value),
      0.95,
    ),
    tokensPerResponse: messagesOut > 0 ? tokenOut / messagesOut : null,
    unansweredSamples,
    passiveCanary: {
      status: ageMs == null ? 'unknown' : ageMs <= passiveCanaryMaxAgeMs ? 'healthy' : 'stale',
      lastDeliveredAt,
      ageMs,
    },
  };
}
