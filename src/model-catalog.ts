/**
 * OpenRouter model catalog with Artificial Analysis intelligence scores.
 *
 * Adapted from SignalFold's ai-sidecar/src/models.ts. Fetches the public
 * OpenRouter model list (pricing, context, tool-capability — no API key needed)
 * and merges an "Intelligence Index" per model, scraped from Artificial
 * Analysis (the attributed source; keyless). Result is cached to
 * `data/model-catalog.json` with a TTL so page views and per-spawn reads never
 * hit the network — the host refreshes it on a schedule.
 *
 * Only the HOST fetches (it has open egress). Ops Center reads the cache file
 * via its own reader; it never calls the network.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export interface CatalogModel {
  /** Provider-prefixed id, e.g. `openrouter/minimax/minimax-m3`. */
  id: string;
  name: string;
  contextWindow: number;
  toolCapable: boolean;
  /** USD per 1M prompt tokens. */
  promptCost: number;
  /** USD per 1M completion tokens. */
  completionCost: number;
  /** Artificial Analysis Intelligence Index, or null when unknown. */
  intelligenceIndex: number | null;
}

export interface ModelCatalogFile {
  fetchedAt: number;
  source: string;
  models: CatalogModel[];
}

const CATALOG_PATH = path.join(DATA_DIR, 'model-catalog.json');
const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** Artificial Analysis embeds the full leaderboard on any model page. */
const AA_URL = 'https://artificialanalysis.ai/models/minimax-m3';

/** Normalize a model name/id to a comparable key for benchmark matching. */
function benchmarkKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(withfallback|xhigh|max|high|medium|low)$/, '');
}

function toCatalogModel(value: Record<string, unknown>): CatalogModel {
  const pricing = (value.pricing as Record<string, unknown>) ?? {};
  const supported = Array.isArray(value.supported_parameters) ? (value.supported_parameters as string[]) : [];
  return {
    id: `openrouter/${String(value.id)}`,
    name: String(value.name || value.id),
    contextWindow: Number(value.context_length || 128000),
    toolCapable: supported.includes('tools'),
    promptCost: Number(pricing.prompt || 0) * 1_000_000,
    completionCost: Number(pricing.completion || 0) * 1_000_000,
    intelligenceIndex: null,
  };
}

/** Fetch AA intelligence scores keyed by normalized model label. Best-effort. */
async function fetchIntelligenceScores(): Promise<Record<string, number>> {
  try {
    const res = await fetch(AA_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Artificial Analysis status ${res.status}`);
    const html = await res.text();
    const rows = [
      ...html.matchAll(/"label":"((?:\\.|[^"])*)","artificialAnalysisIntelligenceIndex":(-?\d+(?:\.\d+)?)/g),
    ];
    const scores: Record<string, number> = {};
    for (const row of rows) {
      const label = JSON.parse(`"${row[1]}"`) as string;
      scores[benchmarkKey(label)] = Number(row[2]);
    }
    return scores;
  } catch (err) {
    log.warn('Model catalog: intelligence-index fetch failed', { err: String(err) });
    return {};
  }
}

function scoreForModel(model: CatalogModel, scores: Record<string, number>): number | null {
  const name = benchmarkKey(model.name);
  const tail = benchmarkKey(model.id.split('/').at(-1) || '');
  for (const key of Object.keys(scores)) {
    if (key === name || key === tail || (name && name.endsWith(key)) || (key && key.endsWith(name))) {
      return scores[key];
    }
  }
  return null;
}

/**
 * Fetch the live OpenRouter catalog + intelligence scores and write the cache.
 * Host-only (needs open egress). Returns the models, or throws on a hard
 * fetch failure (caller keeps any existing cache).
 */
export async function refreshModelCatalog(): Promise<CatalogModel[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenRouter catalog status ${res.status}`);
  const payload = (await res.json()) as { data?: Record<string, unknown>[] };
  const scores = await fetchIntelligenceScores();
  const models = (payload.data || [])
    .map(toCatalogModel)
    .filter((m) => m.toolCapable)
    .map((m) => ({ ...m, intelligenceIndex: scoreForModel(m, scores) }));

  const file: ModelCatalogFile = {
    fetchedAt: Date.now(),
    source: 'openrouter+artificial-analysis',
    models,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
  log.info('Model catalog refreshed', {
    count: models.length,
    withScore: models.filter((m) => m.intelligenceIndex != null).length,
  });
  return models;
}

/** Read the cached catalog (no network). Returns null if absent/unreadable. */
export function readModelCatalog(): ModelCatalogFile | null {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as ModelCatalogFile;
  } catch {
    return null;
  }
}

/** True when the cache is missing or older than the TTL. */
export function catalogIsStale(): boolean {
  const cached = readModelCatalog();
  return !cached || Date.now() - cached.fetchedAt > TTL_MS;
}

/**
 * Refresh the catalog if stale; swallow errors (keep any existing cache). Safe
 * to call on startup and on an interval. Never throws.
 */
export async function ensureModelCatalogFresh(): Promise<void> {
  if (!catalogIsStale()) return;
  try {
    await refreshModelCatalog();
  } catch (err) {
    log.warn('Model catalog refresh failed; keeping existing cache', { err: String(err) });
  }
}

/** Look up one model by its provider-prefixed id in the cache. */
export function findCatalogModel(id: string): CatalogModel | undefined {
  return readModelCatalog()?.models.find((m) => m.id === id);
}
