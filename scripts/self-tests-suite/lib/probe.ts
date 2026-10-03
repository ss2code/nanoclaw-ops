/**
 * Probe transport for the self-tests suite: send one message into a group's
 * web-chat session (the same routed cli.sock path Ops Center chat uses) and
 * capture the delivered text reply.
 *
 * Capturing the reply text matters because some routing failures never reach a
 * model at all — e.g. a mis-parsed `/model` command replies locally with
 * "Unknown model tier …" and schedules no turn. The ground-truth model read
 * (truth.ts) would just time out; the reply text says *why*.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { sendViaCliSock, getWebChatState, ensureWebChat } from '../../../ops-center/chat.js';

export interface WebSession {
  sessionDir: string;
}

export interface ChatReply {
  text: string;
  timestampMs: number;
}

/** Ensure the group's web chat is wired and a session dir exists. */
export async function resolveWebSession(
  agentGroupId: string,
  groupName: string,
  opts: { warmupMs: number; pollMs: number },
): Promise<WebSession> {
  let state = getWebChatState(agentGroupId);
  if (!state.wired || !state.hasDestination) {
    const r = await ensureWebChat(agentGroupId, groupName);
    if (!r.ok) throw new Error(`could not wire web chat: ${r.message}`);
    state = getWebChatState(agentGroupId);
  }
  if (state.sessionDir) return { sessionDir: state.sessionDir };

  // No session yet — a warmup message creates one. Wait for its reply too so
  // the first real probe cannot be coalesced into the active warmup turn.
  await sendViaCliSock(agentGroupId, 'self-test: warmup, reply with ok');
  const deadline = Date.now() + opts.warmupMs;
  while (Date.now() < deadline) {
    await sleep(opts.pollMs);
    state = getWebChatState(agentGroupId);
    if (state.sessionDir) {
      await waitForChatReply(state.sessionDir, 0, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        pollMs: opts.pollMs,
      });
      return { sessionDir: state.sessionDir };
    }
  }
  throw new Error('web session did not materialize after warmup');
}

/** Max outbound seq — the "before" cursor for capturing a reply. */
export function outboundCursor(sessionDir: string): number {
  const db = openRo(path.join(sessionDir, 'outbound.db'));
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT MAX(seq) AS s FROM messages_out').get() as { s: number | null };
    return row?.s ?? 0;
  } finally {
    db.close();
  }
}

/** Newest delivered chat reply text past `cursor`, or null. */
export function replyAfter(sessionDir: string, cursor: number): string | null {
  return replyRecordAfter(sessionDir, cursor)?.text ?? null;
}

/** Newest delivered chat reply plus its provider-completion correlation timestamp. */
export function replyRecordAfter(sessionDir: string, cursor: number): ChatReply | null {
  const db = openRo(path.join(sessionDir, 'outbound.db'));
  if (!db) return null;
  try {
    const rows = db
      .prepare("SELECT content, timestamp FROM messages_out WHERE seq > ? AND kind='chat' ORDER BY seq DESC LIMIT 1")
      .all(cursor) as { content: string }[];
    if (!rows.length) return null;
    const timestampMs = Date.parse((rows[0] as { timestamp?: string }).timestamp ?? '');
    if (!Number.isFinite(timestampMs)) return null;
    try {
      const c = JSON.parse(rows[0].content) as { text?: string };
      return { text: typeof c.text === 'string' ? c.text : rows[0].content, timestampMs };
    } catch {
      return { text: rows[0].content, timestampMs };
    }
  } finally {
    db.close();
  }
}

/** Wait until a delivered chat reply appears after `cursor`. */
export async function waitForChatReply(
  sessionDir: string,
  cursor: number,
  opts: { timeoutMs: number; pollMs: number },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const reply = replyRecordAfter(sessionDir, cursor);
    if (reply !== null) return reply.text;
    await sleep(opts.pollMs);
  }
  throw new Error('web session warmup did not produce a chat reply before timeout');
}

/** Wait until a delivered chat reply appears and retain its timestamp. */
export async function waitForChatReplyRecord(
  sessionDir: string,
  cursor: number,
  opts: { timeoutMs: number; pollMs: number },
): Promise<ChatReply> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const reply = replyRecordAfter(sessionDir, cursor);
    if (reply !== null) return reply;
    await sleep(opts.pollMs);
  }
  throw new Error('web session did not produce a chat reply before timeout');
}

export { sendViaCliSock };

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
