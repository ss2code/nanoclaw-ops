import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHandoff, handoffChecksum, materializeHandoff, parseHandoff, parseIngestDocument } from '../scripts/handoff';
import type { IngestEnvelope } from '../scripts/types';

const envelope: IngestEnvelope = {
  ingestVersion: 1,
  idempotencyKey: 'whatsapp:message-42',
  source: { url: 'https://www.instagram.com/reel/example' },
  member: { localId: 'whatsapp:member-1', displayAlias: 'Sam' },
  places: [{
    name: 'Example Temple',
    regionCandidate: 'bangalore',
    verification: { references: ['https://example.com/verification'] },
  }],
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Save Places handoffs', () => {
  test('wraps and validates a deterministic owner handoff', () => {
    const first = createHandoff(envelope, {
      originalMessageId: 'whatsapp-message-id',
      originalChannel: 'whatsapp',
      delegatedBy: 'jeeves',
      researchedBy: 'errand-runner',
    });
    const second = createHandoff(envelope, {
      originalMessageId: 'whatsapp-message-id',
      originalChannel: 'whatsapp',
      delegatedBy: 'jeeves',
      researchedBy: 'errand-runner',
    });
    expect(first.handoffId).toBe(second.handoffId);
    expect(handoffChecksum(first)).toBe(handoffChecksum(second));
    expect(parseHandoff(first).envelope.idempotencyKey).toContain('whatsapp-message-id');
    expect(parseHandoff(first).envelope.places).toEqual(envelope.places);
    expect(parseIngestDocument(first).handoff?.provenance.researchedBy).toBe('errand-runner');
  });

  test('rejects a tampered handoff ID', () => {
    const handoff = createHandoff(envelope, {
      originalMessageId: 'whatsapp-message-id',
      originalChannel: 'whatsapp',
      delegatedBy: 'jeeves',
      researchedBy: 'errand-runner',
    });
    expect(() => parseHandoff({ ...handoff, handoffId: 'sph_tampered' })).toThrow(/handoffId/);
  });

  test('materializes and checksums attached local media into the owner store', () => {
    const root = mkdtempSync(join(tmpdir(), 'save-places-handoff-'));
    tempDirs.push(root);
    const inbox = join(root, 'inbox');
    const store = join(root, 'store');
    mkdirSync(inbox, { recursive: true });
    const media = join(inbox, 'temple.png');
    writeFileSync(media, 'image bytes');
    const digest = createHash('sha256').update(readFileSync(media)).digest('hex');
    const handoff = createHandoff({
      ...envelope,
      places: [{ ...envelope.places[0], media: [{ kind: 'local-image', localPath: '/workspace/agent/temple.png', alt: 'Temple' }] }],
    }, {
      originalMessageId: 'whatsapp-message-id',
      originalChannel: 'whatsapp',
      delegatedBy: 'jeeves',
      researchedBy: 'errand-runner',
    }, [{ filename: 'temple.png', sha256: digest, purpose: 'reel screenshot' }]);
    const ready = materializeHandoff(handoff, inbox, store);
    const localPath = ready.envelope.places[0].media?.[0].localPath!;
    expect(localPath).toContain('/store/media/');
    expect(readFileSync(localPath, 'utf8')).toBe('image bytes');
  });
});
