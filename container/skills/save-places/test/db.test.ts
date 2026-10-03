import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlaceStore } from '../scripts/db';
import type { IngestEnvelope } from '../scripts/types';

const dirs: string[] = [];

function store(): PlaceStore {
  const dir = mkdtempSync(join(tmpdir(), 'save-places-db-'));
  dirs.push(dir);
  return new PlaceStore(dir);
}

function envelope(overrides: Partial<IngestEnvelope> = {}): IngestEnvelope {
  return {
    ingestVersion: 1,
    idempotencyKey: 'wa:message-1',
    source: { url: 'https://www.instagram.com/p/abc/?utm_source=chat' },
    member: { localId: 'whatsapp:+15550001', displayAlias: 'Sam' },
    places: [{
      name: 'Cubbon Park',
      locality: 'Bengaluru',
      categories: ['nature', 'walking'],
      tags: ['sunset'],
      verification: { state: 'verified', confidence: 0.94 },
      activity: { type: 'saved', interest: 'want-to-go', comment: 'Sunday morning?' },
    }],
    ...overrides,
  };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('PlaceStore', () => {
  test('seeds regions, routes a place, normalizes taxonomy, and replays idempotently', () => {
    const db = store();
    expect(db.listRegions().map((region) => region.id)).toEqual(['bangalore', 'bay-area']);

    const first = db.ingest(envelope());
    expect(first.ok).toBe(true);
    expect(first.affectedRegions).toEqual(['bangalore']);
    expect(first.mutations[0].status).toBe('created');
    const revision = first.revision;

    const replay = db.ingest(envelope());
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toBe(revision);
    expect(db.listPlaces()).toHaveLength(1);

    const place = db.listPlaces()[0];
    expect(place.categories).toEqual(['nature-scenery', 'hikes-walks-cycling']);
    expect(place.tags).toContain('sunset');
    expect(place.sources[0].url).not.toContain('utm_source');
    expect(place.summary.wantToGo).toBe(1);
    expect(db.doctor().ok).toBe(true);
    db.close();
  });

  test('extracts multiple destinations from one source and updates a strong duplicate', () => {
    const db = store();
    const initial = db.ingest(envelope({
      places: [
        { name: 'Lalbagh Botanical Garden', locality: 'Bengaluru', categories: ['nature'] },
        { name: 'MTR', locality: 'Bengaluru', categories: ['food'] },
      ],
    }));
    expect(initial.mutations.map((item) => item.status)).toEqual(['created', 'created']);

    const second = db.ingest(envelope({
      idempotencyKey: 'wa:message-2',
      places: [{
        name: 'MTR',
        locality: 'Bengaluru',
        categories: ['restaurant'],
        activity: { type: 'visit', visitState: 'visited', rating: 5, comment: 'Excellent dosa' },
      }],
    }));
    expect(second.mutations[0].status).toBe('updated');
    expect(db.listPlaces()).toHaveLength(2);
    expect(db.search('excellent dosa')[0].name).toBe('MTR');
    expect(db.search('food drink')).toHaveLength(1);
    db.close();
  });

  test('reingest repairs a partial write without duplicating the place, activity, evidence, or media', () => {
    const db = store();
    const key = 'whatsapp:message-42';
    const partial = envelope({
      idempotencyKey: key,
      places: [{ name: 'Nettigere Guruvayurappan Temple', locality: 'Kanakapura Road, Bengaluru', regionCandidate: 'bangalore' }],
    });
    db.ingest(partial);

    const rich = envelope({
      idempotencyKey: key,
      source: {
        url: 'https://www.instagram.com/reel/DYt7_9MyX09/?igsh=tracking',
        platform: 'instagram',
        title: 'Sri Guruvayoorappan Temple, Nettigere',
      },
      places: [{
        name: 'Nettigere Guruvayurappan Temple',
        address: 'Nettigere, Kanakapura Road',
        locality: 'Kanakapura Road, Bengaluru',
        neighborhood: 'Nettigere',
        regionCandidate: 'bangalore',
        categories: ['culture-history'],
        tags: ['kerala-style', 'peaceful'],
        verification: {
          state: 'verified',
          confidence: 0.9,
          references: [
            'https://www.explorebangalore.com/temples/netigere-guruvayurappan-temple',
            'TripAdvisor listing confirms the temple and visitor history',
          ],
        },
        activity: { type: 'saved', interest: 'want-to-go', comment: 'Strict dress code; peaceful setting.' },
        media: [{ kind: 'source-card', url: 'https://www.instagram.com/reel/DYt7_9MyX09/', alt: 'Temple reel' }],
      }],
    });
    const repaired = db.ingest(rich, { reingest: true });
    expect(repaired.replayed).toBe(false);
    expect(db.listPlaces()).toHaveLength(1);
    const place = db.listPlaces()[0];
    expect(place.address).toBe('Nettigere, Kanakapura Road');
    expect(place.evidence).toHaveLength(2);
    expect(place.media).toHaveLength(1);
    expect(place.activities).toHaveLength(1);
    expect(place.activities[0].comment).toContain('Strict dress code');

    const stableRevision = db.revision();
    const stableReplay = db.ingest(rich, { reingest: true });
    expect(stableReplay.replayed).toBe(true);
    expect(db.revision()).toBe(stableRevision);
    const replayedRepair = db.listPlaces()[0];
    expect(replayedRepair.evidence).toHaveLength(2);
    expect(replayedRepair.media).toHaveLength(1);
    expect(replayedRepair.activities).toHaveLength(1);
    db.close();
  });

  test('same source shared in a new message deduplicates the place but records the new member activity', () => {
    const db = store();
    const source = { url: 'https://example.com/shared-place' };
    const first = db.ingest(envelope({
      idempotencyKey: 'whatsapp:message-a',
      source,
      member: { localId: 'member-a', displayAlias: 'Sam' },
      places: [{ name: 'Shared Place', locality: 'Bengaluru', regionCandidate: 'bangalore', activity: { type: 'saved', interest: 'want-to-go' } }],
    }));
    const second = db.ingest(envelope({
      idempotencyKey: 'whatsapp:message-b',
      source,
      member: { localId: 'member-b', displayAlias: 'Alex' },
      places: [{ name: 'Shared Place', locality: 'Bengaluru', regionCandidate: 'bangalore', activity: { type: 'saved', interest: 'maybe' } }],
    }));
    expect(first.mutations[0].placeId).toBe(second.mutations[0].placeId);
    expect(db.listPlaces()).toHaveLength(1);
    expect(db.listPlaces()[0].memberStates).toHaveLength(2);
    db.close();
  });

  test('does not merge similarly named branches merely because they share a source', () => {
    const db = store();
    const result = db.ingest(envelope({
      idempotencyKey: 'wa:branch-list',
      places: [
        { name: 'Blue Tokai MG Road', locality: 'Bengaluru', categories: ['cafe'] },
        { name: 'Blue Tokai Indiranagar', locality: 'Bengaluru', categories: ['cafe'] },
      ],
    }));
    expect(result.mutations.map((mutation) => mutation.status)).toEqual(['created', 'created']);
    expect(db.listPlaces()).toHaveLength(2);
    db.close();
  });

  test('queues unresolved locations and ambiguous duplicates for review', () => {
    const db = store();
    const unresolved = db.ingest(envelope({
      idempotencyKey: 'wa:unknown',
      places: [{ name: 'Mystery Lookout' }],
    }));
    expect(unresolved.ok).toBe(false);
    expect(unresolved.mutations[0].status).toBe('review');

    db.ingest(envelope({
      idempotencyKey: 'wa:one',
      source: { url: 'https://example.com/one' },
      places: [{ name: 'Common Grounds', regionCandidate: 'bay-area', forceNew: true }],
    }));
    const ambiguous = db.ingest(envelope({
      idempotencyKey: 'wa:two',
      source: { url: 'https://example.com/two' },
      places: [{ name: 'Common Grounds', regionCandidate: 'bay-area' }],
    }));
    expect(ambiguous.mutations[0].status).toBe('review');
    expect(db.listReviewItems()).toHaveLength(2);

    const reviews = db.listReviewItems() as Array<{ id: string; reason: string }>;
    const unresolvedReview = reviews.find((review) => review.reason.startsWith('region:'))!;
    const resolvedRegion = db.resolveReview(unresolvedReview.id, { regionId: 'bangalore', forceNew: true });
    expect(resolvedRegion.mutations[0].status).toBe('created');
    expect(resolvedRegion.affectedRegions).toEqual(['bangalore']);

    const duplicateReview = (db.listReviewItems() as Array<{ id: string }>)[0];
    const existing = db.listPlaces({ regionId: 'bay-area' })[0];
    const resolvedDuplicate = db.resolveReview(duplicateReview.id, { usePlaceId: existing.id });
    expect(resolvedDuplicate.mutations[0].status).toBe('updated');
    expect(db.listReviewItems()).toHaveLength(0);
    db.close();
  });

  test('enforces ratings, records state history, corrects, and merges anchors', () => {
    const db = store();
    const created = db.ingest(envelope());
    const cubbon = created.mutations[0].placeId!;
    expect(() => db.addMemberActivity(
      cubbon,
      { localId: 'other', displayAlias: 'Alex' },
      { type: 'rating', rating: 4 },
      'rating-without-visit',
    )).toThrow('requires visitState=visited or revisit');

    db.addMemberActivity(
      cubbon,
      { localId: 'other', displayAlias: 'Alex' },
      { type: 'visit', visitState: 'revisit', rating: 4, comment: 'Go again', visibility: 'shareable' },
      'valid-visit',
    );
    expect(db.showPlace(cubbon).summary.revisit).toBe(1);
    db.correctPlace(
      cubbon,
      { neighborhood: 'Central Bengaluru' },
      { localId: 'owner', displayAlias: 'Owner' },
      'Neighborhood correction',
    );
    expect(db.showPlace(cubbon).neighborhood).toBe('Central Bengaluru');

    const second = db.ingest(envelope({
      idempotencyKey: 'wa:distinct',
      source: { url: 'https://example.com/distinct' },
      places: [{
        name: 'Cubbon Park Bandstand',
        locality: 'Bengaluru',
        externalIds: { google: 'second-google-id' },
        forceNew: true,
      }],
    })).mutations[0].placeId!;
    db.ingest(envelope({
      idempotencyKey: 'wa:map-cubbon',
      source: { url: 'https://example.com/map-cubbon' },
      places: [{
        name: 'Cubbon Park',
        locality: 'Bengaluru',
        externalIds: { google: 'first-google-id' },
      }],
    }));
    const merged = db.mergePlaces(cubbon, second, { localId: 'owner', displayAlias: 'Owner' }, 'Same destination anchor');
    expect(merged.ok).toBe(true);
    expect(db.listPlaces()).toHaveLength(1);
    expect(db.showPlace(second).status).toBe('merged');
    expect(db.showPlace(cubbon).aliases).toContain('Cubbon Park Bandstand');
    expect(db.doctor().foreignKeyErrors).toEqual([]);
    db.close();
  });
});
