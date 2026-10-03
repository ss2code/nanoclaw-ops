#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PlaceStore } from './db';
import { createHandoff, handoffChecksum, materializeHandoff, parseHandoff, parseIngestDocument } from './handoff';
import { publishRegionToHub } from './publish-hub';
import { renderRegion } from './render';
import type { ActivityInput, IngestEnvelope, InterestState, MemberInput, RegionInput, SavePlacesHandoff, VisitState } from './types';

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    if (equal > 2) {
      flags.set(value.slice(2, equal), value.slice(equal + 1));
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next != null && !next.startsWith('--')) {
      flags.set(name, next);
      index += 1;
    } else flags.set(name, true);
  }
  return { positionals, flags };
}

function stringFlag(parsed: Parsed, name: string, required = false): string | undefined {
  const value = parsed.flags.get(name);
  if (value === true || value == null || String(value).trim() === '') {
    if (required) throw new Error(`--${name} is required`);
    return undefined;
  }
  return String(value);
}

function boolFlag(parsed: Parsed, name: string): boolean {
  return parsed.flags.get(name) === true || parsed.flags.get(name) === 'true';
}

function numberFlag(parsed: Parsed, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (value == null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${name} must be a number`);
  return number;
}

function readJson<T>(path: string): T {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(path), 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readIngestDocument(path: string): { envelope: IngestEnvelope; handoff?: SavePlacesHandoff } {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(path), 'utf8');
  try {
    return parseIngestDocument(JSON.parse(raw));
  } catch (error) {
    throw new Error(`invalid ingest document in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function member(parsed: Parsed): MemberInput {
  return {
    localId: stringFlag(parsed, 'member-id', true)!,
    displayAlias: stringFlag(parsed, 'member-name', true)!,
  };
}

function key(parsed: Parsed, prefix: string): string {
  return stringFlag(parsed, 'idempotency-key') ?? `${prefix}:${Date.now()}:${crypto.randomUUID()}`;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function publishAffected(store: PlaceStore, regions: string[], parsed: Parsed): unknown[] {
  if (!boolFlag(parsed, 'publish-hub')) return [];
  try {
    return regions.map((regionId) => publishRegionToHub(store, {
      regionId,
      profile: (stringFlag(parsed, 'profile') as 'private' | 'share' | undefined) ?? 'private',
      audience: stringFlag(parsed, 'audience'),
      hubRoot: stringFlag(parsed, 'hub-root'),
      hubScript: stringFlag(parsed, 'hub-script'),
    }));
  } catch (error) {
    throw new Error(`place data was saved, but hub publishing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function help(): string {
  return `Save Places regional tracker

Usage:
  bun scripts/place-board.ts [--dir <workspace>/place-tracker] <command> [options]

Commands:
  init
  regions list
  regions upsert --json region.json
  ingest --json envelope-or-handoff.json [--reingest] [--publish-hub]
  list [--region ID] [--category ID] [--interest STATE] [--visit-state STATE]
  search --query TEXT [the same filters as list]
  show --place-id ID [--profile private|share]
  comment --place-id ID --member-id ID --member-name NAME --text TEXT [--visibility group|shareable] [--publish-hub]
  react --place-id ID --member-id ID --member-name NAME --interest want-to-go|maybe|not-for-me [--publish-hub]
  visit --place-id ID --member-id ID --member-name NAME --state not-visited|visited|revisit [--rating 1..5] [--comment TEXT] [--publish-hub]
  correct --place-id ID --json changes.json --member-id ID --member-name NAME --comment TEXT [--publish-hub]
  merge --keep ID --merge ID --member-id ID --member-name NAME --reason TEXT [--publish-hub]
  review list
  review resolve --review-id ID [--region ID | --use-place ID | --force-new] [--publish-hub]
  handoff create --json envelope.json --out handoff.json --message-id ID --channel CHANNEL --delegated-by AGENT --researched-by AGENT
  handoff validate --json handoff.json
  handoff materialize --json handoff.json --inbox /workspace/inbox/A2A_ID --dir <workspace>/place-tracker --out handoff-ready.json
  render --region ID [--profile private|share] [--out DIR]
  publish-hub --region ID [--profile private|share] [--audience shared]
  doctor

The Notion adapter is intentionally reserved and is not implemented.`;
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  const [command, subcommand] = parsed.positionals;
  if (!command || command === 'help' || boolFlag(parsed, 'help')) {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (command === 'handoff') {
    const jsonPath = stringFlag(parsed, 'json', true)!;
    if (subcommand === 'validate') {
      const handoff = parseHandoff(readJson(jsonPath));
      output({ ok: true, handoffId: handoff.handoffId, idempotencyKey: handoff.envelope.idempotencyKey, places: handoff.envelope.places.length });
      return;
    }
    if (subcommand === 'create') {
      const outPath = resolve(stringFlag(parsed, 'out', true)!);
      const handoff = createHandoff(readJson<IngestEnvelope>(jsonPath), {
        originalMessageId: stringFlag(parsed, 'message-id', true)!,
        originalChannel: stringFlag(parsed, 'channel', true)!,
        delegatedBy: stringFlag(parsed, 'delegated-by', true)!,
        researchedBy: stringFlag(parsed, 'researched-by', true)!,
      });
      writeFileSync(outPath, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
      output({ ok: true, handoffId: handoff.handoffId, path: outPath, checksum: handoffChecksum(handoff) });
      return;
    }
    if (subcommand === 'materialize') {
      const storeDir = resolve(stringFlag(parsed, 'dir', true)!);
      const inboxDir = resolve(stringFlag(parsed, 'inbox', true)!);
      const outPath = resolve(stringFlag(parsed, 'out', true)!);
      const materialized = materializeHandoff(parseHandoff(readJson(jsonPath)), inboxDir, storeDir);
      writeFileSync(outPath, `${JSON.stringify(materialized, null, 2)}\n`, { mode: 0o600 });
      output({ ok: true, handoffId: materialized.handoffId, path: outPath, checksum: handoffChecksum(materialized) });
      return;
    }
    throw new Error(`unknown handoff command: ${subcommand ?? '(missing subcommand)'}`);
  }
  const dir = resolve(stringFlag(parsed, 'dir') ?? process.env.SAVE_PLACES_DIR ?? '/workspace/agent/place-tracker');
  const dbPath = stringFlag(parsed, 'db');
  const store = new PlaceStore(dir, dbPath ? { dbPath: resolve(dbPath) } : {});
  try {
    if (command === 'init') {
      output({ dir: store.dir, dbPath: store.dbPath, ...store.doctor(), regions: store.listRegions() });
      return;
    }
    if (command === 'regions' && subcommand === 'list') {
      output(store.listRegions(boolFlag(parsed, 'all')));
      return;
    }
    if (command === 'regions' && subcommand === 'upsert') {
      output(store.upsertRegion(readJson<RegionInput>(stringFlag(parsed, 'json', true)!)));
      return;
    }
    if (command === 'ingest') {
      const result = store.ingest(
        readIngestDocument(stringFlag(parsed, 'json', true)!).envelope,
        { reingest: boolFlag(parsed, 'reingest') },
      );
      output({ ...result, published: publishAffected(store, result.affectedRegions, parsed) });
      return;
    }
    if (command === 'list' || command === 'search') {
      const options = {
        regionId: stringFlag(parsed, 'region'),
        category: stringFlag(parsed, 'category'),
        interest: stringFlag(parsed, 'interest') as InterestState | undefined,
        visitState: stringFlag(parsed, 'visit-state') as VisitState | undefined,
        includeClosed: boolFlag(parsed, 'include-closed'),
        profile: (stringFlag(parsed, 'profile') as 'private' | 'share' | undefined) ?? 'private',
      };
      output(command === 'search' ? store.search(stringFlag(parsed, 'query', true)!, options) : store.listPlaces(options));
      return;
    }
    if (command === 'show') {
      output(store.showPlace(stringFlag(parsed, 'place-id', true)!, (stringFlag(parsed, 'profile') as 'private' | 'share' | undefined) ?? 'private'));
      return;
    }
    if (['comment', 'react', 'visit'].includes(command)) {
      const placeId = stringFlag(parsed, 'place-id', true)!;
      let activity: ActivityInput;
      if (command === 'comment') {
        activity = { type: 'comment', comment: stringFlag(parsed, 'text', true), visibility: stringFlag(parsed, 'visibility') as ActivityInput['visibility'] };
      } else if (command === 'react') {
        activity = { type: 'interest', interest: stringFlag(parsed, 'interest', true) as InterestState };
      } else {
        activity = {
          type: 'visit',
          visitState: stringFlag(parsed, 'state', true) as VisitState,
          rating: numberFlag(parsed, 'rating'),
          comment: stringFlag(parsed, 'comment'),
          visibility: stringFlag(parsed, 'visibility') as ActivityInput['visibility'],
        };
      }
      const result = store.addMemberActivity(placeId, member(parsed), activity, key(parsed, command));
      output({ ...result, published: publishAffected(store, result.affectedRegions, parsed) });
      return;
    }
    if (command === 'correct') {
      const result = store.correctPlace(
        stringFlag(parsed, 'place-id', true)!,
        readJson(stringFlag(parsed, 'json', true)!),
        member(parsed),
        stringFlag(parsed, 'comment', true)!,
      );
      output({ ...result, published: publishAffected(store, result.affectedRegions, parsed) });
      return;
    }
    if (command === 'merge') {
      const result = store.mergePlaces(
        stringFlag(parsed, 'keep', true)!,
        stringFlag(parsed, 'merge', true)!,
        member(parsed),
        stringFlag(parsed, 'reason', true)!,
      );
      output({ ...result, published: publishAffected(store, result.affectedRegions, parsed) });
      return;
    }
    if (command === 'review' && subcommand === 'list') {
      output(store.listReviewItems());
      return;
    }
    if (command === 'review' && subcommand === 'resolve') {
      const result = store.resolveReview(stringFlag(parsed, 'review-id', true)!, {
        regionId: stringFlag(parsed, 'region'),
        usePlaceId: stringFlag(parsed, 'use-place'),
        forceNew: boolFlag(parsed, 'force-new'),
      });
      output({ ...result, published: publishAffected(store, result.affectedRegions, parsed) });
      return;
    }
    if (command === 'render') {
      output(renderRegion(store, {
        regionId: stringFlag(parsed, 'region', true)!,
        profile: (stringFlag(parsed, 'profile') as 'private' | 'share' | undefined) ?? 'private',
        outputDir: stringFlag(parsed, 'out'),
      }));
      return;
    }
    if (command === 'publish-hub') {
      output(publishRegionToHub(store, {
        regionId: stringFlag(parsed, 'region', true)!,
        profile: (stringFlag(parsed, 'profile') as 'private' | 'share' | undefined) ?? 'private',
        audience: stringFlag(parsed, 'audience'),
        hubRoot: stringFlag(parsed, 'hub-root'),
        hubScript: stringFlag(parsed, 'hub-script'),
      }));
      return;
    }
    if (command === 'doctor') {
      output(store.doctor());
      return;
    }
    throw new Error(`unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`save-places: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
