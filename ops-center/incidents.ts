import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { IncidentRow } from './opsdb.js';

export interface IncidentSignal {
  scopeKey: string;
  groupId?: string;
  kind: string;
  severity: 'warn' | 'error';
  summary: string;
  evidence?: unknown;
  recommendation: string;
}

interface IncidentDraft {
  scopeKey: string;
  groupId: string | null;
  severity: 'warn' | 'error';
  title: string;
  summary: string;
  evidence: unknown[];
  recommendation: string;
}

function drafts(signals: IncidentSignal[]): IncidentDraft[] {
  const grouped = new Map<string, IncidentSignal[]>();
  for (const signal of signals) {
    const bucket = grouped.get(signal.scopeKey) ?? [];
    bucket.push(signal);
    grouped.set(signal.scopeKey, bucket);
  }
  return [...grouped.entries()].map(([scopeKey, rows]) => {
    const severity = rows.some((r) => r.severity === 'error') ? 'error' : 'warn';
    const groupId = rows.find((r) => r.groupId)?.groupId ?? null;
    const kinds = rows.map((r) => r.kind.replace(/_/g, ' '));
    return {
      scopeKey,
      groupId,
      severity,
      title: groupId ? `${severity === 'error' ? 'Degraded' : 'Attention'}: ${groupId}` : kinds.join(' + '),
      summary: rows.map((r) => r.summary).join(' '),
      evidence: rows.map((r) => ({ kind: r.kind, detail: r.evidence ?? null })),
      recommendation: [...new Set(rows.map((r) => r.recommendation))].join(' Then '),
    };
  });
}

/**
 * Reconcile current red/warn signals into one durable incident per scope.
 * Missing scopes are resolved, while changing evidence updates the existing
 * incident rather than creating alert noise.
 */
export function reconcileIncidents(
  db: Database.Database,
  signals: IncidentSignal[],
  now: Date = new Date(),
): { opened: string[]; resolved: string[] } {
  const ts = now.toISOString();
  const active = drafts(signals);
  const activeScopes = new Set(active.map((d) => d.scopeKey));
  const opened: string[] = [];
  const resolved: string[] = [];
  const findOpen = db.prepare("SELECT id FROM incidents WHERE scope_key = ? AND status = 'open' LIMIT 1");
  const update = db.prepare(
    `UPDATE incidents SET severity = ?, title = ?, summary = ?, evidence_json = ?,
       recommendation = ?, updated_at = ? WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO incidents
      (id, scope_key, group_id, status, severity, title, summary, evidence_json,
       recommendation, opened_at, updated_at, resolved_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const tx = db.transaction(() => {
    for (const d of active) {
      const existing = findOpen.get(d.scopeKey) as { id: string } | undefined;
      const evidence = JSON.stringify(d.evidence);
      if (existing) {
        update.run(d.severity, d.title, d.summary, evidence, d.recommendation, ts, existing.id);
      } else {
        const id = randomUUID();
        insert.run(id, d.scopeKey, d.groupId, d.severity, d.title, d.summary, evidence, d.recommendation, ts, ts);
        opened.push(id);
      }
    }
    const openRows = db.prepare("SELECT id, scope_key FROM incidents WHERE status = 'open'").all() as {
      id: string;
      scope_key: string;
    }[];
    const resolve = db.prepare(
      "UPDATE incidents SET status = 'resolved', updated_at = ?, resolved_at = ? WHERE id = ?",
    );
    for (const row of openRows) {
      if (!activeScopes.has(row.scope_key)) {
        resolve.run(ts, ts, row.id);
        resolved.push(row.id);
      }
    }
  });
  tx();
  return { opened, resolved };
}

export function getIncident(db: Database.Database, id: string): IncidentRow | undefined {
  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined;
}
