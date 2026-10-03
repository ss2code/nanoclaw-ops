/**
 * Read-only evidence digest for NanoClaw's execution health.
 *
 * This module does arithmetic over sources the Ops Center already has. It does
 * not instrument the runtime, call a model, write a ledger, or change config.
 * Its output is intentionally bounded: fleet/group rollups and a small sample
 * of signal-relevant, expensive, or troubled workflows.
 */
import type Database from 'better-sqlite3';

import { listEventsByKind, listIncidents, listOperations } from '../opsdb.js';
import { getGroupConfig, listAgentGroups, type AgentGroupInfo } from '../readers/central.js';
import { listAvailableSkills, resolveGroupSkills, type SkillInfo } from '../readers/skills.js';
import {
  cacheHitRatio,
  classifyToolLatency,
  readExecutionRuns,
  redundantToolCalls,
  shortModelName,
  summarizeOutcomes,
  type ExecutionRun,
  type OutcomeCounts,
  type TurnOutcome,
  type ToolLatencyClass,
} from '../readers/runs.js';
import { readImprovementLedger, type ImprovementEntry } from './ledger.js';
import { coalesceWorkflows, type ReflectWorkflow } from './workflows.js';

const IN_FLIGHT_MS = 15 * 60_000;

export type SourceState = 'ok' | 'empty' | 'unavailable';

export interface EvidenceHealth {
  complete: boolean;
  groups: SourceState;
  runs: SourceState;
  settledTurns: SourceState;
  opsDb: SourceState;
  warnings: string[];
}

export interface TriggerBucket {
  kind: string;
  turns: number;
  costUsd: number;
  costPerTurn: number | null;
  outcomes: OutcomeCounts;
}

export interface SkillUsage {
  id: string;
  description: string;
  enabledForGroups: string[];
  invocations: number;
  troubledTurns: number;
  costUsd: number;
}

export interface ToolHealth {
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
  recoveredErrors: number;
  unresolvedErrors: number;
  unresolvedErrorRate: number;
  /** Calls after a failed call through the first later success, summed. */
  recoveryCalls: number;
  /** Wall time from failed call to first later success, when timestamps exist. */
  recoveryMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  priorP95Ms: number | null;
  recentP95Ms: number | null;
  /** Dominant wall-time shape; generic tool names such as Bash need this context. */
  latencyClass?: ToolLatencyClass;
}

export interface TurnExhibit {
  id: string;
  runId: string;
  groupId: string;
  turnIndexes: number[];
  /** First phase index, retained for old snapshot/UI readers. */
  turnIndex: number;
  startedAt: string;
  trigger: string;
  intent: string;
  outcome: TurnOutcome;
  costUsd: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreate: number };
  cacheHitRatio: number | null;
  toolCalls: number;
  errorCount: number;
  recoveredErrors: number;
  unresolvedErrors: number;
  compactions: number;
  contextEdits?: number;
  responseEvidence: ReflectWorkflow['responseEvidence'];
  skillsInvoked: string[];
  toolSequence: string[];
  focusTags: string[];
  redundant: { key: string; count: number }[];
  responsePreview: string | null;
}

export interface GroupDigest {
  groupId: string;
  name: string;
  provider: string | null;
  model: string | null;
  maxMessagesPerPrompt: number | null;
  outcomes: OutcomeCounts;
  pricedTurns: number;
  unpricedTurns: number;
  costUsd: number;
  costPerWorkingTurn: number | null;
  /**
   * Total working-workflow spend divided by clean successful workflows. Failed and
   * degraded attempts remain in the numerator because the user paid for them.
   */
  costPerSuccessfulResult: number | null;
  medianCacheHitRatio: number | null;
  compactionsPerWorkingTurn: number | null;
  /** Pi append-only context edits per working workflow; null when none are settled. */
  contextEditsPerWorkingWorkflow?: number | null;
  medianContextTokens: number | null;
  /** Positive, comparable context observations used by the digest. */
  contextObservations: number;
  contextDriftTokens: number | null;
  byTrigger: TriggerBucket[];
  modelMix: { model: string; turns: number; costUsd: number }[];
}

export interface FleetDigest {
  from: string;
  to: string;
  runs: number;
  outcomes: OutcomeCounts;
  pricedTurns: number;
  unpricedTurns: number;
  costUsd: number;
  costPerWorkingTurn: number | null;
  costPerSuccessfulResult: number | null;
  toolHealth: ToolHealth[];
  skills: SkillUsage[];
  dormantSkills: string[];
  events: { kind: string; severity: string; count: number }[];
  openIncidents: { title: string; severity: string; groupId: string | null; recommendation: string }[];
  recentOperations: { id: string; kind: string; scopeId: string | null; status: string; startedAt: string }[];
}

export interface EvidencePack {
  generatedAt: string;
  windowDays: number;
  scope: string;
  health: EvidenceHealth;
  fleet: FleetDigest;
  groups: GroupDigest[];
  exhibits: TurnExhibit[];
  improvements: ImprovementEntry[];
  packTokens: number;
}

export interface DigestOptions {
  windowDays?: number;
  groupId?: string;
  exhibitLimit?: number;
  now?: Date;
  sessionsRoot?: string;
  /** Why ops.db is absent, for the read-only CLI's health report. */
  opsDbUnavailableReason?: string;
}

interface WorkflowPair {
  run: ExecutionRun;
  workflow: ReflectWorkflow;
}

export interface ContextSample {
  runId: string;
  contextTokens: number | null;
}

export interface ContextDriftMeasurement {
  driftTokens: number | null;
  /** All positive observations available after parser-quality filtering. */
  observed: number;
  /** Observations in the longest comparable run/epoch. */
  comparable: number;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

const median = (values: number[]): number | null => percentile(values, 0.5);

const CONTEXT_RESET_RATIO = 0.6;
const MIN_CONTEXT_OBSERVATIONS = 8;

/**
 * Measure context growth without comparing separate sessions or fresh
 * continuations. A sharp drop is treated as a reset/compaction boundary; the
 * digest then reports only the longest sufficiently populated epoch.
 */
export function measureContextDrift(samples: ContextSample[]): ContextDriftMeasurement {
  const byRun = new Map<string, number[]>();
  let observed = 0;
  for (const sample of samples) {
    const value = sample.contextTokens;
    if (value == null || !Number.isFinite(value) || value <= 0) continue;
    observed += 1;
    const values = byRun.get(sample.runId) ?? [];
    values.push(value);
    byRun.set(sample.runId, values);
  }

  const epochs: number[][] = [];
  for (const values of byRun.values()) {
    let epoch: number[] = [];
    for (const value of values) {
      const previous = epoch.at(-1);
      if (previous != null && value <= previous * CONTEXT_RESET_RATIO) {
        epochs.push(epoch);
        epoch = [];
      }
      epoch.push(value);
    }
    if (epoch.length) epochs.push(epoch);
  }

  const comparable = epochs
    .filter((epoch) => epoch.length >= MIN_CONTEXT_OBSERVATIONS)
    .sort((a, b) => b.length - a.length)[0];
  if (!comparable) return { driftTokens: null, observed, comparable: 0 };

  const quarter = Math.floor(comparable.length / 4);
  const driftTokens =
    quarter >= 2 ? (median(comparable.slice(-quarter)) ?? 0) - (median(comparable.slice(0, quarter)) ?? 0) : null;
  return { driftTokens, observed, comparable: comparable.length };
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? '').length / 4);
}

function settledWindowWorkflows(runs: ExecutionRun[], fromMs: number, nowMs: number): WorkflowPair[] {
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const pairs: WorkflowPair[] = [];
  for (const workflow of coalesceWorkflows(runs)) {
    const started = Date.parse(workflow.startedAt);
    const ended = Date.parse(workflow.endedAt);
    if (!Number.isFinite(started) || started < fromMs) continue;
    if (!Number.isFinite(ended) || nowMs - ended < IN_FLIGHT_MS) continue;
    const run = byRun.get(workflow.runId);
    if (run) pairs.push({ run, workflow });
  }
  return pairs.sort((a, b) => a.workflow.startedAt.localeCompare(b.workflow.startedAt));
}

function digestGroup(group: AgentGroupInfo, pairs: WorkflowPair[]): GroupDigest {
  const turns = pairs.map((p) => p.workflow);
  const outcomes = summarizeOutcomes(turns);
  const working = turns.filter((t) => t.outcome !== 'idle');
  const priced = working.filter((t) => t.costUsd != null);
  const costUsd = priced.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
  const ratios = working.map((turn) => cacheHitRatio(turn.totals)).filter((v): v is number => v != null);
  const contextMeasurement = measureContextDrift(
    pairs.map(({ run, workflow }) => ({ runId: run.id, contextTokens: workflow.contextTokens })),
  );
  const contexts = working
    .map((turn) => turn.contextTokens)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);

  const triggerMap = new Map<string, ReflectWorkflow[]>();
  for (const turn of turns) {
    const list = triggerMap.get(turn.trigger.kind) ?? [];
    list.push(turn);
    triggerMap.set(turn.trigger.kind, list);
  }
  const byTrigger: TriggerBucket[] = [...triggerMap.entries()]
    .map(([kind, list]) => {
      const counts = summarizeOutcomes(list);
      const pricedList = list.filter((turn) => turn.costUsd != null);
      const cost = pricedList.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
      return {
        kind,
        turns: list.length,
        costUsd: round(cost, 4),
        costPerTurn: pricedList.length ? round(cost / pricedList.length, 4) : null,
        outcomes: counts,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  const models = new Map<string, { turns: number; costUsd: number }>();
  for (const turn of working) {
    const model = shortModelName(turn.modelCalls[0]?.model ?? 'unknown');
    const entry = models.get(model) ?? { turns: 0, costUsd: 0 };
    entry.turns += 1;
    entry.costUsd += turn.costUsd ?? 0;
    models.set(model, entry);
  }

  let maxMessagesPerPrompt: number | null = null;
  try {
    maxMessagesPerPrompt = getGroupConfig(group.id)?.max_messages_per_prompt ?? null;
  } catch {
    // Config is useful context, not required to compute execution metrics.
  }

  return {
    groupId: group.id,
    name: group.name,
    provider: group.provider,
    model: group.model,
    maxMessagesPerPrompt,
    outcomes,
    pricedTurns: priced.length,
    unpricedTurns: working.length - priced.length,
    costUsd: round(costUsd, 4),
    costPerWorkingTurn: priced.length ? round(costUsd / priced.length, 4) : null,
    costPerSuccessfulResult: outcomes.ok && priced.length === working.length ? round(costUsd / outcomes.ok, 4) : null,
    medianCacheHitRatio: ratios.length ? round(median(ratios) ?? 0, 3) : null,
    compactionsPerWorkingTurn: outcomes.working
      ? round(working.reduce((sum, turn) => sum + turn.compactions, 0) / outcomes.working, 3)
      : null,
    contextEditsPerWorkingWorkflow: outcomes.working
      ? round(working.reduce((sum, turn) => sum + turn.contextEdits, 0) / outcomes.working, 3)
      : null,
    medianContextTokens: contexts.length ? Math.round(median(contexts) ?? 0) : null,
    contextObservations: contextMeasurement.comparable,
    contextDriftTokens: contextMeasurement.driftTokens == null ? null : Math.round(contextMeasurement.driftTokens),
    byTrigger,
    modelMix: [...models.entries()]
      .map(([model, value]) => ({ model, turns: value.turns, costUsd: round(value.costUsd, 4) }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

function digestSkills(pairs: WorkflowPair[], groups: AgentGroupInfo[], available: SkillInfo[]): SkillUsage[] {
  const enabledBy = new Map<string, string[]>();
  for (const group of groups) {
    try {
      const resolved = resolveGroupSkills(getGroupConfig(group.id)?.skills ?? null, available);
      for (const id of resolved.enabledIds) {
        enabledBy.set(id, [...(enabledBy.get(id) ?? []), group.name]);
      }
    } catch {
      // A missing group config does not invalidate observed invocations.
    }
  }

  const usage = new Map<string, { invocations: number; troubled: number; cost: number }>();
  for (const { workflow } of pairs) {
    for (const id of workflow.skillsInvoked) {
      const entry = usage.get(id) ?? { invocations: 0, troubled: 0, cost: 0 };
      entry.invocations += 1;
      if (workflow.outcome === 'degraded' || workflow.outcome === 'failed') entry.troubled += 1;
      entry.cost += workflow.costUsd ?? 0;
      usage.set(id, entry);
    }
  }

  const ids = new Set([...available.map((skill) => skill.id), ...usage.keys()]);
  return [...ids]
    .map((id) => {
      const info = available.find((skill) => skill.id === id);
      const observed = usage.get(id) ?? { invocations: 0, troubled: 0, cost: 0 };
      return {
        id,
        description: info?.description ?? '',
        enabledForGroups: enabledBy.get(id) ?? [],
        invocations: observed.invocations,
        troubledTurns: observed.troubled,
        costUsd: round(observed.cost, 4),
      };
    })
    .sort((a, b) => b.invocations - a.invocations || a.id.localeCompare(b.id));
}

function digestToolHealth(pairs: WorkflowPair[], midpointMs: number): ToolHealth[] {
  const acc = new Map<
    string,
    {
      calls: number;
      errors: number;
      recovered: number;
      unresolved: number;
      recoveryCalls: number;
      recoveryMs: number;
      all: number[];
      prior: number[];
      recent: number[];
      latencyMs: Map<ToolLatencyClass, number>;
    }
  >();
  for (const { workflow } of pairs) {
    for (let index = 0; index < workflow.tools.length; index += 1) {
      const call = workflow.tools[index];
      const entry = acc.get(call.name) ?? {
        calls: 0,
        errors: 0,
        recovered: 0,
        unresolved: 0,
        recoveryCalls: 0,
        recoveryMs: 0,
        all: [],
        prior: [],
        recent: [],
        latencyMs: new Map<ToolLatencyClass, number>(),
      };
      entry.calls += 1;
      if (call.error) {
        entry.errors += 1;
        const laterSuccess =
          workflow.responseEvidence === 'none'
            ? -1
            : workflow.tools.findIndex((candidate, later) => later > index && !candidate.error);
        if (laterSuccess < 0) {
          entry.unresolved += 1;
        } else {
          entry.recovered += 1;
          entry.recoveryCalls += laterSuccess - index;
          const failedAt = Date.parse(call.ts);
          const recoveredAt = Date.parse(workflow.tools[laterSuccess].ts);
          if (Number.isFinite(failedAt) && Number.isFinite(recoveredAt) && recoveredAt >= failedAt) {
            entry.recoveryMs += recoveredAt - failedAt;
          }
        }
      }
      if (call.durationMs != null && call.durationMs >= 0) {
        entry.all.push(call.durationMs);
        const latencyClass = classifyToolLatency(call);
        entry.latencyMs.set(latencyClass, (entry.latencyMs.get(latencyClass) ?? 0) + call.durationMs);
        const timestamp = Date.parse(call.ts);
        (Number.isFinite(timestamp) && timestamp >= midpointMs ? entry.recent : entry.prior).push(call.durationMs);
      }
      acc.set(call.name, entry);
    }
  }
  return [...acc.entries()]
    .map(([name, value]) => ({
      name,
      calls: value.calls,
      errors: value.errors,
      errorRate: value.calls ? round(value.errors / value.calls, 3) : 0,
      recoveredErrors: value.recovered,
      unresolvedErrors: value.unresolved,
      unresolvedErrorRate: value.calls ? round(value.unresolved / value.calls, 3) : 0,
      recoveryCalls: value.recoveryCalls,
      recoveryMs: value.recoveryMs,
      p50Ms: percentile(value.all, 0.5),
      p95Ms: percentile(value.all, 0.95),
      priorP95Ms: value.prior.length >= 5 ? percentile(value.prior, 0.95) : null,
      recentP95Ms: value.recent.length >= 5 ? percentile(value.recent, 0.95) : null,
      latencyClass: [...value.latencyMs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
    }))
    .sort((a, b) => b.errors - a.errors || b.calls - a.calls);
}

export function pickExhibits(pairs: WorkflowPair[], limit: number): TurnExhibit[] {
  const penalty: Record<TurnOutcome, number> = { failed: 3, degraded: 1.6, ok: 1, idle: 0 };
  if (limit <= 0) return [];
  const candidates = pairs
    .filter(({ workflow }) => workflow.outcome !== 'idle')
    .map((pair) => ({
      ...pair,
      score:
        (pair.workflow.costUsd ??
          (pair.workflow.totals.inputTokens + pair.workflow.totals.outputTokens + pair.workflow.totals.cacheRead) /
            1e6) * penalty[pair.workflow.outcome],
    }))
    .sort((a, b) => b.score - a.score);
  const selected: typeof candidates = [];
  const seen = new Set<string>();
  const add = (candidate: (typeof candidates)[number] | undefined) => {
    if (!candidate || seen.has(candidate.workflow.id) || selected.length >= limit) return;
    selected.push(candidate);
    seen.add(candidate.workflow.id);
  };

  // Reserve one failed workflow per affected group before global cost ranking.
  // Otherwise a cheap but high-severity group failure can disappear from the
  // bounded fleet sample and its signal has no inspectable evidence.
  for (const groupId of [
    ...new Set(candidates.filter(({ workflow }) => workflow.outcome === 'failed').map(({ run }) => run.groupId)),
  ]) {
    add(candidates.find(({ run, workflow }) => run.groupId === groupId && workflow.outcome === 'failed'));
  }

  const errorTools = [
    ...new Set(
      candidates.flatMap(({ workflow }) => workflow.tools.filter((tool) => tool.error).map((tool) => tool.name)),
    ),
  ];
  for (const toolName of errorTools.slice(0, 5)) {
    add(candidates.find(({ workflow }) => workflow.tools.some((tool) => tool.name === toolName && tool.error)));
  }
  const troubledSkills = [
    ...new Set(
      candidates.flatMap(({ workflow }) =>
        workflow.outcome === 'degraded' || workflow.outcome === 'failed' ? workflow.skillsInvoked : [],
      ),
    ),
  ];
  for (const skillId of troubledSkills.slice(0, 3)) {
    add(candidates.find(({ workflow }) => workflow.skillsInvoked.includes(skillId)));
  }
  for (const candidate of candidates) add(candidate);

  return selected.map(({ run, workflow }) => ({
    id: workflow.id,
    runId: run.id,
    groupId: run.groupId,
    turnIndexes: workflow.turnIndexes,
    turnIndex: workflow.turnIndexes[0],
    startedAt: workflow.startedAt,
    trigger: `${workflow.trigger.kind}/${workflow.trigger.label}`,
    intent: workflow.trigger.intent.slice(0, 240),
    outcome: workflow.outcome,
    costUsd: workflow.costUsd == null ? null : round(workflow.costUsd, 4),
    tokens: {
      input: workflow.totals.inputTokens,
      output: workflow.totals.outputTokens,
      cacheRead: workflow.totals.cacheRead,
      cacheCreate: workflow.totals.cacheCreate,
    },
    cacheHitRatio: nullableRound(cacheHitRatio(workflow.totals), 3),
    toolCalls: workflow.tools.length,
    errorCount: workflow.errorCount,
    recoveredErrors: workflow.recoveredErrors,
    unresolvedErrors: workflow.unresolvedErrors,
    compactions: workflow.compactions,
    contextEdits: workflow.contextEdits,
    responseEvidence: workflow.responseEvidence,
    skillsInvoked: [...workflow.skillsInvoked],
    toolSequence: workflow.tools.slice(0, 30).map((tool) => (tool.error ? `${tool.name}!` : tool.name)),
    focusTags: [
      `group:${workflow.groupId}`,
      `outcome:${workflow.outcome}`,
      ...workflow.skillsInvoked.map((id) => `skill:${id}`),
      ...unique(workflow.tools.map((tool) => `tool:${tool.name}`)),
    ],
    redundant: redundantToolCalls(workflow).slice(0, 5),
    responsePreview: workflow.responsePreview?.slice(0, 200) ?? null,
  }));
}

export function buildEvidencePack(opsDb: Database.Database | null, opts: DigestOptions = {}): EvidencePack {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 7;
  const nowMs = now.getTime();
  const fromMs = nowMs - windowDays * 86_400_000;
  const fromIso = new Date(fromMs).toISOString();
  const midpointMs = fromMs + (nowMs - fromMs) / 2;
  const warnings: string[] = [];

  let groups: AgentGroupInfo[] = [];
  let groupState: SourceState = 'unavailable';
  try {
    groups = listAgentGroups().filter((group) => !opts.groupId || group.id === opts.groupId);
    groupState = groups.length ? 'ok' : 'empty';
    if (!groups.length)
      warnings.push(opts.groupId ? `No agent group found for ${opts.groupId}.` : 'No agent groups found.');
  } catch (error) {
    warnings.push(`Central group data unavailable: ${message(error)}.`);
  }

  let runs: ExecutionRun[] = [];
  let runState: SourceState = 'unavailable';
  try {
    runs = readExecutionRuns({ limit: Infinity, groupId: opts.groupId, sessionsRoot: opts.sessionsRoot });
    runState = runs.length ? 'ok' : 'empty';
    if (!runs.length) warnings.push('No execution runs were readable in scope.');
  } catch (error) {
    warnings.push(`Execution runs unavailable: ${message(error)}.`);
  }

  const pairs = settledWindowWorkflows(runs, fromMs, nowMs);
  const settledState: SourceState = pairs.length ? 'ok' : 'empty';
  if (!pairs.length) warnings.push(`No settled workflows were found in the last ${windowDays} day(s).`);

  let available: SkillInfo[] = [];
  try {
    available = listAvailableSkills();
  } catch (error) {
    warnings.push(`Skill catalog unavailable: ${message(error)}.`);
  }
  const improvementHistory = readImprovementLedger();
  warnings.push(...improvementHistory.warnings);

  const groupDigests = groups
    .map((group) =>
      digestGroup(
        group,
        pairs.filter((pair) => pair.run.groupId === group.id),
      ),
    )
    .filter((group) => group.outcomes.working > 0)
    .sort((a, b) => b.costUsd - a.costUsd);

  const outcomes = summarizeOutcomes(pairs.map((pair) => pair.workflow));
  const working = pairs.map((pair) => pair.workflow).filter((workflow) => workflow.outcome !== 'idle');
  const priced = working.filter((turn) => turn.costUsd != null);
  const costUsd = priced.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
  if (working.length > priced.length) {
    warnings.push(`${working.length - priced.length} working workflow(s) had no price; cost ratios omit them.`);
  }

  let opsState: SourceState = opsDb ? 'ok' : 'unavailable';
  const eventCounts = new Map<string, { severity: string; count: number }>();
  let openIncidents: FleetDigest['openIncidents'] = [];
  let recentOperations: FleetDigest['recentOperations'] = [];
  if (!opsDb) {
    warnings.push(opts.opsDbUnavailableReason ?? 'ops.db is unavailable; operational signals are omitted.');
  } else {
    try {
      const eventKinds = ['rate_limit', 'container_kill', 'docker_autostart_failed', 'alert_sent'];
      for (const group of [...groups.map((item) => item.id), 'all', 'host']) {
        for (const row of listEventsByKind(opsDb, group, eventKinds, fromIso)) {
          const key = `${row.kind}|${row.severity}`;
          const entry = eventCounts.get(key) ?? { severity: row.severity, count: 0 };
          entry.count += 1;
          eventCounts.set(key, entry);
        }
      }
      openIncidents = listIncidents(opsDb, 'open', 25).map((incident) => ({
        title: incident.title,
        severity: incident.severity,
        groupId: incident.group_id,
        recommendation: incident.recommendation,
      }));
      recentOperations = listOperations(opsDb, 40)
        .filter((operation) => operation.started_at >= fromIso)
        .map((operation) => ({
          id: operation.id,
          kind: operation.kind,
          scopeId: operation.scope_id,
          status: operation.status,
          startedAt: operation.started_at,
        }));
    } catch (error) {
      opsState = 'unavailable';
      warnings.push(`ops.db could not be queried: ${message(error)}.`);
    }
  }

  const skills = digestSkills(pairs, groups, available);
  const fleet: FleetDigest = {
    from: fromIso,
    to: now.toISOString(),
    runs: new Set(pairs.map((pair) => pair.run.id)).size,
    outcomes,
    pricedTurns: priced.length,
    unpricedTurns: working.length - priced.length,
    costUsd: round(costUsd, 4),
    costPerWorkingTurn: priced.length ? round(costUsd / priced.length, 4) : null,
    costPerSuccessfulResult: outcomes.ok && priced.length === working.length ? round(costUsd / outcomes.ok, 4) : null,
    toolHealth: digestToolHealth(pairs, midpointMs).slice(0, 25),
    skills,
    dormantSkills: skills
      .filter((skill) => skill.enabledForGroups.length > 0 && skill.invocations === 0)
      .map((skill) => skill.id),
    events: [...eventCounts.entries()].map(([key, value]) => ({
      kind: key.split('|')[0],
      severity: value.severity,
      count: value.count,
    })),
    openIncidents,
    recentOperations,
  };

  const health: EvidenceHealth = {
    complete: groupState === 'ok' && runState === 'ok' && settledState === 'ok' && opsState === 'ok',
    groups: groupState,
    runs: runState,
    settledTurns: settledState,
    opsDb: opsState,
    warnings,
  };
  const pack: EvidencePack = {
    generatedAt: now.toISOString(),
    windowDays,
    scope: opts.groupId ?? 'fleet',
    health,
    fleet,
    groups: groupDigests,
    exhibits: pickExhibits(pairs, opts.exhibitLimit ?? 12),
    improvements: improvementHistory.entries,
    packTokens: 0,
  };
  pack.packTokens = estimateTokens(pack);
  return pack;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nullableRound(value: number | null, digits: number): number | null {
  return value == null ? null : round(value, digits);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
