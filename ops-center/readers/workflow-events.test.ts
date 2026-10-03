import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readWorkflowEventsByTurn, workflowEventSummary } from './workflow-events.js';
import type { RunTurn } from './runs.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const turn = (index: number): RunTurn => ({
  index,
  startedAt: '2026-08-20T10:00:00.000Z',
  endedAt: '2026-08-20T10:01:00.000Z',
  trigger: { kind: 'chat', label: 'test', intent: 'test' },
  tools: [], modelCalls: [], activeMs: 1_000, errorCount: 0, compactions: 0,
  responsePreview: 'done', outMessages: [], artifacts: [], contextTokens: null, costUsd: null,
  totals: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
  memoryOps: [], memoryInjected: null, skillsInvoked: [], outcome: 'ok',
});

describe('workflow event reader', () => {
  it('matches generic receipts to a run turn and summarizes source/status', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-workflow-reader-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'workflow-events.jsonl'), [
      JSON.stringify({ schema: 1, at: '2026-08-20T10:00:10.000Z', source: 'skill', name: 'frontier.loaded', status: 'completed', trace_id: 't1', turn_id: 'm1', data: {} }),
      JSON.stringify({ schema: 1, at: '2026-08-20T10:00:20.000Z', source: 'application', name: 'assessment.recorded', status: 'failed', trace_id: 't1', turn_id: 'm1', data: {} }),
    ].join('\n') + '\n');

    const byTurn = readWorkflowEventsByTurn(root, [turn(1)]);
    expect(byTurn.get(1)).toHaveLength(2);
    expect(workflowEventSummary(byTurn.get(1)!)).toEqual({ total: 2, failed: 1, sources: ['application', 'skill'] });
  });
});
