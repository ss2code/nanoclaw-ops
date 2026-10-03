import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openOpsDb } from '../opsdb.js';
import {
  cacheHitRatio,
  classifyToolLatency,
  classifyOutcome,
  contextTokensFromUsage,
  inferTurnSkills,
  observedContextTokens,
  redundantToolCalls,
  summarizeOutcomes,
  type ExecutionRun,
  type RunTurn,
} from '../readers/runs.js';
import { estimateTokens, measureContextDrift, pickExhibits, type EvidencePack } from './digest.js';
import { readImprovementLedger } from './ledger.js';
import { coalesceRunWorkflows } from './workflows.js';
import { reflectSystemCard, reflectSystemScript } from './system-card.js';
import { reflectBody } from './page.js';
import { renderDigest } from './report.js';
import { computeSignals } from './signals.js';
import type { ReflectRunState } from './ops-run.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-'));
  db = openOpsDb(path.join(dir, 'ops.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('turn outcome classification', () => {
  const classify = (over: Partial<Parameters<typeof classifyOutcome>[0]> = {}) =>
    classifyOutcome({
      modelCalls: [{}],
      tools: [],
      outMessages: [],
      responsePreview: null,
      errorCount: 0,
      compactions: 0,
      ...over,
    });

  it('excludes empty wakes as idle', () => {
    expect(
      classifyOutcome({
        modelCalls: [],
        tools: [],
        outMessages: [],
        responsePreview: null,
        errorCount: 0,
        compactions: 0,
      }),
    ).toBe('idle');
  });

  it('marks work with no visible response failed', () => {
    expect(classify()).toBe('failed');
  });

  it('marks a clean visible response ok', () => {
    expect(classify({ responsePreview: 'done' })).toBe('ok');
  });

  it('marks a successful outbound action as answered even without transcript text', () => {
    expect(classify({ outboundActions: [{ kind: 'message', tool: 'mcp__nanoclaw__send_message' }] })).toBe('ok');
  });

  it('marks answered tool errors or compaction degraded', () => {
    expect(classify({ outMessages: [{}], errorCount: 1 })).toBe('degraded');
    expect(classify({ responsePreview: 'done', compactions: 1 })).toBe('degraded');
  });

  it('uses ok+degraded+failed as the working denominator', () => {
    expect(
      summarizeOutcomes([{ outcome: 'ok' }, { outcome: 'degraded' }, { outcome: 'failed' }, { outcome: 'idle' }]),
    ).toEqual({ ok: 1, degraded: 1, failed: 1, idle: 1, working: 3 });
  });
});

describe('cache and tool accounting', () => {
  it('classifies browser waits and deliberate sleeps inside shell tools', () => {
    expect(classifyToolLatency({ name: 'Bash', detail: 'agent-browser wait --load networkidle 20000' })).toBe(
      'browser-wait',
    );
    expect(classifyToolLatency({ name: 'Bash', detail: 'sleep 8' })).toBe('explicit-sleep');
    expect(classifyToolLatency({ name: 'Bash', detail: 'git status --short' })).toBe('shell');
  });

  it('counts cache creation as a miss', () => {
    expect(cacheHitRatio({ inputTokens: 100, cacheRead: 20_000, cacheCreate: 30_000 })).toBeCloseTo(0.399, 2);
  });

  it('returns zero for a cold prompt and null for no prompt', () => {
    expect(cacheHitRatio({ inputTokens: 100, cacheRead: 0, cacheCreate: 50_000 })).toBe(0);
    expect(cacheHitRatio({ inputTokens: 0, cacheRead: 0, cacheCreate: 0 })).toBeNull();
  });

  it('distinguishes repeated calls from calls with different arguments', () => {
    const out = redundantToolCalls({
      tools: [
        { ts: '', name: 'Read', summary: 'Read /a', detail: '/a' },
        { ts: '', name: 'Read', summary: 'Read /a', detail: '/a' },
        { ts: '', name: 'Read', summary: 'Read /b', detail: '/b' },
      ],
    });
    expect(out).toEqual([{ key: 'Read /a', count: 2 }]);
  });
});

describe('context measurement quality', () => {
  it('keeps missing or zero usage unknown instead of treating it as a fresh context', () => {
    expect(contextTokensFromUsage({ output_tokens: 120 })).toBeNull();
    expect(contextTokensFromUsage({ input_tokens: 0, cache_read_input_tokens: 0 })).toBeNull();
    expect(observedContextTokens({ inputTokens: 0, cacheRead: 0, cacheCreate: 0 })).toBeNull();
    expect(contextTokensFromUsage({ input_tokens: 100, cache_read_input_tokens: 900 })).toBe(1000);
  });

  it('does not compare separate runs or reset epochs', () => {
    const samples = [
      ...Array.from({ length: 8 }, (_, index) => ({ runId: 'old', contextTokens: 40_000 + index * 1_000 })),
      ...Array.from({ length: 8 }, (_, index) => ({ runId: 'new', contextTokens: 2_000 + index * 100 })),
    ];
    const measurement = measureContextDrift(samples);
    expect(measurement.observed).toBe(16);
    expect(measurement.comparable).toBe(8);
    expect(measurement.driftTokens).toBeLessThan(15_000);
  });

  it('retains a genuine within-epoch growth signal', () => {
    const measurement = measureContextDrift(
      Array.from({ length: 12 }, (_, index) => ({ runId: 'same', contextTokens: 30_000 + index * 5_000 })),
    );
    expect(measurement.comparable).toBe(12);
    expect(measurement.driftTokens).toBeGreaterThan(15_000);
  });
});

describe('provider-neutral skill attribution', () => {
  const turn = (label: string, tools: Parameters<typeof inferTurnSkills>[0]['tools'] = [], existing: string[] = []) =>
    inferTurnSkills({
      trigger: { kind: 'schedule', label, intent: '' },
      tools,
      skillsInvoked: existing,
    });

  it('keeps parser-provided attribution and expanded-skill triggers', () => {
    expect(turn('skill: reflect', [], ['welcome'])).toEqual(['reflect', 'welcome']);
  });

  it('recognises OpenCode Skill summaries', () => {
    expect(turn('prompt', [{ name: 'skill', summary: 'Skill reflect', detail: '{"name":"reflect"}' }])).toEqual([
      'reflect',
    ]);
  });

  it('recognises Codex skill paths', () => {
    expect(
      turn('Codex', [
        {
          name: 'exec',
          summary: 'read instructions',
          detail: 'sed -n 1,200p /workspace/.codex/skills/reflect/SKILL.md',
        },
      ]),
    ).toEqual(['reflect']);
  });
});

describe('workflow accounting', () => {
  const turn = (index: number, over: Partial<RunTurn>): RunTurn => ({
    index,
    startedAt: `2026-07-26T00:0${index}:00.000Z`,
    endedAt: `2026-07-26T00:0${index}:30.000Z`,
    trigger: { kind: 'chat', label: 'owner', intent: 'Run reflect' },
    tools: [],
    modelCalls: [],
    activeMs: 30_000,
    errorCount: 0,
    compactions: 0,
    responsePreview: null,
    outMessages: [],
    artifacts: [],
    contextTokens: null,
    costUsd: 0.01,
    totals: {
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 0,
      cacheCreate: 0,
      modelCalls: 1,
      toolCalls: 0,
    },
    memoryOps: [],
    memoryInjected: null,
    skillsInvoked: [],
    outcome: 'failed',
    ...over,
  });

  const run = (turns: RunTurn[]): ExecutionRun => ({
    id: 'run-1',
    groupId: 'g1',
    sessionId: 's1',
    lane: 'main',
    file: '/tmp/run.jsonl',
    startedAt: turns[0]?.startedAt ?? null,
    lastAt: turns.at(-1)?.endedAt ?? null,
    modelCalls: turns.flatMap((item) => item.modelCalls),
    tools: turns.flatMap((item) => item.tools),
    skills: [],
    files: [],
    debugTag: 'test',
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreate: 0,
      modelCalls: 0,
      toolCalls: 0,
    },
    turns,
    activeMs: 0,
    errorCount: 0,
    compactions: 0,
    costUsd: 0,
    artifacts: [],
  });

  it('counts a prompt, skill expansion, and compaction resume as one workflow', () => {
    const workflows = coalesceRunWorkflows(
      run([
        turn(0, {
          tools: [{ ts: '2026-07-26T00:00:10.000Z', name: 'Skill', summary: 'Skill reflect', detail: 'reflect' }],
          skillsInvoked: ['reflect'],
        }),
        turn(1, {
          trigger: { kind: 'schedule', label: 'skill: reflect', intent: 'Base directory for this skill' },
          tools: [
            {
              ts: '2026-07-26T00:01:10.000Z',
              name: 'Write',
              summary: 'Write report',
              detail: '/workspace/report.md',
              error: true,
              resultPreview: 'File has not been read yet',
            },
            {
              ts: '2026-07-26T00:01:20.000Z',
              name: 'Read',
              summary: 'Read report',
              detail: '/workspace/report.md',
              error: false,
            },
          ],
          skillsInvoked: ['reflect'],
          errorCount: 1,
        }),
        turn(2, {
          trigger: { kind: 'compact-resume', label: 'compact', intent: 'Continue after compaction' },
          compactions: 1,
          responsePreview: 'Analysis complete',
          outMessages: [{ to: 'owner', preview: 'Analysis complete' }],
          skillsInvoked: ['reflect'],
          outcome: 'degraded',
        }),
      ]),
    );

    expect(workflows).toHaveLength(1);
    expect(workflows[0].turnIndexes).toEqual([0, 1, 2]);
    expect(workflows[0].skillsInvoked).toEqual(['reflect']);
    expect(workflows[0].outcome).toBe('degraded');
    expect(workflows[0].responseEvidence).toBe('addressed');
    expect(workflows[0].recoveredErrors).toBe(1);
    expect(workflows[0].unresolvedErrors).toBe(0);
  });

  it('labels successful outbound-tool-only workflows as action evidence', () => {
    const workflows = coalesceRunWorkflows(
      run([
        turn(0, {
          tools: [
            {
              name: 'mcp__nanoclaw__send_message',
              summary: 'send',
              detail: null,
              ts: '2026-07-26T00:00:10.000Z',
              error: false,
            },
          ],
          outboundActions: [{ kind: 'message', tool: 'mcp__nanoclaw__send_message', summary: 'Message queued.' }],
          outcome: 'ok',
        }),
      ]),
    );

    expect(workflows[0].responseEvidence).toBe('action');
    expect(workflows[0].outcome).toBe('ok');
  });

  it('reserves a failed exhibit for each affected group', () => {
    const failedCall = {
      ts: '2026-07-26T00:00:05.000Z',
      model: 'claude-test',
      inputTokens: 10,
      outputTokens: 10,
      cacheRead: 0,
      cacheCreate: 0,
      id: null,
      text: null,
      toolNames: [],
      stopReason: 'end_turn',
    };
    const firstRun = run([turn(0, { modelCalls: [failedCall] })]);
    const secondRun = { ...run([turn(0, { modelCalls: [failedCall] })]), id: 'run-2', groupId: 'g2' };
    const pairs = [firstRun, secondRun].flatMap((item) =>
      coalesceRunWorkflows(item).map((workflow) => ({ run: item, workflow })),
    );

    const exhibits = pickExhibits(pairs, 2);

    expect(exhibits.map((exhibit) => exhibit.groupId).sort()).toEqual(['g1', 'g2']);
  });

  it('does not merge a later real user prompt into the previous workflow', () => {
    const workflows = coalesceRunWorkflows(
      run([
        turn(0, { responsePreview: 'first', outcome: 'ok' }),
        turn(1, {
          trigger: { kind: 'chat', label: 'owner', intent: 'A separate request' },
          responsePreview: 'second',
          outcome: 'ok',
        }),
      ]),
    );
    expect(workflows.map((workflow) => workflow.turnIndexes)).toEqual([[0], [1]]);
  });

  it('carries Pi context-edit accounting into Reflect workflows', () => {
    const workflows = coalesceRunWorkflows(
      run([turn(0, { responsePreview: 'done', contextEdits: 2 })]),
    );

    expect(workflows[0].contextEdits).toBe(2);
  });
});

const basePack = (over: Partial<EvidencePack> = {}): EvidencePack => ({
  generatedAt: '2026-07-26T00:00:00.000Z',
  windowDays: 7,
  scope: 'fleet',
  health: {
    complete: true,
    groups: 'ok',
    runs: 'ok',
    settledTurns: 'ok',
    opsDb: 'ok',
    warnings: [],
  },
  fleet: {
    from: '2026-07-19T00:00:00.000Z',
    to: '2026-07-26T00:00:00.000Z',
    runs: 1,
    outcomes: { ok: 10, degraded: 0, failed: 0, idle: 0, working: 10 },
    pricedTurns: 10,
    unpricedTurns: 0,
    costUsd: 1,
    costPerWorkingTurn: 0.1,
    costPerSuccessfulResult: 0.1,
    toolHealth: [],
    skills: [],
    dormantSkills: [],
    events: [],
    openIncidents: [],
    recentOperations: [],
  },
  groups: [
    {
      groupId: 'g1',
      name: 'G1',
      provider: 'claude',
      model: 'sonnet',
      maxMessagesPerPrompt: null,
      outcomes: { ok: 10, degraded: 0, failed: 0, idle: 0, working: 10 },
      pricedTurns: 10,
      unpricedTurns: 0,
      costUsd: 1,
      costPerWorkingTurn: 0.1,
      costPerSuccessfulResult: 0.1,
      medianCacheHitRatio: 0.9,
      compactionsPerWorkingTurn: 0,
      medianContextTokens: 10_000,
      contextObservations: 10,
      contextDriftTokens: 0,
      byTrigger: [],
      modelMix: [],
    },
  ],
  exhibits: [],
  improvements: [],
  packTokens: 100,
  ...over,
});

describe('signals and evidence honesty', () => {
  it('stays silent for a healthy complete pack', () => {
    expect(computeSignals(basePack())).toEqual([]);
    expect(renderDigest(basePack(), [])).toContain('No action is indicated');
  });

  it('reports context-edit rates without treating them as failures', () => {
    const pack = basePack({
      groups: [{ ...basePack().groups[0], contextEditsPerWorkingWorkflow: 0.5 }],
    });

    expect(renderDigest(pack, [])).toContain('ctx edits 0.50');
    expect(computeSignals(pack)).toEqual([]);
  });

  it('does not call incomplete evidence healthy', () => {
    const pack = basePack({
      health: {
        complete: false,
        groups: 'ok',
        runs: 'empty',
        settledTurns: 'empty',
        opsDb: 'ok',
        warnings: ['No settled turns.'],
      },
    });
    const report = renderDigest(pack, []);
    expect(report).toContain('do not interpret silence as healthy stasis');
    expect(report).toContain('not a health verdict');
    expect(report).not.toContain('No action is indicated');
  });

  it('flags a high failure rate', () => {
    const pack = basePack({
      groups: [
        {
          ...basePack().groups[0],
          outcomes: { ok: 5, degraded: 1, failed: 4, idle: 0, working: 10 },
        },
      ],
    });
    expect(computeSignals(pack).some((signal) => signal.id === 'failure-rate:g1')).toBe(true);
  });

  it('flags tool errors only with enough calls', () => {
    const health = (calls: number) => ({
      name: 'Gmail',
      calls,
      errors: Math.round(calls / 2),
      errorRate: 0.5,
      recoveredErrors: 0,
      unresolvedErrors: Math.round(calls / 2),
      unresolvedErrorRate: 0.5,
      recoveryCalls: 0,
      recoveryMs: 0,
      p50Ms: 100,
      p95Ms: 200,
      priorP95Ms: null,
      recentP95Ms: null,
    });
    const few = basePack({ fleet: { ...basePack().fleet, toolHealth: [health(4)] } });
    const many = basePack({ fleet: { ...basePack().fleet, toolHealth: [health(20)] } });
    expect(computeSignals(few, ['perf'])).toEqual([]);
    expect(computeSignals(many, ['perf']).some((signal) => signal.id === 'tool-errors:Gmail')).toBe(true);
  });

  it('reports recovered tool errors as recovery tax instead of integration failure', () => {
    const pack = basePack({
      fleet: {
        ...basePack().fleet,
        toolHealth: [
          {
            name: 'Write',
            calls: 36,
            errors: 26,
            errorRate: 0.722,
            recoveredErrors: 26,
            unresolvedErrors: 0,
            unresolvedErrorRate: 0,
            recoveryCalls: 52,
            recoveryMs: 12_000,
            p50Ms: 100,
            p95Ms: 200,
            priorP95Ms: null,
            recentP95Ms: null,
          },
        ],
      },
      exhibits: [
        {
          id: 'run-1:0',
          runId: 'run-1',
          groupId: 'g1',
          turnIndexes: [0, 1],
          turnIndex: 0,
          startedAt: '2026-07-25T00:00:00.000Z',
          trigger: 'chat/owner',
          intent: 'daily update',
          outcome: 'degraded',
          costUsd: 0.1,
          tokens: { input: 10, output: 10, cacheRead: 0, cacheCreate: 0 },
          cacheHitRatio: 0,
          toolCalls: 3,
          errorCount: 1,
          recoveredErrors: 1,
          unresolvedErrors: 0,
          compactions: 0,
          responseEvidence: 'addressed',
          skillsInvoked: ['daily-update'],
          toolSequence: ['Write!', 'Read', 'Edit'],
          focusTags: ['group:g1', 'outcome:degraded', 'skill:daily-update', 'tool:Write'],
          redundant: [],
          responsePreview: 'done',
        },
      ],
      improvements: [
        {
          id: 'daily-update-fresh-triage-output',
          signalIds: ['tool-recovery-tax:Write'],
          title: 'Fresh outputs',
          status: 'fixed',
          firstSeenAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-26T00:00:00.000Z',
          rootCause: 'Stable paths.',
          changeSummary: 'Fresh paths.',
          changedFiles: ['triage.ts'],
          verification: ['test'],
        },
      ],
    });
    const signals = computeSignals(pack, ['perf']);
    expect(signals.some((signal) => signal.id === 'tool-errors:Write')).toBe(false);
    const recovery = signals.find((signal) => signal.id === 'tool-recovery-tax:Write');
    expect(recovery?.exhibitIds).toEqual(['run-1:0']);
    expect(recovery?.improvementIds).toEqual(['daily-update-fresh-triage-output']);
    expect(recovery?.evidenceLimitations?.join(' ')).toContain('delivery is not confirmed');
  });

  it('reports dormancy only for skills enabled in active groups', () => {
    const pack = basePack({
      fleet: {
        ...basePack().fleet,
        outcomes: { ok: 20, degraded: 0, failed: 0, idle: 0, working: 20 },
        skills: [
          {
            id: 'active-group-skill',
            description: '',
            enabledForGroups: ['G1'],
            invocations: 0,
            troubledTurns: 0,
            costUsd: 0,
          },
          {
            id: 'idle-group-skill',
            description: '',
            enabledForGroups: ['G2'],
            invocations: 0,
            troubledTurns: 0,
            costUsd: 0,
          },
        ],
      },
    });
    const dormant = computeSignals(pack, ['skills']).find((signal) => signal.id === 'dormant-skills');
    expect(dormant?.evidence.join(' ')).toContain('active-group-skill');
    expect(dormant?.evidence.join(' ')).not.toContain('idle-group-skill');
    expect(dormant?.severity).toBe('low');
  });
});

describe('improvement history', () => {
  it('loads a bounded structured history without making it part of diagnostic writes', () => {
    const ledgerPath = path.join(dir, 'reflect-improvements.json');
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'reflect-workflow-accounting',
            signalIds: ['skill-trouble:reflect'],
            title: 'Coalesce provider continuation phases',
            status: 'verified',
            firstSeenAt: '2026-07-20T00:00:00.000Z',
            updatedAt: '2026-07-26T00:00:00.000Z',
            rootCause: 'Skill expansion prompts were counted as separate work.',
            changeSummary: 'Reflect now reports workflows.',
            changedFiles: ['ops-center/reflect/workflows.ts'],
            verification: ['workflow regression test'],
          },
        ],
      }),
      'utf8',
    );

    const result = readImprovementLedger(ledgerPath);
    expect(result.warnings).toEqual([]);
    expect(result.entries[0].status).toBe('verified');
    expect(result.entries[0].signalIds).toContain('skill-trouble:reflect');
  });

  it('treats malformed history as unavailable evidence instead of breaking Reflect', () => {
    const ledgerPath = path.join(dir, 'reflect-improvements.json');
    fs.writeFileSync(ledgerPath, '{not json', 'utf8');
    const result = readImprovementLedger(ledgerPath);
    expect(result.entries).toEqual([]);
    expect(result.warnings[0]).toContain('unreadable');
  });
});

describe('read-only surface', () => {
  it('renders no mutation controls or reflect action endpoints', () => {
    const html = reflectBody(db, new URLSearchParams({ group: 'definitely-missing-group' }));
    expect(html).toContain('read-only execution-health digest');
    expect(html).toContain('/api/reflect/run');
    expect(html).toContain('id="rf-page-group"');
    expect(html).toContain('<option value="">all groups</option>');
    expect(html).not.toContain('<input id="rf-page-group"');
    expect(html).not.toMatch(/\/api\/reflect\/(accept|reject|apply|revert)/);
    expect(html).not.toMatch(/>Apply<|>Accept<|>Revert</);
  });

  it('keeps diagnostic entry points separate from the explicit ledger mutation command', () => {
    const diagnostic = [
      fs.readFileSync(path.join(process.cwd(), 'scripts', 'reflect.ts'), 'utf8'),
      fs.readFileSync(path.join(process.cwd(), 'ops-center', 'reflect', 'ops-run.ts'), 'utf8'),
    ].join('\n');
    expect(diagnostic).not.toContain('upsertImprovement');
    expect(diagnostic).not.toContain('reflect-ledger');
  });

  it('escapes the group filter in HTML and CLI guidance', () => {
    const html = reflectBody(db, new URLSearchParams({ group: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('estimates serialized evidence size without a tokenizer dependency', () => {
    expect(estimateTokens({ text: 'x'.repeat(400) })).toBeGreaterThan(100);
  });

  it('documents the Node-22-safe Reflect command in the page', () => {
    const html = reflectBody(db, new URLSearchParams());
    expect(html).toContain('pnpm run reflect digest');
    expect(html).not.toContain('pnpm exec tsx scripts/reflect.ts digest');
  });
});

describe('Ops Center System entry point', () => {
  it('renders a user-triggered run control and the latest digest summary', () => {
    const state: ReflectRunState = {
      runId: 'run-12345678',
      status: 'complete',
      startedAt: '2026-07-26T00:00:00.000Z',
      finishedAt: '2026-07-26T00:00:01.000Z',
      windowDays: 7,
      groupId: null,
      pack: basePack(),
      signals: [],
      error: null,
      snapshotSaved: true,
      snapshotError: null,
    };
    const html = reflectSystemCard(state, [
      {
        id: 'g1',
        name: 'G1',
        folder: 'g1',
        model: 'sonnet',
        provider: 'claude',
        cli_scope: 'global',
        model_tiers: null,
      },
    ]);
    expect(html).toContain('Run /reflect');
    expect(html).toContain('evidence complete');
    expect(html).toContain('Open full result');
    expect(html).toContain('value="g1"');
    expect(html).not.toContain('proposal');
  });

  it('uses the authenticated read-only run endpoint and refreshes the result', () => {
    const script = reflectSystemScript();
    expect(script).toContain("fetch('/api/reflect/run'");
    expect(script).toContain("'x-ops-action-token'");
    expect(script).toContain('location.reload()');
  });

  it('keeps the endpoint outside the generic action logger', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'ops-center', 'server.ts'), 'utf8');
    const route = source.indexOf("url.pathname === '/api/reflect/run'");
    const genericActions = source.indexOf("if (req.method === 'POST' && url.pathname.startsWith('/api/trips/')");
    expect(route).toBeGreaterThan(-1);
    expect(route).toBeLessThan(genericActions);
    expect(source.slice(route, genericActions)).toContain('runReflectFromOpsCenter');
    expect(source.slice(route, genericActions)).not.toContain('addEvent(opsDb');
  });
});
