import type { Database } from 'bun:sqlite';
import { appendJournal } from '../../trip-core/scripts/db';

// The normalized location every other plan table references (§7). Ratings and
// review_count are DETERMINISTIC (from Maps); review_summary is LLM-written and
// must be grounded by a cited source link (§10). Every place carries a map link.

export interface PlaceRow {
  id: number;
  name: string;
  kind: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  gmaps_place_id: string | null;
  map_url: string | null;
  rating: number | null;
  review_count: number | null;
  review_summary: string | null;
  open_hours: string | null;
}

/** General field setter for deterministic place facts. Undefined leaves a field alone. */
export function setPlace(db: Database, id: number, patch: { name?: string; mapUrl?: string | null; openHours?: string | null }, actorId: number | null, at: string): void {
  const before = getPlace(db, id);
  if (!before) throw new Error(`place ${id} not found`);
  const after = { ...before, name: patch.name ?? before.name, map_url: patch.mapUrl ?? before.map_url, open_hours: patch.openHours ?? before.open_hours };
  db.query('UPDATE places SET name=$name, map_url=$map, open_hours=$hours WHERE id=$id').run({ $id: id, $name: after.name, $map: after.map_url, $hours: after.open_hours });
  appendJournal(db, { at, actorId, action: 'place.set', entity: `place:${id}`, before, after });
}

export function parseGoogleMapsLatLng(url: string | null | undefined): { lat: number; lng: number } | null {
  if (!url) return null;
  const at = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|z|$)/);
  if (at) return { lat: Number(at[1]), lng: Number(at[2]) };
  const bang = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (bang) return { lat: Number(bang[1]), lng: Number(bang[2]) };
  const query = url.match(/[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:&|$)/);
  if (query) return { lat: Number(query[1]), lng: Number(query[2]) };
  return null;
}

export function addPlace(
  db: Database,
  p: {
    name: string;
    kind?: string | null;
    address?: string | null;
    lat?: number | null;
    lng?: number | null;
    gmapsPlaceId?: string | null;
    mapUrl?: string | null;
  },
  actorId: number | null,
  at: string,
): number {
  const parsed = parseGoogleMapsLatLng(p.mapUrl);
  const lat = p.lat ?? parsed?.lat ?? null;
  const lng = p.lng ?? parsed?.lng ?? null;
  const res = db
    .query(
      `INSERT INTO places (name, kind, address, lat, lng, gmaps_place_id, map_url)
       VALUES ($n, $k, $a, $lat, $lng, $g, $m)`,
    )
    .run({
      $n: p.name,
      $k: p.kind ?? null,
      $a: p.address ?? null,
      $lat: lat,
      $lng: lng,
      $g: p.gmapsPlaceId ?? null,
      $m: p.mapUrl ?? null,
    });
  const id = Number(res.lastInsertRowid);
  appendJournal(db, { at, actorId, action: 'plan.place.add', entity: `place:${id}`, before: null, after: { id, name: p.name } });
  return id;
}

export function getPlace(db: Database, id: number): PlaceRow | null {
  return db.query('SELECT * FROM places WHERE id = $id').get({ $id: id }) as PlaceRow | null;
}

/** Set the deterministic rating/review_count (from Maps) + the cited LLM review summary. */
export function setReviewDigest(
  db: Database,
  id: number,
  rating: number | null,
  reviewCount: number | null,
  summary: string | null,
  sourceUrl: string | null,
  at: string,
): void {
  const before = getPlace(db, id);
  if (!before) throw new Error(`place ${id} not found`);
  // The summary must be grounded — keep the source link inside map_url's sibling
  // field only if provided; here we store the digest text. The agent supplies a
  // cited summary; the script never invents ratings.
  db.query('UPDATE places SET rating = $r, review_count = $c, review_summary = $s WHERE id = $id').run({
    $r: rating,
    $c: reviewCount,
    $s: summary,
    $id: id,
  });
  appendJournal(db, {
    at,
    actorId: null,
    action: 'plan.place.review',
    entity: `place:${id}`,
    before,
    after: { rating, review_count: reviewCount, source_url: sourceUrl },
  });
}

const STAY_KEYS = ['wifi', 'door_code', 'host_phone', 'checkout_time', 'house_rules', 'address_local'];
const SAFETY_KEYS = ['emergency', 'hospital', 'pharmacy', 'police', 'embassy'];
export function setPlaceInfo(db: Database, placeId: number, key: string, value: string, sourceUrl: string | null, actorId: number | null, at: string): void {
  if (!getPlace(db, placeId)) throw new Error(`place ${placeId} not found`);
  const before = db.query('SELECT * FROM place_info WHERE place_id=$p AND key=$k').get({ $p: placeId, $k: key });
  db.query(`INSERT INTO place_info (place_id,key,value,source_url,updated_by,updated_at) VALUES ($p,$k,$v,$s,$by,$at) ON CONFLICT(place_id,key) DO UPDATE SET value=excluded.value,source_url=excluded.source_url,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run({ $p: placeId, $k: key, $v: value, $s: sourceUrl, $by: actorId, $at: at });
  appendJournal(db, { at, actorId, action: 'place.info.set', entity: `place:${placeId}:${key}`, before, after: { value, source_url: sourceUrl } });
}
export function unsetPlaceInfo(db: Database, placeId: number, key: string, actorId: number | null, at: string): void {
  const before = db.query('SELECT * FROM place_info WHERE place_id=$p AND key=$k').get({ $p: placeId, $k: key });
  db.query('DELETE FROM place_info WHERE place_id=$p AND key=$k').run({ $p: placeId, $k: key });
  appendJournal(db, { at, actorId, action: 'place.info.unset', entity: `place:${placeId}:${key}`, before, after: null });
}
export function stayCard(db: Database, date: string, stayId?: number): any {
  const stay = stayId == null
    ? db.query(`SELECT s.*,p.name,p.address,p.map_url FROM stays s JOIN places p ON p.id=s.place_id WHERE s.status='committed' AND s.check_in <= $date AND s.check_out > $date ORDER BY s.check_in LIMIT 1`).get({ $date: date })
    : db.query('SELECT s.*,p.name,p.address,p.map_url FROM stays s JOIN places p ON p.id=s.place_id WHERE s.id=$id').get({ $id: stayId });
  if (!stay) throw new Error(`no committed stay covers ${date} — pass --stay`);
  const info = db.query('SELECT key,value,source_url FROM place_info WHERE place_id=$p ORDER BY key').all({ $p: (stay as any).place_id }) as any[];
  return { stay, info, missing: STAY_KEYS.filter((k) => !info.some((i) => i.key === k)) };
}
export function safetyCard(db: Database, date: string, destinationId?: number): any {
  const dest = destinationId == null
    ? db.query(`SELECT d.*,p.name,p.address,p.map_url FROM destinations d JOIN places p ON p.id=d.place_id JOIN stays s ON s.destination_id=d.id WHERE d.status='committed' AND s.status='committed' AND s.check_in <= $date AND s.check_out > $date ORDER BY d.order_index LIMIT 1`).get({ $date: date })
    : db.query('SELECT d.*,p.name,p.address,p.map_url FROM destinations d JOIN places p ON p.id=d.place_id WHERE d.id=$id').get({ $id: destinationId });
  if (!dest) throw new Error(`no committed destination covers ${date} — pass --destination`);
  const rows = db.query('SELECT key,value,source_url FROM place_info WHERE place_id=$p').all({ $p: (dest as any).place_id }) as any[];
  const info = [...rows].sort((a,b) => (SAFETY_KEYS.indexOf(a.key) + 99 * Number(!SAFETY_KEYS.includes(a.key))) - (SAFETY_KEYS.indexOf(b.key) + 99 * Number(!SAFETY_KEYS.includes(b.key))));
  return { destination: dest, info, missing: SAFETY_KEYS.filter((k) => !rows.some((i) => i.key === k)) };
}
