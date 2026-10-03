import { describe, expect, it } from 'vitest';

import { modelRow, turnDetails } from './server.js';
import type { RunTurn } from './readers/runs.js';

describe('Runs model timeline rendering', () => {
  it('keeps reasoning/COT closed by default and escapes its contents', () => {
    const html = modelRow({
      ts: '2026-09-03T10:00:00.000Z',
      model: 'xai/grok-4.6',
      inputTokens: 10,
      outputTokens: 12,
      cacheRead: 3,
      cacheCreate: 1,
      id: 'a-1',
      text: 'Done.',
      reasoning: 'Inspect <script>alert(1)</script>\nChoose the smallest safe change.',
      toolNames: ['bash'],
      stopReason: 'stop',
      nativeCostUsd: 0.01,
    });

    expect(html).toContain('<details><summary class="muted small">reasoning / COT</summary>');
    expect(html).not.toContain('<details open>');
    expect(html).toContain('Inspect &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('shows Pi context-edit accounting in the turn timeline', () => {
    const turn: RunTurn = {
      index: 0,
      startedAt: '2026-09-03T10:00:00.000Z',
      endedAt: '2026-09-03T10:00:01.000Z',
      trigger: { kind: 'chat', label: 'owner', intent: 'Keep working.' },
      tools: [],
      modelCalls: [],
      activeMs: 1_000,
      errorCount: 0,
      compactions: 0,
      contextEdits: 2,
      responsePreview: 'Done.',
      outMessages: [],
      artifacts: [],
      contextTokens: null,
      costUsd: null,
      totals: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
      memoryOps: [],
      memoryInjected: null,
      skillsInvoked: [],
      outcome: 'ok',
    };

    expect(turnDetails(turn)).toContain('2 ctx edits');
  });
});
