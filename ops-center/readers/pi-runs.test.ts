import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readExecutionRuns } from './runs.js';
import { listPiSessionFiles, parsePiRunJsonl, readPiRuns } from './pi-runs.js';

const jl = (value: unknown) => `${JSON.stringify(value)}\n`;

const piTranscript =
  jl({
    type: 'session',
    version: 1,
    id: 'pi-native-1',
    timestamp: '2026-09-03T10:00:00.000Z',
    cwd: '/workspace/agent',
  }) +
  jl({
    type: 'message',
    id: 'u-1',
    parentId: null,
    timestamp: '2026-09-03T10:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '<message from="atlas" sender="Alice">Investigate the service.</message>' }],
    },
  }) +
  jl({
    type: 'message',
    id: 'a-1',
    parentId: 'u-1',
    timestamp: '2026-09-03T10:00:02.000Z',
    message: {
      role: 'assistant',
      provider: 'xai',
      model: 'grok-4.6',
      stopReason: 'toolUse',
      usage: {
        input: 100,
        output: 12,
        reasoning: 3,
        cacheRead: 4,
        cacheWrite: 2,
        cost: { total: 0.1234 },
      },
      content: [
        { type: 'thinking', thinking: 'First inspect the service, then report the result.' },
        { type: 'text', text: 'I am checking the service.' },
        { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'systemctl status nanoclaw' } },
      ],
    },
  }) +
  jl({
    type: 'message',
    id: 'r-1',
    parentId: 'a-1',
    timestamp: '2026-09-03T10:00:05.000Z',
    message: {
      role: 'toolResult',
      toolName: 'bash',
      toolCallId: 'tool-1',
      isError: false,
      content: [{ type: 'text', text: 'active (running)' }],
    },
  }) +
  jl({
    type: 'message',
    id: 'a-2',
    parentId: 'r-1',
    timestamp: '2026-09-03T10:00:06.000Z',
    message: {
      role: 'assistant',
      provider: 'xai',
      model: 'grok-4.6',
      stopReason: 'stop',
      usage: { input: 40, output: 8, reasoning: 1, cacheRead: 6, cacheWrite: 0, cost: { total: 0.0456 } },
      content: [
        { type: 'thinking', thinking: 'The service is healthy.' },
        { type: 'text', text: '<message to="atlas">Service is healthy.</message>' },
      ],
    },
  }) +
  jl({
    type: 'message',
    id: 'u-2',
    parentId: 'a-2',
    timestamp: '2026-09-03T10:05:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Now summarize the result.' }] },
  }) +
  jl({
    type: 'message',
    id: 'a-3',
    parentId: 'u-2',
    timestamp: '2026-09-03T10:05:01.000Z',
    message: {
      role: 'assistant',
      provider: 'xai',
      model: 'grok-4.6',
      stopReason: 'stop',
      usage: { input: 20, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      content: [{ type: 'text', text: 'The service is healthy.' }],
    },
  });

const piOutboundToolTranscript =
  jl({
    type: 'session',
    version: 1,
    id: 'pi-outbound-1',
    timestamp: '2026-09-03T10:00:00.000Z',
    cwd: '/workspace/agent',
  }) +
  jl({
    type: 'message',
    timestamp: '2026-09-03T10:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '<message from="atlas" sender="Alice">Send the result to Jeeves.</message>' }],
    },
  }) +
  jl({
    type: 'message',
    timestamp: '2026-09-03T10:00:02.000Z',
    message: {
      role: 'assistant',
      provider: 'xai',
      model: 'grok-4.6',
      usage: { input: 100, output: 10, cost: { total: 0.01 } },
      content: [
        {
          type: 'toolCall',
          id: 'send-1',
          name: 'mcp__nanoclaw__send_message',
          arguments: { to: 'jeeves', text: 'The result.' },
        },
      ],
    },
  }) +
  jl({
    type: 'message',
    timestamp: '2026-09-03T10:00:03.000Z',
    message: {
      role: 'toolResult',
      toolCallId: 'send-1',
      isError: false,
      content: [{ type: 'text', text: 'Message sent to jeeves (id:303)' }],
    },
  }) +
  jl({
    type: 'message',
    timestamp: '2026-09-03T10:00:04.000Z',
    message: {
      role: 'assistant',
      provider: 'xai',
      model: 'grok-4.6',
      usage: { input: 120, output: 2, cost: { total: 0.002 } },
      content: [{ type: 'text', text: '<internal>Delivery queued.</internal>' }],
    },
  });

describe('Pi Ops Center run reader', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('maps native Pi messages, reasoning, tools, usage, cost, and turns', () => {
    const run = parsePiRunJsonl(piTranscript, { groupId: 'ag-pi', file: '/tmp/sess-1/pi-sessions/pi-native-1.jsonl' });

    expect(run.sessionId).toBe('pi-native-1');
    expect(run.lane).toBe('main');
    expect(run.turns).toHaveLength(2);
    expect(run.turns[0].trigger).toMatchObject({ kind: 'chat', label: 'Alice', intent: 'Investigate the service.' });
    expect(run.turns[0].responsePreview).toBe('Service is healthy.');
    expect(run.turns[0].outMessages).toEqual([{ to: 'atlas', preview: 'Service is healthy.' }]);
    expect(run.turns[0].tools[0]).toMatchObject({
      name: 'bash',
      detail: 'systemctl status nanoclaw',
      durationMs: 3000,
      error: false,
      resultPreview: 'active (running)',
    });
    expect(run.turns[0].modelCalls[0]).toMatchObject({
      model: 'xai/grok-4.6',
      inputTokens: 100,
      outputTokens: 15,
      cacheRead: 4,
      cacheCreate: 2,
      nativeCostUsd: 0.1234,
      reasoning: 'First inspect the service, then report the result.',
    });
    expect(run.turns[0].modelCalls[1]).toMatchObject({
      outputTokens: 9,
      reasoning: 'The service is healthy.',
    });
    expect(run.totals).toMatchObject({
      inputTokens: 160,
      outputTokens: 29,
      cacheRead: 10,
      cacheCreate: 2,
      modelCalls: 3,
      toolCalls: 1,
    });
    expect(run.costUsd).toBeCloseTo(0.179, 10);
    expect(run.activeMs).toBe(6_000);
    expect(run.openingPrompt).toBe('<message from="atlas" sender="Alice">Investigate the service.</message>');
  });

  it('keeps injected memory metadata while hiding system/grounding wrappers from the prompt', () => {
    const text =
      jl({
        type: 'message',
        timestamp: '2026-09-03T11:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system>private instructions</system><trip_grounding>\nMemory: {"total":2,"rows":[{"title":"One"},{"title":"Two"}]}\n</trip_grounding><message from="atlas" sender="Alice">Check memory.</message>',
            },
          ],
        },
      }) +
      jl({
        type: 'message',
        timestamp: '2026-09-03T11:00:01.000Z',
        message: {
          role: 'assistant',
          provider: 'xai',
          model: 'grok-4.6',
          usage: { input: 1, output: 1, cost: { total: 0.001 } },
          content: [{ type: 'text', text: '<message to="atlas">Done.</message>' }],
        },
      });
    const run = parsePiRunJsonl(text, { groupId: 'ag-pi', file: '/tmp/pi-memory.jsonl' });

    expect(run.openingPrompt).toBe('<message from="atlas" sender="Alice">Check memory.</message>');
    expect(run.turns[0].memoryInjected).toEqual({ count: 2, titles: ['One', 'Two'] });
  });

  it('counts successful NanoClaw outbound tools as action response evidence', () => {
    const run = parsePiRunJsonl(piOutboundToolTranscript, {
      groupId: 'ag-pi',
      file: '/tmp/pi-outbound-1.jsonl',
    });

    expect(run.turns[0].outboundActions).toEqual([
      expect.objectContaining({ kind: 'message', tool: 'mcp__nanoclaw__send_message' }),
    ]);
    expect(run.turns[0].outcome).toBe('ok');
  });

  it('accounts for Pi 0.87 append-only context edits in Runs', () => {
    const text =
      jl({ type: 'session', version: 1, id: 'pi-context-edit-1', timestamp: '2026-09-03T12:00:00.000Z' }) +
      jl({
        type: 'message',
        timestamp: '2026-09-03T12:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Keep working.' }] },
      }) +
      jl({
        type: 'message',
        timestamp: '2026-09-03T12:00:02.000Z',
        message: {
          role: 'assistant',
          provider: 'xai',
          model: 'grok-4.7',
          usage: { input: 100, output: 10, cost: { total: 0.01 } },
          content: [{ type: 'text', text: 'Continuing.' }],
        },
      }) +
      jl({
        type: 'context_edit',
        timestamp: '2026-09-03T12:00:03.000Z',
        entryId: 'a-1',
        replacement: null,
      });

    const run = parsePiRunJsonl(text, { groupId: 'ag-pi', file: '/tmp/pi-context-edit-1.jsonl' });

    expect(run.contextEdits).toBe(1);
    expect(run.turns[0].contextEdits).toBe(1);
  });

  it('discovers session-local Pi files, scopes groups, and merges them into shared Runs', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pi-runs-'));
    const piDir = path.join(root, 'ag-pi', 'sess-host-1', 'pi-sessions');
    fs.mkdirSync(piDir, { recursive: true });
    const file = path.join(piDir, 'pi-native-1.jsonl');
    fs.writeFileSync(file, piTranscript);

    expect(listPiSessionFiles(root)).toEqual([{ groupId: 'ag-pi', file, lane: 'main' }]);
    expect(readPiRuns({ sessionsRoot: root, groupId: 'other' })).toEqual([]);
    expect(readPiRuns({ sessionsRoot: root, groupId: 'ag-pi' })).toHaveLength(1);

    const claudeDir = path.join(root, 'ag-claude', '.claude-shared', 'projects', '-workspace');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'claude.jsonl'),
      `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-03T10:00:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } })}\n`,
    );

    const runs = readExecutionRuns({ sessionsRoot: root, limit: Infinity });
    expect(runs.map((run) => run.groupId).sort()).toEqual(['ag-claude', 'ag-pi']);
    expect(runs.find((run) => run.groupId === 'ag-pi')?.file).toBe(file);
  });

  it('skips malformed and oversized input without throwing', () => {
    expect(() =>
      parsePiRunJsonl('{not json}\n' + piTranscript, { groupId: 'ag-pi', file: '/tmp/pi.jsonl' }),
    ).not.toThrow();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pi-bad-'));
    const dir = path.join(root, 'ag-pi', 'sess-1', 'pi-sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.jsonl'), '{bad}\n');
    expect(readPiRuns({ sessionsRoot: root, maxFileBytes: 64 })).toHaveLength(1);
  });
});
