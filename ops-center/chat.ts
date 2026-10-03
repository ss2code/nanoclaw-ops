/**
 * Web chat — conversational input to agent groups from the Ops Center.
 *
 * Send path: the host's CLI channel socket (data/cli.sock) routed opcode.
 * The host does routing, session resolution, and the inbound.db write, so
 * the single-writer invariant holds — Ops Center never writes a session DB.
 * Each agent group gets a dedicated messaging group (channel_type 'cli',
 * platform_id 'web:<agent-group-id>') wired always-on via pattern '.'; its
 * session is parallel to (not shared with) any WhatsApp/Telegram session.
 *
 * Read path: read-only per-session DBs, the same pattern as every reader.
 * The agent's reply is addressed to the host-owned web messaging group; the
 * delivery layer acknowledges that logical destination and the persisted
 * messages_out row is what the Ops Center renders.
 *
 * Entity creation goes through the ncl CLI (host caller — no approval gate),
 * same as the other Ops Center verified actions.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { PATHS, ROOT } from './config.js';
import { ncl, type ActionResult } from './lifecycle.js';
import { withCentral } from './readers/central.js';
import { toUtcMs } from './readers/sessiondbs.js';

export const WEB_CHAT_CHANNEL = 'cli';

export interface CliSockAddress {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export interface CliSockRoutePayload {
  text: string;
  to: CliSockAddress;
  reply_to: CliSockAddress;
  sender: string;
  senderName: string;
  senderId: string;
  isMention: true;
}

export function webChatPlatformId(agentGroupId: string): string {
  return `web:${agentGroupId}`;
}

export interface WebChatState {
  mgId: string | null;
  wired: boolean;
  /** agent_destinations row naming this mg — without it the agent sees the
   *  origin as `from="unknown:cli:web:…"` and replies to some other channel. */
  hasDestination: boolean;
  sessionId: string | null;
  sessionDir: string | null;
}

export interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
  sender: string;
  ts: string;
  tsMs: number;
}

export interface ChatSlice {
  messages: ChatMessage[];
  inMax: number;
  outMax: number;
  /** 'idle' | 'queued' | 'working' — derived from the newest inbound chat row. */
  status: 'idle' | 'queued' | 'working';
}

/** Current wiring + session state for a group's web chat. All read-only. */
export function getWebChatState(agentGroupId: string): WebChatState {
  return withCentral((db) => {
    const mg = db
      .prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
      .get(WEB_CHAT_CHANNEL, webChatPlatformId(agentGroupId)) as { id: string } | undefined;
    if (!mg) return { mgId: null, wired: false, hasDestination: false, sessionId: null, sessionDir: null };
    const wiring = db
      .prepare('SELECT id FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
      .get(mg.id, agentGroupId) as { id: string } | undefined;
    let hasDestination = false;
    try {
      hasDestination = Boolean(
        db
          .prepare(
            "SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?",
          )
          .get(agentGroupId, mg.id),
      );
    } catch {
      /* agent-to-agent module absent — table doesn't exist; leave false */
    }
    const session = db
      .prepare(
        'SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(agentGroupId, mg.id) as { id: string } | undefined;
    const dir = session ? path.join(PATHS.sessionsDir, agentGroupId, session.id) : null;
    return {
      mgId: mg.id,
      wired: Boolean(wiring),
      hasDestination,
      sessionId: session?.id ?? null,
      sessionDir: dir && fs.existsSync(dir) ? dir : null,
    };
  });
}

/**
 * The identity stamped on outgoing web messages. Prefer the global owner —
 * the person sitting at this machine (the cli.sock is 0600, so "can reach
 * Ops Center actions" ≈ "is the operator"). Falls back to any owner row.
 */
export function ownerIdentity(): { userId: string; name: string } | null {
  return withCentral((db) => {
    const row = db
      .prepare(
        `SELECT ur.user_id AS id, u.display_name AS name FROM user_roles ur
         LEFT JOIN users u ON u.id = ur.user_id
         WHERE ur.role = 'owner'
         ORDER BY ur.agent_group_id IS NULL DESC LIMIT 1`,
      )
      .get() as { id: string; name: string | null } | undefined;
    if (!row) return null;
    return { userId: row.id, name: row.name ?? 'Operator' };
  });
}

/** Build the routed CLI payload used by Web Chat and WebQI. */
export function buildCliSockRoutePayload(
  text: string,
  to: CliSockAddress,
  replyTo: CliSockAddress,
  owner: { userId: string; name: string } | null = ownerIdentity(),
): CliSockRoutePayload {
  const display = owner ? `${owner.name} (web)` : 'Operator (web)';
  return {
    text,
    to,
    reply_to: replyTo,
    // A routed WebQI action may target a normal WhatsApp/Telegram session
    // whose wiring is mention-engaged. It is an operator-authored command,
    // so mark it as addressed rather than silently accumulating/dropping it.
    isMention: true,
    sender: display,
    senderName: display,
    senderId: owner?.userId ?? 'cli:local',
  };
}

/**
 * Create the web messaging group + always-on wiring for a group if missing.
 * Idempotent; both writes go through ncl (host caller). engage_mode must be
 * 'pattern' with '.' so the dedicated Web Chat session is always-on. Routed
 * WebQI messages explicitly carry isMention for source sessions that use
 * mention-sticky engagement.
 */
export async function ensureWebChat(agentGroupId: string, groupName: string): Promise<ActionResult> {
  const state = getWebChatState(agentGroupId);
  if (!state.mgId) {
    const created = await ncl([
      'messaging-groups',
      'create',
      '--channel-type',
      WEB_CHAT_CHANNEL,
      '--platform-id',
      webChatPlatformId(agentGroupId),
      '--name',
      `Web Chat (${groupName})`,
      '--is-group',
      '0',
    ]);
    if (!created.ok) return created;
  }
  const after = getWebChatState(agentGroupId);
  if (!after.mgId) return { ok: false, message: 'messaging group not visible after create' };
  if (!after.wired) {
    const wired = await ncl([
      'wirings',
      'create',
      '--messaging-group-id',
      after.mgId,
      '--agent-group-id',
      agentGroupId,
      '--engage-mode',
      'pattern',
      '--engage-pattern',
      '.',
      '--session-mode',
      'shared',
    ]);
    if (!wired.ok) return wired;
  }
  // Name the web mg as a destination ('web-chat'). Without this the trigger
  // renders from="unknown:cli:web:…" — the agent can't address the origin, so
  // it replies to whatever named channel it associates with the sender (Jeeves
  // picked the owner's Telegram DM). The add handler also projects the row
  // into live sessions' inbound.db, so a running container picks it up.
  if (!after.hasDestination) {
    const dest = await ncl([
      'destinations',
      'add',
      '--agent-group-id',
      agentGroupId,
      '--local-name',
      'web-chat',
      '--target-type',
      'channel',
      '--target-id',
      after.mgId,
    ]);
    if (!dest.ok) return dest;
  }
  return { ok: true, message: 'web chat wired' };
}

/**
 * Send one message into the group's web session via the cli.sock routed
 * opcode. Fire-and-forget at the protocol level (the socket sends no ack for
 * routed one-shots); errors surface only as connection failures.
 */
export function sendViaCliSock(agentGroupId: string, text: string): Promise<ActionResult> {
  return sendViaCliSockRoute(
    text,
    { channelType: WEB_CHAT_CHANNEL, platformId: webChatPlatformId(agentGroupId), threadId: null },
    { channelType: WEB_CHAT_CHANNEL, platformId: webChatPlatformId(agentGroupId), threadId: null },
  );
}

/**
 * Send a routed one-shot while keeping the response in the Ops Center web
 * session. This is the small seam WebQI uses to continue a consultation in
 * its original WhatsApp/Telegram/session route without writing that session DB
 * from the dashboard.
 */
export function sendViaCliSockRoute(
  text: string,
  to: CliSockAddress,
  replyTo: CliSockAddress,
): Promise<ActionResult> {
  const owner = ownerIdentity();
  const payload = buildCliSockRoutePayload(text, to, replyTo, owner);
  const sock = path.join(ROOT, 'data', 'cli.sock');
  return new Promise((resolve) => {
    const done = (r: ActionResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const socket = net.connect(sock);
    const timer = setTimeout(() => done({ ok: false, message: 'cli.sock timeout (host busy?)' }), 5000);
    socket.on('connect', () => {
      socket.write(JSON.stringify(payload) + '\n', (err) => {
        if (err) return done({ ok: false, message: `cli.sock write failed: ${err.message}` });
        // Give the kernel a beat to flush before tearing down the socket.
        setTimeout(() => done({ ok: true, message: 'sent' }), 50);
      });
    });
    socket.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      const msg =
        e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
          ? 'NanoClaw host is not running (cli.sock unreachable)'
          : `cli.sock error: ${e.message}`;
      done({ ok: false, message: msg });
    });
  });
}

/**
 * Provider continuation ids recorded by the session ('continuation:claude' →
 * SDK transcript uuid, 'continuation:opencode' → ses_…). ExecutionRun.sessionId
 * carries the same id for both transcript sources, so these are the join keys
 * between a host session and its runs.
 */
export function readContinuationIds(sessionDir: string): string[] {
  const db = openRo(path.join(sessionDir, 'outbound.db'));
  if (!db) return [];
  try {
    return (db.prepare("SELECT value FROM session_state WHERE key LIKE 'continuation:%'").all() as {
      value: string;
    }[]).map((r) => r.value);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Provider names with a continuation slot in the session state. */
export function readContinuationProviders(sessionDir: string): string[] {
  const db = openRo(path.join(sessionDir, 'outbound.db'));
  if (!db) return [];
  try {
    return (db.prepare("SELECT key FROM session_state WHERE key LIKE 'continuation:%'").all() as { key: string }[])
      .map((r) => r.key.slice('continuation:'.length).toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function openRo(file: string): Database.Database | null {
  try {
    return fs.existsSync(file) ? new Database(file, { readonly: true, fileMustExist: true }) : null;
  } catch {
    return null;
  }
}

function parseText(content: string): { text: string; sender?: string } {
  try {
    const c = JSON.parse(content) as Record<string, unknown>;
    return {
      text: typeof c.text === 'string' ? c.text : '',
      sender: typeof c.sender === 'string' ? c.sender : undefined,
    };
  } catch {
    return { text: content };
  }
}

/**
 * Read chat rows past the given rowid cursors and derive the agent's
 * activity status. Rowid cursors (not timestamps) for the same reason as
 * readMessageDeltas: rows become visible across the mount boundary after
 * their stamp, and outbound timestamps are zone-less.
 */
export function readChatSlice(sessionDir: string, inCursor: number, outCursor: number): ChatSlice {
  const messages: ChatMessage[] = [];
  let inMax = inCursor;
  let outMax = outCursor;
  let status: ChatSlice['status'] = 'idle';

  const inDb = openRo(path.join(sessionDir, 'inbound.db'));
  const outDb = openRo(path.join(sessionDir, 'outbound.db'));

  let newestIn: { id: string; status: string; rowid: number } | null = null;
  if (inDb) {
    try {
      const rows = inDb
        .prepare(
          "SELECT rowid, id, status, timestamp, content FROM messages_in WHERE kind = 'chat' AND rowid > ? ORDER BY rowid",
        )
        .all(inCursor) as { rowid: number; id: string; status: string; timestamp: string; content: string }[];
      for (const r of rows) {
        const { text, sender } = parseText(r.content);
        messages.push({ role: 'user', text, sender: sender ?? 'you', ts: r.timestamp, tsMs: toUtcMs(r.timestamp) });
        inMax = Math.max(inMax, r.rowid);
      }
      newestIn = (inDb
        .prepare("SELECT rowid, id, status FROM messages_in WHERE kind = 'chat' ORDER BY rowid DESC LIMIT 1")
        .get() ?? null) as { id: string; status: string; rowid: number } | null;
    } catch {
      /* mid-schema-change or locked — render what we have */
    } finally {
      inDb.close();
    }
  }

  if (outDb) {
    try {
      const rows = outDb
        .prepare(
          "SELECT rowid, timestamp, content FROM messages_out WHERE kind = 'chat' AND rowid > ? ORDER BY rowid",
        )
        .all(outCursor) as { rowid: number; timestamp: string; content: string }[];
      for (const r of rows) {
        const { text } = parseText(r.content);
        if (text) messages.push({ role: 'agent', text, sender: 'agent', ts: r.timestamp, tsMs: toUtcMs(r.timestamp) });
        outMax = Math.max(outMax, r.rowid);
      }

      // Activity: the newest inbound chat row drives the indicator. Ack rows
      // live in outbound.db (container-owned side of the split).
      if (newestIn) {
        const ack = (outDb
          .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
          .get(newestIn.id) ?? null) as { status: string } | null;
        if (ack?.status === 'processing') status = 'working';
        else if (!ack && newestIn.status === 'pending') status = 'queued';
      }
    } catch {
      /* tolerate — status stays idle */
    } finally {
      outDb.close();
    }
  } else if (newestIn && newestIn.status === 'pending') {
    // Session exists but the container hasn't created outbound.db yet.
    status = 'queued';
  }

  messages.sort((a, b) => a.tsMs - b.tsMs || (a.role === 'user' ? -1 : 1));
  return { messages, inMax, outMax, status };
}
