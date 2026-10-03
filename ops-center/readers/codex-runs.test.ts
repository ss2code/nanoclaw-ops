import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openOpsDb } from '../opsdb.js';
import { parseCodexRunJsonl, readCodexRuns } from './codex-runs.js';
import { collectTokenDeltas } from './tokens.js';

const jl = (value: unknown) => `${JSON.stringify(value)}\n`;

const transcript =
  jl({
    timestamp: '2026-07-16T04:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'thread-codex-1', source: 'app_server', model_provider: 'openai' },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1 },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:01.100Z',
    type: 'turn_context',
    payload: { turn_id: 'turn-1', model: 'gpt-5.6-terra', effort: 'xhigh' },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:01.200Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '<message from="atlas" sender="Alice">Check the service.</message>' },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:02.000Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: '{"cmd":"ncl groups list"}' },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:03.500Z',
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'ok' },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:04.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: '<message to="atlas">Service is healthy.</message>' },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:04.100Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 1200,
          cached_input_tokens: 900,
          output_tokens: 80,
          reasoning_output_tokens: 20,
          total_tokens: 1280,
        },
        model_context_window: 258400,
      },
    },
  }) +
  jl({
    timestamp: '2026-07-16T04:00:05.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 4000, last_agent_message: 'Service is healthy.' },
  });

describe('Codex Ops Center run reader', () => {
  it('maps native Codex rollout events into the provider-neutral Runs shape', () => {
    const run = parseCodexRunJsonl(transcript, { groupId: 'atlas-id', file: '/tmp/rollout.jsonl' });

    expect(run.sessionId).toBe('thread-codex-1');
    expect(run.lane).toBe('main');
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].trigger).toMatchObject({ kind: 'chat', label: 'Alice' });
    expect(run.turns[0].tools[0]).toMatchObject({ name: 'exec', durationMs: 1500, error: false });
    expect(run.turns[0].responsePreview).toBe('Service is healthy.');
    expect(run.modelCalls[0]).toMatchObject({
      model: 'gpt-5.6-terra',
      inputTokens: 300,
      cacheRead: 900,
      outputTokens: 80,
    });
    expect(run.activeMs).toBe(4000);
  });

  it('uses the A2A origin when the formatter supplied an Unknown sender sentinel', () => {
    const run = parseCodexRunJsonl(
      jl({
        timestamp: '2026-08-08T07:14:26.792Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: '<message from="jeeves" sender="Unknown">use model Low / haiku and list your memory items</message>',
        },
      }),
      { groupId: 'atlas-id', file: '/tmp/rollout.jsonl' },
    );

    expect(run.turns[0].trigger).toMatchObject({ kind: 'chat', label: 'jeeves' });
  });

  it('discovers rollouts under both legacy group and current per-session state trees', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-runs-'));
    try {
      const legacyDir = path.join(root, 'atlas-id', '.codex-shared', 'sessions', '2026', '07', '16');
      const sessionDir = path.join(root, 'sample-trip', 'sess-1', '.codex-shared', 'sessions', '2026', '08', '08');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'rollout-legacy.jsonl'), transcript);
      fs.writeFileSync(path.join(sessionDir, 'rollout-session.jsonl'), transcript);

      const runs = readCodexRuns({ sessionsRoot: root });
      expect(runs).toHaveLength(2);
      expect(runs.map((run) => run.groupId).sort()).toEqual(['atlas-id', 'sample-trip']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('feeds Codex token usage into the incremental Overview collector once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-usage-'));
    const ops = openOpsDb(path.join(root, 'ops.db'));
    try {
      const sessionsRoot = path.join(root, 'sessions');
      const legacyDir = path.join(sessionsRoot, 'atlas-id', '.codex-shared', 'sessions', '2026', '07', '16');
      const sessionDir = path.join(
        sessionsRoot,
        'sample-trip',
        'sess-1',
        '.codex-shared',
        'sessions',
        '2026',
        '08',
        '08',
      );
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'rollout-legacy.jsonl'), transcript);
      fs.writeFileSync(path.join(sessionDir, 'rollout-session.jsonl'), transcript);

      const initial = collectTokenDeltas(ops, sessionsRoot).deltas;
      expect(initial).toHaveLength(2);
      expect(initial).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            groupId: 'atlas-id',
            model: 'gpt-5.6-terra',
            inputTokens: 300,
            cacheRead: 900,
            outputTokens: 80,
            requests: 1,
          }),
          expect.objectContaining({
            groupId: 'sample-trip',
            model: 'gpt-5.6-terra',
            inputTokens: 300,
            cacheRead: 900,
            outputTokens: 80,
            requests: 1,
          }),
        ]),
      );
      expect(collectTokenDeltas(ops, sessionsRoot).deltas).toEqual([]);

      fs.appendFileSync(
        path.join(sessionDir, 'rollout-session.jsonl'),
        jl({
          timestamp: '2026-07-16T04:00:06.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 1500,
                cached_input_tokens: 1000,
                output_tokens: 90,
                reasoning_output_tokens: 10,
                total_tokens: 1590,
              },
              model_context_window: 258400,
            },
          },
        }),
      );
      expect(collectTokenDeltas(ops, sessionsRoot).deltas[0]).toMatchObject({
        model: 'gpt-5.6-terra',
        inputTokens: 500,
        cacheRead: 1000,
        outputTokens: 90,
      });
    } finally {
      ops.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
