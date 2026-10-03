/**
 * Read-only access to per-session inbound.db / outbound.db files.
 * Session dirs live at data/v2-sessions/<agent_group_id>/<session_id>/.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { PATHS } from '../config.js';

export interface SessionDirs {
  groupId: string;
  sessionId: string;
  dir: string;
}

export function listSessionDirs(sessionsRoot: string = PATHS.sessionsDir): SessionDirs[] {
  const out: SessionDirs[] = [];
  if (!fs.existsSync(sessionsRoot)) return out;
  for (const groupId of fs.readdirSync(sessionsRoot)) {
    const groupDir = path.join(sessionsRoot, groupId);
    if (!fs.statSync(groupDir).isDirectory() || groupId.startsWith('.')) continue;
    for (const sessionId of fs.readdirSync(groupDir)) {
      if (sessionId.startsWith('.')) continue;
      const dir = path.join(groupDir, sessionId);
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'inbound.db'))) {
        out.push({ groupId, sessionId, dir });
      }
    }
  }
  return out;
}

function openRo(file: string): Database.Database | null {
  if (!fs.existsSync(file)) return null;
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

export type JourneyStage =
  | 'received'
  | 'queued'
  | 'processing'
  | 'completed_no_response'
  | 'response_written'
  | 'delivered'
  | 'failed';

export interface MessageJourney {
  messageId: string;
  sessionId: string;
  receivedAt: string;
  sender: string;
  channel: string;
  /**
   * For agent-to-agent hops (`channel === 'agent'`), the source agent group id
   * (from the inbound row's `platform_id`). Null for channel/user messages.
   * Lets the UI attribute the hop and link to the sending agent's group.
   */
  sourceAgentGroupId: string | null;
  /** Truncated message text, so the content is visible at a glance (esp. a2a). */
  preview: string;
  inboundStatus: string;
  ackStatus: string | null;
  responseId: string | null;
  responseAt: string | null;
  deliveredAt: string | null;
  linkage: 'exact' | 'inferred' | 'none';
  stage: JourneyStage;
  ageMs: number;
}

export interface MsgDelta {
  /** new chat messages (excl. tasks) inbound / outbound since the given cursors */
  msgsIn: number;
  msgsOut: number;
  /** current MAX(rowid) per table — store these and pass back next tick */
  inMax: number;
  outMax: number;
}

/**
 * Count NEW messages by rowid cursor rather than a wall-clock window.
 *
 * Why not timestamps: the per-tick approach in readSessionStats keys off each
 * message's own creation timestamp vs a moving `lastIso` window. A message only
 * becomes visible to this read-only host process after the container writes it
 * and the row crosses the mount boundary — often a tick or two after its stamp.
 * By then its timestamp has fallen out of the window, so it is silently dropped
 * forever. Outbound timestamps ('2026-06-11 09:29:12', no zone, second-res) make
 * the boundary comparison leakier still. rowids are monotonic and only appear
 * once visible, so counting `rowid > cursor` is exact, format-agnostic, and
 * catch-up-safe across collector restarts (mirrors the token byte-offset reader).
 *
 * Pass `null` for a cursor the first time a session is seen: we baseline to the
 * current MAX(rowid) and count 0, so pre-existing history is not dumped onto the
 * current tick as a false spike.
 */
export function readMessageDeltas(dir: string, inCursor: number | null, outCursor: number | null): MsgDelta {
  const out: MsgDelta = { msgsIn: 0, msgsOut: 0, inMax: inCursor ?? 0, outMax: outCursor ?? 0 };
  const inDb = openRo(path.join(dir, 'inbound.db'));
  if (inDb) {
    try {
      out.inMax = (inDb.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM messages_in').get() as { m: number }).m;
      if (inCursor != null) {
        out.msgsIn = (
          inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE rowid > ? AND kind != 'task'").get(inCursor) as {
            n: number;
          }
        ).n;
      }
    } catch {
      /* older/missing schema — leave zeros, baseline cursor */
    } finally {
      inDb.close();
    }
  }
  const outDb = openRo(path.join(dir, 'outbound.db'));
  if (outDb) {
    try {
      out.outMax = (outDb.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM messages_out').get() as { m: number }).m;
      if (outCursor != null) {
        out.msgsOut = (
          outDb.prepare('SELECT COUNT(*) AS n FROM messages_out WHERE rowid > ?').get(outCursor) as { n: number }
        ).n;
      }
    } catch {
      /* table may not exist yet */
    } finally {
      outDb.close();
    }
  }
  return out;
}

export interface RoutingDecision {
  ts: string;
  model: string;
  reason: string;
  /** 'spawn' = derived from a subagent_spawn event; 'line' = an agent-written `[model — reason]` text line. */
  source?: 'spawn' | 'line';
  /** Agent JSONL file the spawn came from (spawn rows only) — a display hint. */
  file?: string;
}

const ROUTING_RE = /\[(haiku|sonnet|opus)\s*[—–-]\s*([^\]]{2,120})\]/gi;

/** Collapse any full or short model id to its tier family for display + cross-source matching. */
export function modelFamily(m: string): string {
  const f = /(haiku|sonnet|opus)/i.exec(m);
  return f ? f[1].toLowerCase() : m;
}

/**
 * Best-effort: extract `[model — reason]` transparency lines (the model-routing
 * policy asks the agent to append one when it delegates) from recent replies.
 */
export function readRoutingDecisions(dir: string, sinceIso: string, limit = 20): RoutingDecision[] {
  const db = openRo(path.join(dir, 'outbound.db'));
  if (!db) return [];
  const out: RoutingDecision[] = [];
  const sinceMs = toUtcMs(sinceIso);
  try {
    const rows = db
      .prepare("SELECT timestamp, content FROM messages_out WHERE kind = 'chat' ORDER BY rowid DESC LIMIT 200")
      .all() as { timestamp: string; content: string }[];
    for (const r of rows) {
      // outbound.db stores zone-less SQLite datetimes ('2026-06-14 12:28:10'); a
      // raw `timestamp >= sinceIso` in SQL mis-compares the ' ' separator against
      // an ISO 'T', wrongly excluding rows. Filter in UTC ms instead.
      if (toUtcMs(r.timestamp) < sinceMs) continue;
      let text = r.content;
      try {
        const c = JSON.parse(r.content);
        if (typeof c.text === 'string') text = c.text;
      } catch {
        /* raw text content */
      }
      for (const m of text.matchAll(ROUTING_RE)) {
        out.push({ ts: r.timestamp, model: m[1].toLowerCase(), reason: m[2].trim(), source: 'line' });
        if (out.length >= limit) return out;
      }
    }
  } catch {
    /* missing table/schema — best-effort */
  } finally {
    db.close();
  }
  return out;
}

export interface SpawnDecision {
  ts: string; // ISO — the subagent_spawn event timestamp
  model: string; // full model id, e.g. 'claude-sonnet-4-6'
  file?: string;
  /** Reason derived from the transcript at spawn time (parent Task description or
   * the subagent's own prompt). Takes precedence over any fuzzy-matched text line. */
  reason?: string;
}

/**
 * Fuse the reliable `subagent_spawn` event stream (ground truth for WHEN a
 * delegation happened and to WHICH tier) with best-effort `[model — reason]`
 * text lines (which carry a human reason the agent often forgets to write).
 *
 * Each spawn carries a `reason` derived from its transcript at detection time
 * (the parent Task `description`, or the subagent's own opening prompt). That is
 * the primary reason. A `[model — reason]` text line within `windowMs` of a
 * same-tier spawn is used only as a secondary source when the spawn has no
 * transcript reason, then falls back to 'subagent spawned'. Unmatched lines are
 * kept on their own. Newest first.
 */
export function mergeRoutingDecisions(
  spawns: SpawnDecision[],
  lines: RoutingDecision[],
  windowMs = 120_000,
): RoutingDecision[] {
  const lineRows = lines.map((l) => ({ row: l, ms: toUtcMs(l.ts), fam: modelFamily(l.model), used: false }));
  const out: RoutingDecision[] = [];
  for (const s of spawns) {
    const fam = modelFamily(s.model);
    const sMs = toUtcMs(s.ts);
    let best: (typeof lineRows)[number] | undefined;
    let bestGap = Infinity;
    for (const l of lineRows) {
      if (l.used || l.fam !== fam) continue;
      const gap = Math.abs(l.ms - sMs);
      if (gap <= windowMs && gap < bestGap) {
        best = l;
        bestGap = gap;
      }
    }
    if (best) best.used = true;
    const spawnReason = s.reason?.trim();
    out.push({
      ts: toIsoUtc(s.ts),
      model: fam,
      reason: spawnReason || (best ? best.row.reason : 'subagent spawned'),
      source: 'spawn',
      file: s.file,
    });
  }
  for (const l of lineRows) {
    if (l.used) continue;
    out.push({ ts: toIsoUtc(l.row.ts), model: l.fam, reason: l.row.reason, source: 'line' });
  }
  return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export interface MsgRow {
  id: string;
  timestamp: string;
  kind: string;
  trigger?: number;
  status?: string;
  content?: string;
  in_reply_to?: string;
}

/** Chat messages (excludes scheduled tasks) in a window, plus queue/inflight gauges. */
export interface SessionStats {
  msgsIn: number;
  msgsOut: number;
  queueDepth: number;
  inflight: number;
  /** reply latencies (ms) for messages answered in the window */
  latencies: number[];
  /** distinct sender ids seen today, keyed by channel */
  sendersToday: Map<string, Set<string>>;
  /** trigger messages older than thresholdMs with no reply (last 24h) */
  unanswered: number;
  heartbeatAgeMs: number | null;
  currentTool: string | null;
  scheduledTasks: { id: string; status: string; content: string }[];
}

export type WorkItemKind = 'message' | 'response' | 'task';
export type WorkItemState = 'queued' | 'processing' | 'failed' | 'awaiting_delivery' | 'due' | 'scheduled' | 'paused';

export interface SessionWorkItem {
  kind: WorkItemKind;
  state: WorkItemState;
  id: string;
  sessionId: string;
  createdAt: string;
  dueAt: string | null;
  channel: string | null;
  sender: string | null;
  summary: string;
  currentTool: string | null;
  ageMs: number;
  /** Retry count (scheduled tasks only): >0 means the task was reset and
   * re-run, e.g. the container was killed mid-work. Undefined for messages. */
  tries?: number;
  /** Cron expression for recurring tasks (scheduled tasks only); null for
   * one-shot tasks and undefined for non-task items. */
  recurrence?: string | null;
  /** Series identity for scheduled tasks — shared across every occurrence of a
   * recurring task, so a pending chip can be matched to its past firings. */
  seriesId?: string;
}

/** A scheduled task that already fired: a `completed` task row whose scheduled
 *  time (`process_after`) falls in the query window. `seriesId` ties it back to
 *  the still-pending occurrence shown in the Scheduled-actions strip. */
export interface ScheduledFiring {
  seriesId: string;
  firedAtMs: number;
  summary: string;
  sessionId: string;
}

/**
 * Scheduled-task firings in a window: `completed` task rows whose scheduled fire
 * time (`process_after`) lands in `[sinceMs, nowMs]`. Excludes future-dated
 * completed rows (e.g. cancelled one-shots parked in the future). Cheap — there
 * are only a handful of completed task rows per session.
 */
export function readRecentFirings(dir: string, sinceMs: number, nowMs: number): ScheduledFiring[] {
  const inDb = openRo(path.join(dir, 'inbound.db'));
  if (!inDb) return [];
  const sessionId = path.basename(dir);
  try {
    const rows = inDb
      .prepare(
        `SELECT series_id, id, process_after, content FROM messages_in
         WHERE kind = 'task' AND status = 'completed' AND process_after IS NOT NULL`,
      )
      .all() as { series_id: string | null; id: string; process_after: string; content: string }[];
    const out: ScheduledFiring[] = [];
    for (const r of rows) {
      const ms = toUtcMs(r.process_after);
      if (Number.isNaN(ms) || ms < sinceMs || ms > nowMs) continue;
      out.push({ seriesId: r.series_id ?? r.id, firedAtMs: ms, summary: messageSummary(r.content), sessionId });
    }
    return out;
  } catch {
    return [];
  } finally {
    inDb.close();
  }
}

/**
 * Timestamp normalizer. inbound.db uses ISO ('2026-06-11T07:23:08.000Z');
 * outbound.db uses SQLite datetime ('2026-06-11 07:24:59', UTC, no zone).
 * Naive Date.parse would read the latter as LOCAL time — always go through this.
 */
export function toUtcMs(ts: string): number {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts);
  return Date.parse(hasZone ? ts : ts.replace(' ', 'T') + 'Z');
}

export function toIsoUtc(ts: string): string {
  return new Date(toUtcMs(ts)).toISOString();
}

export function senderOf(contentJson: string): { id: string; name: string; channel?: string } | null {
  try {
    const c = JSON.parse(contentJson);
    const id = c.senderId ?? c.author?.userId ?? c.sender ?? null;
    if (id == null) return null;
    return { id: String(id), name: String(c.senderName ?? c.sender ?? id) };
  } catch {
    return null;
  }
}

/**
 * A short, single-line preview of a message's text for the journey table.
 * Message content is JSON; the human/agent text lives in `.text` (agent-to-agent
 * and channel inbounds alike). Falls back to noting attachment-only messages,
 * then to the raw string. Whitespace is collapsed and the result truncated.
 */
export function previewOf(contentJson: string, max = 140): string {
  let text = '';
  try {
    const c = JSON.parse(contentJson);
    if (typeof c.text === 'string') text = c.text;
    if (!text.trim()) {
      const files = Array.isArray(c.attachments) ? c.attachments : Array.isArray(c.files) ? c.files : [];
      if (files.length > 0) text = `[${files.length} attachment${files.length === 1 ? '' : 's'}]`;
    }
  } catch {
    text = contentJson;
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function readSessionStats(
  dir: string,
  sinceIso: string,
  opts: { unansweredAfterMs: number; nowMs: number },
): SessionStats {
  const stats: SessionStats = {
    msgsIn: 0,
    msgsOut: 0,
    queueDepth: 0,
    inflight: 0,
    latencies: [],
    sendersToday: new Map(),
    unanswered: 0,
    heartbeatAgeMs: null,
    currentTool: null,
    scheduledTasks: [],
  };
  const todayIso = new Date(opts.nowMs).toISOString().slice(0, 10);
  const dayAgoIso = new Date(opts.nowMs - 86_400_000).toISOString();

  const inDb = openRo(path.join(dir, 'inbound.db'));
  const inRows: MsgRow[] = [];
  if (inDb) {
    try {
      stats.msgsIn = (
        inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE kind != 'task' AND timestamp >= ?").get(sinceIso) as {
          n: number;
        }
      ).n;
      // Exclude kind='system' (question_response payloads): the container's
      // poll loop never processes them, so they aren't real queue depth.
      // Counting them here shows a phantom "queue N" that never drains — the
      // same rows the host wake-count (countDueMessages) now also excludes.
      stats.queueDepth = (
        inDb
          .prepare(
            "SELECT COUNT(*) AS n FROM messages_in WHERE kind != 'task' AND kind != 'system' AND status = 'pending'",
          )
          .get() as {
          n: number;
        }
      ).n;
      for (const r of inDb
        .prepare(
          "SELECT id, timestamp, channel_type AS kind, content, trigger FROM messages_in WHERE kind != 'task' AND timestamp >= ?",
        )
        .all(dayAgoIso) as (MsgRow & { content: string })[]) {
        inRows.push(r);
        if (r.timestamp.slice(0, 10) === todayIso && r.content) {
          const s = senderOf(r.content);
          if (s) {
            const channel = r.kind ?? 'unknown';
            if (!stats.sendersToday.has(channel)) stats.sendersToday.set(channel, new Set());
            stats.sendersToday.get(channel)!.add(s.id);
          }
        }
      }
      try {
        stats.scheduledTasks = inDb
          .prepare(
            "SELECT id, status, substr(content, 1, 300) AS content FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')",
          )
          .all() as { id: string; status: string; content: string }[];
      } catch {
        /* older schema */
      }
    } finally {
      inDb.close();
    }
  }

  const outDb = openRo(path.join(dir, 'outbound.db'));
  const replies = new Map<string, string>(); // in_reply_to -> out timestamp
  let latestOutMs = 0; // most recent outbound of ANY kind (incl. unlinked)
  if (outDb) {
    try {
      stats.msgsOut = (
        outDb
          .prepare("SELECT COUNT(*) AS n FROM messages_out WHERE replace(timestamp, ' ', 'T') >= ?")
          .get(sinceIso) as { n: number }
      ).n;
      for (const r of outDb
        .prepare(
          "SELECT in_reply_to, timestamp FROM messages_out WHERE replace(timestamp, ' ', 'T') >= ? AND in_reply_to IS NOT NULL",
        )
        .all(dayAgoIso) as { in_reply_to: string; timestamp: string }[]) {
        replies.set(r.in_reply_to, r.timestamp);
      }
      const maxOut = outDb.prepare("SELECT MAX(replace(timestamp, ' ', 'T')) AS t FROM messages_out").get() as {
        t: string | null;
      };
      if (maxOut.t) latestOutMs = toUtcMs(maxOut.t);
      try {
        stats.inflight = (
          outDb.prepare("SELECT COUNT(*) AS n FROM processing_ack WHERE status = 'processing'").get() as { n: number }
        ).n;
      } catch {
        /* table may not exist */
      }
      try {
        const cs = outDb.prepare('SELECT current_tool FROM container_state WHERE id = 1').get() as
          | { current_tool: string | null }
          | undefined;
        stats.currentTool = cs?.current_tool ?? null;
      } catch {
        /* table may not exist */
      }
    } finally {
      outDb.close();
    }
  }

  // Latency join + unanswered detection (in-memory; windows are small).
  // Unanswered is a *current* alarm, not a historical audit: only look at the
  // last 2h, and treat ANY outbound activity after the inbound as an answer —
  // in_reply_to linkage is only ~76% on real traffic (agents reply via MCP
  // send_message without linkage), so linkage alone over-counts badly.
  const twoHoursAgoMs = opts.nowMs - 2 * 3_600_000;
  for (const m of inRows) {
    if (!m.trigger) continue;
    const replyTs = replies.get(m.id);
    const inMs = toUtcMs(m.timestamp);
    if (replyTs) {
      if (m.timestamp >= sinceIso) stats.latencies.push(Math.max(0, toUtcMs(replyTs) - inMs));
    } else if (
      inMs >= twoHoursAgoMs &&
      opts.nowMs - inMs > opts.unansweredAfterMs &&
      latestOutMs <= inMs // nothing at all went out after this message
    ) {
      stats.unanswered++;
    }
  }

  const hb = path.join(dir, '.heartbeat');
  if (fs.existsSync(hb)) stats.heartbeatAgeMs = opts.nowMs - fs.statSync(hb).mtimeMs;

  return stats;
}

/**
 * Reconstruct recent trigger-message progress across the two session DBs.
 * Exact in_reply_to linkage wins; otherwise the first outbound before the next
 * inbound is shown as inferred activity because not every MCP send is linked.
 */
export function readMessageJourneys(
  dir: string,
  opts: { limit?: number; nowMs?: number; agentNames?: Map<string, string> } = {},
): MessageJourney[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const nowMs = opts.nowMs ?? Date.now();
  const sessionId = path.basename(dir);
  const inDb = openRo(path.join(dir, 'inbound.db'));
  if (!inDb) return [];
  let inbound: (MsgRow & { channel_type: string; platform_id: string | null; content: string })[] = [];
  const delivered = new Map<string, string>();
  try {
    inbound = inDb
      .prepare(
        `SELECT id, timestamp, status, trigger, channel_type, platform_id, content
         FROM messages_in WHERE kind != 'task' AND trigger = 1
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(limit) as (MsgRow & { channel_type: string; platform_id: string | null; content: string })[];
    try {
      for (const row of inDb.prepare('SELECT message_out_id, delivered_at FROM delivered').all() as {
        message_out_id: string;
        delivered_at: string;
      }[]) {
        delivered.set(row.message_out_id, row.delivered_at);
      }
    } catch {
      /* older schema */
    }
  } finally {
    inDb.close();
  }
  inbound.reverse();

  const ack = new Map<string, { status: string; changed: string }>();
  const outbound: { id: string; in_reply_to: string | null; timestamp: string }[] = [];
  const outDb = openRo(path.join(dir, 'outbound.db'));
  if (outDb) {
    try {
      try {
        for (const row of outDb.prepare('SELECT message_id, status, status_changed FROM processing_ack').all() as {
          message_id: string;
          status: string;
          status_changed: string;
        }[]) {
          ack.set(row.message_id, { status: row.status, changed: row.status_changed });
        }
      } catch {
        /* missing table */
      }
      try {
        outbound.push(
          ...(outDb
            .prepare('SELECT id, in_reply_to, timestamp FROM messages_out ORDER BY timestamp')
            .all() as typeof outbound),
        );
      } catch {
        /* missing table */
      }
    } finally {
      outDb.close();
    }
  }

  return inbound
    .map((msg, index): MessageJourney => {
      const inMs = toUtcMs(msg.timestamp);
      const nextInMs = index + 1 < inbound.length ? toUtcMs(inbound[index + 1].timestamp) : Number.POSITIVE_INFINITY;
      const exact = outbound.find((o) => o.in_reply_to === msg.id);
      const inferred = exact
        ? undefined
        : outbound.find((o) => {
            const outMs = toUtcMs(o.timestamp);
            return outMs >= inMs && outMs < nextInMs && outMs - inMs <= 2 * 3_600_000;
          });
      const response = exact ?? inferred;
      const a = ack.get(msg.id);
      const deliveredAt = response ? (delivered.get(response.id) ?? null) : null;
      let stage: JourneyStage = 'received';
      if (a?.status === 'failed') stage = 'failed';
      else if (deliveredAt) stage = 'delivered';
      else if (response) stage = 'response_written';
      else if (a?.status === 'processing') stage = 'processing';
      else if (a?.status === 'completed') stage = 'completed_no_response';
      else if (msg.status === 'pending') stage = 'queued';
      // Agent-to-agent hops carry no sender fields in `content` — the sending
      // agent's identity is the inbound row's `platform_id` (source agent group
      // id). Resolve it to a name when the caller supplies the group-name map,
      // otherwise fall back to the raw group id (still far better than "unknown").
      const isAgent = msg.channel_type === 'agent';
      const sourceAgentGroupId = isAgent ? (msg.platform_id ?? null) : null;
      const sender = senderOf(msg.content);
      const senderName = isAgent
        ? (sourceAgentGroupId ? (opts.agentNames?.get(sourceAgentGroupId) ?? sourceAgentGroupId) : 'unknown agent')
        : (sender?.name ?? 'unknown');
      return {
        messageId: msg.id,
        sessionId,
        receivedAt: msg.timestamp,
        sender: senderName,
        channel: msg.channel_type ?? 'unknown',
        sourceAgentGroupId,
        preview: previewOf(msg.content),
        inboundStatus: msg.status ?? 'unknown',
        ackStatus: a?.status ?? null,
        responseId: response?.id ?? null,
        responseAt: response?.timestamp ? toIsoUtc(response.timestamp) : null,
        deliveredAt: deliveredAt ? toIsoUtc(deliveredAt) : null,
        linkage: exact ? 'exact' : inferred ? 'inferred' : 'none',
        stage,
        ageMs: Math.max(0, nowMs - inMs),
      };
    })
    .reverse();
}

/** Current actionable work for one session, across both session DBs. */
export function readSessionWork(dir: string, opts: { nowMs?: number; limit?: number } = {}): SessionWorkItem[] {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 300));
  const sessionId = path.basename(dir);
  const items: SessionWorkItem[] = [];
  const ack = new Map<string, { status: string; changed: string }>();
  let currentTool: string | null = null;

  const outDb = openRo(path.join(dir, 'outbound.db'));
  if (outDb) {
    try {
      try {
        for (const row of outDb.prepare('SELECT message_id, status, status_changed FROM processing_ack').all() as {
          message_id: string;
          status: string;
          status_changed: string;
        }[]) {
          ack.set(row.message_id, { status: row.status, changed: row.status_changed });
        }
      } catch {
        /* missing table */
      }
      try {
        const row = outDb.prepare('SELECT current_tool FROM container_state WHERE id = 1').get() as
          | { current_tool: string | null }
          | undefined;
        currentTool = row?.current_tool ?? null;
      } catch {
        /* missing table */
      }
    } finally {
      outDb.close();
    }
  }

  const inDb = openRo(path.join(dir, 'inbound.db'));
  if (!inDb) return items;
  try {
    const messages = inDb
      .prepare(
        `SELECT id, timestamp, status, channel_type, content
         FROM messages_in
         WHERE kind != 'task' AND trigger = 1
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(limit) as { id: string; timestamp: string; status: string; channel_type: string | null; content: string }[];
    for (const msg of messages) {
      const a = ack.get(msg.id);
      if (msg.status !== 'pending' && a?.status !== 'processing' && a?.status !== 'failed') continue;
      const sender = senderOf(msg.content);
      const state: WorkItemState =
        a?.status === 'failed' ? 'failed' : a?.status === 'processing' ? 'processing' : 'queued';
      items.push({
        kind: 'message',
        state,
        id: msg.id,
        sessionId,
        createdAt: msg.timestamp,
        dueAt: null,
        channel: msg.channel_type,
        sender: sender?.name ?? null,
        summary: messageSummary(msg.content),
        currentTool: state === 'processing' ? currentTool : null,
        ageMs: Math.max(0, nowMs - toUtcMs(msg.timestamp)),
      });
    }

    try {
      const tasks = inDb
        .prepare(
          `SELECT id, series_id, timestamp, status, process_after, recurrence, tries, content
           FROM messages_in
           WHERE kind = 'task' AND status IN ('pending', 'paused')
           ORDER BY COALESCE(process_after, timestamp) LIMIT ?`,
        )
        .all(limit) as {
        id: string;
        series_id: string | null;
        timestamp: string;
        status: string;
        process_after: string | null;
        recurrence: string | null;
        tries: number | null;
        content: string;
      }[];
      for (const task of tasks) {
        const dueAt = task.process_after ? toIsoUtc(task.process_after) : task.timestamp;
        const dueMs = toUtcMs(dueAt);
        const state: WorkItemState = task.status === 'paused' ? 'paused' : dueMs <= nowMs ? 'due' : 'scheduled';
        items.push({
          kind: 'task',
          state,
          id: task.id,
          sessionId,
          createdAt: task.timestamp,
          dueAt,
          channel: null,
          sender: null,
          summary: messageSummary(task.content) + (task.recurrence ? ` · ${task.recurrence}` : ''),
          currentTool: null,
          ageMs: state === 'scheduled' ? Math.max(0, dueMs - nowMs) : Math.max(0, nowMs - dueMs),
          tries: task.tries ?? 0,
          recurrence: task.recurrence,
          seriesId: task.series_id ?? task.id,
        });
      }
    } catch {
      /* older schema */
    }
  } finally {
    inDb.close();
  }

  const responseDb = openRo(path.join(dir, 'outbound.db'));
  const deliveredDb = openRo(path.join(dir, 'inbound.db'));
  if (responseDb && deliveredDb) {
    try {
      const delivery = new Map<string, string>();
      try {
        for (const row of deliveredDb.prepare('SELECT message_out_id, status FROM delivered').all() as {
          message_out_id: string;
          status: string;
        }[]) {
          delivery.set(row.message_out_id, row.status);
        }
      } catch {
        /* older schema */
      }
      try {
        for (const row of responseDb
          .prepare('SELECT id, timestamp, channel_type, content FROM messages_out ORDER BY timestamp DESC LIMIT ?')
          .all(limit) as { id: string; timestamp: string; channel_type: string | null; content: string }[]) {
          const deliveryStatus = delivery.get(row.id);
          if (deliveryStatus && deliveryStatus !== 'failed') continue;
          items.push({
            kind: 'response',
            state: deliveryStatus === 'failed' ? 'failed' : 'awaiting_delivery',
            id: row.id,
            sessionId,
            createdAt: toIsoUtc(row.timestamp),
            dueAt: null,
            channel: row.channel_type,
            sender: null,
            summary: messageSummary(row.content),
            currentTool: null,
            ageMs: Math.max(0, nowMs - toUtcMs(row.timestamp)),
          });
        }
      } catch {
        /* missing table */
      }
    } finally {
      responseDb.close();
      deliveredDb.close();
    }
  } else {
    responseDb?.close();
    deliveredDb?.close();
  }

  return items.sort((a, b) => {
    const priority = (item: SessionWorkItem) =>
      item.state === 'failed'
        ? 0
        : item.state === 'processing'
          ? 1
          : item.state === 'queued' || item.state === 'awaiting_delivery' || item.state === 'due'
            ? 2
            : 3;
    return priority(a) - priority(b) || b.ageMs - a.ageMs;
  });
}

function messageSummary(content: string): string {
  try {
    const parsed = JSON.parse(content);
    const text = parsed.text ?? parsed.prompt ?? parsed.content ?? parsed.message ?? parsed.body;
    if (typeof text === 'string') return text.replace(/\s+/g, ' ').trim().slice(0, 180);
  } catch {
    /* plain text */
  }
  return content.replace(/\s+/g, ' ').trim().slice(0, 180);
}

/** Most recent outbound delivery timestamp across all sessions (status strip). */
export function lastDeliveryTs(dirs: SessionDirs[]): string | null {
  let latest: string | null = null;
  for (const d of dirs) {
    const db = openRo(path.join(d.dir, 'outbound.db'));
    if (!db) continue;
    try {
      const row = db.prepare("SELECT MAX(replace(timestamp, ' ', 'T')) AS t FROM messages_out").get() as {
        t: string | null;
      };
      if (row.t) {
        const iso = toIsoUtc(row.t);
        if (!latest || iso > latest) latest = iso;
      }
    } finally {
      db.close();
    }
  }
  return latest;
}
