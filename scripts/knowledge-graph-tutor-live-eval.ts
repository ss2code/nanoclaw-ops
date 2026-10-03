/** Serialized live/provider UAT for six representative tutor personas. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { parseUsageLines } from '../ops-center/readers/tokens.js';
import { parseTutorConfig, type KnowledgeGraphTutorConfig } from '../templates/education/knowledge-graph-tutor/host/admin.js';
import { sendAndWait, type Actor, type TurnResult } from './knowledge-graph-tutor-uat.js';

interface LivePersona {
  id: string;
  studentIndex: number;
  outcomes: Array<'correct' | 'partial' | 'hinted' | 'incorrect'>;
}

interface StudentStateCounts {
  attempts: number;
  decisions: number;
  active_misconceptions: number;
  applied_commands: number;
  traces: number;
  blank_evidence: number;
  attempt_keys: string[];
}

type Quality = Record<string, number>;
type ScoredTurn = TurnResult & { persona: string; quality: Quality };
export type CheckpointMode = 'never' | 'on-quality' | 'each-persona';

export interface LiveEvalOptions {
  configPath: string;
  runId: string;
  resume: boolean;
  checkpoint: CheckpointMode;
  qualityThreshold: number;
}

interface ModelObservation {
  main_calls: number;
  main_models: Record<string, number>;
  subagent_calls: number;
  subagent_models: Record<string, number>;
}

interface ModelContract extends ModelObservation {
  configured_model: string;
  database_model: string | null;
  materialized_model: string | null;
  provider: string;
  match: boolean;
}

interface LaneModelObservation extends ModelObservation {
  persona: string;
}

interface AccumulatedRun {
  turns: ScoredTurn[];
  laneStops: Array<{ persona: string; containers_stopped: number }>;
  states: Array<{ persona: string; counts: StudentStateCounts }>;
  failures: string[];
  models: ModelObservation;
  laneModels: LaneModelObservation[];
}

interface LiveCheckpoint {
  schema: 2;
  run_id: string;
  created_at: string;
  status: 'attention_required';
  checkpoint_index: number;
  next_persona_index: number;
  reason: string;
  question: string;
  choices: Array<{ action: string; effect: string }>;
  configured_model: string;
  checkpoint_mode: CheckpointMode;
  quality_threshold: number;
  lane_quality: number;
  accumulated: AccumulatedRun;
}

const PERSONAS: LivePersona[] = [
  { id: 'systematic_novice', studentIndex: 0, outcomes: ['correct', 'correct', 'correct', 'correct', 'correct', 'correct', 'correct'] },
  { id: 'persistent_misconception', studentIndex: 1, outcomes: ['incorrect', 'incorrect', 'partial', 'correct', 'correct', 'correct', 'correct'] },
  { id: 'advanced', studentIndex: 2, outcomes: ['correct', 'correct', 'correct', 'correct', 'correct', 'correct', 'correct'] },
  { id: 'hint_dependent', studentIndex: 3, outcomes: ['hinted', 'partial', 'hinted', 'correct', 'partial', 'correct', 'correct'] },
  { id: 'uneven', studentIndex: 5, outcomes: ['correct', 'partial', 'correct', 'incorrect', 'correct', 'correct', 'partial'] },
  { id: 'visual_accessibility', studentIndex: 6, outcomes: ['correct', 'correct', 'partial', 'correct', 'correct', 'correct', 'correct'] },
];

const EMPTY_MODELS = (): ModelObservation => ({ main_calls: 0, main_models: {}, subagent_calls: 0, subagent_models: {} });

export function parseLiveEvalArgs(argv: string[]): LiveEvalOptions {
  const positional: string[] = [];
  let resume = false;
  let checkpoint: CheckpointMode = 'on-quality';
  let qualityThreshold = 1.7;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--resume') resume = true;
    else if (arg === '--checkpoint') {
      const value = argv[++index] as CheckpointMode | undefined;
      if (!value || !['never', 'on-quality', 'each-persona'].includes(value)) {
        throw new Error('--checkpoint must be never, on-quality, or each-persona');
      }
      checkpoint = value;
    } else if (arg === '--quality-threshold') {
      qualityThreshold = Number(argv[++index]);
      if (!Number.isFinite(qualityThreshold) || qualityThreshold < 0 || qualityThreshold > 2) {
        throw new Error('--quality-threshold must be a number from 0 to 2');
      }
    } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (!positional[0]) {
    throw new Error('usage: knowledge-graph-tutor-live-eval <eight-persona-config.json> [run-id] [--checkpoint never|on-quality|each-persona] [--quality-threshold 1.7] [--resume]');
  }
  if (positional.length > 2) throw new Error(`unexpected positional argument ${positional[2]}`);
  return { configPath: positional[0], runId: positional[1] ?? `live-${Date.now()}`, resume, checkpoint, qualityThreshold };
}

export function shouldPauseForReview(mode: CheckpointMode, laneQuality: number, threshold: number, hasMore: boolean): boolean {
  if (!hasMore || mode === 'never') return false;
  return mode === 'each-persona' || laneQuality < threshold;
}

export function modelContractMatches(configuredModel: string, observation: ModelObservation): boolean {
  const observed = Object.keys(observation.main_models);
  return observation.main_calls > 0 && observed.length === 1 && observed[0] === configuredModel;
}

function answer(outcome: LivePersona['outcomes'][number], persona: string, turn: number): string {
  if (outcome === 'correct') return `Simulated ${persona} answer ${turn}: 42 is greater than 24 because 4 tens are greater than 2 tens; I compared the highest place independently before the ones.`;
  if (outcome === 'partial') return `Simulated ${persona} answer ${turn}: 42 is greater than 24 and I compared the tens first, but I cannot yet explain why the ones cannot reverse that result.`;
  if (outcome === 'hinted') return `Simulated ${persona} answer ${turn}: After your hint to compare tens first, I got 42 > 24 because 4 tens are greater than 2; I needed that hint.`;
  return `Simulated ${persona} answer ${turn}: I think 24 is greater than 42 because the 4 in the ones place is bigger than 2.`;
}

function scoreReply(reply: string, persona: string): Quality {
  const lower = reply.toLowerCase();
  return {
    correctness: reply.trim().length >= 40 ? 2 : 0,
    grounding: /source|revision|concept|course|according|graph/.test(lower) ? 2 : 1,
    learner_appropriateness: reply.length <= 4000 ? 2 : 1,
    pedagogy_fit: persona === 'persistent_misconception'
      ? (/error|misconception|why|compare|step/.test(lower) ? 2 : 1)
      : persona === 'visual_accessibility'
        ? (/visual|diagram|graph|step/.test(lower) ? 2 : 1)
        : /question|try|explain|example|review|practice/.test(lower) ? 2 : 1,
    scaffold_quality: !/the answer is[: ]/i.test(reply) ? 2 : 1,
    next_action_clarity: /\?|next|try|explain|show/.test(lower) ? 2 : 1,
    accessibility: !/[│┌┐└┘]{3,}/.test(reply) ? 2 : 1,
  };
}

function averageQuality(turns: ScoredTurn[]): number {
  const values = turns.flatMap((turn) => Object.values(turn.quality));
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function groupAction(groupId: string, action: 'pause' | 'run'): { containersStopped: number; wakesRequested: number } {
  const output = execFileSync(path.join(process.cwd(), 'bin/ncl'), ['groups', action, '--id', groupId, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(output) as {
    ok?: boolean;
    data?: { containersStopped?: number; wakesRequested?: number };
    containersStopped?: number;
    wakesRequested?: number;
  };
  if (parsed.ok === false) throw new Error(`ncl groups ${action} failed: ${output}`);
  return {
    containersStopped: parsed.data?.containersStopped ?? parsed.containersStopped ?? 0,
    wakesRequested: parsed.data?.wakesRequested ?? parsed.wakesRequested ?? 0,
  };
}

async function pauseUntilQuiet(groupId: string): Promise<number> {
  let observed = groupAction(groupId, 'pause').containersStopped;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const remaining = groupAction(groupId, 'pause').containersStopped;
    observed = Math.max(observed, remaining);
    if (remaining === 0) return observed;
  }
  throw new Error(`agent group ${groupId} did not quiesce within 10 seconds`);
}

function stateCounts(root: string, displayName: string): StudentStateCounts {
  const classDb = new Database(path.join(root, 'class.db'), { readonly: true, fileMustExist: true });
  const student = classDb.prepare('SELECT id FROM students WHERE display_name=?').get(displayName) as { id: string };
  classDb.close();
  const db = new Database(path.join(root, 'students', student.id, 'student.db'), { readonly: true, fileMustExist: true });
  try {
    return {
      attempts: (db.prepare('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number }).n,
      decisions: (db.prepare('SELECT COUNT(*) AS n FROM teaching_decisions').get() as { n: number }).n,
      active_misconceptions: (db.prepare("SELECT COUNT(*) AS n FROM misconceptions WHERE status!='resolved'").get() as { n: number }).n,
      applied_commands: (db.prepare('SELECT COUNT(*) AS n FROM applied_commands').get() as { n: number }).n,
      traces: (db.prepare('SELECT COUNT(*) AS n FROM learning_traces').get() as { n: number }).n,
      blank_evidence: (db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE trim(evidence)='' ").get() as { n: number }).n,
      attempt_keys: (db.prepare('SELECT idempotency_key FROM learning_events ORDER BY at,id').all() as Array<{ idempotency_key: string }>).map((row) => row.idempotency_key),
    };
  } finally { db.close(); }
}

function transcriptFiles(groupId: string): Array<{ file: string; lane: 'main' | 'subagent' }> {
  const root = path.join(DATA_DIR, 'v2-sessions', groupId, '.claude-shared', 'projects');
  const files: Array<{ file: string; lane: 'main' | 'subagent' }> = [];
  if (!fs.existsSync(root)) return files;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ file, lane: file.includes(`${path.sep}subagents${path.sep}`) ? 'subagent' : 'main' });
      }
    }
  };
  walk(root);
  return files;
}

function captureTranscriptOffsets(groupId: string): Record<string, number> {
  return Object.fromEntries(transcriptFiles(groupId).map(({ file }) => [file, fs.statSync(file).size]));
}

function observeTranscriptDelta(groupId: string, before: Record<string, number>): ModelObservation {
  const observed = EMPTY_MODELS();
  for (const { file, lane } of transcriptFiles(groupId)) {
    const size = fs.statSync(file).size;
    const offset = Math.min(before[file] ?? 0, size);
    if (size <= offset) continue;
    const fd = fs.openSync(file, 'r');
    let text = '';
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
    for (const usage of parseUsageLines(text)) {
      const models = lane === 'main' ? observed.main_models : observed.subagent_models;
      models[usage.model] = (models[usage.model] ?? 0) + 1;
      if (lane === 'main') observed.main_calls += 1;
      else observed.subagent_calls += 1;
    }
  }
  return observed;
}

function mergeModels(target: ModelObservation, source: ModelObservation): void {
  target.main_calls += source.main_calls;
  target.subagent_calls += source.subagent_calls;
  for (const [model, calls] of Object.entries(source.main_models)) target.main_models[model] = (target.main_models[model] ?? 0) + calls;
  for (const [model, calls] of Object.entries(source.subagent_models)) target.subagent_models[model] = (target.subagent_models[model] ?? 0) + calls;
}

function preflightModelContract(config: KnowledgeGraphTutorConfig): Omit<ModelContract, keyof ModelObservation | 'match'> {
  if (!config.model) throw new Error('serialized live eval requires an explicit pinned config.model; provider defaults are forbidden');
  const central = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
  const row = central.prepare(`SELECT g.folder,g.agent_provider,c.provider,c.model,c.model_tiers
    FROM agent_groups g JOIN container_configs c ON c.agent_group_id=g.id WHERE g.id=?`).get(config.id) as {
      folder: string; agent_provider: string | null; provider: string | null; model: string | null; model_tiers: string | null;
    } | undefined;
  central.close();
  if (!row) throw new Error(`agent group or container config not found: ${config.id}`);
  const provider = (row.provider || row.agent_provider || 'claude').toLowerCase();
  if (provider !== 'claude') throw new Error(`serialized model attestation currently requires provider=claude; observed ${provider}`);
  const tiers = row.model_tiers ? JSON.parse(row.model_tiers) as Record<string, string> : null;
  const databaseModel = tiers ? tiers[tiers.default] ?? null : row.model;
  const materializedPath = path.join(GROUPS_DIR, row.folder, 'container.json');
  if (!fs.existsSync(materializedPath)) throw new Error(`materialized container config missing: ${materializedPath}`);
  const materialized = JSON.parse(fs.readFileSync(materializedPath, 'utf8')) as { model?: unknown };
  const materializedModel = typeof materialized.model === 'string' ? materialized.model : null;
  if (databaseModel !== config.model || materializedModel !== config.model) {
    throw new Error(`model preflight mismatch: requested=${config.model} database=${databaseModel ?? '<unset>'} materialized=${materializedModel ?? '<unset>'}; re-apply the config and restart before spending provider tokens`);
  }
  return { configured_model: config.model, database_model: databaseModel, materialized_model: materializedModel, provider };
}

function latestCheckpoint(dir: string): LiveCheckpoint | null {
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((name) => /^checkpoint-\d+\.json$/.test(name)).sort();
  if (!names.length) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1]), 'utf8')) as LiveCheckpoint;
}

function writeCheckpoint(
  dir: string,
  options: LiveEvalOptions,
  configuredModel: string,
  nextPersonaIndex: number,
  laneQuality: number,
  accumulated: AccumulatedRun,
): { file: string; checkpoint: LiveCheckpoint } {
  const checkpointIndex = nextPersonaIndex;
  const reason = options.checkpoint === 'each-persona'
    ? 'Human review was requested after every persona.'
    : `Lane quality ${laneQuality.toFixed(3)} is below the ${options.qualityThreshold.toFixed(3)} review threshold.`;
  const checkpoint: LiveCheckpoint = {
    schema: 2,
    run_id: options.runId,
    created_at: new Date().toISOString(),
    status: 'attention_required',
    checkpoint_index: checkpointIndex,
    next_persona_index: nextPersonaIndex,
    reason,
    question: `Continue the comparable run on ${accumulated.models.main_calls ? Object.keys(accumulated.models.main_models).join(', ') : 'the configured low-cost model'}, or start a separate comparison run with a stronger model for skill tuning?`,
    choices: [
      { action: 'continue', effect: `Run the same command with --resume; the configured model must remain unchanged.` },
      { action: 'pause', effect: 'Do nothing. The tutor group is quiescent and this immutable checkpoint remains resumable.' },
      { action: 'stronger-model', effect: 'Use a new run ID and separately instantiated state; mixed-model continuation is rejected.' },
    ],
    configured_model: configuredModel,
    checkpoint_mode: options.checkpoint,
    quality_threshold: options.qualityThreshold,
    lane_quality: laneQuality,
    accumulated,
  };
  const file = path.join(dir, `checkpoint-${String(checkpointIndex).padStart(2, '0')}.json`);
  fs.writeFileSync(file, JSON.stringify(checkpoint, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, checkpoint };
}

async function main(): Promise<void> {
  const options = parseLiveEvalArgs(process.argv.slice(2));
  const parsed = parseTutorConfig(JSON.parse(fs.readFileSync(options.configPath, 'utf8')));
  if (!parsed.config) throw new Error(parsed.errors.join('\n'));
  const config: KnowledgeGraphTutorConfig = parsed.config;
  if (config.students.length < 8) throw new Error('serialized live eval requires the eight-persona synthetic config');
  if (!config.model) throw new Error('serialized live eval requires explicit config.model; use pinned Haiku for tuning runs');

  const preflight = preflightModelContract(config);
  const central = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
  const group = central.prepare('SELECT folder FROM agent_groups WHERE id=?').get(config.id) as { folder: string } | undefined;
  central.close();
  if (!group) throw new Error(`agent group not found: ${config.id}`);
  const root = path.join(GROUPS_DIR, group.folder, 'tutor-app');
  const dir = path.join('logs', 'knowledge-graph-tutor-evals', options.runId);
  const finalFile = path.join(dir, 'live-provider.json');
  if (!options.resume && fs.existsSync(dir)) throw new Error(`run directory already exists: ${dir}; use a new run ID or --resume`);
  if (options.resume && fs.existsSync(finalFile)) throw new Error(`run ${options.runId} already has a final receipt and cannot resume`);
  fs.mkdirSync(dir, { recursive: true });

  const prior = options.resume ? latestCheckpoint(dir) : null;
  if (options.resume && !prior) throw new Error(`--resume requested but no checkpoint exists under ${dir}`);
  if (prior?.configured_model && prior.configured_model !== config.model) {
    throw new Error(`refusing mixed-model resume: checkpoint=${prior.configured_model}, current=${config.model}; use a new run ID for the stronger-model comparison`);
  }
  const accumulated: AccumulatedRun = prior?.accumulated ?? {
    turns: [], laneStops: [], states: [], failures: [], models: EMPTY_MODELS(), laneModels: [],
  };
  const startPersona = prior?.next_persona_index ?? 0;
  const tutor: Actor = { key: 'tutor-control', user: config.tutor.user, displayName: config.tutor.displayName ?? 'Test Tutor', channel: config.tutor.channel };

  await pauseUntilQuiet(config.id);
  for (let personaIndex = startPersona; personaIndex < PERSONAS.length; personaIndex += 1) {
    const persona = PERSONAS[personaIndex];
    const laneTurnStart = accumulated.turns.length;
    const transcriptBefore = captureTranscriptOffsets(config.id);
    let laneFailed = false;
    try {
      groupAction(config.id, 'run');
      const studentConfig = config.students[persona.studentIndex];
      const student: Actor = { key: persona.id, user: studentConfig.user, displayName: studentConfig.displayName, channel: studentConfig.channel };
      const tutorBefore = await sendAndWait(config, tutor,
        `LIVE EVAL ${persona.id} tutor setup. Using only the tutor app CLI, queue one guidance command for ${student.displayName} on C01 with idempotency ${options.runId}-${persona.id}-guide. The exact guidance text is: "Compare the highest place value first and explain the first differing digit." Reply with the exact receipt and no private memory.`);
      accumulated.turns.push({ ...tutorBefore, persona: persona.id, quality: scoreReply(tutorBefore.reply, persona.id) });

      const opening = await sendAndWait(config, student,
        `LIVE EVAL ${persona.id} turn 1. Follow the normal student-teaching skill: apply inbox, resolve context, compute frontier, plan one action, retrieve grounded course material, and ask one concise student-facing question. Do not print raw tool output.`);
      accumulated.turns.push({ ...opening, persona: persona.id, quality: scoreReply(opening.reply, persona.id) });

      for (let index = 0; index < persona.outcomes.length; index += 1) {
        const simulatedAnswer = answer(persona.outcomes[index], persona.id, index + 2);
        const turn = await sendAndWait(config, student,
          `LIVE EVAL ${persona.id} turn ${index + 2}. The student's concrete answer is: "${simulatedAnswer}" Assess only this observable evidence; the deterministic oracle expects ${persona.outcomes[index]}, but do not use that label if the answer content conflicts. Record the assessed outcome idempotently as ${options.runId}-${persona.id}-attempt-${index + 1} and pass the concrete answer as the required evidence; update any evidenced misconception; call learning plan-action; compute the frontier; select only a returned policy-eligible pedagogy; retrieve grounded material; then reply naturally with feedback and one next action. Do not expose internal IDs or another student.`);
        accumulated.turns.push({ ...turn, persona: persona.id, quality: scoreReply(turn.reply, persona.id) });
      }

      const tutorAfter = await sendAndWait(config, tutor,
        `LIVE EVAL ${persona.id} tutor inspection. Generate an admin report only for ${student.displayName}. State attempt, misconception, current-action, and mastery summaries without any memory content.`);
      accumulated.turns.push({ ...tutorAfter, persona: persona.id, quality: scoreReply(tutorAfter.reply, persona.id) });
      const counts = stateCounts(root, student.displayName);
      if (counts.applied_commands < 1) accumulated.failures.push(`${persona.id}: targeted tutor command was not applied`);
      if (counts.decisions < 1) accumulated.failures.push(`${persona.id}: no teaching decisions persisted`);
      const expectedKeys = persona.outcomes.map((_, index) => `${options.runId}-${persona.id}-attempt-${index + 1}`);
      if (counts.attempts !== expectedKeys.length || counts.attempt_keys.some((key, index) => key !== expectedKeys[index])) {
        accumulated.failures.push(`${persona.id}: expected exact assessment keys ${expectedKeys.join(',')}; observed ${counts.attempt_keys.join(',')}`);
      }
      if (counts.blank_evidence !== 0) accumulated.failures.push(`${persona.id}: ${counts.blank_evidence} blank attempt evidence row(s) persisted`);
      if (counts.traces < 1) accumulated.failures.push(`${persona.id}: no intermediate learning traces persisted`);
      accumulated.states.push({ persona: persona.id, counts });
    } catch (error) {
      laneFailed = true;
      accumulated.failures.push(`${persona.id}: live lane failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const containersStopped = await pauseUntilQuiet(config.id);
      accumulated.laneStops.push({ persona: persona.id, containers_stopped: containersStopped });
      if (containersStopped > 2) accumulated.failures.push(`${persona.id}: serialized lane observed ${containersStopped} running containers; expected at most 2`);
    } catch (error) {
      laneFailed = true;
      accumulated.failures.push(`${persona.id}: failed to quiesce lane: ${error instanceof Error ? error.message : String(error)}`);
    }
    const laneModels = observeTranscriptDelta(config.id, transcriptBefore);
    mergeModels(accumulated.models, laneModels);
    accumulated.laneModels.push({ persona: persona.id, ...laneModels });
    if (laneFailed) break;

    const laneQuality = averageQuality(accumulated.turns.slice(laneTurnStart));
    if (shouldPauseForReview(options.checkpoint, laneQuality, options.qualityThreshold, personaIndex + 1 < PERSONAS.length)) {
      const { file, checkpoint } = writeCheckpoint(dir, options, config.model, personaIndex + 1, laneQuality, accumulated);
      console.log(JSON.stringify({
        status: checkpoint.status,
        reason: checkpoint.reason,
        question: checkpoint.question,
        choices: checkpoint.choices,
        checkpoint_path: path.resolve(file),
      }, null, 2));
      process.exitCode = 75;
      return;
    }
  }

  const average = averageQuality(accumulated.turns);
  if (accumulated.turns.length !== 60) accumulated.failures.push(`expected 60 routed turns, observed ${accumulated.turns.length}`);
  if (new Set(accumulated.turns.map((turn) => turn.sessionId)).size !== 7) accumulated.failures.push(`expected seven distinct live sessions (one tutor plus six students)`);
  if (average < options.qualityThreshold) accumulated.failures.push(`advisory live quality ${average.toFixed(3)} below ${options.qualityThreshold}`);
  const runtimeMatch = modelContractMatches(config.model, accumulated.models);
  if (!runtimeMatch) {
    accumulated.failures.push(`model attestation failed: configured=${config.model}, observed=${JSON.stringify(accumulated.models.main_models)}, calls=${accumulated.models.main_calls}`);
  }
  const modelContract: ModelContract = { ...preflight, ...accumulated.models, match: runtimeMatch };
  const receipt = {
    schema: 2,
    run_id: options.runId,
    created_at: new Date().toISOString(),
    mode: 'serialized-live-provider',
    checkpoint_policy: { mode: options.checkpoint, quality_threshold: options.qualityThreshold },
    model_contract: modelContract,
    lane_models: accumulated.laneModels,
    personas: PERSONAS.map((persona) => persona.id),
    pass: accumulated.failures.length === 0,
    failures: accumulated.failures,
    metrics: {
      turns: accumulated.turns.length,
      tutor_turns: accumulated.turns.filter((turn) => turn.actor === 'tutor-control').length,
      student_turns: accumulated.turns.filter((turn) => turn.actor !== 'tutor-control').length,
      distinct_sessions: new Set(accumulated.turns.map((turn) => turn.sessionId)).size,
      average_quality: average,
      container_stop_counts: accumulated.laneStops,
      states: accumulated.states,
    },
    turns: accumulated.turns,
  };
  fs.writeFileSync(finalFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ pass: receipt.pass, failures: receipt.failures, model_contract: receipt.model_contract, metrics: receipt.metrics, receipt_path: path.resolve(finalFile) }, null, 2));
  if (!receipt.pass) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exit(1); });
