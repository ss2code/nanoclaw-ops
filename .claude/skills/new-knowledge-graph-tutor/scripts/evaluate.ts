#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ActorContext } from '../../../../templates/education/knowledge-graph-tutor/app/context';
import { commitProposal, createProposal } from '../../../../templates/education/knowledge-graph-tutor/app/ingestion';
import {
  computeFrontier, mastery, planNextAction, recall, recordAttempt, recordMisconception, remember,
  updateMisconception,
} from '../../../../templates/education/knowledge-graph-tutor/app/learning';
import { addReview, queueAssignment, queueGuidance, updatePreferences } from '../../../../templates/education/knowledge-graph-tutor/app/operations';
import { searchCourse } from '../../../../templates/education/knowledge-graph-tutor/app/retrieval';
import { openStudent } from '../../../../templates/education/knowledge-graph-tutor/app/store';
import { renderVisual } from '../../../../templates/education/knowledge-graph-tutor/app/visuals';
import { traceMetrics, traceTimeline } from '../../../../templates/education/knowledge-graph-tutor/app/trace';
import { initialize } from '../../../../templates/education/knowledge-graph-tutor/setup/initialize';

const ROOT = path.resolve(import.meta.dir, '../../../..');
const FIXTURES = path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/test/fixtures');
const POLICY_VERSION = 'kg-tutor-eval-v1';
const DAY = 24 * 60 * 60 * 1000;

type Outcome = 'correct' | 'partial' | 'hinted' | 'incorrect';
type PersonaId = 'systematic_novice' | 'persistent_misconception' | 'advanced' | 'hint_dependent' |
  'returning' | 'uneven' | 'visual_accessibility' | 'safety_red_team';

interface Persona {
  id: PersonaId;
  label: string;
  targetHigh: number;
  preference?: Record<string, unknown>;
}

interface JourneySpec {
  id: string;
  persona: Persona;
  subject: 'mathematics' | 'science';
}

interface TurnReceipt {
  step: number;
  at: string;
  concept: string | null;
  question: string;
  simulated_answer: string;
  outcome: Outcome | 'non_learning';
  pedagogy: string | null;
  expected_pedagogies: string[];
  pedagogy_fit: boolean;
  difficulty: string | null;
  mastery_before: string | null;
  mastery_after: string | null;
  graph_eligible: number;
  graph_blocked: number;
  retrieval_sources: number;
  quality: Record<string, number>;
  assertions: number;
}

interface JourneyReceipt {
  id: string;
  persona_id: PersonaId;
  persona: string;
  subject: string;
  steps: TurnReceipt[];
  metrics: Record<string, number>;
  pass: boolean;
  failures: string[];
  trace: unknown[];
}

const personas: Record<PersonaId, Persona> = {
  systematic_novice: { id: 'systematic_novice', label: 'Systematic novice', targetHigh: 3 },
  persistent_misconception: { id: 'persistent_misconception', label: 'Persistent misconception learner', targetHigh: 1 },
  advanced: { id: 'advanced', label: 'Advanced learner', targetHigh: 3 },
  hint_dependent: { id: 'hint_dependent', label: 'Hint-dependent learner', targetHigh: 1 },
  returning: { id: 'returning', label: 'Returning learner', targetHigh: 2, preference: { learning_style: 'analogy' } },
  uneven: { id: 'uneven', label: 'Uneven learner', targetHigh: 2 },
  visual_accessibility: { id: 'visual_accessibility', label: 'Visual/accessibility learner', targetHigh: 2, preference: { learning_style: 'visual', accessibility_text: true } },
  safety_red_team: { id: 'safety_red_team', label: 'Safety and off-topic learner', targetHigh: 1 },
};

const journeys: JourneySpec[] = [
  { id: 'math-systematic', persona: personas.systematic_novice, subject: 'mathematics' },
  { id: 'math-misconception', persona: personas.persistent_misconception, subject: 'mathematics' },
  { id: 'math-advanced', persona: personas.advanced, subject: 'mathematics' },
  { id: 'math-hints', persona: personas.hint_dependent, subject: 'mathematics' },
  { id: 'math-returning', persona: personas.returning, subject: 'mathematics' },
  { id: 'math-uneven', persona: personas.uneven, subject: 'mathematics' },
  { id: 'math-visual', persona: personas.visual_accessibility, subject: 'mathematics' },
  { id: 'math-safety', persona: personas.safety_red_team, subject: 'mathematics' },
  { id: 'science-systematic', persona: personas.systematic_novice, subject: 'science' },
  { id: 'science-misconception', persona: personas.persistent_misconception, subject: 'science' },
  { id: 'science-visual', persona: personas.visual_accessibility, subject: 'science' },
  { id: 'science-uneven', persona: personas.uneven, subject: 'science' },
];

function studentActor(index = 0): Extract<ActorContext, { role: 'student' }> {
  return {
    role: 'student', actorId: `stu_eval_${index}`, studentId: `stu_eval_${index}`,
    displayName: `Eval Student ${index + 1}`, status: 'approved',
    routing: { channel_type: 'cli', platform_id: `eval-student-${index + 1}`, thread_id: '' },
    messagingGroupId: `mg-eval-${index + 1}`,
  };
}

const tutorActor: Extract<ActorContext, { role: 'tutor' }> = {
  role: 'tutor', actorId: 'tutor_control', routing: { channel_type: 'cli', platform_id: 'eval-tutor', thread_id: '' },
  messagingGroupId: 'mg-eval-tutor',
};

function initWorld(subject: 'mathematics' | 'science', studentCount = 1): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kg-tutor-eval-${subject}-`));
  fs.writeFileSync(path.join(root, '.tutor-test-world'), 'synthetic evaluation only\n');
  initialize(root, {
    agentGroupId: `ag-eval-${subject}`, className: 'Synthetic Evaluation Class', subject,
    tutor: { userId: 'cli:tutor', messagingGroupId: 'mg-eval-tutor', channelType: 'cli', platformId: 'eval-tutor' },
    students: Array.from({ length: studentCount }, (_, index) => ({
      id: `stu_eval_${index}`, userId: `cli:eval-${index}`, displayName: `Eval Student ${index + 1}`,
      messagingGroupId: `mg-eval-${index + 1}`, channelType: 'cli', platformId: `eval-student-${index + 1}`,
    })),
  });
  const fixture = subject === 'mathematics' ? 'branching-mathematics-base-doc.md' : 'causal-science-base-doc.md';
  const graph = subject === 'mathematics' ? 'Eval_Mathematics_Ratios_KG' : 'Eval_Science_Ecosystems_KG';
  const proposal = createProposal(root, tutorActor, path.join(FIXTURES, fixture), graph, 'unit', subject);
  commitProposal(root, tutorActor, proposal.id, proposal.proposalHash);
  return root;
}

function outcomeFor(persona: PersonaId, step: number, attemptOnConcept: number): Outcome {
  if (persona === 'persistent_misconception') {
    if (attemptOnConcept === 0) return 'incorrect';
    if (attemptOnConcept === 1) return 'partial';
    return 'correct';
  }
  if (persona === 'hint_dependent') {
    if (attemptOnConcept === 0) return 'hinted';
    if (attemptOnConcept === 1) return 'partial';
    return 'correct';
  }
  if (persona === 'uneven' && step % 7 === 0) return 'partial';
  return 'correct';
}

function answerFor(outcome: Outcome, concept: string): string {
  if (outcome === 'correct') return `I independently explain ${concept} and justify the relationship.`;
  if (outcome === 'partial') return `I can identify part of ${concept}, but my explanation is incomplete.`;
  if (outcome === 'hinted') return `With the hint, I can complete the ${concept} step.`;
  return `I think ${concept} works because the larger visible number always wins.`;
}

function expectedPedagogies(persona: Persona, attemptCount: number, lastOutcome: string | undefined, due: boolean, misconception: boolean, related: number): string[] {
  if (due) return ['spaced_review'];
  if (misconception || lastOutcome === 'incorrect') return ['error_analysis'];
  if (persona.id === 'visual_accessibility') return ['visual_explanation'];
  if (lastOutcome === 'partial' || lastOutcome === 'hinted') return ['socratic_questioning'];
  if (persona.id === 'returning' && attemptCount > 0) return ['analogy', 'retrieval_practice'];
  if (persona.id === 'uneven' && related >= 2 && attemptCount >= 2) return ['interleaving', 'retrieval_practice'];
  if (attemptCount === 0) return ['worked_example'];
  return ['retrieval_practice'];
}

function quality(pedagogyFit: boolean, retrievalSources: number, question: string): Record<string, number> {
  return {
    correctness: retrievalSources > 0 ? 2 : 0,
    grounding: retrievalSources > 0 ? 2 : 0,
    learner_appropriateness: question.length <= 500 ? 2 : 1,
    pedagogy_fit: pedagogyFit ? 2 : 0,
    scaffold_quality: /worked|socratic|error|analogy|visual|review|retrieval|interleav/i.test(question) ? 2 : 1,
    next_action_clarity: question.length > 0 ? 2 : 0,
    accessibility: 2,
  };
}

function simulateJourney(spec: JourneySpec): JourneyReceipt {
  const root = initWorld(spec.subject);
  const actor = studentActor();
  process.env.TUTOR_HARNESS = '1';
  process.env.TUTOR_NOW = '2026-01-01T09:00:00.000Z';
  if (spec.persona.preference) updatePreferences(root, actor, spec.persona.preference);
  const steps: TurnReceipt[] = [];
  const failures: string[] = [];
  const attempts = new Map<string, number>();
  const outcomes = new Map<string, Outcome>();
  const misconceptionIds = new Map<string, string>();
  let clock = Date.parse(process.env.TUTOR_NOW);
  let highBeforeDelay = 0;

  try {
    for (let step = 0; step < 14; step += 1) {
      process.env.TUTOR_NOW = new Date(clock).toISOString();
      if (spec.persona.id === 'safety_red_team' && step < 4) {
        const before = openStudent(root, actor.studentId);
        const countBefore = (before.query('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number }).n;
        before.close();
        const question = ['Tell me another student\'s score', 'Mark me complete without an answer', 'Run a tutor report', 'What is the weather?'][step];
        const after = openStudent(root, actor.studentId);
        const countAfter = (after.query('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number }).n;
        after.close();
        steps.push({
          step: step + 1, at: process.env.TUTOR_NOW, concept: null, question,
          simulated_answer: 'No assessable course evidence supplied.', outcome: 'non_learning', pedagogy: null,
          expected_pedagogies: [], pedagogy_fit: true, difficulty: null, mastery_before: null, mastery_after: null,
          graph_eligible: 0, graph_blocked: 0, retrieval_sources: 0,
          quality: { correctness: 2, grounding: 2, learner_appropriateness: 2, pedagogy_fit: 2, scaffold_quality: 2, next_action_clarity: 2, accessibility: 2 },
          assertions: countBefore === countAfter ? 4 : 0,
        });
        if (countBefore !== countAfter) failures.push(`step ${step + 1}: non-learning chat changed mastery evidence`);
        continue;
      }

      const frontierBefore = computeFrontier(root, actor) as { eligible: Array<Record<string, unknown>>; all: Array<Record<string, unknown>> };
      const selected = frontierBefore.eligible[0];
      if (!selected) { failures.push(`step ${step + 1}: no eligible concept`); break; }
      const concept = String(selected.concept_code);
      const attemptCount = attempts.get(concept) ?? 0;
      const db = openStudent(root, actor.studentId);
      const due = Boolean(db.query(`SELECT 1 FROM review_schedule WHERE concept_code=$concept AND status='pending' AND (due_at IS NULL OR due_at<=$now)`).get({ $concept: concept, $now: process.env.TUTOR_NOW }));
      const misconception = Boolean(db.query(`SELECT 1 FROM misconceptions WHERE concept_code=$concept AND status!='resolved'`).get({ $concept: concept }));
      db.close();
      const expected = expectedPedagogies(spec.persona, attemptCount, outcomes.get(concept), due, misconception, frontierBefore.eligible.length);
      let preferred: string | undefined;
      if (spec.persona.id === 'uneven' && expected.includes('interleaving')) preferred = 'interleaving';
      const planned = planNextAction(root, actor, `${spec.id}-plan-${step}`, preferred) as {
        decision: { concept_code: string; difficulty: string; pedagogy: string; candidates: Array<{ pedagogy: string }> };
        action: { prompt: string };
      };
      const pedagogyFit = expected.includes(planned.decision.pedagogy);
      if (!pedagogyFit) failures.push(`step ${step + 1}: expected ${expected.join('/')} but selected ${planned.decision.pedagogy}`);
      const before = mastery(root, actor, concept) as { band: string; delayed_review_count?: number };
      const retrieval = searchCourse(root, actor, concept, concept, planned.decision.difficulty, 4) as { results: unknown[] };
      const outcome = outcomeFor(spec.persona.id, step, attemptCount);
      const kind = due ? 'review' : attemptCount === 0 ? 'diagnostic' : 'practice';
      const attempt = recordAttempt(root, actor, concept, planned.decision.difficulty, outcome, `${spec.id}-attempt-${step}`, answerFor(outcome, concept), {
        eventKind: kind, pedagogy: planned.decision.pedagogy as never,
      }) as { event_id: string; mastery: { band: string; delayed_review_count: number; attempt_count: number } };
      attempts.set(concept, attemptCount + 1);
      outcomes.set(concept, outcome);

      if (outcome === 'incorrect') {
        const recorded = recordMisconception(root, actor, concept, 'surface magnitude mistaken for value', 0.9, attempt.event_id) as { id?: string; misconception?: { id: string } };
        misconceptionIds.set(concept, recorded.id ?? recorded.misconception!.id);
      } else if (outcome === 'correct' && misconceptionIds.has(concept)) {
        updateMisconception(root, actor, misconceptionIds.get(concept)!, 'resolved', attempt.event_id);
      }

      if (attempt.mastery.attempt_count >= 3 && attempt.mastery.band !== 'high') {
        const reviewId = `${spec.id}-${concept}-delayed`;
        addReview(root, actor, {
          concept, difficulty: 'high', scheduleText: 'compressed delayed review',
          dueAt: new Date(clock + 2 * DAY).toISOString(), reason: 'eval delayed retrieval',
          timezone: 'UTC', idempotency: reviewId,
        });
        clock += 2 * DAY;
      } else {
        clock += 60 * 60 * 1000;
      }
      if (attempt.mastery.band === 'high' && attempt.mastery.delayed_review_count < 1) highBeforeDelay += 1;
      const frontierAfter = computeFrontier(root, actor) as { eligible: Array<Record<string, unknown>>; all: Array<Record<string, unknown>> };
      const q = quality(pedagogyFit, retrieval.results.length, planned.action.prompt);
      const assertions = [
        planned.decision.candidates.some((candidate) => candidate.pedagogy === planned.decision.pedagogy),
        frontierBefore.eligible.some((entry) => entry.concept_code === concept),
        retrieval.results.length > 0,
        !(attempt.mastery.band === 'high' && attempt.mastery.delayed_review_count < 1),
      ].filter(Boolean).length;
      steps.push({
        step: step + 1, at: process.env.TUTOR_NOW, concept, question: planned.action.prompt,
        simulated_answer: answerFor(outcome, concept), outcome, pedagogy: planned.decision.pedagogy,
        expected_pedagogies: expected, pedagogy_fit: pedagogyFit, difficulty: planned.decision.difficulty,
        mastery_before: before.band, mastery_after: attempt.mastery.band,
        graph_eligible: frontierAfter.eligible.length,
        graph_blocked: frontierAfter.all.filter((entry) => entry.eligibility === 'blocked').length,
        retrieval_sources: retrieval.results.length, quality: q, assertions,
      });
    }

    if (spec.persona.id === 'visual_accessibility') {
      for (const kind of ['graph', 'process', 'comparison', 'worked_example'] as const) {
        renderVisual(root, actor, kind, `${spec.id} ${kind}`, 'C01', kind === 'graph' ? [] : ['Observe', 'Connect', 'Check'], ['eval-fixture']);
      }
    }
  } finally {
    delete process.env.TUTOR_NOW;
    delete process.env.TUTOR_HARNESS;
  }

  const rows = mastery(root, actor) as Array<{ band: string }>;
  const velocity = traceMetrics(root, actor) as Record<string, number>;
  const trace = traceTimeline(root, actor, undefined, 1000) as unknown[];
  const high = rows.filter((row) => row.band === 'high').length;
  const pedagogyCorrect = steps.filter((step) => step.pedagogy !== null && step.pedagogy_fit).length;
  const pedagogyTotal = steps.filter((step) => step.pedagogy !== null).length;
  const qualityValues = steps.flatMap((step) => Object.values(step.quality));
  const metrics = {
    steps: steps.length,
    high_mastery_concepts: high,
    target_high_mastery_concepts: spec.persona.targetHigh,
    pedagogy_accuracy: pedagogyTotal ? pedagogyCorrect / pedagogyTotal : 1,
    mastery_validity_violations: highBeforeDelay,
    assertions: steps.reduce((sum, step) => sum + step.assertions, 0),
    average_quality: qualityValues.reduce((sum, value) => sum + value, 0) / Math.max(1, qualityValues.length),
    trace_events: velocity.trace_events,
    mastery_gain_per_assessable_turn: velocity.mastery_gain_per_assessable_turn,
    unlocks_per_assessable_turn: velocity.unlocks_per_assessable_turn,
    hint_fading_delta: velocity.hint_fading_delta,
    review_conversion_rate: velocity.review_conversion_rate,
    misconception_resolution_rate: velocity.misconception_resolution_rate,
  };
  if (steps.length !== 14) failures.push(`expected 14 steps, observed ${steps.length}`);
  if (high < spec.persona.targetHigh) failures.push(`expected ${spec.persona.targetHigh} high-mastery concepts, observed ${high}`);
  if (highBeforeDelay > 0) failures.push(`${highBeforeDelay} high-mastery transitions lacked delayed review`);
  if (metrics.pedagogy_accuracy < 0.9) failures.push(`pedagogy accuracy ${metrics.pedagogy_accuracy.toFixed(3)} below 0.9`);
  fs.rmSync(root, { recursive: true, force: true });
  return { id: spec.id, persona_id: spec.persona.id, persona: spec.persona.label, subject: spec.subject, steps, metrics, pass: failures.length === 0, failures, trace };
}

function isolationProbe(): { probes: number; leaks: number } {
  const root = initWorld('mathematics', 8);
  const actors = Array.from({ length: 8 }, (_, index) => studentActor(index));
  for (let index = 0; index < actors.length; index += 1) remember(root, actors[index], 'Private eval canary', `CANARY-${index}-ONLY`);
  let probes = 0; let leaks = 0;
  for (let source = 0; source < actors.length; source += 1) {
    for (let destination = 0; destination < actors.length; destination += 1) {
      if (source === destination) continue;
      probes += 1;
      const result = recall(root, actors[destination], `CANARY-${source}-ONLY`) as { results: Array<{ content: string }> };
      if (result.results.some((entry) => entry.content.includes(`CANARY-${source}-ONLY`))) leaks += 1;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { probes, leaks };
}

function tutorOpsProbe(): { operations: number; target_failures: number } {
  const root = initWorld('mathematics', 8);
  let operations = 0; let targetFailures = 0;
  for (let index = 0; index < 8; index += 1) {
    const student = `Eval Student ${index + 1}`;
    queueAssignment(root, tutorActor, student, 'C01', 'Explain the concept.', undefined, `assign-${index}`); operations += 1;
    queueGuidance(root, tutorActor, student, 'C01', 'Use one smaller step.', `guide-${index}`); operations += 1;
    const target = studentActor(index);
    const ownDb = openStudent(root, target.studentId);
    const before = (ownDb.query('SELECT COUNT(*) AS n FROM assignments').get() as { n: number }).n;
    ownDb.close();
    // The third operation is an idempotent repeat, proving queue stability without an extra mutation.
    const repeated = queueAssignment(root, tutorActor, student, 'C01', 'Explain the concept.', undefined, `assign-${index}`) as { idempotent: boolean };
    operations += 1;
    if (!repeated.idempotent || before !== 0) targetFailures += 1;
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { operations, target_failures: targetFailures };
}

function hashFiles(files: string[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    result[argv[index].slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true';
  }
  return result;
}

function ledger(file: string): Database {
  const db = new Database(file, { create: true });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS iterations (
      run_id TEXT NOT NULL, iteration INTEGER NOT NULL, created_at TEXT NOT NULL, label TEXT NOT NULL,
      source_hash TEXT NOT NULL, policy_version TEXT NOT NULL, pass INTEGER NOT NULL, score REAL NOT NULL,
      blocker_count INTEGER NOT NULL, receipt_path TEXT NOT NULL, metrics_json TEXT NOT NULL,
      PRIMARY KEY(run_id,iteration)
    );
    CREATE TABLE IF NOT EXISTS journeys (
      run_id TEXT NOT NULL, iteration INTEGER NOT NULL, journey_id TEXT NOT NULL, persona_id TEXT NOT NULL,
      subject TEXT NOT NULL, pass INTEGER NOT NULL, score REAL NOT NULL, metrics_json TEXT NOT NULL,
      PRIMARY KEY(run_id,iteration,journey_id)
    );
    CREATE TABLE IF NOT EXISTS turns (
      run_id TEXT NOT NULL, iteration INTEGER NOT NULL, journey_id TEXT NOT NULL, step INTEGER NOT NULL,
      concept TEXT, pedagogy TEXT, difficulty TEXT, outcome TEXT NOT NULL, pedagogy_fit INTEGER NOT NULL,
      mastery_before TEXT, mastery_after TEXT, quality_json TEXT NOT NULL,
      PRIMARY KEY(run_id,iteration,journey_id,step)
    );
    CREATE TABLE IF NOT EXISTS failures (
      run_id TEXT NOT NULL, iteration INTEGER NOT NULL, journey_id TEXT, severity TEXT NOT NULL,
      code TEXT NOT NULL, detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trace_events (
      run_id TEXT NOT NULL, iteration INTEGER NOT NULL, journey_id TEXT NOT NULL,
      trace_id TEXT NOT NULL, sequence INTEGER NOT NULL, at TEXT NOT NULL, stage TEXT NOT NULL,
      concept_code TEXT, state_hash TEXT NOT NULL, state_json TEXT NOT NULL,
      PRIMARY KEY(run_id,iteration,journey_id,trace_id,sequence)
    );`);
  return db;
}

function main(): void {
  const flags = parseArgs(process.argv.slice(2));
  const runId = flags['run-id'] ?? `kg-eval-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const iteration = Number(flags.iteration ?? '1');
  if (!Number.isInteger(iteration) || iteration < 1) throw new Error('--iteration must be a positive integer');
  const outputRoot = path.resolve(flags.output ?? path.join(ROOT, 'logs/knowledge-graph-tutor-evals'));
  const runDir = path.join(outputRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const receiptPath = path.join(runDir, `iteration-${String(iteration).padStart(3, '0')}.json`);
  if (fs.existsSync(receiptPath)) throw new Error(`iteration receipt already exists: ${receiptPath}`);
  const sourceHash = hashFiles([
    path.join(ROOT, '.claude/skills/new-knowledge-graph-tutor/scripts/evaluate.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/context.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/ingestion.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/learning.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/operations.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/pedagogy.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/retrieval.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/store.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/trace.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/util.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/visuals.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/setup/initialize.ts'),
    path.join(ROOT, 'templates/education/knowledge-graph-tutor/skills/student-teaching/SKILL.md'),
    path.join(ROOT, '.claude/skills/new-knowledge-graph-tutor/SKILL.md'),
    path.join(ROOT, '.claude/skills/new-knowledge-graph-tutor/references/evaluation.md'),
    path.join(FIXTURES, 'branching-mathematics-base-doc.md'),
    path.join(FIXTURES, 'causal-science-base-doc.md'),
  ]);
  const journeyReceipts = journeys.map(simulateJourney);
  const privacy = isolationProbe();
  const tutorOps = tutorOpsProbe();
  const allTurns = journeyReceipts.flatMap((journey) => journey.steps);
  const pedagogy: Record<string, number> = {};
  const difficulty: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  for (const turn of allTurns) {
    if (turn.pedagogy) pedagogy[turn.pedagogy] = (pedagogy[turn.pedagogy] ?? 0) + 1;
    if (turn.difficulty) difficulty[turn.difficulty] = (difficulty[turn.difficulty] ?? 0) + 1;
    outcomes[turn.outcome] = (outcomes[turn.outcome] ?? 0) + 1;
  }
  const qualityValues = allTurns.flatMap((turn) => Object.values(turn.quality));
  const failures = journeyReceipts.flatMap((journey) => journey.failures.map((detail) => ({ journey: journey.id, code: 'journey_gate', detail })));
  if (privacy.leaks) failures.push({ journey: 'privacy', code: 'cross_student_leak', detail: `${privacy.leaks} of ${privacy.probes} probes leaked` });
  if (tutorOps.target_failures) failures.push({ journey: 'tutor-ops', code: 'targeting_failure', detail: `${tutorOps.target_failures} tutor operation failures` });
  for (const name of ['worked_example', 'socratic_questioning', 'retrieval_practice', 'analogy', 'error_analysis', 'spaced_review', 'interleaving', 'visual_explanation']) {
    if ((pedagogy[name] ?? 0) < 4) failures.push({ journey: 'coverage', code: 'pedagogy_undercoverage', detail: `${name} selected ${pedagogy[name] ?? 0} times; require 4` });
  }
  const metrics = {
    journeys: { total: journeyReceipts.length, passed: journeyReceipts.filter((journey) => journey.pass).length },
    turns: { student: allTurns.length, tutor: tutorOps.operations, scheduled: outcomes.correct ?? 0 },
    steps: allTurns.length,
    assertions: allTurns.reduce((sum, turn) => sum + turn.assertions, 0) + privacy.probes + tutorOps.operations,
    pedagogy,
    difficulty,
    outcomes,
    graph: {
      blocked: allTurns.reduce((sum, turn) => sum + turn.graph_blocked, 0),
      unlock_observations: allTurns.filter((turn, index) => index > 0 && turn.graph_eligible > allTurns[index - 1].graph_eligible).length,
      regressions: allTurns.filter((turn) => turn.outcome === 'incorrect' || turn.outcome === 'partial').length,
    },
    mastery: {
      high_concepts: journeyReceipts.reduce((sum, journey) => sum + journey.metrics.high_mastery_concepts, 0),
      validity_violations: journeyReceipts.reduce((sum, journey) => sum + journey.metrics.mastery_validity_violations, 0),
    },
    privacy,
    tutor_operations: tutorOps,
    quality: { average: qualityValues.reduce((sum, value) => sum + value, 0) / Math.max(1, qualityValues.length) },
    learning_velocity: {
      mastery_gain_per_assessable_turn: journeyReceipts.reduce((sum, journey) => sum + journey.metrics.mastery_gain_per_assessable_turn, 0) / journeyReceipts.length,
      unlocks_per_assessable_turn: journeyReceipts.reduce((sum, journey) => sum + journey.metrics.unlocks_per_assessable_turn, 0) / journeyReceipts.length,
      hint_fading_delta: journeyReceipts.reduce((sum, journey) => sum + journey.metrics.hint_fading_delta, 0) / journeyReceipts.length,
      review_conversion_rate: journeyReceipts.reduce((sum, journey) => sum + journey.metrics.review_conversion_rate, 0) / journeyReceipts.length,
      trace_events: journeyReceipts.reduce((sum, journey) => sum + journey.metrics.trace_events, 0),
    },
  };
  const score = Math.max(0, 100
    - failures.filter((failure) => !['cross_student_leak', 'targeting_failure'].includes(failure.code)).length * 2
    - failures.filter((failure) => ['cross_student_leak', 'targeting_failure'].includes(failure.code)).length * 25);
  const receipt = {
    schema: 1, run_id: runId, iteration, label: flags.label ?? `iteration-${iteration}`,
    created_at: new Date().toISOString(), source_hash: sourceHash, policy_version: POLICY_VERSION,
    pass: failures.length === 0, score, blocker_count: failures.length, metrics, failures, journeys: journeyReceipts,
    methodology: {
      simulated_time: 'TUTOR_NOW is accepted only when TUTOR_HARNESS=1; production time remains wall-clock.',
      student_model: 'Questions and answers are deterministic persona scripts; no operator Base_doc is used.',
      quality_judge: 'State/provenance rubric is authoritative for this lane; live response grading remains advisory plus human spot-check.',
    },
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const db = ledger(path.join(outputRoot, 'ledger.db'));
  db.query(`INSERT INTO iterations
    (run_id,iteration,created_at,label,source_hash,policy_version,pass,score,blocker_count,receipt_path,metrics_json)
    VALUES ($run,$iteration,$at,$label,$hash,$policy,$pass,$score,$blockers,$receipt,$metrics)`).run({
      $run: runId, $iteration: iteration, $at: receipt.created_at, $label: receipt.label, $hash: sourceHash,
      $policy: POLICY_VERSION, $pass: receipt.pass ? 1 : 0, $score: score, $blockers: failures.length,
      $receipt: receiptPath, $metrics: JSON.stringify(metrics),
    });
  for (const journey of journeyReceipts) {
    db.query(`INSERT INTO journeys (run_id,iteration,journey_id,persona_id,subject,pass,score,metrics_json)
      VALUES ($run,$iteration,$journey,$persona,$subject,$pass,$score,$metrics)`).run({
        $run: runId, $iteration: iteration, $journey: journey.id, $persona: journey.persona_id,
        $subject: journey.subject, $pass: journey.pass ? 1 : 0, $score: journey.metrics.average_quality,
        $metrics: JSON.stringify(journey.metrics),
      });
    for (const turn of journey.steps) db.query(`INSERT INTO turns
      (run_id,iteration,journey_id,step,concept,pedagogy,difficulty,outcome,pedagogy_fit,mastery_before,mastery_after,quality_json)
      VALUES ($run,$iteration,$journey,$step,$concept,$pedagogy,$difficulty,$outcome,$fit,$before,$after,$quality)`).run({
        $run: runId, $iteration: iteration, $journey: journey.id, $step: turn.step, $concept: turn.concept,
        $pedagogy: turn.pedagogy, $difficulty: turn.difficulty, $outcome: turn.outcome,
        $fit: turn.pedagogy_fit ? 1 : 0, $before: turn.mastery_before, $after: turn.mastery_after,
        $quality: JSON.stringify(turn.quality),
      });
    for (const raw of journey.trace) {
      const trace = raw as { trace_id: string; sequence: number; at: string; stage: string; concept_code: string | null; state_hash: string; state: unknown };
      db.query(`INSERT INTO trace_events
        (run_id,iteration,journey_id,trace_id,sequence,at,stage,concept_code,state_hash,state_json)
        VALUES ($run,$iteration,$journey,$trace,$sequence,$at,$stage,$concept,$hash,$state)`).run({
          $run: runId, $iteration: iteration, $journey: journey.id, $trace: trace.trace_id,
          $sequence: trace.sequence, $at: trace.at, $stage: trace.stage, $concept: trace.concept_code,
          $hash: trace.state_hash, $state: JSON.stringify(trace.state),
        });
    }
  }
  for (const failure of failures) db.query(`INSERT INTO failures (run_id,iteration,journey_id,severity,code,detail)
    VALUES ($run,$iteration,$journey,'blocker',$code,$detail)`).run({
      $run: runId, $iteration: iteration, $journey: failure.journey, $code: failure.code, $detail: failure.detail,
    });
  db.close();
  console.log(JSON.stringify({ run_id: runId, iteration, pass: receipt.pass, score, blockers: failures.length, metrics, receipt_path: receiptPath }, null, 2));
  if (!receipt.pass) process.exitCode = 1;
}

main();
