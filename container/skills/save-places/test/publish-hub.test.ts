import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PlaceStore } from '../scripts/db';
import { publishRegionToHub } from '../scripts/publish-hub';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('NanoClaw hub publication', () => {
  test('publishes a stable status tracker and verifies the JSON sidecar revision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-places-publish-'));
    const hub = mkdtempSync(join(tmpdir(), 'save-places-hub-'));
    dirs.push(dir, hub);
    const db = new PlaceStore(dir);
    db.ingest({
      ingestVersion: 1,
      idempotencyKey: 'publish:1',
      member: { localId: 'member', displayAlias: 'Sam' },
      places: [{ name: 'Lalbagh', locality: 'Bengaluru', categories: ['nature'] }],
    });
    const script = resolve(import.meta.dir, '..', '..', 'nano-pvt-hub', 'hub.mjs');

    const first = publishRegionToHub(db, { regionId: 'bangalore', hubRoot: hub, hubScript: script });
    expect(first.trackerId).toBe('places-bangalore');
    expect(first.verified).toBe(true);
    const root = join(hub, 'trackers', 'shared', 'places-bangalore');
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const payload = JSON.parse(readFileSync(join(root, 'data', 'places.json'), 'utf8'));
    expect(manifest.shape).toBe('status');
    expect(manifest.series).toBe('places');
    expect(payload.revision).toBe(db.revision());
    expect(payload.places).toHaveLength(1);

    db.addMemberActivity(
      first.regionId === 'bangalore' ? db.listPlaces()[0].id : '',
      { localId: 'member', displayAlias: 'Sam' },
      { type: 'comment', comment: 'Bring a picnic' },
      'publish:2',
    );
    const second = publishRegionToHub(db, { regionId: 'bangalore', hubRoot: hub, hubScript: script });
    expect(second.trackerId).toBe(first.trackerId);
    expect(JSON.parse(readFileSync(join(root, 'data', 'places.json'), 'utf8')).revision).toBe(db.revision());
    db.close();
  });
});

