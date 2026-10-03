import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-test-long-running-notice',
}));

vi.mock('../../config.js', () => ({
  DATA_DIR: TEST_DIR,
  LONG_RUNNING_NOTICE_AFTER_MS: 50,
  LONG_RUNNING_NOTICE_TEXT: 'Still working on this test.',
}));

import { ensureSchema } from '../../db/session-db.js';
import { cancelLongRunningNoticesForSession, setLongRunningNoticeAdapter, startLongRunningNotice } from './index.js';

function initOutbound(agentGroupId: string, sessionId: string): string {
  const dir = path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'outbound.db');
  ensureSchema(dbPath, 'outbound');
  return dbPath;
}

beforeEach(() => {
  vi.useFakeTimers();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  cancelLongRunningNoticesForSession('sess-1');
  vi.useRealTimers();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('long-running notice', () => {
  it('delivers one notice after the threshold while the inbound is still processing', async () => {
    const dbPath = initOutbound('ag-1', 'sess-1');
    const db = new Database(dbPath);
    db.prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('msg-1', 'processing', datetime('now'))",
    ).run();
    db.close();

    const calls: string[] = [];
    setLongRunningNoticeAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'platform-notice-1';
      },
    });

    startLongRunningNotice({
      sessionId: 'sess-1',
      agentGroupId: 'ag-1',
      messageId: 'msg-1',
      channelType: 'whatsapp',
      platformId: 'chat-1',
      threadId: null,
      kind: 'chat',
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([JSON.stringify({ text: 'Still working on this test.' })]);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
  });

  it('cancels the notice when the session produces a user-facing reply first', async () => {
    initOutbound('ag-1', 'sess-1');
    const calls: string[] = [];
    setLongRunningNoticeAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'platform-notice-1';
      },
    });

    startLongRunningNotice({
      sessionId: 'sess-1',
      agentGroupId: 'ag-1',
      messageId: 'msg-1',
      channelType: 'whatsapp',
      platformId: 'chat-1',
      threadId: null,
      kind: 'chat',
    });
    cancelLongRunningNoticesForSession('sess-1');

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(0);
  });
});
