/**
 * Host log access: incremental scan for ops signals (rate limits, kills,
 * errors), live tail buffer for the dashboard, and copy-truncate rotation
 * (launchd holds the fd, so we must truncate in place, never rename).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type Database from 'better-sqlite3';
import { getMeta, setMeta } from '../opsdb.js';
import { PATHS } from '../config.js';

export interface KillEvent {
  /** Raw (formatting-stripped) log line, truncated. */
  line: string;
  /** killContainer reason: absolute-ceiling | claim-stuck | restarted via ncl | rebuild applied | … */
  reason: string;
  /**
   * True only for kills that mean the container died UNEXPECTEDLY and its work
   * was reset for retry — the genuine crash-loop signal. Idle GC
   * (absolute-ceiling) and intentional restarts (operator ncl, self-mod
   * rebuilds) are normal lifecycle and must never trip the crash-loop alert.
   */
  abnormal: boolean;
}

export interface LogSignals {
  rateLimitEvents: string[];
  killEvents: KillEvent[];
  errorLines: string[];
  newLines: string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown';

export interface StructuredLogEvent {
  source: string;
  clock: string | null;
  level: LogLevel;
  category: string;
  message: string;
  groupId: string | null;
  sessionId: string | null;
  fields: Record<string, string>;
  line: string;
}

// Match an explicit provider/status signal, not the `.429`/`.529` millisecond
// suffix in the host log timestamp. The collector persists the full matching
// line, so a false positive here becomes a misleading provider incident.
const RATE_LIMIT_STATUS_RE = /(?:\b(?:http|status|code|err(?:or)?)\s*[=:]?\s*|\(\s*)(?:429|529)\b/i;
const RATE_LIMIT_TEXT_RE = /\b(?:rate[_ -]?limit(?:[_ -]?error)?|adapterratelimiterror|overloaded)\b/i;
// The canonical, exactly-once, reason-bearing kill line is killContainer's
// "Killing container … reason=…" log. Host-sweep's pre-log WARNs ("past
// absolute ceiling" / "message claimed then silent") and the follow-on "Reset
// stale message" / "Cleared orphan processing claims" lines all lack a reason=
// field, so keying on this pair de-dupes the 2+-lines-per-kill count down to one.
const KILL_LINE_RE = /Killing container\b/i;
const KILL_REASON_RE = /reason=(?:"([^"]+)"|([\w-]+))/;
// Kill reasons that signal an UNEXPECTED death (container hung, message retried) —
// the only kills that count toward the crash-loop alert. Every other reason
// (absolute-ceiling idle GC, "restarted via ncl", "rebuild applied", …) is
// normal lifecycle.
const ABNORMAL_KILL_REASONS = new Set(['claim-stuck']);
const ERROR_RE = /\bERROR\b|\bFATAL\b/;

export function stripLogFormatting(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\\x1b\[[0-9;]*m/g, '')
    .replace(/\\u001b\[[0-9;]*m/g, '');
}

function fields(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of line.matchAll(/\b([A-Za-z_][\w-]*)=(?:"([^"]*)"|([^\s]+))/g)) {
    out[match[1]] = match[2] ?? match[3];
  }
  return out;
}

export function parseLogLine(line: string, source = 'nanoclaw.log'): StructuredLogEvent | null {
  const clean = stripLogFormatting(line).trim();
  if (!clean) return null;
  const prefix = clean.match(/^\[([^\]]+)\]\s+(DEBUG|INFO|WARN|ERROR|FATAL)\s+(.+)$/i);
  let level = (prefix?.[2]?.toLowerCase() ?? 'unknown') as LogLevel;
  const rest = prefix?.[3] ?? clean;
  const parsedFields = fields(rest);
  if (level === 'info' && parsedFields.ok === 'false') level = 'warn';
  const firstField = rest.search(/\s[A-Za-z_][\w-]*=(?:"|[^\s])/);
  const message = (firstField >= 0 ? rest.slice(0, firstField) : rest).trim();
  const category = classifyLogEvent(message, level);
  return {
    source,
    clock: prefix?.[1] ?? null,
    level,
    category,
    message,
    groupId: parsedFields.agentGroup ?? parsedFields.agent_group_id ?? parsedFields.group ?? null,
    sessionId: parsedFields.sessionId ?? parsedFields.session_id ?? null,
    fields: parsedFields,
    line: clean,
  };
}

function classifyLogEvent(message: string, level: LogLevel): string {
  if (/rate.?limit|overloaded|\b429\b|\b529\b/i.test(message)) return 'rate_limit';
  if (/Killing container|Container exited|Spawning container/i.test(message)) return 'container';
  if (/Message routed|Agent message routed/i.test(message)) return 'routing';
  if (/Message delivered|delivery failed/i.test(message)) return 'delivery';
  if (/CLI request|CLI response/i.test(message)) return 'cli';
  if (/Channel adapter|Webhook|Inbound DM/i.test(message)) return 'channel';
  if (/approval/i.test(message)) return 'approval';
  if (level === 'error' || level === 'fatal') return 'error';
  return 'system';
}

export interface LogEventFilters {
  query?: string;
  level?: string;
  source?: string;
  category?: string;
  groupId?: string;
  sessionId?: string;
  limit?: number;
}

/** Structured events from live logs, newest first. Raw archives remain searchable separately. */
export function readLogEvents(filters: LogEventFilters = {}): StructuredLogEvent[] {
  const limit = Math.max(1, Math.min(filters.limit ?? 300, 1000));
  const query = filters.query?.trim().toLowerCase();
  const files = [
    { file: PATHS.hostLog, source: 'nanoclaw.log' },
    { file: PATHS.hostErrLog, source: 'nanoclaw.error.log' },
  ];
  const events: StructuredLogEvent[] = [];
  for (const { file, source } of files) {
    if (filters.source && filters.source !== 'all' && filters.source !== source) continue;
    for (const line of tailLines(file, 3000, 2 * 1024 * 1024).reverse()) {
      const event = parseLogLine(line, source);
      if (!event) continue;
      if (filters.level && filters.level !== 'all' && event.level !== filters.level) continue;
      if (filters.category && filters.category !== 'all' && event.category !== filters.category) continue;
      if (filters.groupId && !matchesScope(event.groupId, event.line, filters.groupId)) continue;
      if (filters.sessionId && !matchesScope(event.sessionId, event.line, filters.sessionId)) continue;
      if (query && !event.line.toLowerCase().includes(query)) continue;
      events.push(event);
      if (events.length >= limit) return events;
    }
  }
  return events;
}

function matchesScope(value: string | null, line: string, wanted: string): boolean {
  return value === wanted || line.includes(wanted);
}

export function scanLogSignals(text: string): LogSignals {
  const out: LogSignals = { rateLimitEvents: [], killEvents: [], errorLines: [], newLines: [] };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const clean = stripLogFormatting(line);
    out.newLines.push(clean);
    // Remove the structured log prefix before matching numeric status codes so
    // timestamps ending in .429/.529 cannot be mistaken for HTTP responses.
    const message = clean.replace(/^\[[^\]]+\]\s+(?:DEBUG|INFO|WARN|ERROR|FATAL)\s+/i, '');
    if (RATE_LIMIT_STATUS_RE.test(message) || RATE_LIMIT_TEXT_RE.test(message)) {
      out.rateLimitEvents.push(clean.slice(0, 400));
    }
    if (KILL_LINE_RE.test(clean)) {
      const m = clean.match(KILL_REASON_RE);
      const reason = m ? (m[1] ?? m[2]) : undefined;
      // Only the reason-bearing killContainer line is a real kill; skipping the
      // reason-less pre-log/reset WARNs is what de-dupes the count.
      if (reason) {
        out.killEvents.push({ line: clean.slice(0, 400), reason, abnormal: ABNORMAL_KILL_REASONS.has(reason) });
      }
    }
    if (ERROR_RE.test(clean)) out.errorLines.push(clean.slice(0, 400));
  }
  return out;
}

/** Read appended bytes of a log since the stored offset (offset key in ops.db meta). */
export function readNewLogText(opsDb: Database.Database, file: string): string {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const metaKey = `log:${file}`;
  let offset = Number(getMeta(opsDb, metaKey) ?? size); // first run: start at EOF, don't replay history
  if (offset > size) offset = 0; // rotated/truncated
  if (size <= offset) {
    setMeta(opsDb, metaKey, String(size));
    return '';
  }
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024)); // cap a single scan at 4MB
    fs.readSync(fd, buf, 0, buf.length, offset);
    setMeta(opsDb, metaKey, String(offset + buf.length));
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Last N lines of a log file for the tail view. */
export function tailLines(file: string, n: number, maxBytes = 256 * 1024): string[] {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const readFrom = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

export interface RotationResult {
  rotated: string[];
  removed: string[];
}

/**
 * Copy-truncate rotation. For each log over maxBytes: gzip-copy to
 * logs/archive/<name>-<stamp>.log.gz, then truncate the live file in place.
 * Keeps the newest `keep` archives per log name.
 */
export function rotateLogs(
  files: string[],
  maxBytes: number,
  keep: number,
  archiveDir: string = PATHS.logArchiveDir,
  nowIso?: string,
): RotationResult {
  const result: RotationResult = { rotated: [], removed: [] };
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const file of files) {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) continue;
    const base = path.basename(file, '.log');
    const stamp = (nowIso ?? new Date().toISOString()).replace(/[:.]/g, '-');
    const target = path.join(archiveDir, `${base}-${stamp}.log.gz`);
    const data = fs.readFileSync(file);
    fs.writeFileSync(target, zlib.gzipSync(data));
    fs.truncateSync(file, 0); // launchd keeps writing to the same fd
    result.rotated.push(target);
    // Prune old generations of this log
    const archives = fs
      .readdirSync(archiveDir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.log.gz'))
      .sort();
    while (archives.length > keep) {
      const victim = archives.shift()!;
      fs.unlinkSync(path.join(archiveDir, victim));
      result.removed.push(victim);
    }
  }
  return result;
}

/** Search live + archived logs for a substring (case-insensitive), newest first. */
export function searchLogs(query: string, limit = 200): { source: string; line: string }[] {
  const q = query.toLowerCase();
  const out: { source: string; line: string }[] = [];
  const scanText = (source: string, text: string) => {
    for (const rawLine of text.split('\n').reverse()) {
      const line = stripLogFormatting(rawLine);
      if (line.toLowerCase().includes(q)) {
        out.push({ source, line: line.slice(0, 500) });
        if (out.length >= limit) return true;
      }
    }
    return false;
  };
  for (const f of [PATHS.hostLog, PATHS.hostErrLog]) {
    if (fs.existsSync(f) && scanText(path.basename(f), fs.readFileSync(f, 'utf8'))) return out;
  }
  if (fs.existsSync(PATHS.logArchiveDir)) {
    const archives = fs
      .readdirSync(PATHS.logArchiveDir)
      .filter((f) => f.endsWith('.log.gz'))
      .sort()
      .reverse();
    for (const f of archives) {
      const text = zlib.gunzipSync(fs.readFileSync(path.join(PATHS.logArchiveDir, f))).toString('utf8');
      if (scanText(f, text)) return out;
    }
  }
  return out;
}
