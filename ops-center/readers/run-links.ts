/**
 * Read-only joins which enrich the Runs session drill-down.  They deliberately
 * live outside the transcript parser: session DBs and host logs are volatile
 * operational state, whereas parsed transcripts are mtime-cached.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { listSessionDirs, toUtcMs } from './sessiondbs.js';
import type { ForwardRouteEvent } from './routes.js';
import { normWs, type ExecutionRun, type RunToolCall, type RunTurn } from './runs.js';

export type DeliveryState = 'delivered' | 'pending' | 'none';

function openRo(file: string): Database.Database | null {
  try {
    return fs.existsSync(file) ? new Database(file, { readonly: true, fileMustExist: true }) : null;
  } catch {
    return null;
  }
}

let sessionMapCache: { at: number; entries: Map<string, string> } | null = null;

/** Map the current Claude transcript UUID to its host session directory. */
export function claudeSessionDirs(now = Date.now()): Map<string, string> {
  if (sessionMapCache && now - sessionMapCache.at < 60_000) return sessionMapCache.entries;
  const entries = new Map<string, string>();
  for (const session of listSessionDirs()) {
    const db = openRo(path.join(session.dir, 'outbound.db'));
    if (!db) continue;
    try {
      const row = db.prepare("SELECT value FROM session_state WHERE key = 'continuation:claude'").get() as { value?: string } | undefined;
      if (row?.value) entries.set(row.value, session.dir);
    } catch {
      // Old sessions do not necessarily have session_state.
    } finally {
      db.close();
    }
  }
  sessionMapCache = { at: now, entries };
  return entries;
}

/**
 * Delivery evidence for each turn. A chat outbound row linked by in_reply_to is
 * delivered; a chat row in the response window without linkage is pending.
 */
export function deliveryByTurn(sessionId: string, turns: RunTurn[]): Map<number, DeliveryState> {
  const states = new Map<number, DeliveryState>();
  const dir = claudeSessionDirs().get(sessionId);
  if (!dir) return states;
  const inDb = openRo(path.join(dir, 'inbound.db'));
  const outDb = openRo(path.join(dir, 'outbound.db'));
  if (!inDb || !outDb) {
    inDb?.close(); outDb?.close();
    return states;
  }
  try {
    const inboundIds = new Set((inDb.prepare('SELECT id FROM messages_in').all() as { id: string }[]).map((row) => row.id));
    const out = outDb.prepare("SELECT timestamp, in_reply_to FROM messages_out WHERE kind = 'chat'").all() as { timestamp: string; in_reply_to: string | null }[];
    for (const turn of turns) {
      const start = toUtcMs(turn.startedAt);
      const end = toUtcMs(turn.endedAt) + 60_000;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const rows = out.filter((row) => {
        const at = toUtcMs(row.timestamp);
        return Number.isFinite(at) && at >= start && at <= end;
      });
      if (rows.some((row) => row.in_reply_to && inboundIds.has(row.in_reply_to))) states.set(turn.index, 'delivered');
      else if (rows.length) states.set(turn.index, 'pending');
      else states.set(turn.index, 'none');
    }
  } catch {
    // A DB can disappear or be mid-schema-change; omit evidence rather than fail Runs.
  } finally {
    inDb.close(); outDb.close();
  }
  return states;
}

export interface A2aLink { tool: RunToolCall; href: string; toGroupId: string; }

/**
 * Resolve a run to its nanoclaw session id (`sess-…`). OpenCode runs already
 * use it as `sessionId`; Claude-lane runs use the transcript UUID, which
 * `claudeSessionDirs` maps back to the host session directory.
 */
export function hostSessionIdFor(run: ExecutionRun): string {
  const dir = claudeSessionDirs().get(run.sessionId);
  if (dir) return path.basename(dir);
  // OpenCode runs: the store path embeds the host session id
  // (<group>/<sess-…>/opencode-xdg/opencode/opencode.db).
  const m = run.file.match(/[/\\](sess-[^/\\]+)[/\\]/);
  return m ? m[1] : run.sessionId;
}

/** Correlate a sender tool step to a logged host forward and receiving a2a turn. */
export function correlateA2aLinks(run: ExecutionRun, pool: ExecutionRun[], routes: ForwardRouteEvent[]): A2aLink[] {
  const links: A2aLink[] = [];
  for (const turn of run.turns) for (const tool of turn.tools) {
    if (tool.name !== 'mcp__nanoclaw__send_message') continue;
    const at = Date.parse(tool.ts);
    if (!Number.isFinite(at)) continue;
    const route = routes
      .filter((r) => r.fromGroupId === run.groupId && Math.abs(toUtcMs(r.clock) - at) <= 120_000)
      .sort((a, b) => Math.abs(toUtcMs(a.clock) - at) - Math.abs(toUtcMs(b.clock) - at))[0];
    if (!route) continue;
    const target = pool.find((candidate) => candidate.groupId === route.toGroupId && hostSessionIdFor(candidate) === route.targetSession);
    const receiving = target?.turns
      .filter((candidate) => candidate.trigger.kind === 'a2a')
      .sort((a, b) => Math.abs(Date.parse(a.startedAt) - toUtcMs(route.clock)) - Math.abs(Date.parse(b.startedAt) - toUtcMs(route.clock)))[0];
    if (!target || !receiving) continue;
    links.push({ tool, toGroupId: route.toGroupId, href: `/runs/session?group=${encodeURIComponent(target.groupId)}&session=${encodeURIComponent(target.sessionId)}#turn-${receiving.index}` });
  }
  return links;
}

/** Exact Task prompt → child opening prompt links; ambiguous fan-outs return no link. */
export function taskChildLinks(parent: ExecutionRun, children: ExecutionRun[]): Map<RunToolCall, ExecutionRun> {
  const links = new Map<RunToolCall, ExecutionRun>();
  for (const tool of parent.tools) {
    if ((tool.name !== 'Task' && tool.name !== 'Agent') || !tool.taskPrompt) continue;
    const matches = children.filter((child) => child.openingPrompt && normWs(child.openingPrompt) === normWs(tool.taskPrompt!));
    if (matches.length === 1) links.set(tool, matches[0]);
  }
  return links;
}
