import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { IngestEnvelope, SavePlacesHandoff } from './types';
import { normalizeUrl, sha256 } from './util';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function validateEnvelopeShape(value: unknown): IngestEnvelope {
  const envelope = record(value, 'envelope');
  if (envelope.ingestVersion !== 1) throw new Error('envelope.ingestVersion must be 1');
  requiredString(envelope.idempotencyKey, 'envelope.idempotencyKey');
  const member = record(envelope.member, 'envelope.member');
  requiredString(member.localId, 'envelope.member.localId');
  requiredString(member.displayAlias, 'envelope.member.displayAlias');
  if (!Array.isArray(envelope.places) || envelope.places.length < 1 || envelope.places.length > 50) {
    throw new Error('envelope.places must contain between 1 and 50 entries');
  }
  for (const [index, place] of envelope.places.entries()) {
    const item = record(place, `envelope.places[${index}]`);
    requiredString(item.name, `envelope.places[${index}].name`);
    const verification = item.verification;
    if (verification != null) {
      const refs = record(verification, `envelope.places[${index}].verification`);
      if (refs.references != null && (!Array.isArray(refs.references) || refs.references.some((ref) => typeof ref !== 'string'))) {
        throw new Error(`envelope.places[${index}].verification.references must be strings`);
      }
    }
  }
  return envelope as unknown as IngestEnvelope;
}

export function createHandoff(
  envelope: IngestEnvelope,
  provenance: SavePlacesHandoff['provenance'],
  artifacts: SavePlacesHandoff['artifacts'] = [],
): SavePlacesHandoff {
  const originalMessageId = requiredString(provenance.originalMessageId, 'provenance.originalMessageId');
  const validated = validateEnvelopeShape(envelope);
  const idempotencyKey = validated.idempotencyKey.includes(originalMessageId)
    ? validated.idempotencyKey
    : `${validated.idempotencyKey}:message:${originalMessageId}`;
  if (idempotencyKey.length > 300) throw new Error('handoff idempotency key would exceed 300 characters');
  const handoffEnvelope = idempotencyKey === validated.idempotencyKey ? validated : { ...validated, idempotencyKey };
  const handoffId = `sph_${sha256(`${originalMessageId}:${handoffEnvelope.idempotencyKey}`).slice(0, 20)}`;
  return {
    handoffVersion: 1,
    kind: 'save-places.research',
    handoffId,
    provenance: {
      originalMessageId,
      originalChannel: requiredString(provenance.originalChannel, 'provenance.originalChannel'),
      delegatedBy: requiredString(provenance.delegatedBy, 'provenance.delegatedBy'),
      researchedBy: requiredString(provenance.researchedBy, 'provenance.researchedBy'),
    },
    envelope: handoffEnvelope,
    ...(artifacts.length ? { artifacts } : {}),
  };
}

export function parseHandoff(value: unknown): SavePlacesHandoff {
  const handoff = record(value, 'handoff');
  if (handoff.handoffVersion !== 1) throw new Error('handoff.handoffVersion must be 1');
  if (handoff.kind !== 'save-places.research') throw new Error('unsupported handoff kind');
  requiredString(handoff.handoffId, 'handoff.handoffId');
  const provenance = record(handoff.provenance, 'handoff.provenance');
  const envelope = validateEnvelopeShape(handoff.envelope);
  const artifacts = handoff.artifacts;
  if (artifacts != null) {
    if (!Array.isArray(artifacts)) throw new Error('handoff.artifacts must be an array');
    for (const [index, artifact] of artifacts.entries()) {
      const item = record(artifact, `handoff.artifacts[${index}]`);
      requiredString(item.filename, `handoff.artifacts[${index}].filename`);
      const digest = requiredString(item.sha256, `handoff.artifacts[${index}].sha256`);
      if (!/^[a-f0-9]{64}$/i.test(digest)) throw new Error(`handoff.artifacts[${index}].sha256 must be SHA-256`);
    }
  }
  return createHandoff(envelope, {
    originalMessageId: requiredString(provenance.originalMessageId, 'provenance.originalMessageId'),
    originalChannel: requiredString(provenance.originalChannel, 'provenance.originalChannel'),
    delegatedBy: requiredString(provenance.delegatedBy, 'provenance.delegatedBy'),
    researchedBy: requiredString(provenance.researchedBy, 'provenance.researchedBy'),
  }, artifacts as SavePlacesHandoff['artifacts'] ?? []).handoffId === handoff.handoffId
    ? handoff as unknown as SavePlacesHandoff
    : (() => { throw new Error('handoff.handoffId does not match provenance and idempotency key'); })();
}

export function parseIngestDocument(value: unknown): { envelope: IngestEnvelope; handoff?: SavePlacesHandoff } {
  const object = record(value, 'ingest document');
  if (object.handoffVersion != null || object.kind != null || object.envelope != null) {
    const handoff = parseHandoff(object);
    return { envelope: handoff.envelope, handoff };
  }
  return { envelope: validateEnvelopeShape(object) };
}

export function normalizeEvidenceReference(reference: string): { reference: string; url?: string } {
  const value = requiredString(reference, 'evidence reference').slice(0, 2000);
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = normalizeUrl(value);
      return { reference: url, url };
    } catch {
      // Keep malformed evidence visible as text; the primary source remains validated by PlaceStore.
    }
  }
  return { reference: value };
}

export function handoffChecksum(value: SavePlacesHandoff): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Move attachment bytes from the session inbox into the owner's persistent
 * tracker media directory and rewrite local media paths to stay portable.
 */
export function materializeHandoff(
  handoff: SavePlacesHandoff,
  inboxDir: string,
  storeDir: string,
): SavePlacesHandoff {
  const artifacts = handoff.artifacts ?? [];
  if (!artifacts.length) return handoff;
  const sourceRoot = resolve(inboxDir);
  const mediaRoot = resolve(storeDir, 'media');
  mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
  const seen = new Set<string>();
  const replacements = new Map<string, string>();
  for (const artifact of artifacts) {
    const filename = basename(artifact.filename);
    if (!filename || filename !== artifact.filename || filename.includes('\0') || seen.has(filename)) {
      throw new Error(`unsafe or duplicate handoff artifact filename: ${artifact.filename}`);
    }
    seen.add(filename);
    const source = resolve(sourceRoot, filename);
    if (!source.startsWith(`${sourceRoot}/`) || !existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`handoff artifact missing from inbox: ${filename}`);
    }
    const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
    if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error(`handoff artifact checksum mismatch: ${filename}`);
    }
    const destination = resolve(mediaRoot, `${handoff.handoffId}-${filename}`);
    if (!destination.startsWith(`${mediaRoot}/`)) throw new Error(`unsafe handoff media destination: ${filename}`);
    if (!existsSync(destination)) copyFileSync(source, destination);
    replacements.set(filename, destination);
  }
  return {
    ...handoff,
    envelope: {
      ...handoff.envelope,
      places: handoff.envelope.places.map((place) => ({
        ...place,
        ...(place.media ? {
          media: place.media.map((media) => {
            if (!media.localPath) return media;
            const replacement = replacements.get(basename(media.localPath));
            return replacement ? { ...media, localPath: replacement } : media;
          }),
        } : {}),
      })),
    },
  };
}
