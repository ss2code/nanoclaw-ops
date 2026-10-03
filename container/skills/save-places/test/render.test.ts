import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlaceStore } from '../scripts/db';
import { renderRegion } from '../scripts/render';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('regional dashboard rendering', () => {
  test('renders separate self-contained regional files and safely embeds user text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-places-render-'));
    dirs.push(dir);
    const db = new PlaceStore(dir);
    db.ingest({
      ingestVersion: 1,
      idempotencyKey: 'render:1',
      source: { url: 'https://example.com/place' },
      member: { localId: 'member-1', displayAlias: 'Sam' },
      places: [{
        name: 'Cafe </script><script>alert(1)</script>',
        locality: 'Bengaluru',
        categories: ['food-drink'],
        activity: {
          type: 'visit',
          visitState: 'visited',
          rating: 4,
          comment: '<img src=x onerror=alert(2)>',
          visibility: 'group',
        },
      }],
    });

    const bangalore = renderRegion(db, { regionId: 'bangalore' });
    const bayArea = renderRegion(db, { regionId: 'bay-area' });
    const html = readFileSync(bangalore.htmlPath, 'utf8');
    expect(html).toContain('document-version');
    expect(html).toContain('id="places-data"');
    expect(html).not.toContain('class="map-panel"');
    expect(html).toContain('class="recent-panel"');
    expect(html).toContain('Latest additions');
    expect(html).toContain('recent-tile');
    expect(html).toContain('class="category-tabs"');
    expect(html).toContain('View full place record');
    expect(html).toContain("el('div','detail-body')");
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(JSON.parse(readFileSync(bangalore.jsonPath, 'utf8')).places).toHaveLength(1);
    expect(JSON.parse(readFileSync(bayArea.jsonPath, 'utf8')).places).toHaveLength(0);
    db.close();
  });

  test('share profile removes group-only comments and member aliases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-places-share-'));
    dirs.push(dir);
    const db = new PlaceStore(dir);
    const placeId = db.ingest({
      ingestVersion: 1,
      idempotencyKey: 'share:1',
      member: { localId: 'member-1', displayAlias: 'Private Name' },
      places: [{
        name: 'Public Garden',
        locality: 'Oakland',
        activity: { type: 'visit', visitState: 'visited', comment: 'Private note', visibility: 'group' },
      }],
    }).mutations[0].placeId!;
    db.addMemberActivity(
      placeId,
      { localId: 'member-2', displayAlias: 'Another Name' },
      { type: 'comment', comment: 'Shareable note', visibility: 'shareable' },
      'share:2',
    );

    const rendered = renderRegion(db, { regionId: 'bay-area', profile: 'share' });
    const payload = JSON.parse(readFileSync(rendered.jsonPath, 'utf8'));
    expect(JSON.stringify(payload)).not.toContain('Private Name');
    expect(JSON.stringify(payload)).not.toContain('Another Name');
    expect(JSON.stringify(payload)).not.toContain('Private note');
    expect(JSON.stringify(payload)).toContain('Shareable note');
    expect(payload.places[0].activities[0].displayAlias).toBe('A member');
    expect(payload.places[0].summary.visited).toBe(0);
    expect(payload.places[0].memberStates).toHaveLength(1);
    db.close();
  });
});
