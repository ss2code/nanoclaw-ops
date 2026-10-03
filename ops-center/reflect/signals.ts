/**
 * Conservative, deterministic findings over an EvidencePack.
 *
 * These are reporting thresholds, not recommendations to mutate the system.
 * Empty output is valid only when the pack has sufficient evidence; callers
 * must consult pack.health before describing an empty list as healthy stasis.
 */
import type { EvidencePack } from './digest.js';

export type ReflectLane = 'tokens' | 'skills' | 'perf';
export type SignalSeverity = 'high' | 'medium' | 'low';

export interface Signal {
  lane: ReflectLane;
  id: string;
  severity: SignalSeverity;
  scope: string;
  groupId: string | null;
  title: string;
  evidence: string[];
  next: string;
  /** Exact bounded workflow exhibits selected for this signal. */
  exhibitIds?: string[];
  /** Prior approved diagnoses/repairs that named this signal id. */
  improvementIds?: string[];
  evidenceLimitations?: string[];
}

const T = {
  minTurns: 8,
  cacheHitFloor: 0.6,
  compactionRate: 0.25,
  failureRate: 0.15,
  contextDriftTokens: 15_000,
  triggerCostFactor: 1.5,
  toolErrorRate: 0.2,
  toolErrorMinCalls: 10,
  p95DriftFactor: 2,
} as const;

function tokenSignals(pack: EvidencePack): Signal[] {
  const out: Signal[] = [];
  for (const group of pack.groups) {
    if (group.outcomes.working < T.minTurns) continue;
    const base = { lane: 'tokens' as const, scope: group.name, groupId: group.groupId };

    if (group.medianCacheHitRatio != null && group.medianCacheHitRatio < T.cacheHitFloor) {
      out.push({
        ...base,
        id: `cache-miss:${group.groupId}`,
        severity: group.medianCacheHitRatio < 0.35 ? 'high' : 'medium',
        title: `Low prompt-cache hit ratio (${pct(group.medianCacheHitRatio)})`,
        evidence: [
          `Median cache hit ${pct(group.medianCacheHitRatio)} across ${group.outcomes.working} working workflows.`,
          `Cost per priced workflow ${money(group.costPerWorkingTurn)}.`,
        ],
        next: 'Inspect the changing prefix: standing instructions, injected memory, and per-turn skill/config material.',
      });
    }

    if (group.compactionsPerWorkingTurn != null && group.compactionsPerWorkingTurn > T.compactionRate) {
      out.push({
        ...base,
        id: `compaction:${group.groupId}`,
        severity: group.compactionsPerWorkingTurn > 0.6 ? 'high' : 'medium',
        title: `Frequent context compaction (${group.compactionsPerWorkingTurn.toFixed(2)}/workflow)`,
        evidence: [
          `${group.compactionsPerWorkingTurn.toFixed(2)} compactions per working workflow.`,
          `Median context ${group.medianContextTokens?.toLocaleString() ?? 'unknown'} tokens.`,
          `max_messages_per_prompt ${group.maxMessagesPerPrompt ?? 'default'}.`,
        ],
        next: 'Inspect prompt history and injected memory before changing the message or context limit.',
      });
    }

    if (group.contextDriftTokens != null && group.contextDriftTokens > T.contextDriftTokens) {
      out.push({
        ...base,
        id: `context-creep:${group.groupId}`,
        severity: 'medium',
        title: `Context grew ${group.contextDriftTokens.toLocaleString()} tokens across the window`,
        evidence: [
          `Newest-quarter median exceeds oldest-quarter median by ${group.contextDriftTokens.toLocaleString()} tokens across ${group.contextObservations} comparable observations.`,
        ],
        next: 'Check whether conversation history or injected memory is accumulating without being retired; rotate or compact the provider continuation before it reaches the model context ceiling.',
      });
    }

    const failureRate = group.outcomes.failed / group.outcomes.working;
    if (failureRate > T.failureRate) {
      out.push({
        ...base,
        id: `failure-rate:${group.groupId}`,
        severity: failureRate > 0.3 ? 'high' : 'medium',
        title: `${pct(failureRate)} of working workflows produced no visible response`,
        evidence: [
          `${group.outcomes.failed} failed / ${group.outcomes.working} working workflows.`,
          `${money(group.costUsd)} observed group spend.`,
        ],
        next: 'Open the failed exhibits and look for a shared trigger or failing tool before changing instructions.',
      });
    }

    const chat = group.byTrigger.find((bucket) => bucket.kind === 'chat');
    if (chat?.costPerTurn != null && chat.costPerTurn > 0) {
      for (const bucket of group.byTrigger) {
        if (bucket.kind === 'chat' || bucket.turns < 4 || bucket.costPerTurn == null) continue;
        if (bucket.costPerTurn > chat.costPerTurn * T.triggerCostFactor) {
          out.push({
            ...base,
            id: `trigger-cost:${group.groupId}:${bucket.kind}`,
            severity: 'medium',
            title: `${bucket.kind} workflows cost ${(bucket.costPerTurn / chat.costPerTurn).toFixed(1)}× chat workflows`,
            evidence: [
              `${bucket.kind}: ${bucket.turns} workflows at ${money(bucket.costPerTurn)}/workflow.`,
              `chat: ${chat.turns} workflows at ${money(chat.costPerTurn)}/workflow.`,
            ],
            next: 'Inspect whether unattended work carries an oversized prompt or uses a stronger model than its task requires.',
          });
        }
      }
    }
  }

  const loops = pack.exhibits.filter((exhibit) => exhibit.redundant.some((item) => item.count >= 3));
  if (loops.length >= 2) {
    out.push({
      lane: 'tokens',
      id: 'tool-loops',
      severity: 'medium',
      scope: 'fleet',
      groupId: null,
      title: `${loops.length} costly workflows repeated an identical tool call 3+ times`,
      evidence: loops
        .slice(0, 5)
        .map(
          (exhibit) =>
            `${exhibit.groupId} turn ${exhibit.turnIndex}: ${exhibit.redundant.map((item) => `${item.key} ×${item.count}`).join(', ')}`,
        ),
      next: 'Check whether results were truncated, unclear, or needlessly re-verified.',
    });
  }
  return out;
}

function skillSignals(pack: EvidencePack): Signal[] {
  const out: Signal[] = [];
  if (pack.fleet.outcomes.working < 12) return out;

  const activeGroups = new Set(pack.groups.map((group) => group.name));
  const dormant = pack.fleet.skills.filter(
    (skill) => skill.invocations === 0 && skill.enabledForGroups.some((groupName) => activeGroups.has(groupName)),
  );
  if (dormant.length) {
    out.push({
      lane: 'skills',
      id: 'dormant-skills',
      severity: 'low',
      scope: 'fleet',
      groupId: null,
      title: `${dormant.length} optional enabled skill(s) were not invoked in active groups`,
      evidence: dormant
        .slice(0, 12)
        .map((skill) => `${skill.id} — enabled for ${skill.enabledForGroups.join(', ')}, 0 invocations.`),
      next: 'Confirm that the observation window includes the work these skills exist for; removal is only a candidate, not an automatic conclusion.',
    });
  }

  for (const skill of pack.fleet.skills) {
    if (skill.invocations < 4) continue;
    const troubledRate = skill.troubledTurns / skill.invocations;
    if (troubledRate <= 0.4) continue;
    out.push({
      lane: 'skills',
      id: `skill-trouble:${skill.id}`,
      severity: troubledRate > 0.65 ? 'high' : 'medium',
      scope: skill.id,
      groupId: null,
      title: `Skill "${skill.id}" leaves ${pct(troubledRate)} of its workflows degraded or failed`,
      evidence: [
        `${skill.troubledTurns} troubled / ${skill.invocations} workflow-level invocations.`,
        `${money(skill.costUsd)} observed spend on workflows using the skill.`,
      ],
      next: 'Inspect those exhibits for a missing precondition or failure path; do not assume more instructions are the answer.',
    });
  }
  return out;
}

function perfSignals(pack: EvidencePack): Signal[] {
  const out: Signal[] = [];
  for (const tool of pack.fleet.toolHealth) {
    if (tool.calls >= T.toolErrorMinCalls && tool.unresolvedErrorRate > T.toolErrorRate) {
      out.push({
        lane: 'perf',
        id: `tool-errors:${tool.name}`,
        severity: tool.unresolvedErrorRate > 0.4 ? 'high' : 'medium',
        scope: tool.name,
        groupId: null,
        title: `${tool.name} has unresolved errors on ${pct(tool.unresolvedErrorRate)} of calls`,
        evidence: [
          `${tool.unresolvedErrors} unresolved errors / ${tool.calls} calls (${tool.errors} raw errors).`,
          `p50 ${ms(tool.p50Ms)}, p95 ${ms(tool.p95Ms)}.`,
        ],
        next: 'Inspect failing call shapes and results to distinguish bad arguments from an unhealthy integration.',
      });
    }
    if (tool.calls >= T.toolErrorMinCalls && tool.recoveredErrors >= 5 && tool.errorRate > T.toolErrorRate) {
      out.push({
        lane: 'perf',
        id: `tool-recovery-tax:${tool.name}`,
        severity: 'medium',
        scope: tool.name,
        groupId: null,
        title: `${tool.name} recovered from ${tool.recoveredErrors} error(s), but paid retry tax`,
        evidence: [
          `${tool.recoveredErrors} recovered / ${tool.errors} raw errors; ${tool.unresolvedErrors} remained unresolved.`,
          `${tool.recoveryCalls} follow-up call(s) and ${ms(tool.recoveryMs)} observed until the first later success.`,
          'Recovery is inferred from later successful tool progress plus a visible workflow response.',
        ],
        next: 'Inspect the linked exhibits for a repeated preventable precondition before changing the integration.',
      });
    }
    if (tool.priorP95Ms != null && tool.recentP95Ms != null && tool.recentP95Ms > tool.priorP95Ms * T.p95DriftFactor) {
      out.push({
        lane: 'perf',
        id: `tool-drift:${tool.name}`,
        severity: 'medium',
        scope: tool.name,
        groupId: null,
        title: `${tool.name} recent p95 is ${(tool.recentP95Ms / tool.priorP95Ms).toFixed(1)}× slower${tool.latencyClass ? ` (${latencyLabel(tool.latencyClass)})` : ''}`,
        evidence: [
          `Older-half p95 ${ms(tool.priorP95Ms)}; newer-half p95 ${ms(tool.recentP95Ms)}.`,
          `${tool.calls} calls in the full window.`,
        ],
        next: latencyNext(tool.latencyClass, pack.fleet.recentOperations.length),
      });
    }
  }

  const rateLimits = pack.fleet.events.find((event) => event.kind === 'rate_limit');
  if (rateLimits && rateLimits.count >= 10) {
    out.push({
      lane: 'perf',
      id: 'rate-limits',
      severity: rateLimits.count > 50 ? 'high' : 'medium',
      scope: 'fleet',
      groupId: null,
      title: `${rateLimits.count} rate-limit events in ${pack.windowDays} day(s)`,
      evidence: [`${rateLimits.count} recorded rate_limit events.`],
      next: 'Check whether concurrent work is arriving in bursts before changing retry or scheduling behavior.',
    });
  }

  if (pack.fleet.openIncidents.length) {
    out.push({
      lane: 'perf',
      id: 'open-incidents',
      severity: pack.fleet.openIncidents.some((incident) => incident.severity === 'error') ? 'high' : 'low',
      scope: 'fleet',
      groupId: null,
      title: `${pack.fleet.openIncidents.length} open incident(s) already recorded`,
      evidence: pack.fleet.openIncidents
        .slice(0, 6)
        .map((incident) => `[${incident.severity}] ${incident.title} — ${incident.recommendation}`),
      next: 'Use the existing incident recommendation instead of deriving a duplicate diagnosis.',
    });
  }
  return out;
}

export function computeSignals(pack: EvidencePack, lanes?: ReflectLane[]): Signal[] {
  const wants = (lane: ReflectLane) => !lanes?.length || lanes.includes(lane);
  const rank: Record<SignalSeverity, number> = { high: 0, medium: 1, low: 2 };
  return [
    ...(wants('tokens') ? tokenSignals(pack) : []),
    ...(wants('skills') ? skillSignals(pack) : []),
    ...(wants('perf') ? perfSignals(pack) : []),
  ]
    .map((signal) => attachEvidence(pack, signal))
    .sort((a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id));
}

function attachEvidence(pack: EvidencePack, signal: Signal): Signal {
  const tags: string[] = [];
  if (signal.id.startsWith('skill-trouble:')) tags.push(`skill:${signal.id.slice('skill-trouble:'.length)}`);
  if (signal.id.startsWith('tool-errors:')) tags.push(`tool:${signal.id.slice('tool-errors:'.length)}`);
  if (signal.id.startsWith('tool-recovery-tax:')) tags.push(`tool:${signal.id.slice('tool-recovery-tax:'.length)}`);
  if (signal.id.startsWith('tool-drift:')) tags.push(`tool:${signal.id.slice('tool-drift:'.length)}`);
  if (signal.id.startsWith('failure-rate:'))
    tags.push(`group:${signal.id.slice('failure-rate:'.length)}`, 'outcome:failed');
  if (signal.id.startsWith('context-creep:')) tags.push(`group:${signal.id.slice('context-creep:'.length)}`);
  if (signal.id.startsWith('compaction:')) tags.push(`group:${signal.id.slice('compaction:'.length)}`);
  if (signal.id.startsWith('cache-miss:')) tags.push(`group:${signal.id.slice('cache-miss:'.length)}`);
  if (signal.id === 'tool-loops') {
    const ids = pack.exhibits.filter((exhibit) => exhibit.redundant.length).map((exhibit) => exhibit.id);
    return withHistory(pack, signal, ids);
  }
  const ids = tags.length
    ? pack.exhibits
        .filter((exhibit) => tags.every((tag) => exhibit.focusTags?.includes(tag)))
        .map((exhibit) => exhibit.id)
        .slice(0, 3)
    : [];
  return withHistory(pack, signal, ids);
}

function withHistory(pack: EvidencePack, signal: Signal, exhibitIds: string[]): Signal {
  const exhibits = pack.exhibits.filter((exhibit) => exhibitIds.includes(exhibit.id));
  const limitations = [
    ...(exhibitIds.length === 0
      ? ['No bounded exhibit matched this signal; inspect source traces before acting.']
      : []),
    ...(exhibits.some((exhibit) => exhibit.responseEvidence === 'plain')
      ? ['At least one exhibit has transcript response text but no recorded outbound destination.']
      : []),
    ...(exhibits.some((exhibit) => exhibit.responseEvidence === 'addressed')
      ? ['An addressed response is present in the transcript, but downstream channel delivery is not confirmed.']
      : []),
    ...(exhibits.some((exhibit) => exhibit.responseEvidence === 'action')
      ? [
          'A NanoClaw outbound action was acknowledged by the delivery tool; downstream channel delivery is not confirmed.',
        ]
      : []),
  ];
  return {
    ...signal,
    exhibitIds,
    improvementIds: (pack.improvements ?? [])
      .filter((entry) => entry.signalIds.includes(signal.id))
      .map((entry) => entry.id),
    evidenceLimitations: limitations,
  };
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
const money = (value: number | null): string => (value == null ? 'unavailable' : `$${value.toFixed(4)}`);
const ms = (value: number | null): string =>
  value == null ? 'unavailable' : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;

function latencyLabel(value: NonNullable<import('../readers/runs.js').ToolLatencyClass>): string {
  return value === 'browser-wait'
    ? 'mostly browser/network waits'
    : value === 'browser-action'
      ? 'mostly browser actions'
      : value === 'explicit-sleep'
        ? 'mostly deliberate sleeps'
        : value === 'shell'
          ? 'shell work'
          : 'mixed/unknown work';
}

function latencyNext(
  value: NonNullable<import('../readers/runs.js').ToolLatencyClass> | undefined,
  operations: number,
): string {
  if (value === 'browser-wait')
    return 'Inspect browser wait commands and prefer targeted element waits or bounded source endpoints before changing the shell tool.';
  if (value === 'explicit-sleep')
    return 'Replace fixed sleeps with readiness checks before attributing the drift to the shell integration.';
  return `Compare the midpoint with the ${operations} recorded operation(s) before attributing a cause.`;
}
