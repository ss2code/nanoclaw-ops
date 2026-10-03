import type { Database } from 'bun:sqlite';
import { appendJournal } from './db';

// Index over the per-trip assets/ folder (§16): docs, photos, tickets, maps.
// Queryable + attributable. The deterministic backbone under the future
// Document Vault / Photos features and the archive zip.

export interface AssetRow {
  id: number;
  kind: string;
  label: string | null;
  path: string;
  added_by: number | null;
  stage: string | null;
  tags: string;
  created_at: string;
  day_date: string | null;
  place_id: number | null;
}

export function indexAsset(
  db: Database,
  a: { kind: string; label?: string | null; path: string; addedBy?: number | null; stage?: string | null; tags?: string[]; dayDate?: string | null; placeId?: number | null },
  at: string,
): number {
  const res = db
    .query(
      `INSERT INTO assets (kind, label, path, added_by, stage, tags, created_at, day_date, place_id)
       VALUES ($k, $l, $p, $by, $s, $tags, $at, $day, $place)`,
    )
    .run({
      $k: a.kind,
      $l: a.label ?? null,
      $p: a.path,
      $by: a.addedBy ?? null,
      $s: a.stage ?? null,
      $tags: JSON.stringify(a.tags ?? []),
      $at: at,
      $day: a.dayDate ?? null,
      $place: a.placeId ?? null,
    });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, {
    at,
    actorId: a.addedBy ?? null,
    action: 'asset.index',
    entity: `asset:${id}`,
    before: null,
    after: { id, kind: a.kind, label: a.label ?? null, path: a.path },
  });
  return id;
}

export function listAssets(db: Database, opts?: { kind?: string; dayDate?: string; placeId?: number }): AssetRow[] {
  const where: string[] = [];
  const bind: Record<string, unknown> = {};
  if (opts?.kind) { where.push('kind = $k'); bind.$k = opts.kind; }
  if (opts?.dayDate) { where.push('day_date = $day'); bind.$day = opts.dayDate; }
  if (opts?.placeId != null) { where.push('place_id = $place'); bind.$place = opts.placeId; }
  return db.query(`SELECT * FROM assets${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`).all(bind) as AssetRow[];
}
