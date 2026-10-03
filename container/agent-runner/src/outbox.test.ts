import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { enqueueFileOut } from './outbox.js';

let outboxDir: string;
let srcDir: string;

beforeEach(() => {
  initTestSessionDb();
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbox-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-src-'));
  process.env.NANOCLAW_OUTBOX_DIR = outboxDir;
});

afterEach(() => {
  closeSessionDb();
  delete process.env.NANOCLAW_OUTBOX_DIR;
  fs.rmSync(outboxDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

function writeSrc(name: string, bytes: string): string {
  const filePath = path.join(srcDir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

describe('enqueueFileOut', () => {
  it('stages the file and enqueues one routed messages_out row', () => {
    const src = writeSrc('ig_abc.png', 'PNGDATA');

    const { id, filename } = enqueueFileOut({
      srcPath: src,
      routing: { platform_id: 'chan-1', channel_type: 'whatsapp', thread_id: null, in_reply_to: 'm1' },
      text: 'here you go',
    });

    expect(fs.readFileSync(path.join(outboxDir, id, filename), 'utf8')).toBe('PNGDATA');
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('whatsapp');
    expect(out[0].in_reply_to).toBe('m1');
    expect(JSON.parse(out[0].content)).toEqual({ text: 'here you go', files: ['ig_abc.png'] });
  });

  it('defaults the filename and text', () => {
    const src = writeSrc('chart.png', 'X');

    const { filename } = enqueueFileOut({
      srcPath: src,
      routing: { platform_id: 'C-1', channel_type: 'slack', thread_id: null },
    });

    expect(filename).toBe('chart.png');
    const row = getUndeliveredMessages()[0];
    expect(row.in_reply_to).toBeNull();
    expect(JSON.parse(row.content)).toEqual({ text: '', files: ['chart.png'] });
  });

  it('does not enqueue when the source file is missing', () => {
    expect(() =>
      enqueueFileOut({
        srcPath: path.join(srcDir, 'missing.png'),
        routing: { platform_id: 'C-1', channel_type: 'slack', thread_id: null },
      }),
    ).toThrow();
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
