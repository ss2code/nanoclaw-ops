import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { PiProvider } from './pi.js';

let root: string;
let previousSessionRoot: string | undefined;
let previousConversations: string | undefined;
let previousBytes: string | undefined;
let previousDays: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rotate-'));
  previousSessionRoot = process.env.NANOCLAW_PI_SESSION_ROOT;
  previousConversations = process.env.NANOCLAW_CONVERSATIONS_DIR;
  previousBytes = process.env.PI_TRANSCRIPT_ROTATE_BYTES;
  previousDays = process.env.PI_TRANSCRIPT_ROTATE_AGE_DAYS;
  process.env.NANOCLAW_PI_SESSION_ROOT = path.join(root, 'pi-sessions');
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(root, 'conversations');
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) =>
    value === undefined ? delete process.env[key] : (process.env[key] = value);
  restore('NANOCLAW_PI_SESSION_ROOT', previousSessionRoot);
  restore('NANOCLAW_CONVERSATIONS_DIR', previousConversations);
  restore('PI_TRANSCRIPT_ROTATE_BYTES', previousBytes);
  restore('PI_TRANSCRIPT_ROTATE_AGE_DAYS', previousDays);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PiProvider.maybeRotateContinuation', () => {
  it('rotates an oversized Pi transcript and leaves an archive summary', () => {
    const sessionDir = path.join(root, 'pi-sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, 'large.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString() })}\n${'x'.repeat(10_000)}`);
    process.env.PI_TRANSCRIPT_ROTATE_BYTES = '1024';

    const reason = new PiProvider({ assistantName: 'Atlas' }).maybeRotateContinuation(file);

    expect(reason).toContain('MB');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(sessionDir).some((name) => name.startsWith('large.jsonl.rotated-'))).toBe(true);
  });

  it('keeps a recent transcript below the configured cap', () => {
    const sessionDir = path.join(root, 'pi-sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const file = path.join(sessionDir, 'small.jsonl');
    fs.writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString() }));
    process.env.PI_TRANSCRIPT_ROTATE_BYTES = '1024';

    expect(new PiProvider().maybeRotateContinuation(file)).toBeNull();
    expect(fs.existsSync(file)).toBe(true);
  });
});
