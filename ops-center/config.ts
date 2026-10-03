/**
 * Ops Center configuration. Defaults here; overridable via ops-center/config.json.
 * Everything path-like is resolved relative to the repo root (parent of this dir).
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const INSTALL_SLUG = createHash('sha1').update(ROOT).digest('hex').slice(0, 8);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;

export interface OpsConfig {
  port: number;
  /** Fast SSE lane interval (ms) — live counters/status. */
  liveTickMs: number;
  /** Sample lane interval (ms) — persisted metrics. */
  sampleTickMs: number;
  /** Raw sample retention (hours). */
  rawRetentionHours: number;
  /** Hourly rollup retention (days). */
  hourlyRetentionDays: number;
  /** Daily rollup retention (days). */
  dailyRetentionDays: number;
  /** Event retention (days). */
  eventRetentionDays: number;
  /** Rotate host logs at this size (bytes); keep this many compressed generations. */
  logRotateBytes: number;
  logRotateKeep: number;
  /** Nightly backup hour (local) + retention count. */
  backupHour: number;
  backupKeep: number;
  /** ops.db soft ceiling (bytes) — alert when exceeded. */
  opsDbMaxBytes: number;
  /** Telegram alerting. Token read from .env (TELEGRAM_BOT_TOKEN); chatId here. */
  alerts: {
    enabled: boolean;
    telegramChatId: string;
    /** Min ms between repeat alerts for the same condition. */
    cooldownMs: number;
    unansweredAfterMs: number;
    crashLoopKills: number;
    crashLoopWindowMs: number;
    diskGrowthBytesPerDay: number;
  };
  /**
   * API-equivalent cost table, $ per 1M tokens (estimates — you're on a
   * subscription; this is a relative gauge only). Matched by substring on
   * the model id. cacheRead/cacheWrite are multipliers on input price.
   */
  pricing: Record<string, { input: number; output: number }>;
  cacheReadMult: number;
  cacheWriteMult: number;
  /** Models offered in the per-group model dropdown. */
  modelChoices: string[];
  /**
   * Claude subscription quota tracking (the cdq analog for Claude). Source of the
   * 5h/7d utilization that gets charted over time. See readers/quota.ts for the seam.
   */
  quotaSource: 'statusline' | 'oauth';
  /** Max age (ms) of the quota snapshot before it's treated as stale and skipped. */
  quotaStaleMs: number;
  /**
   * 'oauth' source only: refresh the shared usage cache when older than this (ms).
   * Longer than statusline's 60s refresh so an open interactive session always
   * wins the refresh race and the collector only fetches when nothing else is
   * keeping the cache warm.
   */
  quotaFetchTtlMs: number;
  /** Verification window for lifecycle/config operations. */
  operationVerifyTimeoutMs: number;
  /** Baseline window and passive end-to-end freshness threshold. */
  sloWindowDays: number;
  passiveCanaryMaxAgeMs: number;
  /** Trip Companion ops-center tab options. */
  tripCompanion: {
    /** Show short inbound/outbound message text excerpts in the local ops UI. */
    showMessageSnippets: boolean;
  };
  /**
   * Extra `Host` values accepted besides loopback — for a reverse proxy in front
   * of this server, e.g. a Tailscale Serve hostname. The server still binds
   * 127.0.0.1 only; this just relaxes the anti-DNS-rebinding Host check for
   * names you control. Exact hostnames only, never wildcards, and only names
   * whose front-end is itself access-controlled (Tailscale Serve is tailnet-only;
   * Funnel is NOT). Empty by default → loopback-only, as before.
   */
  trustedHosts: string[];
}

const DEFAULTS: OpsConfig = {
  port: 10333,
  liveTickMs: 3000,
  sampleTickMs: 60_000,
  rawRetentionHours: 48,
  hourlyRetentionDays: 90,
  dailyRetentionDays: 365,
  eventRetentionDays: 90,
  logRotateBytes: 10 * 1024 * 1024,
  logRotateKeep: 14,
  backupHour: 3, // 03:xx local; minute fixed at 30
  backupKeep: 14,
  opsDbMaxBytes: 25 * 1024 * 1024,
  alerts: {
    enabled: true,
    // Instance-specific — set in ops-center/config.json (overlay-owned), never here.
    telegramChatId: '',
    cooldownMs: 30 * 60_000,
    unansweredAfterMs: 10 * 60_000,
    crashLoopKills: 3,
    crashLoopWindowMs: 30 * 60_000,
    diskGrowthBytesPerDay: 200 * 1024 * 1024,
  },
  pricing: {
    haiku: { input: 1, output: 5 },
    sonnet: { input: 3, output: 15 },
    opus: { input: 5, output: 25 },
  },
  cacheReadMult: 0.1,
  cacheWriteMult: 1.25,
  // Aliases (haiku/sonnet/opus) let the Agent SDK track the latest version of
  // each tier; pinned IDs (claude-opus-4-7) freeze a specific release. Both work
  // — setModel passes the string straight to `ncl groups config update --model`,
  // shortModel() renders full IDs compactly (claude-opus-4-7 → opus-4-7), and
  // cost estimation matches by substring. Pinned IDs must be ones the provider
  // accepts. Edit this list to change what the dashboard dropdown offers.
  modelChoices: [
    'haiku',
    'sonnet',
    'opus',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
  ],
  quotaSource: 'oauth',
  // Statusline refreshes ~every 60s while a Claude Code session is live; 10 min
  // tolerates brief idle gaps without flat-lining a stale value across long outages.
  quotaStaleMs: 10 * 60_000,
  quotaFetchTtlMs: 180_000,
  operationVerifyTimeoutMs: 20_000,
  sloWindowDays: 7,
  passiveCanaryMaxAgeMs: 24 * 3_600_000,
  tripCompanion: {
    showMessageSnippets: true,
  },
  // Instance-specific — set in ops-center/config.json (overlay-owned), never here.
  trustedHosts: [],
};

export const PATHS = {
  centralDb: path.join(ROOT, 'data', 'v2.db'),
  opsDb: path.join(ROOT, 'data', 'ops.db'),
  // Latest user-triggered Reflect summary. This is a bounded JSON snapshot,
  // not the improvement history; the Ops Center reads it at startup.
  reflectLatest: path.join(ROOT, 'data', 'reflect-latest.json'),
  // Explicitly maintained after an approved repair. Reflect only reads this.
  reflectImprovements: path.join(ROOT, 'data', 'reflect-improvements.json'),
  // Non-secret receipts written by scripts/reauth-*.sh. They contain method
  // labels and timestamps only; provider credentials remain in OneCLI/OpenCode.
  providerAuthStatus: path.join(ROOT, 'data', 'provider-auth-status.json'),
  // Non-secret state and reports for an optional host recovery workflow.
  remoteRecoveryDir: path.join(ROOT, 'data', 'remote-recovery'),
  remoteRecoveryState: path.join(ROOT, 'data', 'remote-recovery', 'state.json'),
  sessionsDir: path.join(ROOT, 'data', 'v2-sessions'),
  backupsDir: path.join(ROOT, 'data', 'backups'),
  logsDir: path.join(ROOT, 'logs'),
  logArchiveDir: path.join(ROOT, 'logs', 'archive'),
  hostLog: path.join(ROOT, 'logs', 'nanoclaw.log'),
  hostErrLog: path.join(ROOT, 'logs', 'nanoclaw.error.log'),
  envFile: path.join(ROOT, '.env'),
  nclBin: path.join(ROOT, 'bin', 'ncl'),
  projectDocsDir: path.join(ROOT, 'docs'),
  // nano-pvt-hub store root (data/hub) — served read-only under /hub. Holds the
  // writable dashboards/trackers/agent-docs surfaces plus the `nanoclaw-docs`
  // symlink into projectDocsDir. See serveHubFile in server.ts.
  hubDir: path.join(ROOT, 'data', 'hub'),
  groupsDir: path.join(ROOT, 'groups'),
  wakeCyclerDisabled: path.join(ROOT, 'data', 'wake-cycler.disabled'),
  // Shared skill catalog — the universe every agent group draws from. Per-group
  // selection lives in container_configs.skills; see readers/skills.ts.
  containerSkillsDir: path.join(ROOT, 'container', 'skills'),
  // Shared usage cache (raw /api/oauth/usage response; mtime = freshness). Written by
  // ~/.claude/statusline.sh while interactive sessions run, and by the collector's
  // read-through refresh when stale (quotaSource: 'oauth'). See readers/quota.ts.
  statuslineUsageCache: '/tmp/claude/statusline-usage-cache.json',
};

export function loadConfig(): OpsConfig {
  const file = path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) return DEFAULTS;
  try {
    const user = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...DEFAULTS,
      ...user,
      alerts: { ...DEFAULTS.alerts, ...(user.alerts ?? {}) },
      tripCompanion: { ...DEFAULTS.tripCompanion, ...(user.tripCompanion ?? {}) },
    };
  } catch {
    console.error('[ops-center] config.json unparseable — using defaults');
    return DEFAULTS;
  }
}

/** Read a single key from .env without exposing the rest. */
export function readEnvKey(key: string): string | undefined {
  try {
    const text = fs.readFileSync(PATHS.envFile, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env */
  }
  return undefined;
}
