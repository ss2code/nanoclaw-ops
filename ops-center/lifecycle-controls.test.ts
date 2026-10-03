import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { buildGroupRestartArgs } from './lifecycle.js';
import { channelsCard, fleetCard, type GroupCardExtras } from './ui.js';

const extras = {
  routingName: 'test',
  skills: { mode: 'all', enabledIds: [], total: 0 },
  tokensToday: [],
  costTodayUsd: 0,
  senders: { unique: 0, unknown: 0, top: [] },
  latencyP95ProxyMs: null,
  sloWindowDays: 7,
  p95Ms: null,
  spans: [],
  subagentTicks: [],
  compactionsToday: 0,
  recalls: null,
  recallHitRate: null,
  nowMs: Date.now(),
  mix: [],
  wirings: [],
  maxMessagesPerPrompt: null,
} as unknown as GroupCardExtras;

describe('Ops Center lifecycle controls', () => {
  it('renders scoped Run, Stop, Pause, and Resume controls with confirmation for destructive actions', () => {
    const html = fleetCard(
      {
        id: 'ag-jeeves',
        name: 'Jeeves',
        model: 'claude-sonnet-5',
        modelTiers: null,
        provider: 'claude',
        sessions: 1,
        containersUp: 0,
        minHeartbeatAgeMs: null,
        currentTool: null,
        queueDepth: 2,
        inflight: 0,
        todayIn: 0,
        todayOut: 0,
        unanswered: 0,
        contextWindows: [],
        lifecycleStatus: 'paused',
        desiredState: 'paused',
        lifecycleError: null,
      } as never,
      extras,
    );

    expect(html).toContain('/api/group/ag-jeeves/resume');
    expect(html).toContain('/api/group/ag-jeeves/stop');
    expect(html).toContain('/api/group/ag-jeeves/pause');
    expect(html).toContain('title="Restart fresh"');
    expect(html).toContain('{fresh:true}');
    expect(html).toContain('with a fresh context');
    expect(html).toContain("'STOP'");
    expect(html).toContain("'PAUSE'");
    expect(html).toContain('paused');

    const server = fs.readFileSync(path.join(process.cwd(), 'ops-center', 'server.ts'), 'utf8');
    expect(server).toContain('body.confirm !== expected');
    expect(server).toContain('Boolean(body.fresh)');
  });

  it('builds a fresh restart as an explicit fresh-context ncl restart', () => {
    expect(buildGroupRestartArgs('ag-jeeves', false, false)).toEqual(['groups', 'restart', '--id', 'ag-jeeves']);
    expect(buildGroupRestartArgs('ag-jeeves', false, true)).toEqual([
      'groups',
      'restart',
      '--id',
      'ag-jeeves',
      '--fresh',
    ]);
    expect(buildGroupRestartArgs('ag-jeeves', true, true)).toEqual([
      'groups',
      'restart',
      '--id',
      'ag-jeeves',
      '--rebuild',
      '--fresh',
    ]);
  });

  it('saves model tiers through a fresh restart so stale provider context is not reused', () => {
    const lifecycle = fs.readFileSync(path.join(process.cwd(), 'ops-center', 'lifecycle.ts'), 'utf8');
    expect(lifecycle).toContain('groupRestart(groupId, false, true)');
  });

  it('keeps long group names readable and labels every connected channel', () => {
    const html = fleetCard(
      {
        id: 'ag-trip',
        name: 'Sample Trip Companion',
        model: 'claude-sonnet-5',
        modelTiers: null,
        provider: 'claude',
        sessions: 1,
        containersUp: 0,
        minHeartbeatAgeMs: null,
        currentTool: null,
        queueDepth: 0,
        inflight: 0,
        todayIn: 0,
        todayOut: 0,
        unanswered: 0,
        contextWindows: [],
        lifecycleStatus: 'idle',
        desiredState: 'running',
        lifecycleError: null,
      } as never,
      extras,
    );
    expect(html).toContain('Sample Trip Companion');
    expect(html).toContain('fc-actions');

    const channels = channelsCard([
      {
        id: 'w1',
        messaging_group_id: 'mg1',
        channel_type: 'whatsapp',
        instance: 'whatsapp',
        name: 'UK Trip Family',
        platform_id: '120363000000000111@g.us',
        engage_mode: 'mention',
        ignored_message_policy: 'drop',
        voice_transcription: 'on',
      },
    ]);
    expect(channels).toContain('UK Trip Family');
    expect(channels).toContain('120363000000000111');
    expect(channels).toContain('whatsapp');
  });
});
