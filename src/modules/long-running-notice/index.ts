/**
 * Long-running response notices - default host module.
 *
 * The host owns this instead of the agent because the agent may be busy in
 * tools or still starting. If a user-facing inbound stays in flight past the
 * configured threshold, send one lightweight "still working" message directly
 * through the channel adapter.
 */
import Database from 'better-sqlite3';

import { LONG_RUNNING_NOTICE_AFTER_MS, LONG_RUNNING_NOTICE_TEXT } from '../../config.js';
import { log } from '../../log.js';
import { outboundDbPath } from '../../session-manager.js';

interface NoticeAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
  ): Promise<string | undefined>;
}

interface NoticeEntry {
  sessionId: string;
  agentGroupId: string;
  messageId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  timer: NodeJS.Timeout;
}

let adapter: NoticeAdapter | null = null;
const noticesByMessage = new Map<string, NoticeEntry>();
const messagesBySession = new Map<string, Set<string>>();

export function setLongRunningNoticeAdapter(a: NoticeAdapter): void {
  adapter = a;
}

function remember(entry: NoticeEntry): void {
  noticesByMessage.set(entry.messageId, entry);
  let sessionMessages = messagesBySession.get(entry.sessionId);
  if (!sessionMessages) {
    sessionMessages = new Set();
    messagesBySession.set(entry.sessionId, sessionMessages);
  }
  sessionMessages.add(entry.messageId);
}

function forget(messageId: string): NoticeEntry | undefined {
  const entry = noticesByMessage.get(messageId);
  if (!entry) return undefined;

  clearTimeout(entry.timer);
  noticesByMessage.delete(messageId);
  const sessionMessages = messagesBySession.get(entry.sessionId);
  if (sessionMessages) {
    sessionMessages.delete(messageId);
    if (sessionMessages.size === 0) messagesBySession.delete(entry.sessionId);
  }
  return entry;
}

function getProcessingStatus(agentGroupId: string, sessionId: string, messageId: string): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(outboundDbPath(agentGroupId, sessionId), { readonly: true });
    const row = db.prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(messageId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function fireNotice(messageId: string): Promise<void> {
  const entry = forget(messageId);
  if (!entry) return;

  const status = getProcessingStatus(entry.agentGroupId, entry.sessionId, entry.messageId);
  if (status === 'completed' || status === 'failed') {
    log.debug('Long-running notice skipped; inbound already finished', {
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      status,
    });
    return;
  }

  if (!adapter) {
    log.warn('Long-running notice skipped; no delivery adapter configured', {
      sessionId: entry.sessionId,
      messageId: entry.messageId,
    });
    return;
  }

  try {
    await adapter.deliver(
      entry.channelType,
      entry.platformId,
      entry.threadId,
      'chat',
      JSON.stringify({ text: LONG_RUNNING_NOTICE_TEXT }),
    );
    log.info('Long-running notice delivered', { sessionId: entry.sessionId, messageId: entry.messageId });
  } catch (err) {
    log.warn('Long-running notice delivery failed', { sessionId: entry.sessionId, messageId: entry.messageId, err });
  }
}

export function startLongRunningNotice(args: {
  sessionId: string;
  agentGroupId: string;
  messageId: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  kind: string;
}): void {
  if (LONG_RUNNING_NOTICE_AFTER_MS <= 0) return;
  if (args.kind === 'system' || args.channelType === 'agent') return;
  if (!args.channelType || !args.platformId) return;

  forget(args.messageId);
  const timer = setTimeout(() => {
    void fireNotice(args.messageId);
  }, LONG_RUNNING_NOTICE_AFTER_MS);
  timer.unref();

  remember({
    sessionId: args.sessionId,
    agentGroupId: args.agentGroupId,
    messageId: args.messageId,
    channelType: args.channelType,
    platformId: args.platformId,
    threadId: args.threadId,
    timer,
  });
}

export function cancelLongRunningNotice(messageId: string): void {
  forget(messageId);
}

export function cancelLongRunningNoticesForSession(sessionId: string): void {
  const messageIds = messagesBySession.get(sessionId);
  if (!messageIds) return;
  for (const messageId of [...messageIds]) {
    forget(messageId);
  }
}
