import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { replyRecordAfter, waitForChatReply } from './probe.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('web-session warmup barrier', () => {
  it('waits until a chat reply exists past the outbound cursor', async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-probe-'));
    dirs.push(sessionDir);
    const db = new Database(path.join(sessionDir, 'outbound.db'));
    db.exec('CREATE TABLE messages_out (seq INTEGER, kind TEXT, content TEXT, timestamp TEXT)');
    db.close();

    setTimeout(() => {
      const writer = new Database(path.join(sessionDir, 'outbound.db'));
      writer
        .prepare('INSERT INTO messages_out (seq, kind, content, timestamp) VALUES (?, ?, ?, ?)')
        .run(1, 'chat', JSON.stringify({ text: 'ok' }), new Date().toISOString());
      writer.close();
    }, 10);

    await expect(waitForChatReply(sessionDir, 0, { timeoutMs: 100, pollMs: 5 })).resolves.toBe('ok');
  });

  it('retains the reply timestamp for provider-turn correlation', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-probe-record-'));
    dirs.push(sessionDir);
    const db = new Database(path.join(sessionDir, 'outbound.db'));
    db.exec('CREATE TABLE messages_out (seq INTEGER, kind TEXT, content TEXT, timestamp TEXT)');
    const timestamp = '2026-08-29T13:00:00.000Z';
    db.prepare('INSERT INTO messages_out (seq, kind, content, timestamp) VALUES (?, ?, ?, ?)').run(
      1,
      'chat',
      JSON.stringify({ text: 'ok' }),
      timestamp,
    );
    db.close();

    expect(replyRecordAfter(sessionDir, 0)).toEqual({ text: 'ok', timestampMs: Date.parse(timestamp) });
  });
});
