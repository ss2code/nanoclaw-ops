/**
 * Group-config resolution for the self-tests suite.
 *
 * Reads a group's provider + model tiers from the central DB and exposes the
 * normalization needed to compare a *configured tier id* against the *model id
 * a provider actually records* for a turn. Everything read-only.
 */
import Database from 'better-sqlite3';
import { PATHS, readEnvKey } from '../../../ops-center/config.js';

export type Provider = 'opencode' | 'claude' | string;

export interface ModelTiers {
  high: string;
  medium: string;
  low: string;
  default: 'high' | 'medium' | 'low';
}

export interface GroupRouting {
  agentGroupId: string;
  provider: Provider;
  /** null when the group has no explicit tiers (Claude falls back to a ladder). */
  tiers: ModelTiers | null;
  /** OpenCode provider prefix inferred from the group model/tier profile. */
  opencodeProvider: string;
}

/** Anthropic ladder the Claude provider uses when a group has no tiers. */
const DEFAULT_ANTHROPIC_TIERS: ModelTiers = { high: 'opus', medium: 'sonnet', low: 'haiku', default: 'medium' };

export function readGroupRouting(agentGroupId: string): GroupRouting {
  const db = new Database(PATHS.centralDb, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT provider, model_tiers FROM container_configs WHERE agent_group_id = ?')
      .get(agentGroupId) as { provider: string | null; model_tiers: string | null } | undefined;
    if (!row) throw new Error(`no container_configs row for ${agentGroupId}`);
    const provider = (row.provider || 'claude') as Provider;
    let tiers: ModelTiers | null = null;
    if (row.model_tiers) {
      try {
        tiers = JSON.parse(row.model_tiers) as ModelTiers;
      } catch {
        throw new Error(`model_tiers for ${agentGroupId} is not valid JSON`);
      }
    } else if (provider === 'claude') {
      tiers = DEFAULT_ANTHROPIC_TIERS;
    }
    const tierProvider = tiers?.high?.includes('/') ? tiers.high.split('/', 1)[0] : undefined;
    return {
      agentGroupId,
      provider,
      tiers,
      opencodeProvider: tierProvider || readEnvKey('OPENCODE_PROVIDER') || 'anthropic',
    };
  } finally {
    db.close();
  }
}

/** The full tier id configured for a tier name. */
export function tierModelId(tiers: ModelTiers, tier: 'high' | 'medium' | 'low'): string {
  return tiers[tier];
}

/**
 * Does the model a provider actually recorded (`actual`) match the model
 * configured for a tier (`expectedTierId`)? Provider-aware because the two
 * providers record ids differently:
 *   - opencode strips the OPENCODE_PROVIDER prefix ("openrouter/openai/x" → "openai/x")
 *   - claude records a full/pinned id; tier ids may be aliases ("opus")
 */
export function modelsMatch(g: GroupRouting, expectedTierId: string, actual: string): boolean {
  if (g.provider === 'opencode') {
    const strip = (m: string) => m.replace(new RegExp(`^${g.opencodeProvider}/`), '');
    return strip(expectedTierId) === strip(actual);
  }
  // claude (or unknown): compare on the compact leaf, tolerating alias vs pinned.
  const leaf = (m: string) => m.split('/').pop() || m;
  const e = leaf(expectedTierId).toLowerCase();
  const a = leaf(actual).toLowerCase();
  if (e === a) return true;
  // alias ⊂ pinned, e.g. tier "opus" vs recorded "claude-opus-4-8"
  return a.includes(e) || e.includes(a);
}
