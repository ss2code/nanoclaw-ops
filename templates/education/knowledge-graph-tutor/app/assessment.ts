import type { Database } from 'bun:sqlite';

import { activeBlueprint, type AssessmentBlueprint } from './assessment-policy';
import { resolveConcept } from './concepts';
import { openClass, openCourse, openStudent } from './store';

export interface AssessmentSelection {
  source_item_id: string;
  source_answer_id: string | null;
  assessment_ref: string;
  canonical_concept_id: string;
  display_code: string;
  title: string;
  prompt: string;
  expected_answer: string | null;
  difficulty: string | null;
  cognitive_level: string | null;
  rubric: { schema: number; criteria: Array<{ id: string; description: string; weight: number; evidence?: string }> };
  acceptable_answers: string[];
  misconceptions: Array<Record<string, unknown>>;
  distractors: Array<Record<string, unknown>>;
  tags: string[];
  prior_attempts: number;
  last_outcome: string | null;
  answer_available: boolean;
  age_fit: boolean;
  blueprint: { id: string; version: number; max_exposures_per_item: number };
  provenance: {
    source_document_id: string;
    source_locator: string;
    source_hash: string;
    graph_revision: number;
  };
}

type QuestionRow = {
  source_item_id: string;
  source_answer_id: string | null;
  assessment_ref: string;
  canonical_concept_ids: string | null;
  display_codes: string | null;
  title: string;
  prompt: string;
  expected_answer: string | null;
  difficulty: string | null;
  cognitive_level: string | null;
  rubric_json: string | null;
  acceptable_answers_json: string | null;
  misconceptions_json: string | null;
  distractors_json: string | null;
  tags_json: string | null;
  age_min: number | null;
  age_max: number | null;
  source_document_id: string;
  source_locator: string;
  source_hash: string;
  graph_revision: number;
};

type AssessmentEvent = {
  source_item_id: string;
  outcome: string;
  score: number;
  at: string;
  rubric_scores_json: string | null;
  grading_confidence: number | null;
  selected_option: string | null;
  hint_count: number;
  difficulty: string;
};

function parsed<T>(value: string | null, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
}

function difficultyRank(value: string | null): number {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  if (value === 'low') return 1;
  return 0;
}

function currentQuestions(course: Database, canonicalConceptId?: string): QuestionRow[] {
  return course.query(`SELECT
    q.id AS source_item_id,q.assessment_ref,q.title,q.body_md AS prompt,q.difficulty,
    q.source_document_id,q.source_locator,q.provenance_hash AS source_hash,g.version AS graph_revision,
    GROUP_CONCAT(DISTINCT COALESCE(c.canonical_concept_id,c.code)) AS canonical_concept_ids,
    GROUP_CONCAT(DISTINCT c.code) AS display_codes,
    s.answer_item_id AS source_answer_id,a.body_md AS expected_answer,s.cognitive_level,s.rubric_json,
    s.acceptable_answers_json,s.misconceptions_json,s.distractors_json,s.tags_json,s.age_min,s.age_max
    FROM content_items q
    JOIN knowledge_graphs g ON g.id=q.graph_id
    LEFT JOIN item_concepts ic ON ic.item_id=q.id
    LEFT JOIN concepts c ON c.id=ic.concept_id
    LEFT JOIN assessment_specs s ON s.question_item_id=q.id
    LEFT JOIN content_items a ON a.id=s.answer_item_id AND a.status='active'
    WHERE q.status='active' AND q.kind IN ('question','mcq') AND q.assessment_ref IS NOT NULL
      AND ($concept IS NULL OR c.canonical_concept_id=$concept OR (c.canonical_concept_id IS NULL AND c.code=$concept))
    GROUP BY q.id ORDER BY q.assessment_ref,q.id`).all({ $concept: canonicalConceptId ?? null }) as QuestionRow[];
}

function evidenceItemIds(course: Database, currentItemIds: string[]): Map<string, Set<string>> {
  const result = new Map(currentItemIds.map((id) => [id, new Set([id])]));
  const lineage = course.query(`SELECT from_item_id,to_item_id FROM assessment_item_lineage
    WHERE evidence_policy='carry' AND from_item_id IS NOT NULL AND to_item_id IS NOT NULL`).all() as Array<{
      from_item_id: string; to_item_id: string;
    }>;
  const parents = new Map<string, string[]>();
  for (const edge of lineage) parents.set(edge.to_item_id, [...(parents.get(edge.to_item_id) ?? []), edge.from_item_id]);
  const visit = (root: string, node: string, seen: Set<string>) => {
    for (const parent of parents.get(node) ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      visit(root, parent, seen);
    }
    result.set(root, seen);
  };
  for (const id of currentItemIds) visit(id, id, result.get(id)!);
  return result;
}

function historiesFor(course: Database, student: Database, questions: QuestionRow[]): Map<string, AssessmentEvent[]> {
  const acceptable = evidenceItemIds(course, questions.map((question) => question.source_item_id));
  const reverse = new Map<string, string[]>();
  for (const [current, ids] of acceptable) for (const id of ids) reverse.set(id, [...(reverse.get(id) ?? []), current]);
  const events = student.query(`SELECT source_item_id,outcome,score,at,rubric_scores_json,grading_confidence,
    selected_option,hint_count,difficulty FROM learning_events WHERE source_item_id IS NOT NULL ORDER BY at,id`).all() as AssessmentEvent[];
  const histories = new Map<string, AssessmentEvent[]>();
  for (const event of events) for (const current of reverse.get(event.source_item_id) ?? []) {
    histories.set(current, [...(histories.get(current) ?? []), event]);
  }
  return histories;
}

function audience(root: string): { age_min: number; age_max: number; target_age: number; explanation_level: string } {
  const db = openClass(root);
  try {
    return db.query('SELECT age_min,age_max,target_age,explanation_level FROM class_config WHERE id=1').get() as {
      age_min: number; age_max: number; target_age: number; explanation_level: string;
    };
  } finally { db.close(); }
}

function tags(row: QuestionRow): string[] {
  return parsed<string[]>(row.tags_json, []);
}

function ageFits(row: QuestionRow, profile: ReturnType<typeof audience>): boolean {
  return (row.age_min === null || row.age_min <= profile.age_max) && (row.age_max === null || row.age_max >= profile.age_min);
}

function mixNeed(
  blueprint: AssessmentBlueprint,
  ranked: Array<{ question: QuestionRow; history: AssessmentEvent[] }>,
  key: string | null,
  dimension: 'difficulty_mix' | 'cognitive_mix',
): number {
  if (!key) return 0;
  const target = blueprint[dimension][key] ?? 0;
  const total = ranked.reduce((sum, entry) => sum + entry.history.length, 0);
  if (!total) return target;
  const count = ranked.reduce((sum, entry) => sum + (
    (dimension === 'difficulty_mix' ? entry.question.difficulty : entry.question.cognitive_level) === key
      ? entry.history.length : 0
  ), 0);
  return target - count / total;
}

/** Select an age-compatible, blueprint-aware authored question for the canonical concept. */
export function selectAssessmentItem(root: string, studentId: string, conceptRef: string, difficulty: string): AssessmentSelection | null {
  const resolved = resolveConcept(root, conceptRef);
  const course = openCourse(root);
  const student = openStudent(root, studentId);
  try {
    const questions = currentQuestions(course, resolved.canonical_id);
    if (!questions.length) return null;
    const histories = historiesFor(course, student, questions);
    const profile = audience(root);
    const blueprint = activeBlueprint(root);
    const requestedRank = difficultyRank(difficulty);
    const ranked = questions.filter((question) => ageFits(question, profile))
      .map((question) => ({ question, history: histories.get(question.source_item_id) ?? [] }));
    if (!ranked.length) return null;
    const belowCap = ranked.filter((entry) => entry.history.length < blueprint.config.max_exposures_per_item);
    if (!belowCap.length) return null;
    const pool = belowCap;
    const transferSatisfied = ranked.some((entry) =>
      (tags(entry.question).includes('transfer') || entry.question.cognitive_level === 'transfer') &&
      entry.history.some((event) => event.outcome === 'correct'));
    const selected = pool.sort((a, b) => {
      const aTags = tags(a.question); const bTags = tags(b.question);
      const required = blueprint.config.required_tags.filter((tag) => !aTags.includes(tag)).length -
        blueprint.config.required_tags.filter((tag) => !bTags.includes(tag)).length;
      if (required) return required;
      const unseen = Number(a.history.length > 0) - Number(b.history.length > 0);
      if (unseen) return unseen;
      if (blueprint.config.transfer_required && !transferSatisfied) {
        const aTransfer = tags(a.question).includes('transfer') || a.question.cognitive_level === 'transfer';
        const bTransfer = tags(b.question).includes('transfer') || b.question.cognitive_level === 'transfer';
        if (aTransfer !== bTransfer) return Number(bTransfer) - Number(aTransfer);
      }
      const distance = Math.abs(difficultyRank(a.question.difficulty) - requestedRank) -
        Math.abs(difficultyRank(b.question.difficulty) - requestedRank);
      if (distance) return distance;
      const difficultyMix = mixNeed(blueprint.config, ranked, b.question.difficulty, 'difficulty_mix') -
        mixNeed(blueprint.config, ranked, a.question.difficulty, 'difficulty_mix');
      if (difficultyMix) return difficultyMix;
      const cognitiveMix = mixNeed(blueprint.config, ranked, b.question.cognitive_level, 'cognitive_mix') -
        mixNeed(blueprint.config, ranked, a.question.cognitive_level, 'cognitive_mix');
      if (cognitiveMix) return cognitiveMix;
      if (a.history.length !== b.history.length) return a.history.length - b.history.length;
      return a.question.source_item_id.localeCompare(b.question.source_item_id);
    })[0];
    const rubric = parsed<AssessmentSelection['rubric']>(selected.question.rubric_json, { schema: 1, criteria: [] });
    return {
      source_item_id: selected.question.source_item_id,
      source_answer_id: selected.question.source_answer_id,
      assessment_ref: selected.question.assessment_ref,
      canonical_concept_id: resolved.canonical_id,
      display_code: resolved.display_code,
      title: selected.question.title,
      prompt: selected.question.prompt,
      expected_answer: selected.question.expected_answer,
      difficulty: selected.question.difficulty,
      cognitive_level: selected.question.cognitive_level,
      rubric,
      acceptable_answers: parsed(selected.question.acceptable_answers_json, []),
      misconceptions: parsed(selected.question.misconceptions_json, []),
      distractors: parsed(selected.question.distractors_json, []),
      tags: tags(selected.question),
      prior_attempts: selected.history.length,
      last_outcome: selected.history.at(-1)?.outcome ?? null,
      answer_available: Boolean(selected.question.source_answer_id),
      age_fit: ageFits(selected.question, profile),
      blueprint: {
        id: blueprint.id, version: blueprint.version,
        max_exposures_per_item: blueprint.config.max_exposures_per_item,
      },
      provenance: {
        source_document_id: selected.question.source_document_id,
        source_locator: selected.question.source_locator,
        source_hash: selected.question.source_hash,
        graph_revision: selected.question.graph_revision,
      },
    };
  } finally { course.close(); student.close(); }
}

function rate(numerator: number, denominator: number): number {
  return Number((numerator / Math.max(1, denominator)).toFixed(3));
}

/** Build tutor-facing coverage, rubric, and blueprint statistics against the current question bank. */
export function materialQuestionStatistics(root: string, studentId: string): any {
  const course = openCourse(root);
  const student = openStudent(root, studentId);
  try {
    const questions = currentQuestions(course);
    const histories = historiesFor(course, student, questions);
    const rows = questions.map((question) => {
      const attempts = histories.get(question.source_item_id) ?? [];
      const rubric = parsed<{ criteria?: unknown[] }>(question.rubric_json, {});
      return {
        source_item_id: question.source_item_id,
        assessment_ref: question.assessment_ref,
        title: question.title,
        canonical_concept_ids: question.canonical_concept_ids ? question.canonical_concept_ids.split(',').sort() : [],
        display_codes: question.display_codes ? question.display_codes.split(',').sort() : [],
        difficulty: question.difficulty ?? 'unspecified',
        cognitive_level: question.cognitive_level ?? 'unspecified',
        tags: tags(question),
        answer_available: Boolean(question.source_answer_id),
        rubric_available: Boolean(rubric.criteria?.length),
        attempts: attempts.length,
        last_outcome: attempts.at(-1)?.outcome ?? null,
        best_score: attempts.length ? Math.max(...attempts.map((event) => event.score)) : null,
        mean_score: attempts.length ? Number((attempts.reduce((sum, event) => sum + event.score, 0) / attempts.length).toFixed(3)) : null,
        mean_grading_confidence: attempts.some((event) => event.grading_confidence !== null)
          ? Number((attempts.reduce((sum, event) => sum + (event.grading_confidence ?? 0), 0) /
            attempts.filter((event) => event.grading_confidence !== null).length).toFixed(3)) : null,
        hint_count: attempts.reduce((sum, event) => sum + event.hint_count, 0),
        correct: attempts.some((event) => event.outcome === 'correct'),
      };
    });
    const attempted = rows.filter((row) => row.attempts > 0);
    const correct = rows.filter((row) => row.correct);
    const dimensions = (keys: string[], selector: (row: (typeof rows)[number]) => string[]) => keys.map((key) => {
      const matching = rows.filter((row) => selector(row).includes(key));
      const attemptedRows = matching.filter((row) => row.attempts > 0);
      const correctRows = matching.filter((row) => row.correct);
      return {
        key, total_questions: matching.length, attempted_questions: attemptedRows.length,
        correct_questions: correctRows.length, coverage_rate: rate(attemptedRows.length, matching.length),
        correct_rate_on_attempted: rate(correctRows.length, attemptedRows.length),
      };
    });
    const blueprint = activeBlueprint(root);
    const conceptKeys = [...new Set(rows.flatMap((row) => row.canonical_concept_ids))].sort();
    const conceptCompliance = conceptKeys.map((conceptId) => {
      const conceptRows = rows.filter((row) => row.canonical_concept_ids.includes(conceptId));
      const unique = conceptRows.filter((row) => row.attempts > 0).length;
      return {
        canonical_concept_id: conceptId, unique_questions_attempted: unique,
        required: blueprint.config.min_unique_questions_per_concept,
        satisfied: unique >= blueprint.config.min_unique_questions_per_concept,
      };
    });
    const transferRows = rows.filter((row) => row.tags.includes('transfer') || row.cognitive_level === 'transfer');
    return {
      summary: {
        total_questions: rows.length,
        questions_with_answers: rows.filter((row) => row.answer_available).length,
        questions_with_rubrics: rows.filter((row) => row.rubric_available).length,
        attempted_questions: attempted.length,
        correct_questions: correct.length,
        unseen_questions: rows.length - attempted.length,
        coverage_rate: rate(attempted.length, rows.length),
        correct_rate_on_attempted: rate(correct.length, attempted.length),
      },
      blueprint: {
        id: blueprint.id, name: blueprint.name, version: blueprint.version,
        config: blueprint.config, concept_compliance: conceptCompliance,
        transfer_requirement_satisfied: !blueprint.config.transfer_required || transferRows.some((row) => row.attempts > 0 && row.correct),
      },
      by_difficulty: dimensions([...new Set(rows.map((row) => row.difficulty))].sort(), (row) => [row.difficulty])
        .map(({ key, ...rest }) => ({ difficulty: key, ...rest })),
      by_cognitive_level: dimensions([...new Set(rows.map((row) => row.cognitive_level))].sort(), (row) => [row.cognitive_level])
        .map(({ key, ...rest }) => ({ cognitive_level: key, ...rest })),
      by_concept: dimensions(conceptKeys, (row) => row.canonical_concept_ids)
        .map(({ key, ...rest }) => ({ canonical_concept_id: key, ...rest })),
      questions: rows,
    };
  } finally { course.close(); student.close(); }
}

function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const numerator = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0);
  const denominator = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) * ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
  return denominator ? Number((numerator / denominator).toFixed(3)) : null;
}

/** Cohort-safe item quality metrics. Detailed distributions are suppressed below minCohort. */
export function questionQualityAnalytics(root: string, studentIds: string[], minCohort = 3): unknown {
  const course = openCourse(root);
  try {
    const questions = currentQuestions(course);
    const acceptable = evidenceItemIds(course, questions.map((question) => question.source_item_id));
    const studentData = studentIds.map((studentId) => {
      const db = openStudent(root, studentId);
      try {
        const events = db.query(`SELECT source_item_id,score,outcome,selected_option,hint_count,grading_confidence
          FROM learning_events WHERE source_item_id IS NOT NULL`).all() as Array<{
            source_item_id: string; score: number; outcome: string; selected_option: string | null;
            hint_count: number; grading_confidence: number | null;
          }>;
        return { studentId, events, total: events.length ? events.reduce((sum, event) => sum + event.score, 0) / events.length : 0 };
      } finally { db.close(); }
    });
    return {
      privacy: { minimum_distinct_students: minCohort, rule: 'cohort distributions are suppressed below the threshold' },
      items: questions.map((question) => {
        const ids = acceptable.get(question.source_item_id) ?? new Set([question.source_item_id]);
        const perStudent = studentData.map((student) => {
          const events = student.events.filter((event) => ids.has(event.source_item_id));
          return { ...student, events, itemScore: events.length ? events.reduce((sum, event) => sum + event.score, 0) / events.length : null };
        }).filter((student) => student.events.length > 0);
        const distinct = perStudent.length;
        if (distinct < minCohort) return {
          source_item_id: question.source_item_id, assessment_ref: question.assessment_ref,
          distinct_students: distinct, suppressed: true,
        };
        const events = perStudent.flatMap((student) => student.events);
        const facility = events.reduce((sum, event) => sum + event.score, 0) / events.length;
        const discrimination = correlation(perStudent.map((student) => student.itemScore!), perStudent.map((student) => student.total));
        const hintRate = events.filter((event) => event.hint_count > 0).length / events.length;
        const confidences = events.filter((event) => event.grading_confidence !== null).map((event) => event.grading_confidence!);
        const meanConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
        const optionDistribution = Object.fromEntries([...new Set(events.map((event) => event.selected_option).filter(Boolean))]
          .map((option) => [option, events.filter((event) => event.selected_option === option).length]));
        const signals = [
          discrimination !== null && discrimination < 0.1 ? 'low_discrimination' : null,
          hintRate > 0.5 ? 'high_hint_dependence' : null,
          meanConfidence !== null && meanConfidence < 0.65 ? 'low_grading_confidence' : null,
          facility < 0.2 || facility > 0.95 ? 'extreme_facility' : null,
        ].filter(Boolean);
        return {
          source_item_id: question.source_item_id, assessment_ref: question.assessment_ref,
          distinct_students: distinct, attempts: events.length, suppressed: false,
          facility: Number(facility.toFixed(3)), discrimination, hint_rate: Number(hintRate.toFixed(3)),
          mean_grading_confidence: meanConfidence === null ? null : Number(meanConfidence.toFixed(3)),
          option_distribution: optionDistribution, review_signals: signals,
        };
      }),
    };
  } finally { course.close(); }
}
