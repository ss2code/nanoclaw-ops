import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlaceStore } from './db';
import { renderRegion } from './render';
import type { RenderResult } from './types';

export interface PublishHubOptions {
  regionId: string;
  profile?: 'private' | 'share';
  audience?: string;
  hubRoot?: string;
  hubScript?: string;
}

export interface PublishHubResult extends RenderResult {
  trackerId: string;
  audience: string;
  hubRoot: string;
  route: string;
  verified: boolean;
}

function defaultHubScript(): string {
  const installed = '/app/skills/nano-pvt-hub/hub.mjs';
  if (existsSync(installed)) return installed;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'nano-pvt-hub', 'hub.mjs');
}

function runHub(script: string, args: string[]): string {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`nano-pvt-hub failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function publishRegionToHub(store: PlaceStore, options: PublishHubOptions): PublishHubResult {
  const region = store.getRegion(options.regionId);
  const profile = options.profile ?? 'private';
  const audience = options.audience?.trim() || 'shared';
  const hubRoot = resolve(options.hubRoot ?? process.env.NANOCLAW_HUB_ROOT ?? '/workspace/hub');
  const hubScript = resolve(options.hubScript ?? process.env.NANOCLAW_HUB_SCRIPT ?? defaultHubScript());
  if (!existsSync(hubScript)) throw new Error(`nano-pvt-hub publisher not found: ${hubScript}`);
  const rendered = renderRegion(store, { regionId: region.id, profile });
  const trackerId = `places-${region.id}`;
  const summary = `${rendered.places} saved places in ${region.name}; searchable by category, visit state, interest, and rating.`;

  runHub(hubScript, [
    'publish',
    '--root', hubRoot,
    '--kind', 'tracker',
    '--audience', audience,
    '--id', trackerId,
    '--title', `Places — ${region.name}`,
    '--series', 'places',
    '--shape', 'status',
    '--ttl', 'none',
    '--summary', summary,
    '--source', rendered.htmlPath,
  ]);
  runHub(hubScript, [
    'put-data',
    '--root', hubRoot,
    '--kind', 'tracker',
    '--audience', audience,
    '--id', trackerId,
    '--name', 'places.json',
    '--source', rendered.jsonPath,
  ]);

  const raw = runHub(hubScript, [
    'get',
    '--root', hubRoot,
    '--kind', 'tracker',
    '--audience', audience,
    '--id', trackerId,
  ]);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`nano-pvt-hub read-back was not JSON: ${raw.slice(0, 300)}`);
  }
  const artifactPath = String(manifest.path ?? '');
  const dataPath = join(artifactPath, 'data', 'places.json');
  if (!artifactPath || !existsSync(dataPath)) throw new Error(`published tracker data missing: ${dataPath}`);
  const published = JSON.parse(readFileSync(dataPath, 'utf8')) as { revision?: number; region?: { id?: string } };
  if (published.revision !== rendered.revision || published.region?.id !== region.id) {
    throw new Error(`published tracker verification failed for ${region.id}`);
  }

  return {
    ...rendered,
    trackerId,
    audience,
    hubRoot,
    route: `/hub/trackers/${encodeURIComponent(audience)}/${encodeURIComponent(trackerId)}/`,
    verified: true,
  };
}

