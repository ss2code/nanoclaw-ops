/**
 * Reflect's user-visible unit of work.
 *
 * Transcript parsers intentionally retain every prompt boundary. Provider skill
 * expansion and context compaction can therefore create several RunTurn phases
 * for one user request. Reflect coalesces only those known continuation phases;
 * the Runs UI keeps the original turns unchanged.
 */
import {
  classifyOutcome,
  type ExecutionRun,
  type RunArtifact,
  type RunMemoryOp,
  type RunModelCall,
  type RunOutboundAction,
  type RunToolCall,
  type RunTurn,
  type TurnOutcome,
  type TurnTrigger,
} from '../readers/runs.js';

export type ResponseEvidence = 'addressed' | 'action' | 'plain' | 'none';

export interface ReflectWorkflow {
  id: string;
  runId: string;
  groupId: string;
  turnIndexes: number[];
  startedAt: string;
  endedAt: string;
  trigger: TurnTrigger;
  tools: RunToolCall[];
  modelCalls: RunModelCall[];
  activeMs: number;
  errorCount: number;
  recoveredErrors: number;
  unresolvedErrors: number;
  recoveryCalls: number;
  recoveryMs: number;
  compactions: number;
  /** Append-only provider context edits observed during this workflow. */
  contextEdits: number;
  responsePreview: string | null;
  responseEvidence: ResponseEvidence;
  outMessages: { to: string; preview: string }[];
  outboundActions: RunOutboundAction[];
  artifacts: RunArtifact[];
  contextTokens: number | null;
  costUsd: number | null;
  totals: RunTurn['totals'];
  memoryOps: RunMemoryOp[];
  skillsInvoked: string[];
  outcome: TurnOutcome;
}

function isContinuation(turn: RunTurn): boolean {
  return turn.trigger.kind === 'compact-resume' || /^skill\s*:/i.test(turn.trigger.label);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function responseEvidence(
  outMessages: ReflectWorkflow['outMessages'],
  outboundActions: ReflectWorkflow['outboundActions'],
  preview: string | null,
): ResponseEvidence {
  if (outMessages.length) return 'addressed';
  if (outboundActions.length) return 'action';
  return preview ? 'plain' : 'none';
}

function recoveryStats(
  tools: RunToolCall[],
  answered: boolean,
): Pick<ReflectWorkflow, 'recoveredErrors' | 'unresolvedErrors' | 'recoveryCalls' | 'recoveryMs'> {
  let recoveredErrors = 0;
  let unresolvedErrors = 0;
  let recoveryCalls = 0;
  let recoveryMs = 0;

  for (let index = 0; index < tools.length; index += 1) {
    if (!tools[index].error) continue;
    const laterSuccess = answered ? tools.findIndex((call, later) => later > index && !call.error) : -1;
    if (laterSuccess < 0) {
      unresolvedErrors += 1;
      continue;
    }
    recoveredErrors += 1;
    recoveryCalls += laterSuccess - index;
    const failedAt = Date.parse(tools[index].ts);
    const recoveredAt = Date.parse(tools[laterSuccess].ts);
    if (Number.isFinite(failedAt) && Number.isFinite(recoveredAt) && recoveredAt >= failedAt) {
      recoveryMs += recoveredAt - failedAt;
    }
  }

  return { recoveredErrors, unresolvedErrors, recoveryCalls, recoveryMs };
}

function buildWorkflow(run: ExecutionRun, phases: RunTurn[]): ReflectWorkflow {
  const tools = phases.flatMap((turn) => turn.tools);
  const modelCalls = phases.flatMap((turn) => turn.modelCalls);
  const outMessages = phases.flatMap((turn) => turn.outMessages);
  const outboundActions = phases.flatMap((turn) => turn.outboundActions ?? []);
  const responsePreview = [...phases].reverse().find((turn) => Boolean(turn.responsePreview))?.responsePreview ?? null;
  const compactions = phases.reduce((sum, turn) => sum + turn.compactions, 0);
  const contextEdits = phases.reduce((sum, turn) => sum + (turn.contextEdits ?? 0), 0);
  const errorCount = phases.reduce((sum, turn) => sum + turn.errorCount, 0);
  const evidence = responseEvidence(outMessages, outboundActions, responsePreview);
  const recovery = recoveryStats(tools, evidence !== 'none');
  const priced = phases.filter((turn) => turn.costUsd != null);
  const costUsd = priced.length ? priced.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0) : null;
  const lastContext = [...phases].reverse().find((turn) => turn.contextTokens != null)?.contextTokens ?? null;
  const totals = phases.reduce<RunTurn['totals']>(
    (sum, turn) => ({
      inputTokens: sum.inputTokens + turn.totals.inputTokens,
      outputTokens: sum.outputTokens + turn.totals.outputTokens,
      cacheRead: sum.cacheRead + turn.totals.cacheRead,
      cacheCreate: sum.cacheCreate + turn.totals.cacheCreate,
      modelCalls: sum.modelCalls + turn.totals.modelCalls,
      toolCalls: sum.toolCalls + turn.totals.toolCalls,
    }),
    { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
  );
  const outcome = classifyOutcome({
    modelCalls,
    tools,
    outMessages,
    outboundActions,
    responsePreview,
    errorCount,
    compactions,
  });

  return {
    id: `${run.id}:${phases[0].index}`,
    runId: run.id,
    groupId: run.groupId,
    turnIndexes: phases.map((turn) => turn.index),
    startedAt: phases[0].startedAt,
    endedAt: phases.at(-1)?.endedAt ?? phases[0].endedAt,
    trigger: phases[0].trigger,
    tools,
    modelCalls,
    activeMs: phases.reduce((sum, turn) => sum + turn.activeMs, 0),
    errorCount,
    ...recovery,
    compactions,
    contextEdits,
    responsePreview,
    responseEvidence: evidence,
    outMessages,
    outboundActions,
    artifacts: phases.flatMap((turn) => turn.artifacts),
    contextTokens: lastContext,
    costUsd,
    totals,
    memoryOps: phases.flatMap((turn) => turn.memoryOps),
    skillsInvoked: unique(phases.flatMap((turn) => turn.skillsInvoked)).sort(),
    outcome,
  };
}

export function coalesceRunWorkflows(run: ExecutionRun): ReflectWorkflow[] {
  const workflows: ReflectWorkflow[] = [];
  let phases: RunTurn[] = [];

  const flush = () => {
    if (!phases.length) return;
    workflows.push(buildWorkflow(run, phases));
    phases = [];
  };

  for (const turn of run.turns) {
    if (phases.length && !isContinuation(turn)) flush();
    phases.push(turn);
  }
  flush();
  return workflows;
}

export function coalesceWorkflows(runs: ExecutionRun[]): ReflectWorkflow[] {
  return runs.flatMap(coalesceRunWorkflows).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
