import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initTestWorld, runAs } from './harness';

const fixture = path.join(import.meta.dir, 'fixtures', 'assessment-bank-base-doc.md');
const worlds: string[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) fs.rmSync(world, { recursive: true, force: true });
});

function world(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-tutor-advanced-'));
  worlds.push(root);
  initTestWorld(root);
  return root;
}

function ingest(root: string, document = fixture, graph = 'Eval_Mathematics_Patterns_KG'): any {
  const proposed = runAs(root, 'tutor-control', [
    'ingestion', 'propose', '--document', document, '--graph', graph,
    '--scope-type', 'chapter', '--scope-label', 'Patterns', '--json',
  ]);
  expect(proposed.exitCode).toBe(0);
  const proposal = JSON.parse(proposed.stdout);
  const committed = runAs(root, 'tutor-control', [
    'ingestion', 'commit', '--proposal', proposal.id, '--expected-hash', proposal.proposalHash, '--json',
  ]);
  expect(committed.exitCode).toBe(0);
  return JSON.parse(committed.stdout);
}

describe('advanced knowledge-graph tutor contracts', () => {
  test('persists a mandatory grade and ELI audience profile in routed context', () => {
    const root = world();
    const context = JSON.parse(runAs(root, 'student-a', ['context', 'current', '--json']).stdout);
    expect(context.audience).toEqual({
      grade_level: '7', age_min: 13, age_max: 14, target_age: 14, explanation_level: 'ELI 14',
    });
    const doctor = JSON.parse(runAs(root, 'tutor-control', ['doctor', '--json']).stdout);
    expect(doctor.class).toMatchObject({ grade_level: '7', target_age: 14, explanation_level: 'ELI 14' });
  });

  test('scores authored questions with rubrics and exposes cohort-safe tutor dashboard insight', () => {
    const root = world();
    ingest(root);
    const planned = JSON.parse(runAs(root, 'student-a', [
      'learning', 'plan-action', '--idempotency', 'rubric-plan', '--json',
    ]).stdout);
    expect(planned.decision.assessment).toMatchObject({
      assessment_ref: 'pattern-q1', cognitive_level: 'apply', age_fit: true,
      rubric: { criteria: [expect.objectContaining({ id: 'answer' }), expect.objectContaining({ id: 'reasoning' })] },
    });
    const attempt = runAs(root, 'student-a', [
      'learning', 'record-attempt', '--concept', planned.decision.concept_code,
      '--difficulty', planned.decision.difficulty, '--outcome', 'partial',
      '--item', planned.action.source_item_id, '--rubric-scores', '{"answer":1,"reasoning":0.5}',
      '--grading-confidence', '0.9', '--hint-count', '0', '--selected-option', 'free-response',
      '--idempotency', 'rubric-attempt', '--evidence', '8; the gaps are two each time', '--json',
    ]);
    expect(attempt.exitCode).toBe(0);
    expect(JSON.parse(attempt.stdout).assessment).toMatchObject({ rubric_scored: true, score: 0.7, outcome: 'partial' });

    const dashboard = JSON.parse(runAs(root, 'tutor-control', ['admin', 'dashboard', '--json']).stdout);
    expect(dashboard).toMatchObject({
      surface: 'tutor_control_messaging_channel',
      audience: { grade_level: '7', explanation_level: 'ELI 14' },
      overview: { students: 2, total_attempts: 1, question_quality_suppressed: 2 },
      receipt: 'TUTOR DASHBOARD GENERATED',
    });
    expect(dashboard.delivery).toContain('same tutor-control conversation');
    expect(dashboard.question_quality.items.every((item: { suppressed: boolean }) => item.suppressed)).toBe(true);
    expect(fs.existsSync(dashboard.detailed_report.file)).toBe(true);
  });

  test('enforces an active assessment blueprint including exposure caps', () => {
    const root = world();
    ingest(root);
    const config = JSON.stringify({
      difficulty_mix: { low: 0.5, medium: 0.5, high: 0 },
      cognitive_mix: { apply: 0.5, analyze: 0.5 },
      required_tags: ['sequence'], max_exposures_per_item: 1,
      min_unique_questions_per_concept: 2, transfer_required: false,
    });
    const set = runAs(root, 'tutor-control', [
      'admin', 'blueprint-set', '--name', 'grade7-balanced', '--value', config,
      '--idempotency', 'blueprint-grade7', '--json',
    ]);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ name: 'grade7-balanced', version: 1, config: { max_exposures_per_item: 1 } });

    const first = JSON.parse(runAs(root, 'student-a', ['learning', 'plan-action', '--idempotency', 'bp-plan-1', '--json']).stdout);
    runAs(root, 'student-a', [
      'learning', 'record-attempt', '--concept', first.decision.concept_code, '--difficulty', first.decision.difficulty,
      '--outcome', 'correct', '--item', first.action.source_item_id,
      '--idempotency', 'bp-attempt-1', '--evidence', '8 because the difference is 2', '--json',
    ]);
    const second = JSON.parse(runAs(root, 'student-a', ['learning', 'plan-action', '--idempotency', 'bp-plan-2', '--json']).stdout);
    expect(second.decision.assessment.assessment_ref).toBe('pattern-q2');
    expect(second.decision.assessment.blueprint.max_exposures_per_item).toBe(1);
  });

  test('keeps canonical concept identities stable across graphs and curriculum revisions', () => {
    const root = world();
    const first = ingest(root);
    ingest(root, fixture, 'Eval_Mathematics_Patterns_Review_KG');
    const graphA = JSON.parse(runAs(root, 'tutor-control', ['ckg', 'show', '--graph', 'Eval_Mathematics_Patterns_KG', '--json']).stdout);
    const graphB = JSON.parse(runAs(root, 'tutor-control', ['ckg', 'show', '--graph', 'Eval_Mathematics_Patterns_Review_KG', '--json']).stdout);
    expect(graphA.concepts[0].canonical_concept_id).toBe(graphB.concepts[0].canonical_concept_id);
    const frontier = JSON.parse(runAs(root, 'student-a', ['context', 'frontier', '--json']).stdout);
    expect(frontier.all).toHaveLength(1);
    expect(frontier.all[0]).toMatchObject({ concept_code: graphA.concepts[0].canonical_concept_id, display_code: 'C01' });

    const planned = JSON.parse(runAs(root, 'student-a', ['learning', 'plan-action', '--idempotency', 'revision-plan', '--json']).stdout);
    runAs(root, 'student-a', [
      'learning', 'record-attempt', '--concept', planned.decision.concept_code, '--difficulty', planned.decision.difficulty,
      '--outcome', 'correct', '--item', planned.action.source_item_id,
      '--idempotency', 'revision-attempt', '--evidence', '8 because the pattern adds 2', '--json',
    ]);
    const revisedPath = path.join(root, 'revised-assessment-bank.md');
    const revised = fs.readFileSync(fixture, 'utf8').replace(
      'Explain the rule for 3, 6, 12, 24.',
      'Explain the rule for 5, 10, 20, 40.',
    );
    fs.writeFileSync(revisedPath, revised);
    const revision = ingest(root, revisedPath);
    expect(first.revision).toBe(1);
    expect(revision).toMatchObject({ revision: 2, migration: { unchanged: 1, revised: 1, added: 0, retired: 0 } });
    const report = JSON.parse(runAs(root, 'tutor-control', ['admin', 'report', '--student', 'Asha', '--json']).stdout);
    const q1 = report.students[0].material_question_statistics.questions.find((item: { assessment_ref: string }) => item.assessment_ref === 'pattern-q1');
    expect(q1).toMatchObject({ attempts: 1, correct: true });
  });

  test('publishes reusable diagram-design artifacts only after tutor approval', () => {
    const root = world();
    ingest(root);
    const visual = JSON.parse(runAs(root, 'student-a', [
      'visual', 'render', '--kind', 'process', '--title', 'How a number pattern grows', '--concept', 'C01',
      '--items', '["Find the gap","Check it repeats","Use it for the next term"]',
      '--provenance', '["synthetic-assessment-bank"]', '--json',
    ]).stdout);
    const proposed = runAs(root, 'student-a', [
      'instruction', 'propose', '--concept', 'C01', '--kind', 'diagram', '--title', 'How a number pattern grows',
      '--artifact', visual.svg_path, '--text-alternative', visual.text_alternative,
      '--tags', '["diagram","process","number-patterns"]', '--provenance', '["synthetic-assessment-bank"]',
      '--idempotency', 'diagram-proposal-1', '--json',
    ]);
    expect(proposed.exitCode).toBe(0);
    const resource = JSON.parse(proposed.stdout).resource;
    expect(resource.status).toBe('proposed');
    const tutorCatalogue = JSON.parse(runAs(root, 'tutor-control', [
      'instruction', 'list', '--concept', 'C01', '--json',
    ]).stdout);
    expect(tutorCatalogue).toMatchObject({
      surface: 'materials_catalogue',
      one_liner: expect.stringContaining('Concept-linked'),
      format: expect.stringContaining('concept'),
      scope: 'tutor_review',
      count: 7,
    });
    expect(tutorCatalogue.items.find((item: { id: string }) => item.id === resource.id)).toMatchObject({
      id: resource.id, status: 'proposed', concept: 'C01', kind: 'diagram',
      summary: expect.any(String), format: expect.arrayContaining(['SVG', 'HTML', 'text alternative']),
      review_instruction: expect.stringContaining('send_file'),
    });
    const sourceItems = tutorCatalogue.items.filter((item: { generated: boolean }) => !item.generated);
    expect(sourceItems).toHaveLength(6);
    expect(sourceItems.some((item: { kind: string }) => item.kind === 'source_document')).toBe(true);
    expect(sourceItems.every((item: { tags: string[]; artifact_path: string }) =>
      item.tags.includes('source') && item.tags.includes('curriculum') && item.tags.some((tag) => tag.startsWith('concept:ccpt_')) &&
      item.tags.includes('grade:7') && item.tags.includes('eli:14') && fs.existsSync(item.artifact_path))).toBe(true);
    expect(JSON.parse(runAs(root, 'student-a', [
      'instruction', 'list', '--concept', 'C01', '--json',
    ]).stdout)).toMatchObject({ surface: 'materials_catalogue', scope: 'approved_shared', count: 6 });
    expect(JSON.parse(runAs(root, 'student-a', [
      'instruction', 'search', '--concept', 'C01', '--tags', '["diagram"]', '--json',
    ]).stdout).hit_count).toBe(0);

    expect(runAs(root, 'tutor-control', ['admin', 'instruction-approve', '--id', resource.id, '--json']).exitCode).toBe(0);
    const approvedCatalogue = JSON.parse(runAs(root, 'student-b', [
      'instruction', 'list', '--concept', 'C01', '--json',
    ]).stdout);
    expect(approvedCatalogue).toMatchObject({ scope: 'approved_shared', count: 7 });
    const approvedResource = approvedCatalogue.items.find((item: { id: string }) => item.id === resource.id);
    expect(approvedResource.artifact_path).toContain(`${path.sep}course${path.sep}resources${path.sep}`);
    expect(fs.existsSync(approvedResource.preview_path)).toBe(true);
    const search = JSON.parse(runAs(root, 'student-b', [
      'instruction', 'search', '--concept', 'C01', '--tags', '["diagram"]', '--json',
    ]).stdout);
    expect(search.hit_count).toBe(1);
    expect(search.results[0]).toMatchObject({ kind: 'diagram', title: 'How a number pattern grows' });
    expect(search.results[0].tags).toEqual(expect.arrayContaining(['diagram', 'process', 'grade:7', 'eli:14']));

    const courseDb = new Database(path.join(root, 'course', 'course.db'));
    const relativeArtifact = path.relative(root, approvedResource.artifact_path).split(path.sep).join('/');
    courseDb.query('UPDATE instruction_resources SET artifact_path=$path WHERE id=$id').run({
      $id: resource.id, $path: `/workspace/agent/tutor-app/${relativeArtifact}`,
    });
    courseDb.close();
    const repairedCatalogue = JSON.parse(runAs(root, 'tutor-control', [
      'instruction', 'list', '--concept', 'C01', '--json',
    ]).stdout);
    const repairedResource = repairedCatalogue.items.find((item: { id: string }) => item.id === resource.id);
    expect(repairedResource.artifact_path).toBe(approvedResource.artifact_path);
    expect(fs.existsSync(repairedResource.artifact_path)).toBe(true);

    const dashboard = JSON.parse(runAs(root, 'tutor-control', ['admin', 'dashboard', '--json']).stdout);
    expect(dashboard.materials).toMatchObject({ total: 7, active: 7, proposed: 0, missing_files: 0, concepts_with_materials: 1 });
  });
});
