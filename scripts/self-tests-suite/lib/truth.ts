/**
 * Provider ground-truth: which model *actually* ran a turn.
 *
 * The suite never trusts the agent's self-reported model name (a weak model
 * will hallucinate it). It reads the provider's own record instead:
 *   - opencode → session- or group-persistent `opencode-xdg/opencode/opencode.db`,
 *     or the provider's structured `opencode.log` while its long-lived process
 *     still has recent SQLite writes open; both carry `providerID`/`modelID`
 *   - claude   → SDK transcript JSONL under `.claude-shared/projects/`, `message.model`
 *   - codex    → rollout JSONL under `.codex-shared/sessions/`, completed task model
 *
 * Flow per probe: snapshot a baseline, send the message, then poll for the
 * newest assistant turn that postdates the baseline.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { GroupRouting } from './group.js';

export interface TurnResult {
  /** Model id the provider recorded for the newest assistant turn, or null. */
  model: string | null;
  /** True if no new assistant turn appeared before the deadline. */
  timedOut: boolean;
}

/**
 * OpenCode normally uses a session-local store. Native XAI OAuth groups use a
 * group-persistent store so the refreshable credential survives new sessions.
 * Probe both layouts because the suite must validate either provider mode.
 */
function opencodeDbPaths(sessionDir: string): string[] {
  return [
    path.join(sessionDir, 'opencode-xdg', 'opencode', 'opencode.db'),
    path.join(path.dirname(sessionDir), 'opencode-xdg', 'opencode', 'opencode.db'),
  ].filter((file, i, files) => files.indexOf(file) === i && fs.existsSync(file));
}

function opencodeLogPaths(sessionDir: string): string[] {
  return [
    path.join(sessionDir, 'opencode-xdg', 'opencode', 'log', 'opencode.log'),
    path.join(path.dirname(sessionDir), 'opencode-xdg', 'opencode', 'log', 'opencode.log'),
  ].filter((file, i, files) => files.indexOf(file) === i && fs.existsSync(file));
}

function opencodeLogLatest(
  sessionDir: string,
  afterMs = 0,
  beforeMs = Number.POSITIVE_INFINITY,
): { time: number; model: string } | null {
  let latest: { time: number; model: string } | null = null;
  for (const file of opencodeLogPaths(sessionDir)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('message=stream ') || !line.includes('providerID=') || !line.includes('modelID=')) continue;
      const timestamp = line.match(/(?:^|\s)timestamp=([^\s]+)/)?.[1];
      const model = line.match(/(?:^|\s)modelID=([^\s]+)/)?.[1];
      const time = timestamp ? Date.parse(timestamp) : NaN;
      if (!model || !Number.isFinite(time) || time <= afterMs || time >= beforeMs) continue;
      if (!latest || time > latest.time) latest = { time, model };
    }
  }
  return latest;
}

function opencodeLatestBetween(sessionDir: string, afterMs: number, beforeMs = Number.POSITIVE_INFINITY): string | null {
  // Prefer the provider's structured log while the long-lived OpenCode
  // process is active. Opening its live SQLite store read-only can interfere
  // with WAL writes on the bind mount and produce a non-fatal follow-up error.
  const fromLog = opencodeLogLatest(sessionDir, afterMs, beforeMs);
  if (fromLog) return fromLog.model;

  let latest: { time: number; model: string } | null = null;
  for (const file of opencodeDbPaths(sessionDir)) {
    const db = openRo(file);
    if (!db) continue;
    try {
      const row = db
        .prepare(
          `SELECT time_created AS time, json_extract(data,'$.modelID') AS model
           FROM message
           WHERE json_extract(data,'$.role')='assistant'
             AND json_extract(data,'$.modelID') IS NOT NULL
             AND time_created > ? AND time_created < ?
           ORDER BY time_created DESC LIMIT 1`,
        )
        .get(afterMs, beforeMs) as { time: number; model: string | null } | undefined;
      if (row?.model && (!latest || row.time > latest.time)) latest = { time: row.time, model: row.model };
    } finally {
      db.close();
    }
  }
  return latest?.model ?? null;
}

/** Newest assistant turn's creation time (ms) in the opencode store, or 0. */
function opencodeBaseline(sessionDir: string): number {
  const fromLog = opencodeLogLatest(sessionDir);
  if (fromLog) return fromLog.time;

  let latest = 0;
  for (const file of opencodeDbPaths(sessionDir)) {
    const db = openRo(file);
    if (!db) continue;
    try {
      const row = db
        .prepare(
          `SELECT MAX(time_created) AS t FROM message
           WHERE json_extract(data,'$.role')='assistant'
             AND json_extract(data,'$.modelID') IS NOT NULL`,
        )
        .get() as { t: number | null } | undefined;
      latest = Math.max(latest, row?.t ?? 0);
    } finally {
      db.close();
    }
  }
  return latest;
}

function opencodeLatestAfter(sessionDir: string, baselineMs: number): string | null {
  return opencodeLatestBetween(sessionDir, baselineMs);
}

/** Return the provider model that generated a reply at or before its timestamp. */
export function modelForCompletedTurn(
  g: GroupRouting,
  sessionDir: string,
  baselineMs: number,
  completedAtMs: number,
): string | null {
  return g.provider === 'opencode' ? opencodeLatestBetween(sessionDir, baselineMs, completedAtMs + 1) : null;
}

/**
 * Claude SDK transcripts are per-GROUP, not per-session: they live at
 * data/v2-sessions/<agent-group>/.claude-shared/projects/<project>/  — a
 * sibling of the session dirs. Note this means concurrent activity in another
 * session of the same group can appear here; probes should target a quiet
 * group or tolerate the noise.
 */
function claudeTranscripts(sessionDir: string): { file: string; m: number; size: number }[] {
  const root = path.join(path.dirname(sessionDir), '.claude-shared', 'projects');
  const out: { file: string; m: number; size: number }[] = [];
  try {
    for (const proj of fs.readdirSync(root)) {
      const dir = path.join(root, proj);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const s = fs.statSync(path.join(dir, f));
        out.push({ file: path.join(dir, f), m: s.mtimeMs, size: s.size });
      }
    }
  } catch {
    /* none yet */
  }
  return out;
}

/**
 * Claude baseline is a wall-clock cursor (records carry ISO `timestamp`).
 * Byte- or mtime-based cursors are wrong here: a transcript grows as soon as
 * the new USER record lands, at which point the last assistant record in the
 * file is still the *previous* turn's — reading it produces an off-by-one
 * where every probe reports the prior case's model.
 */
function claudeBaseline(): number {
  return Date.now();
}

/**
 * Newest main-chain assistant `message.model` recorded after `baselineMs`,
 * across all of the group's transcripts (a tier directive starts a fresh SDK
 * session, i.e. a new file). Sidechain (subagent) records are excluded — they
 * run on their own models and would pollute the verdict.
 */
function claudeLatestAfter(sessionDir: string, baselineMs: number): string | null {
  let best: { ts: number; model: string } | null = null;
  for (const f of claudeTranscripts(sessionDir)) {
    if (f.m <= baselineMs) continue; // untouched since baseline
    let lines: string[];
    try {
      lines = fs.readFileSync(f.file, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as {
          timestamp?: string;
          isSidechain?: boolean;
          message?: { role?: string; model?: string };
        };
        if (rec.isSidechain === true) continue;
        if (rec.message?.role !== 'assistant' || typeof rec.message.model !== 'string') continue;
        const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts <= baselineMs) continue;
        if (!best || ts > best.ts) best = { ts, model: rec.message.model };
      } catch {
        /* skip partial line */
      }
    }
  }
  return best?.model ?? null;
}

/** Codex rollout files are group-shared and nested by date. */
function codexRollouts(sessionDir: string): string[] {
  const root = path.join(path.dirname(sessionDir), '.codex-shared', 'sessions');
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(file);
    }
  };
  visit(root);
  return out;
}

/**
 * Return only a completed Codex task. `turn_context` is emitted near task
 * start, so reporting it immediately would let the next probe get coalesced
 * into the active turn via `turn/steer`.
 */
function codexLatestCompletedAfter(sessionDir: string, baselineMs: number): string | null {
  let best: { ts: number; model: string } | null = null;
  for (const file of codexRollouts(sessionDir)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }

    let activeModel: { ts: number; model: string } | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as {
          timestamp?: string;
          type?: string;
          payload?: { type?: string; model?: string };
        };
        const ts = record.timestamp ? Date.parse(record.timestamp) : NaN;
        if (record.type === 'event_msg' && record.payload?.type === 'task_started') {
          activeModel = null;
          continue;
        }
        if (
          record.type === 'turn_context' &&
          typeof record.payload?.model === 'string' &&
          Number.isFinite(ts) &&
          ts > baselineMs
        ) {
          activeModel = { ts, model: record.payload.model };
          continue;
        }
        if (
          record.type === 'event_msg' &&
          record.payload?.type === 'task_complete' &&
          activeModel &&
          Number.isFinite(ts) &&
          ts > activeModel.ts &&
          (!best || ts > best.ts)
        ) {
          best = { ts, model: activeModel.model };
          activeModel = null;
        }
      } catch {
        /* skip partial line */
      }
    }
  }
  return best?.model ?? null;
}

/** Snapshot the provider's "before" cursor for a group. */
export function baseline(g: GroupRouting, sessionDir: string): number {
  return g.provider === 'opencode' ? opencodeBaseline(sessionDir) : claudeBaseline();
}

/** Poll for the newest assistant turn recorded after `baselineCursor`. */
export async function awaitTurn(
  g: GroupRouting,
  sessionDir: string,
  baselineCursor: number,
  opts: { timeoutMs: number; pollMs: number },
): Promise<TurnResult> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const model =
      g.provider === 'opencode'
        ? opencodeLatestAfter(sessionDir, baselineCursor)
        : g.provider === 'codex'
          ? codexLatestCompletedAfter(sessionDir, baselineCursor)
        : claudeLatestAfter(sessionDir, baselineCursor);
    if (model) return { model, timedOut: false };
    await sleep(opts.pollMs);
  }
  return { model: null, timedOut: true };
}

function openRo(file: string): Database.Database | null {
  try {
    return fs.existsSync(file) ? new Database(file, { readonly: true, fileMustExist: true }) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
