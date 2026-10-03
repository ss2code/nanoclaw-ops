/**
 * Claude subscription rate-limit quota — the cdq analog for Claude.
 *
 * Surfaces the rolling 5h and 7d window utilization (% of the subscription cap
 * consumed) so the Ops Center can chart subscription pressure over time, the way
 * `cdq` (~/Dev/projects/scripts/codex_quota.sh) does for Codex.
 *
 * ── Source seam ─────────────────────────────────────────────────────────────
 * Two sources, selected by `OpsConfig.quotaSource`:
 *
 *   'statusline' — pure read-only. Reads the cache file that ~/.claude/statusline.sh
 *      writes when an interactive Claude Code session renders its status line. Zero
 *      auth wiring and zero network from the collector, but only refreshes while
 *      such a session is live.
 *
 *   'oauth' (default) — read-through on the SAME cache file. Reads the cache first;
 *      if it's older than `quotaFetchTtlMs`, kicks off a non-blocking background
 *      fetch of https://api.anthropic.com/api/oauth/usage (bearer token borrowed
 *      from Claude Code's own credentials: env → ~/.claude/.credentials.json →
 *      macOS Keychain → secret-tool) and atomically rewrites the cache for the
 *      next tick. The file is a shared contract: statusline.sh, this collector,
 *      and any future consumer (menu-bar apps etc.) all read it and whoever finds
 *      it stale refreshes it for everyone — aggregate request rate is bounded by
 *      the TTL, not by the number of consumers. While an interactive session is
 *      open, statusline's 60s refresh keeps the file warm and the collector never
 *      fetches. On any failure (expired token, network) the cache is left
 *      untouched, so the chart shows an honest gap rather than a stale flat line.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface QuotaSnapshot {
  /** Rolling 5-hour window utilization, 0–100. */
  fiveHourPct: number;
  /** Rolling 7-day window utilization, 0–100. */
  sevenDayPct: number;
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
  /** Age of the underlying data (ms). For the statusline source, file mtime age. */
  ageMs: number;
  /** ageMs <= staleMs — only fresh snapshots should be persisted as samples. */
  fresh: boolean;
}

export type QuotaSourceKind = 'statusline' | 'oauth';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 4000;

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the statusline cache. Returns null if the file is missing or unparseable,
 * or if it lacks the expected `five_hour`/`seven_day` shape. `fresh` reflects file
 * mtime vs. `staleMs`; the caller decides whether to record a stale snapshot.
 */
export function statuslineQuotaSource(cacheFile: string, staleMs: number, now: number): QuotaSnapshot | null {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(cacheFile).mtimeMs;
    raw = fs.readFileSync(cacheFile, 'utf8');
  } catch {
    return null; // nothing has populated it yet
  }
  let obj: { five_hour?: { utilization?: unknown; resets_at?: unknown }; seven_day?: { utilization?: unknown; resets_at?: unknown } };
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const five = num(obj.five_hour?.utilization);
  const seven = num(obj.seven_day?.utilization);
  if (five === null || seven === null) return null;
  const ageMs = Math.max(0, now - mtimeMs);
  return {
    fiveHourPct: five,
    sevenDayPct: seven,
    fiveHourResetsAt: typeof obj.five_hour?.resets_at === 'string' ? obj.five_hour.resets_at : null,
    sevenDayResetsAt: typeof obj.seven_day?.resets_at === 'string' ? obj.seven_day.resets_at : null,
    ageMs,
    fresh: ageMs <= staleMs,
  };
}

// ── OAuth read-through refresh ──────────────────────────────────────────────

/** Injectable seams so tests can run without keychain/network. */
export interface RefreshDeps {
  getToken: () => Promise<string | null>;
  fetchUsage: (token: string) => Promise<string | null>;
}

function execFileText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function tokenFromBlob(blob: string | null): string | null {
  if (!blob) return null;
  try {
    const t = JSON.parse(blob)?.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Borrow the OAuth access token Claude Code itself maintains, in the same
 * preference order as ~/.claude/statusline.sh's get_oauth_token. We never
 * attempt the refresh-token flow — refresh tokens rotate and racing Claude
 * Code's own refresh could invalidate its session. An expired token simply
 * means no refresh until the next interactive Claude Code run.
 */
async function getOauthToken(): Promise<string | null> {
  const env = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (env) return env;
  try {
    const creds = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const t = tokenFromBlob(creds);
    if (t) return t;
  } catch {
    /* no credentials file */
  }
  if (process.platform === 'darwin') {
    const blob = await execFileText('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
    const t = tokenFromBlob(blob);
    if (t) return t;
  }
  const blob = await execFileText('secret-tool', ['lookup', 'service', 'Claude Code-credentials']);
  return tokenFromBlob(blob);
}

async function fetchUsageRaw(token: string): Promise<string | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.34',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

let refreshInFlight = false;
let lastRefreshLog = '';

function logOnce(msg: string): void {
  if (msg === lastRefreshLog) return;
  lastRefreshLog = msg;
  console.error(`[ops-center] quota refresh: ${msg}`);
}

/**
 * Refresh the shared usage cache if it's older than `fetchTtlMs` (or missing).
 * Non-blocking contract: callers fire-and-forget; the rewritten cache is picked
 * up on the next sample tick. Returns null when no refresh is needed or one is
 * already in flight; otherwise resolves true iff the cache was rewritten.
 *
 * Write protocol (shared with statusline.sh and any other consumer): the file
 * holds the raw /api/oauth/usage response; mtime is the freshness signal; never
 * overwrite on a failed fetch; write atomically (tmp + rename) so concurrent
 * readers never see a partial file.
 */
export function maybeRefreshUsageCache(
  cacheFile: string,
  fetchTtlMs: number,
  now: number,
  deps: RefreshDeps = { getToken: getOauthToken, fetchUsage: fetchUsageRaw },
): Promise<boolean> | null {
  try {
    if (now - fs.statSync(cacheFile).mtimeMs <= fetchTtlMs) return null; // cache warm
  } catch {
    /* missing file → refresh */
  }
  if (refreshInFlight) return null;
  refreshInFlight = true;
  return (async () => {
    try {
      const token = await deps.getToken();
      if (!token) {
        logOnce('no OAuth token available (run Claude Code interactively to refresh credentials)');
        return false;
      }
      const body = await deps.fetchUsage(token);
      if (body === null) {
        logOnce('usage fetch failed (expired token or network) — leaving cache untouched');
        return false;
      }
      let parsed: { five_hour?: { utilization?: unknown }; seven_day?: { utilization?: unknown } };
      try {
        parsed = JSON.parse(body);
      } catch {
        logOnce('usage response unparseable — leaving cache untouched');
        return false;
      }
      if (num(parsed.five_hour?.utilization) === null || num(parsed.seven_day?.utilization) === null) {
        logOnce('usage response missing five_hour/seven_day — leaving cache untouched');
        return false;
      }
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, cacheFile);
      logOnce('ok');
      return true;
    } catch (err) {
      logOnce(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      refreshInFlight = false;
    }
  })();
}

/**
 * Read the current Claude quota snapshot via the configured source. The read path
 * is synchronous and cheap (a single stat+read); the 'oauth' source additionally
 * fire-and-forgets a background cache refresh when the file is older than
 * `fetchTtlMs`, so a fresh value lands by the next tick.
 */
export function readClaudeQuota(
  opts: { source: QuotaSourceKind; cacheFile: string; staleMs: number; fetchTtlMs?: number },
  now: number = Date.now(),
): QuotaSnapshot | null {
  const snap = statuslineQuotaSource(opts.cacheFile, opts.staleMs, now);
  if (opts.source === 'oauth') {
    void maybeRefreshUsageCache(opts.cacheFile, opts.fetchTtlMs ?? 180_000, now);
  }
  return snap;
}
