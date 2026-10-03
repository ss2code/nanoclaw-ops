/**
 * Container lifecycle from host-log lines (design: 2026-06-12 spec, Part 1).
 *
 * Spawn timestamps are exact: container names embed the spawn epoch
 * (nanoclaw-v2-<folder>-<Date.now()>). Exit lines only have a time-of-day
 * clock, so the date is inferred from an anchor: "before now" during live
 * ingestion, "after the previous event" during backfill.
 */
import fs from 'fs';
import type Database from 'better-sqlite3';
import { parseLogLine } from './logs.js';
import { addEvent, getMeta, setMeta } from '../opsdb.js';

const NAME_RE = /^nanoclaw-v2-(.+)-(\d{13})$/;
const CLOCK_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;
const DAY_MS = 86_400_000;

export function parseContainerName(name: string): { folder: string; epochMs: number } | null {
  const m = name.match(NAME_RE);
  return m ? { folder: m[1], epochMs: Number(m[2]) } : null;
}

function clockOnAnchorDay(clock: string, anchorMs: number): number | null {
  const m = clock.match(CLOCK_RE);
  if (!m) return null;
  const d = new Date(anchorMs);
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
  return d.getTime();
}

/** Clock resolved to the most recent occurrence at/before anchor (live scan: anchor = now). */
export function resolveClockBefore(clock: string, anchorMs: number): number | null {
  let ts = clockOnAnchorDay(clock, anchorMs);
  if (ts == null) return null;
  if (ts > anchorMs + 60_000) ts -= DAY_MS;
  return ts;
}

/** Clock resolved to the first occurrence at/after anchor (backfill: anchor = previous event). */
export function resolveClockAfter(clock: string, anchorMs: number): number | null {
  let ts = clockOnAnchorDay(clock, anchorMs);
  if (ts == null) return null;
  while (ts < anchorMs - 60_000) ts += DAY_MS;
  return ts;
}

export interface LifecycleLineEvent {
  kind: 'container_spawn' | 'container_exit';
  tsMs: number;
  folder: string;
  containerName: string;
  sessionId: string | null;
  code: number | null;
  /** What woke the container (spawns only): sender + message preview. Null for
   * exits and for spawns logged without a trigger. */
  trigger: string | null;
  /** killContainer teardown reason (kill-derived exits only): absolute-ceiling |
   * claim-stuck | restarted via ncl | rebuild applied | … Null for spawns and
   * for exits derived from the OS "Container exited" line (those carry a code). */
  reason: string | null;
}

export function parseLifecycleLine(
  line: string,
  anchorMs: number,
  anchorMode: 'before' | 'after',
): LifecycleLineEvent | null {
  const ev = parseLogLine(line);
  if (!ev) return null;
  const isSpawn = ev.message === 'Spawning container';
  // A container span is CLOSED by whichever of these lands FIRST:
  //   • "Killing container" — the host's synchronous, always-logged,
  //     reason-bearing teardown decision (idle GC, claim-stuck, restart, …).
  //   • "Container exited[ non-zero]" — the async confirmation once the
  //     docker-run child actually dies.
  // Keying on BOTH is load-bearing: the async exit line is best-effort and
  // sometimes never reaches the log (the child can die before its exit handler
  // flushes). When it went missing, the open span used to stretch to the NEXT
  // spawn — swallowing the whole dormant gap and inflating "active" time with
  // phantom multi-hour runs. buildSpans() closes at the earliest event, so a
  // normal kill→exit pair still ends the span at the kill instant.
  // Exact-match "Killing container" excludes host-sweep's pre-log WARN
  // ("Killing container past absolute ceiling …"), which carries no
  // containerName and would be dropped by parseContainerName anyway.
  const isKill = ev.message === 'Killing container';
  const isExit = isKill || ev.message === 'Container exited' || ev.message === 'Container exited non-zero';
  if (!isSpawn && !isExit) return null;
  const name = ev.fields.containerName;
  const parsed = name ? parseContainerName(name) : null;
  if (!parsed) return null;
  let tsMs: number;
  if (isSpawn) {
    tsMs = parsed.epochMs;
  } else {
    const resolved = ev.clock
      ? anchorMode === 'before'
        ? resolveClockBefore(ev.clock, anchorMs)
        : resolveClockAfter(ev.clock, anchorMs)
      : null;
    // Clock is always present in real log lines; the fallback only guards malformed input.
    tsMs = resolved ?? anchorMs;
  }
  return {
    kind: isSpawn ? 'container_spawn' : 'container_exit',
    tsMs,
    folder: parsed.folder,
    containerName: name!,
    sessionId: ev.sessionId,
    code: ev.fields.code != null ? Number(ev.fields.code) : null,
    trigger: isSpawn && ev.fields.trigger ? ev.fields.trigger : null,
    reason: isKill && ev.fields.reason ? ev.fields.reason : null,
  };
}

function insertLifecycleEvent(db: Database.Database, ev: LifecycleLineEvent, groupId: string): void {
  addEvent(db, {
    ts: new Date(ev.tsMs).toISOString(),
    group_id: groupId,
    kind: ev.kind,
    severity: 'info',
    detail: JSON.stringify({
      containerName: ev.containerName,
      sessionId: ev.sessionId,
      ...(ev.code != null ? { code: ev.code } : {}),
      ...(ev.trigger ? { trigger: ev.trigger } : {}),
      ...(ev.reason ? { reason: ev.reason } : {}),
    }),
  });
}

export interface ActivitySpan {
  startMs: number;
  endMs: number;
  live: boolean;   // container still running — span extends to now
  approx: boolean; // exit never logged; closed from the last active sample
  sessionId: string | null;
  code: number | null;
  containerName: string;
}

interface SpanEventRowLike {
  ts: string;
  kind: string;
  detail: string;
}

/**
 * Pair spawn/exit events (queried for the last 24h) into spans by containerName.
 * Span starts always come from the epoch embedded in the name — exact even when
 * the spawn event itself predates the query window.
 */
export function buildSpans(
  rows: SpanEventRowLike[],
  opts: { fromMs: number; nowMs: number; containersUpNow: number; lastActiveSampleMs: number | null },
): ActivitySpan[] {
  const byName = new Map<string, { startMs: number; sessionId: string | null; exitMs?: number; code?: number }>();
  for (const r of rows) {
    let d: { containerName?: string; sessionId?: string; code?: number };
    try {
      d = JSON.parse(r.detail);
    } catch {
      continue;
    }
    if (!d.containerName) continue;
    const parsed = parseContainerName(d.containerName);
    if (!parsed) continue;
    const entry = byName.get(d.containerName) ?? { startMs: parsed.epochMs, sessionId: d.sessionId ?? null };
    if (r.kind === 'container_exit') {
      // Earliest close wins: one container can record BOTH a "Killing
      // container" event and its async "Container exited" confirmation. End the
      // span at the first — the kill instant — so it never stretches past the
      // real teardown.
      const exitMs = Date.parse(r.ts);
      entry.exitMs = entry.exitMs == null ? exitMs : Math.min(entry.exitMs, exitMs);
      if (d.code != null) entry.code = d.code;
    }
    if (d.sessionId) entry.sessionId = d.sessionId;
    byName.set(d.containerName, entry);
  }
  // Newest unclosed spans get the live slots (one per running container).
  const unclosed = [...byName.entries()].filter(([, e]) => e.exitMs == null).sort((a, b) => b[1].startMs - a[1].startMs);
  const liveNames = new Set(unclosed.slice(0, opts.containersUpNow).map(([n]) => n));
  // Sorted starts let an orphan's approx-close be bounded by the next container's
  // spawn: a single-session group can't run two containers at once, so the missing
  // exit must precede the next spawn. Without this an orphan stretches to the last
  // active sample (~now) and visually swallows the whole window.
  const starts = [...byName.values()].map((e) => e.startMs).sort((a, b) => a - b);
  const spans: ActivitySpan[] = [];
  for (const [containerName, e] of byName) {
    let endMs: number;
    let live = false;
    let approx = false;
    if (e.exitMs != null) {
      endMs = e.exitMs;
    } else if (liveNames.has(containerName)) {
      endMs = opts.nowMs;
      live = true;
    } else {
      const nextStart = starts.find((s) => s > e.startMs);
      const ceiling = Math.min(opts.lastActiveSampleMs ?? e.startMs, nextStart ?? Infinity);
      endMs = Math.max(e.startMs, ceiling);
      approx = true;
    }
    if (endMs < opts.fromMs) continue;
    spans.push({ startMs: e.startMs, endMs, live, approx, sessionId: e.sessionId, code: e.code ?? null, containerName });
  }
  return spans.sort((a, b) => a.startMs - b.startMs);
}

/** Total covered time of the union of spans, clamped to [fromMs, nowMs]. */
export function unionDurationMs(spans: ActivitySpan[], fromMs: number, nowMs: number): number {
  const iv = spans
    .map((s) => [Math.max(s.startMs, fromMs), Math.min(s.endMs, nowMs)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of iv) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** Live-scan ingestion: called from the collector with each tick's new log lines. */
export function ingestLifecycleLines(
  db: Database.Database,
  lines: string[],
  folderToGroup: Map<string, string>,
  nowMs: number,
): number {
  let n = 0;
  for (const line of lines) {
    const ev = parseLifecycleLine(line, nowMs, 'before');
    if (!ev) continue;
    const groupId = folderToGroup.get(ev.folder);
    if (!groupId) continue; // group deleted or unknown
    insertLifecycleEvent(db, ev, groupId);
    n++;
  }
  return n;
}

/**
 * One-time backfill of the live log so the ribbon is populated on first deploy.
 * Reads only bytes the incremental scan has already consumed (or the whole file
 * if it has never run — in that case the offset is sealed here so the first
 * incremental scan continues from where backfill stopped instead of EOF).
 * Exit dates are inferred monotonically: each event anchors the next.
 */
export function backfillLifecycle(
  db: Database.Database,
  logFile: string,
  folderToGroup: Map<string, string>,
  nowMs: number,
): number {
  if (getMeta(db, 'lifecycle_backfilled')) return 0;
  setMeta(db, 'lifecycle_backfilled', new Date(nowMs).toISOString());
  if (!fs.existsSync(logFile)) return 0;
  const size = fs.statSync(logFile).size;
  const offsetMeta = getMeta(db, `log:${logFile}`);
  const limit = offsetMeta != null ? Math.min(Number(offsetMeta), size) : size;
  if (offsetMeta == null) setMeta(db, `log:${logFile}`, String(limit));
  if (limit <= 0) return 0;
  const fd = fs.openSync(logFile, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(limit);
    fs.readSync(fd, buf, 0, limit, 0);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  // anchor 0 → exits with no prior spawn resolve to ~1970; harmless, filtered by sinceIso at query time.
  let anchor = 0;
  let n = 0;
  for (const line of text.split('\n')) {
    const ev = parseLifecycleLine(line, anchor, 'after');
    if (!ev) continue;
    anchor = Math.max(anchor, ev.tsMs);
    const groupId = folderToGroup.get(ev.folder);
    if (!groupId) continue;
    insertLifecycleEvent(db, ev, groupId);
    n++;
  }
  return n;
}
