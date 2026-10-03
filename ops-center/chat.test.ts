/**
 * Web chat backend — readChatSlice against fabricated session DBs (both
 * timestamp formats, rowid cursors, ack-driven status), platform id shape.
 * ensureWebChat/sendViaCliSock touch the live central DB and cli.sock, so
 * they are exercised in the end-to-end pass, not here.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCliSockRoutePayload, readChatSlice, webChatPlatformId, WEB_CHAT_CHANNEL } from './chat.js';

let dir: string;

function seedDbs(): void {
  const inDb = new Database(path.join(dir, 'inbound.db'));
  inDb.exec(`CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
    status TEXT DEFAULT 'pending', platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL)`);
  inDb.close();
  const outDb = new Database(path.join(dir, 'outbound.db'));
  outDb.exec(`CREATE TABLE messages_out (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT, timestamp TEXT NOT NULL,
    kind TEXT NOT NULL, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL);
    CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT, status_changed TEXT)`);
  outDb.close();
}

function addIn(id: string, ts: string, content: unknown, status = 'pending', kind = 'chat'): void {
  const db = new Database(path.join(dir, 'inbound.db'));
  db.prepare('INSERT INTO messages_in (id, kind, timestamp, status, content) VALUES (?, ?, ?, ?, ?)').run(
    id,
    kind,
    ts,
    status,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  db.close();
}

function addOut(id: string, ts: string, content: unknown, kind = 'chat'): void {
  const db = new Database(path.join(dir, 'outbound.db'));
  db.prepare('INSERT INTO messages_out (id, kind, timestamp, content) VALUES (?, ?, ?, ?)').run(
    id,
    kind,
    ts,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  db.close();
}

function ack(messageId: string, status: string): void {
  const db = new Database(path.join(dir, 'outbound.db'));
  db.prepare("INSERT OR REPLACE INTO processing_ack VALUES (?, ?, datetime('now'))").run(messageId, status);
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'));
  seedDbs();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('webChatPlatformId', () => {
  it('derives a stable per-group platform id on the cli channel', () => {
    expect(webChatPlatformId('ag-x')).toBe('web:ag-x');
    expect(WEB_CHAT_CHANNEL).toBe('cli');
  });

  it('marks routed WebQI commands as addressed for mention-engaged source chats', () => {
    const address = { channelType: 'whatsapp', platformId: 'phone:1', threadId: null };
    expect(buildCliSockRoutePayload('/consult quick test', address, { channelType: 'cli', platformId: 'web:ag-x', threadId: null }, null)).toMatchObject({
      to: address,
      isMention: true,
      senderId: 'cli:local',
    });
  });
});

describe('readChatSlice', () => {
  it('returns user message and queued status when unacked and pending', () => {
    addIn('m1', '2026-07-13T10:00:00.000Z', { text: 'hello', sender: 'Alice (web)' });
    const slice = readChatSlice(dir, 0, 0);
    expect(slice.messages).toHaveLength(1);
    expect(slice.messages[0]).toMatchObject({ role: 'user', text: 'hello', sender: 'Alice (web)' });
    expect(slice.status).toBe('queued');
    expect(slice.inMax).toBe(1);
  });

  it('reports working while the container holds a processing ack', () => {
    addIn('m1', '2026-07-13T10:00:00.000Z', { text: 'hello' });
    ack('m1', 'processing');
    expect(readChatSlice(dir, 0, 0).status).toBe('working');
  });

  it('settles to idle on completed ack and merges the reply in time order', () => {
    addIn('m1', '2026-07-13T10:00:00.000Z', { text: 'hello' });
    // Outbound stamps are zone-less UTC ('YYYY-MM-DD HH:MM:SS') — the merge
    // must still order them after the ISO-stamped inbound row.
    addOut('r1', '2026-07-13 10:00:30', { text: 'hi there' });
    ack('m1', 'completed');
    const slice = readChatSlice(dir, 0, 0);
    expect(slice.status).toBe('idle');
    expect(slice.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(slice.messages[1].text).toBe('hi there');
  });

  it('honours rowid cursors — a second poll returns only new rows', () => {
    addIn('m1', '2026-07-13T10:00:00.000Z', { text: 'hello' });
    addOut('r1', '2026-07-13 10:00:30', { text: 'hi' });
    const first = readChatSlice(dir, 0, 0);
    expect(first.messages).toHaveLength(2);
    const second = readChatSlice(dir, first.inMax, first.outMax);
    expect(second.messages).toHaveLength(0);
    addOut('r2', '2026-07-13 10:01:00', { text: 'anything else?' });
    const third = readChatSlice(dir, first.inMax, first.outMax);
    expect(third.messages).toHaveLength(1);
    expect(third.messages[0].role).toBe('agent');
  });

  it('filters non-chat kinds and tolerates non-JSON content', () => {
    addIn('t1', '2026-07-13T10:00:00.000Z', { text: 'cron tick' }, 'pending', 'task');
    addIn('m1', '2026-07-13T10:00:01.000Z', 'plain string content');
    ack('m1', 'completed');
    const slice = readChatSlice(dir, 0, 0);
    expect(slice.messages).toHaveLength(1);
    expect(slice.messages[0].text).toBe('plain string content');
  });

  it('returns empty idle slice for a missing session dir', () => {
    const slice = readChatSlice(path.join(dir, 'nope'), 0, 0);
    expect(slice.messages).toHaveLength(0);
    expect(slice.status).toBe('idle');
  });
});
