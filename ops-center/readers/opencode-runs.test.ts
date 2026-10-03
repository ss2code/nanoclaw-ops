import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listOpenCodeDbs, readOpenCodeRuns } from './opencode-runs.js';
import { readExecutionRuns } from './runs.js';

/**
 * Build a synthetic OpenCode store at
 * <sessionsRoot>/<groupId>/<sessionDir>/opencode-xdg/opencode/opencode.db with
 * only the columns the reader queries — enough to exercise the mapping without
 * replicating OpenCode's full drizzle schema.
 */
function writeOpenCodeDb(
  sessionsRoot: string,
  groupId: string,
  sessions: {
    id: string;
    parentId: string | null;
    title: string;
    createdMs: number;
    updatedMs: number;
    messages?: Record<string, unknown>[];
    parts?: Record<string, unknown>[];
  }[],
  scope: 'session' | 'group' = 'session',
): void {
  const dir =
    scope === 'group'
      ? path.join(sessionsRoot, groupId, 'opencode-xdg', 'opencode')
      : path.join(sessionsRoot, groupId, 'sess-x', 'opencode-xdg', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'opencode.db'));
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
     CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
     CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`,
  );
  const insSession = db.prepare(
    'INSERT INTO session (id, parent_id, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)',
  );
  const insMessage = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)');
  for (const s of sessions) {
    insSession.run(s.id, s.parentId, s.title, s.createdMs, s.updatedMs);
    for (const [i, m] of (s.messages ?? []).entries()) insMessage.run(`${s.id}-m${i}`, s.id, s.createdMs + i * 1000, JSON.stringify(m));
    for (const [i, p] of (s.parts ?? []).entries()) insPart.run(`${s.id}-p${i}`, `${s.id}-m0`, s.id, s.createdMs + i * 1000, JSON.stringify(p));
  }
  db.close();
}

const assistant = (modelID: string, tokens: Record<string, unknown>) => ({
  role: 'assistant',
  modelID,
  providerID: 'openrouter',
  tokens,
  time: { created: 1_783_330_000_000, completed: 1_783_330_005_000 },
});

const toolPart = (tool: string, input: unknown) => ({
  type: 'tool',
  tool,
  state: { status: 'completed', input, time: { start: 1_783_330_001_000, end: 1_783_330_002_000 } },
});

describe('readOpenCodeRuns', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-oc-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('maps sessions → runs with lane, model, tokens, tools, skills, and a titled debug tag', () => {
    writeOpenCodeDb(root, 'ag-errand-runner', [
      {
        id: 'ses_parent',
        parentId: null,
        title: 'Errand Runner introduction',
        createdMs: 1_783_330_000_000,
        updatedMs: 1_783_330_009_000,
        messages: [
          assistant('minimax/minimax-m3', { input: 100, output: 20, reasoning: 5, cache: { read: 8, write: 3 } }),
        ],
        parts: [
          toolPart('webfetch', { url: 'https://example.com/news' }),
          toolPart('skill', { name: 'agent-browser' }),
        ],
      },
      {
        id: 'ses_child',
        parentId: 'ses_parent',
        title: 'Gather World Cup news (@low subagent)',
        createdMs: 1_783_335_000_000,
        updatedMs: 1_783_336_000_000,
        messages: [
          assistant('openai/gpt-oss-120b', { input: 40, output: 10, reasoning: 2, cache: { read: 1, write: 0 } }),
        ],
        parts: [toolPart('task', { description: 'Gather World Cup news last 24h' })],
      },
    ]);

    const runs = readOpenCodeRuns({ sessionsRoot: root });
    expect(runs).toHaveLength(2);

    const main = runs.find((r) => r.lane === 'main')!;
    expect(main.groupId).toBe('ag-errand-runner');
    expect(main.sessionId).toBe('ses_parent');
    expect(main.file.endsWith('opencode.db')).toBe(true);
    // token mapping: input, output+reasoning, cache.read, cache.write
    expect(main.modelCalls).toEqual([
      expect.objectContaining({
        model: 'minimax/minimax-m3',
        inputTokens: 100,
        outputTokens: 25,
        cacheRead: 8,
        cacheCreate: 3,
      }),
    ]);
    expect(main.totals).toMatchObject({ inputTokens: 100, outputTokens: 25, modelCalls: 1, toolCalls: 2 });
    expect(main.tools.map((t) => t.name).sort()).toEqual(['skill', 'webfetch']);
    expect(main.skills).toEqual(['agent-browser']);
    expect(main.debugTag).toContain('title="Errand Runner introduction"');

    const sub = runs.find((r) => r.lane === 'subagent')!;
    expect(sub.sessionId).toBe('ses_child');
    expect(sub.modelCalls[0]).toMatchObject({ model: 'openai/gpt-oss-120b', outputTokens: 12 });
    // task-tool delegations surface their description as the tool summary
    expect(sub.tools[0]).toMatchObject({ name: 'task', summary: 'Gather World Cup news last 24h' });
  });

  it('reads group-persistent stores used by native XAI groups', () => {
    writeOpenCodeDb(
      root,
      'ag-grok',
      [
        {
          id: 'ses_grok',
          parentId: null,
          title: 'Grok native XAI session',
          createdMs: 1_783_400_000_000,
          updatedMs: 1_783_400_009_000,
          messages: [assistant('xai/grok-4.5', { input: 12, output: 8, reasoning: 3 })],
        },
      ],
      'group',
    );

    const dbPath = path.join(root, 'ag-grok', 'opencode-xdg', 'opencode', 'opencode.db');
    expect(listOpenCodeDbs(root)).toEqual([{ groupId: 'ag-grok', db: dbPath }]);

    const runs = readOpenCodeRuns({ sessionsRoot: root, groupId: 'ag-grok' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ groupId: 'ag-grok', sessionId: 'ses_grok', file: dbPath });
    expect(runs[0].modelCalls[0]).toMatchObject({ model: 'xai/grok-4.5', outputTokens: 11 });
  });

  it('scopes to one group when groupId is given', () => {
    writeOpenCodeDb(root, 'ag-a', [
      {
        id: 's1',
        parentId: null,
        title: 'A',
        createdMs: 1,
        updatedMs: 2,
        messages: [assistant('m/x', { input: 1, output: 1 })],
      },
    ]);
    writeOpenCodeDb(root, 'ag-b', [
      {
        id: 's2',
        parentId: null,
        title: 'B',
        createdMs: 1,
        updatedMs: 2,
        messages: [assistant('m/y', { input: 1, output: 1 })],
      },
    ]);
    expect(readOpenCodeRuns({ sessionsRoot: root, groupId: 'ag-a' }).map((r) => r.groupId)).toEqual(['ag-a']);
  });

  it('is merged into the readExecutionRuns pool alongside JSONL runs', () => {
    // A Claude JSONL run for one group…
    const jsonlDir = path.join(root, 'ag-claude', '.claude-shared', 'projects', '-w');
    fs.mkdirSync(jsonlDir, { recursive: true });
    fs.writeFileSync(
      path.join(jsonlDir, 'sess.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-12T10:00:00.000Z',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
      }) + '\n',
    );
    // …and an OpenCode run for another group.
    writeOpenCodeDb(root, 'ag-errand-runner', [
      {
        id: 'ses_oc',
        parentId: null,
        title: 'errand',
        createdMs: 1_783_330_000_000,
        updatedMs: 1_783_330_009_000,
        messages: [assistant('minimax/minimax-m3', { input: 5, output: 5 })],
        parts: [toolPart('webfetch', { url: 'https://x' })],
      },
    ]);

    const runs = readExecutionRuns({ sessionsRoot: root, limit: Infinity });
    const groups = runs.map((r) => r.groupId).sort();
    expect(groups).toEqual(['ag-claude', 'ag-errand-runner']);
  });

  it('returns nothing (and never throws) for a tree with no opencode.db', () => {
    fs.mkdirSync(path.join(root, 'ag-empty'), { recursive: true });
    expect(readOpenCodeRuns({ sessionsRoot: root })).toEqual([]);
  });
});
