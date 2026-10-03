import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { GroupRouting } from './group.js';
import { modelsMatch } from './group.js';
import { awaitTurn, baseline } from './truth.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex provider ground truth', () => {
  it('waits for task_complete before reporting the turn model', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-truth-'));
    dirs.push(root);
    const sessionDir = path.join(root, 'web-session');
    const rolloutDir = path.join(root, '.codex-shared', 'sessions', '2026', '07', '16');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(rolloutDir, { recursive: true });
    const rollout = path.join(rolloutDir, 'rollout-test.jsonl');
    const group: GroupRouting = {
      agentGroupId: 'atlas',
      provider: 'codex',
      tiers: null,
      opencodeProvider: 'anthropic',
    };
    const cursor = baseline(group, sessionDir);
    const timestamp = (offsetMs: number) => new Date(cursor + offsetMs).toISOString();

    fs.writeFileSync(
      rollout,
      [
        { timestamp: timestamp(10), type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: timestamp(20), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );

    const incomplete = await awaitTurn(group, sessionDir, cursor, { timeoutMs: 20, pollMs: 5 });
    expect(incomplete).toEqual({ model: null, timedOut: true });

    fs.appendFileSync(
      rollout,
      `${JSON.stringify({
        timestamp: timestamp(30),
        type: 'event_msg',
        payload: { type: 'task_complete' },
      })}\n`,
    );

    const complete = await awaitTurn(group, sessionDir, cursor, { timeoutMs: 100, pollMs: 5 });
    expect(complete).toEqual({ model: 'gpt-5.6-sol', timedOut: false });
  });
});

describe('OpenCode provider ground truth', () => {
  it('matches canonical XAI tier ids to OpenCode native model ids', () => {
    const group: GroupRouting = {
      agentGroupId: 'ag-grok',
      provider: 'opencode',
      tiers: null,
      opencodeProvider: 'xai',
    };
    expect(modelsMatch(group, 'xai/grok-4.6', 'grok-4.6')).toBe(true);
  });

  it('reads the group-persistent store used by native XAI groups', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-truth-'));
    dirs.push(root);
    const sessionDir = path.join(root, 'ag-grok', 'sess-x');
    const storeDir = path.join(root, 'ag-grok', 'opencode-xdg', 'opencode');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    const db = new Database(path.join(storeDir, 'opencode.db'));
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, time_created INTEGER, data TEXT)');
    const old = Date.now() - 1000;
    const insert = db.prepare('INSERT INTO message (id, time_created, data) VALUES (?, ?, ?)');
    insert.run('old', old, JSON.stringify({ role: 'assistant', modelID: 'xai/grok-4.5' }));

    const group: GroupRouting = {
      agentGroupId: 'ag-grok',
      provider: 'opencode',
      tiers: null,
      opencodeProvider: 'xai',
    };
    const cursor = baseline(group, sessionDir);
    insert.run('new', cursor + 10, JSON.stringify({ role: 'assistant', modelID: 'xai/grok-4.6' }));
    db.close();

    await expect(awaitTurn(group, sessionDir, cursor, { timeoutMs: 100, pollMs: 5 })).resolves.toEqual({
      model: 'xai/grok-4.6',
      timedOut: false,
    });
  });

  it('falls back to structured provider logs while the OpenCode process buffers SQLite writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-log-truth-'));
    dirs.push(root);
    const sessionDir = path.join(root, 'ag-grok', 'sess-x');
    const logDir = path.join(root, 'ag-grok', 'opencode-xdg', 'opencode', 'log');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    const group: GroupRouting = {
      agentGroupId: 'ag-grok',
      provider: 'opencode',
      tiers: null,
      opencodeProvider: 'xai',
    };
    const old = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(
      path.join(logDir, 'opencode.log'),
      `timestamp=${old} level=INFO message=stream providerID=xai modelID=grok-4.5\n`,
    );
    const cursor = baseline(group, sessionDir);
    const fresh = new Date(cursor + 10).toISOString();
    fs.appendFileSync(
      path.join(logDir, 'opencode.log'),
      `timestamp=${fresh} level=INFO message=stream providerID=xai modelID=grok-4.6\n`,
    );

    await expect(awaitTurn(group, sessionDir, cursor, { timeoutMs: 100, pollMs: 5 })).resolves.toEqual({
      model: 'grok-4.6',
      timedOut: false,
    });
  });
});
