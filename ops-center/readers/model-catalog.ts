/**
 * Read-only view of the OpenRouter model catalog the host caches to
 * `data/model-catalog.json` (see src/model-catalog.ts). Ops Center never
 * fetches — it only reads this cache — so the Models panel is instant and
 * survives OpenRouter being down.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../config.js';

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  toolCapable: boolean;
  promptCost: number;
  completionCost: number;
  intelligenceIndex: number | null;
}

export interface ModelCatalog {
  fetchedAt: number;
  source: string;
  models: CatalogModel[];
}

const CATALOG_PATH = path.join(ROOT, 'data', 'model-catalog.json');

export function readModelCatalog(): ModelCatalog | null {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8')) as ModelCatalog;
  } catch {
    return null;
  }
}

/** Models sorted by Intelligence Index (desc; unscored last). */
export function catalogByIntelligence(catalog: ModelCatalog): CatalogModel[] {
  return [...catalog.models].sort((a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1));
}

export function findCatalogModel(catalog: ModelCatalog | null, id: string | null | undefined): CatalogModel | undefined {
  if (!catalog || !id) return undefined;
  return catalog.models.find((m) => m.id === id);
}
