import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectDocument } from '../ingestion';
import { initTestWorld, runAs } from './harness';

const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', name);
const worlds: string[] = [];
afterEach(() => {
  delete process.env.TUTOR_NOW;
  for (const world of worlds.splice(0)) fs.rmSync(world, { recursive: true, force: true });
});

function seededWorld(): string {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-phase45-'));
  worlds.push(world);
  initTestWorld(world);
  const proposed = runAs(world, 'tutor-control', [
    'ingestion', 'propose', '--document', fixture('branching-mathematics-base-doc.md'),
    '--graph', 'Eval_Mathematics_Ratios_KG', '--scope-type', 'unit', '--scope-label', 'Ratios', '--json',
  ]);
  expect(proposed.exitCode).toBe(0);
  const proposal = JSON.parse(proposed.stdout);
  expect(runAs(world, 'tutor-control', ['ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json']).exitCode).toBe(0);
  return world;
}

function attempt(world: string, difficulty: string, key: string, kind = 'practice', outcome = 'correct') {
  const result = runAs(world, 'student-a', [
    'learning', 'record-attempt', '--concept', 'C01', '--difficulty', difficulty, '--outcome', outcome,
    '--kind', kind, '--idempotency', key, '--evidence', `${kind} ${outcome}`, '--json',
  ]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

describe('phase 4 tutor operations and phase 5 visuals', () => {
  test('uses two structurally different synthetic curricula', () => {
    const math = inspectDocument(fixture('branching-mathematics-base-doc.md'));
    const science = inspectDocument(fixture('causal-science-base-doc.md'));
    expect(math.commitAllowed).toBe(true);
    expect(math.concepts).toHaveLength(12);
    expect(math.edges).toHaveLength(15);
    expect(science.commitAllowed).toBe(true);
    expect(science.concepts).toHaveLength(8);
    expect(science.edges).toHaveLength(10);
  });

  test('moves mastery immediately and regresses on later negative evidence', () => {
    const world = seededWorld();
    attempt(world, 'low', 'mastery-low');
    attempt(world, 'medium', 'mastery-medium');
    attempt(world, 'high', 'mastery-high-1');
    const before = attempt(world, 'high', 'mastery-high-2');
    expect(before.mastery.band).toBe('high');
    expect(before.mastery.delayed_review_count).toBe(0);

    const firstNegative = attempt(world, 'high', 'mastery-negative-1', 'review', 'incorrect');
    expect(firstNegative.mastery.band).toBe('medium');

    const secondNegative = attempt(world, 'high', 'mastery-negative-2', 'review', 'incorrect');
    expect(secondNegative.mastery.band).toBe('low');
  });

  test('selects pedagogy from evidence and records an auditable decision', () => {
    const world = seededWorld();
    const first = runAs(world, 'student-a', ['learning', 'plan-action', '--idempotency', 'plan-first', '--json']);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).decision).toMatchObject({
      pedagogy: 'socratic_questioning',
      reason_code: 'source_diagnostic',
    });

    attempt(world, 'low', 'partial-1', 'practice', 'partial');
    const partial = runAs(world, 'student-a', ['learning', 'plan-action', '--idempotency', 'plan-partial', '--json']);
    expect(JSON.parse(partial.stdout).decision.pedagogy).toBe('socratic_questioning');

    const incorrect = attempt(world, 'low', 'incorrect-1', 'practice', 'incorrect');
    const misconception = runAs(world, 'student-a', [
      'learning', 'misconception', '--concept', 'C01', '--description', 'larger digits always mean larger value',
      '--confidence', '0.9', '--evidence-event', incorrect.event_id, '--json',
    ]);
    expect(misconception.exitCode).toBe(0);
    const reinforced = runAs(world, 'student-a', [
      'learning', 'misconception', '--concept', 'C01', '--description', 'larger digits always mean larger value',
      '--confidence', '0.95', '--evidence-event', incorrect.event_id, '--json',
    ]);
    expect(JSON.parse(reinforced.stdout).reinforced).toBe(true);
    const remediation = runAs(world, 'student-a', ['learning', 'plan-action', '--idempotency', 'plan-error', '--json']);
    expect(JSON.parse(remediation.stdout).decision).toMatchObject({ pedagogy: 'error_analysis', reason_code: 'active_misconception' });
  });

  test('drives pedagogy from authored assessment items and reports per-question coverage', () => {
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-assessment-'));
    worlds.push(world);
    initTestWorld(world);
    const proposed = runAs(world, 'tutor-control', [
      'ingestion', 'propose', '--document', fixture('assessment-bank-base-doc.md'),
      '--graph', 'Eval_Mathematics_Patterns_KG', '--scope-type', 'chapter', '--scope-label', 'Patterns', '--json',
    ]);
    const proposal = JSON.parse(proposed.stdout);
    expect(runAs(world, 'tutor-control', [
      'ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json',
    ]).exitCode).toBe(0);

    const planned = JSON.parse(runAs(world, 'student-a', [
      'learning', 'plan-action', '--idempotency', 'authored-plan-1', '--json',
    ]).stdout);
    expect(planned.decision).toMatchObject({
      pedagogy: 'socratic_questioning', reason_code: 'source_diagnostic',
      assessment: { assessment_ref: 'pattern-q1', answer_available: true, prior_attempts: 0 },
    });
    expect(planned.action.prompt).toContain('What comes next: 2, 4, 6');
    expect(planned.action.source_item_id).toBe(planned.decision.assessment.source_item_id);
    expect(planned.action.source_answer_id).toBeTruthy();

    const recorded = runAs(world, 'student-a', [
      'learning', 'record-attempt', '--concept', 'C01', '--difficulty', 'low', '--outcome', 'correct',
      '--item', planned.action.source_item_id, '--pedagogy', planned.decision.pedagogy,
      '--idempotency', 'authored-attempt-1', '--evidence', '8 because two is added each time', '--json',
    ]);
    expect(recorded.exitCode).toBe(0);
    expect(JSON.parse(recorded.stdout).assessment).toMatchObject({
      source_item_id: planned.action.source_item_id,
      source_answer_id: planned.action.source_answer_id,
    });

    const second = JSON.parse(runAs(world, 'student-a', [
      'learning', 'plan-action', '--idempotency', 'authored-plan-2', '--json',
    ]).stdout);
    expect(second.decision).toMatchObject({
      pedagogy: 'retrieval_practice', reason_code: 'unseen_source_question',
      assessment: { assessment_ref: 'pattern-q2', prior_attempts: 0 },
    });

    const report = JSON.parse(runAs(world, 'tutor-control', [
      'admin', 'report', '--student', 'Asha', '--json',
    ]).stdout);
    expect(report.schema).toBe(5);
    expect(report.students[0].material_question_statistics.summary).toMatchObject({
      total_questions: 2, questions_with_answers: 2, attempted_questions: 1,
      correct_questions: 1, unseen_questions: 1, coverage_rate: 0.5,
    });
    expect(report.students[0].material_question_statistics.questions).toEqual([
      expect.objectContaining({ assessment_ref: 'pattern-q1', attempts: 1, last_outcome: 'correct', answer_available: true }),
      expect.objectContaining({ assessment_ref: 'pattern-q2', attempts: 0, last_outcome: null, answer_available: true }),
    ]);
  });

  test('queues assignments and guidance only from tutor control', () => {
    const world = seededWorld();
    const assignment = runAs(world, 'tutor-control', [
      'admin', 'assignment-command', '--student', 'Asha', '--concept', 'C01', '--body', 'Explain the comparison.',
      '--due-at', '2026-02-01T10:00:00Z', '--idempotency', 'assign-1', '--json',
    ]);
    expect(assignment.exitCode).toBe(0);
    const guidance = runAs(world, 'tutor-control', [
      'admin', 'guidance-command', '--student', 'Asha', '--concept', 'C01', '--guidance', 'Use a place-value table.',
      '--idempotency', 'guide-1', '--json',
    ]);
    expect(guidance.exitCode).toBe(0);
    expect(JSON.parse(runAs(world, 'student-a', ['inbox', 'apply', '--json']).stdout).applied_count).toBe(2);
    expect(JSON.parse(runAs(world, 'student-b', ['inbox', 'apply', '--json']).stdout).applied_count).toBe(0);
    expect(runAs(world, 'student-a', [
      'admin', 'assignment-command', '--student', 'Ben', '--concept', 'C01', '--body', 'forbidden', '--idempotency', 'bad',
    ]).exitCode).toBe(77);
  });

  test('supports class policies, progress reports, and role-aware help', () => {
    const world = seededWorld();
    const policy = runAs(world, 'tutor-control', [
      'admin', 'policy-set', '--key', 'review.quiet_hours', '--value', '{"start":"21:00","end":"07:00"}',
      '--idempotency', 'policy-1', '--json',
    ]);
    expect(policy.exitCode).toBe(0);
    expect(JSON.parse(policy.stdout).policy_version).toBeGreaterThan(1);
    const report = runAs(world, 'tutor-control', ['admin', 'report', '--student', 'Asha', '--json']);
    expect(report.exitCode).toBe(0);
    expect(fs.existsSync(JSON.parse(report.stdout).file)).toBe(true);
    const studentHelp = runAs(world, 'student-a', ['help', 'reports', '--json']);
    expect(studentHelp.stdout).not.toContain('policy-set');
    expect(studentHelp.stdout).toContain('Reports about students are tutor-only');
  });

  test('exposes complete CLI usage and handles command-level help before validation', () => {
    const world = seededWorld();
    const help = runAs(world, 'student-a', ['help', '--json']);
    expect(help.exitCode).toBe(0);
    const catalog = JSON.parse(help.stdout);
    expect(catalog.usage['learning record-attempt'].required_flags).toEqual([
      'concept', 'difficulty', 'outcome', 'idempotency', 'evidence',
    ]);
    expect(catalog.usage['learning set-action'].example).toContain('--expected-evidence');
    expect(catalog.usage['admin report']).toBeUndefined();

    const commandHelp = runAs(world, 'student-a', ['learning', 'set-action', '--help']);
    expect(commandHelp.exitCode).toBe(0);
    expect(JSON.parse(commandHelp.stdout)).toMatchObject({
      command: 'learning set-action',
      required_flags: ['concept', 'type', 'prompt', 'expected-evidence', 'difficulty'],
    });

    const missing = runAs(world, 'student-a', ['learning', 'set-action', '--concept', 'C01']);
    expect(missing.exitCode).toBe(64);
    expect(missing.stderr).toContain('--type');
    expect(missing.stderr).toContain('--expected-evidence');
    expect(missing.stderr).toContain('--difficulty');
  });

  test('builds a private gamified coaching card from evidence and the next frontier task', () => {
    const world = seededWorld();
    process.env.TUTOR_NOW = '2026-01-01T09:00:00.000Z';
    attempt(world, 'low', 'coaching-day-one');
    const first = runAs(world, 'student-a', ['coaching', 'briefing', '--slot', 'morning', '--json']);
    expect(first.exitCode).toBe(0);
    const firstCard = JSON.parse(first.stdout);
    expect(firstCard).toMatchObject({
      schema: 1,
      slot: 'morning',
      student: { display_name: 'Asha' },
      progress: { points: 10, level: 1, total_attempts: 1, streak_days: 1 },
      class: { grade_level: '7', age_min: 13, age_max: 14, target_age: 14, explanation_level: 'ELI 14' },
      next_work: { display_code: 'C01', action_type: 'practice' },
    });
    expect(firstCard.motivation.message).toContain('Asha');
    expect(firstCard.gamification.next_level_points).toBe(90);
    expect(JSON.stringify(firstCard)).not.toContain('Ben');

    process.env.TUTOR_NOW = '2026-01-02T09:00:00.000Z';
    attempt(world, 'medium', 'coaching-day-two');
    const second = JSON.parse(runAs(world, 'student-a', ['coaching', 'briefing', '--slot', 'afternoon', '--json']).stdout);
    expect(second.progress).toMatchObject({ points: 20, total_attempts: 2, streak_days: 2 });
    expect(second.next_work.task).toContain('Whole Number Sense');

    const otherStudent = JSON.parse(runAs(world, 'student-b', ['coaching', 'briefing', '--slot', 'morning', '--json']).stdout);
    expect(otherStudent.student.display_name).toBe('Ben');
    expect(otherStudent.progress.points).toBe(0);
    expect(JSON.stringify(otherStudent)).not.toContain('Asha');
  });

  test('exposes coaching setup and protects it from tutor-only routes', () => {
    const world = seededWorld();
    const plan = runAs(world, 'student-a', ['coaching', 'schedule-plan', '--json']);
    expect(plan.exitCode).toBe(0);
    expect(JSON.parse(plan.stdout).slots).toEqual([
      expect.objectContaining({ slot: 'morning', local_time: '07:00', recurrence: '0 7 * * *' }),
      expect.objectContaining({ slot: 'afternoon', local_time: '15:00', recurrence: '0 15 * * *' }),
    ]);
    expect(runAs(world, 'tutor-control', ['coaching', 'schedule-plan', '--json']).exitCode).toBe(77);
    expect(runAs(world, 'student-a', ['coaching', 'briefing', '--slot', 'midnight', '--json']).exitCode).toBe(64);
    expect(runAs(world, 'student-a', ['help', 'schedules', '--json']).stdout).toContain('07:00');
  });

  test('keeps review lifecycle and delivery receipt in the student session', () => {
    const world = seededWorld();
    const created = runAs(world, 'student-a', [
      'schedule', 'review-add', '--concept', 'C01', '--difficulty', 'medium', '--schedule', 'tomorrow 18:00',
      '--due-at', '2026-01-02T18:00:00Z', '--timezone', 'Asia/Kolkata', '--quiet-start', '21:00', '--quiet-end', '07:00',
      '--idempotency', 'review-1', '--json',
    ]);
    const review = JSON.parse(created.stdout).review;
    expect(runAs(world, 'student-a', ['schedule', 'pause', '--id', review.id, '--json']).exitCode).toBe(0);
    const resumed = JSON.parse(runAs(world, 'student-a', ['schedule', 'resume', '--id', review.id, '--json']).stdout).review;
    const delivered = runAs(world, 'student-a', [
      'schedule', 'delivery-receipt', '--id', review.id, '--revision', String(resumed.revision), '--delivery-id', 'telegram-msg-1', '--json',
    ]);
    expect(delivered.exitCode).toBe(0);
    expect(JSON.parse(delivered.stdout).receipt.session_student_id).toBe('stu_fixture_a');
    expect(runAs(world, 'student-b', [
      'schedule', 'delivery-receipt', '--id', review.id, '--revision', String(resumed.revision), '--delivery-id', 'wrong', '--json',
    ]).exitCode).toBe(66);
  });

  test('renders four accessible, deterministic, student-scoped visual forms', () => {
    const world = seededWorld();
    for (const kind of ['graph', 'process', 'comparison', 'worked_example']) {
      const args = ['visual', 'render', '--kind', kind, '--title', `${kind} test`, '--concept', 'C01', '--provenance', '["fixture-source"]'];
      if (kind !== 'graph') args.push('--items', '["First bounded step","Second bounded step"]');
      args.push('--json');
      const result = runAs(world, 'student-a', args);
      expect(result.exitCode).toBe(0);
      const artifact = JSON.parse(result.stdout);
      const svg = fs.readFileSync(artifact.svg_path, 'utf8');
      expect(svg).toContain('role="img"');
      expect(svg).toContain('aria-labelledby="title desc"');
      expect(fs.readFileSync(artifact.text_path, 'utf8').trim().length).toBeGreaterThan(20);
      expect(artifact.provenance.length).toBeGreaterThan(0);
    }
  });

  test('records routing-scoped intermediate traces and learning-velocity metrics', () => {
    const world = seededWorld();
    const planned = runAs(world, 'student-a', ['learning', 'plan-action', '--idempotency', 'trace-turn-1', '--json']);
    const decision = JSON.parse(planned.stdout).decision;
    const searched = runAs(world, 'student-a', [
      'course', 'search', '--concept', decision.concept_code, '--difficulty', decision.difficulty,
      '--query', 'compare quantity', '--trace', 'trace-turn-1', '--json',
    ]);
    expect(searched.exitCode).toBe(0);
    const recorded = runAs(world, 'student-a', [
      'learning', 'record-attempt', '--concept', decision.concept_code, '--difficulty', decision.difficulty,
      '--outcome', 'correct', '--pedagogy', decision.pedagogy, '--trace', 'trace-turn-1',
      '--idempotency', 'trace-attempt-1', '--evidence', 'independent comparison', '--json',
    ]);
    expect(recorded.exitCode).toBe(0);
    const timeline = JSON.parse(runAs(world, 'student-a', ['trace', 'timeline', '--trace', 'trace-turn-1', '--json']).stdout);
    expect(timeline.map((entry: { stage: string }) => entry.stage)).toEqual([
      'frontier', 'decision', 'action', 'retrieval', 'assessment', 'mastery',
    ]);
    expect(timeline.every((entry: { state_hash: string }) => /^[a-f0-9]{64}$/.test(entry.state_hash))).toBe(true);
    const metrics = JSON.parse(runAs(world, 'student-a', ['trace', 'metrics', '--json']).stdout);
    expect(metrics).toMatchObject({ assessable_turns: 1, trace_events: 6 });
    expect(metrics).toHaveProperty('mastery_gain_per_assessable_turn');
    expect(runAs(world, 'student-b', ['trace', 'timeline', '--trace', 'trace-turn-1', '--json']).stdout).toBe('[]\n');
  });
});
