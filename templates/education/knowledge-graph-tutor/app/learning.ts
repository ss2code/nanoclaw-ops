import fs from 'node:fs';
import path from 'node:path';

import { selectAssessmentItem } from './assessment';
import { resolveConcept } from './concepts';
import { type ActorContext, requireStudent, requireTutor } from './context';
import { isPedagogy, rankPedagogies, type Pedagogy } from './pedagogy';
import { audit, openClass, openCourse, openStudent, paths, studentDbPath } from './store';
import { appendTrace } from './trace';
import { bandRank, canonicalDifficulty, ensureDir, newId, now, sha256, stableId, TutorError, writeJsonAtomic } from './util';

function outcomeScore(outcome: string): number {
  if (outcome === 'correct') return 1;
  if (outcome === 'partial') return 0.55;
  if (outcome === 'hinted') return 0.3;
  if (outcome === 'incorrect') return 0;
  throw new TutorError('outcome must be correct, partial, hinted, or incorrect', 64);
}

function rubricAssessment(rubricJson: string | null, rawScores: Record<string, number> | undefined, hintCount: number): { score: number; outcome: string; scores: Record<string, number> | null } | null {
  if (!rawScores) return null;
  let criteria: Array<{ id: string; weight: number }> = [];
  try { criteria = (JSON.parse(rubricJson ?? '{}') as { criteria?: Array<{ id: string; weight: number }> }).criteria ?? []; }
  catch { criteria = []; }
  if (!criteria.length) throw new TutorError('assessment item has no rubric criteria', 65);
  const known = new Set(criteria.map((criterion) => criterion.id));
  if (Object.keys(rawScores).some((key) => !known.has(key))) throw new TutorError('rubric score contains an unknown criterion', 64);
  if (criteria.some((criterion) => !Number.isFinite(rawScores[criterion.id]) || rawScores[criterion.id] < 0 || rawScores[criterion.id] > 1)) {
    throw new TutorError('every rubric criterion must have a score between 0 and 1', 64);
  }
  const totalWeight = criteria.reduce((sum, criterion) => sum + Math.max(0, criterion.weight), 0) || 1;
  let score = criteria.reduce((sum, criterion) => sum + rawScores[criterion.id] * Math.max(0, criterion.weight), 0) / totalWeight;
  let outcome = score >= 0.85 ? 'correct' : score >= 0.45 ? 'partial' : 'incorrect';
  if (hintCount > 0 && outcome === 'correct') { outcome = 'hinted'; score = Math.min(score, 0.65); }
  return { score, outcome, scores: rawScores };
}

function bandFor(score: number, highestDifficulty: number, attempts: number): 'low' | 'medium' | 'high' {
  // Positive mastery is immediate: a student does not have to wait for a
  // calendar boundary to move forward. The delayed-review counters remain
  // observable evidence, but are not a promotion gate. A later negative
  // assessment is allowed to regress the band below, so the frontier can drive
  // remediation when the student's current evidence changes.
  if (attempts >= 4 && score >= 0.72 && highestDifficulty >= 3) return 'high';
  if (attempts >= 2 && score >= 0.58 && highestDifficulty >= 2) return 'medium';
  return 'low';
}

function regressOnNegativeEvidence(
  computed: 'low' | 'medium' | 'high',
  prior: string | undefined,
  outcome: string,
): 'low' | 'medium' | 'high' {
  if (outcome === 'correct' || !prior) return computed;
  const ceiling = Math.max(1, bandRank(prior) - 1);
  if (bandRank(computed) <= ceiling) return computed;
  return ceiling === 3 ? 'high' : ceiling === 2 ? 'medium' : 'low';
}

export interface AttemptOptions {
  eventKind?: 'practice' | 'review' | 'diagnostic';
  pedagogy?: Pedagogy;
  actionRevision?: number;
  traceId?: string;
  sourceItemId?: string;
  rubricScores?: Record<string, number>;
  gradingConfidence?: number;
  selectedOption?: string;
  hintCount?: number;
}

export function recordAttempt(root: string, actor: ActorContext, conceptCode: string, difficultyValue: string, outcome: string, idempotencyKey: string, evidence = '', options: AttemptOptions = {}): unknown {
  requireStudent(actor);
  const difficulty = canonicalDifficulty(difficultyValue);
  if (!difficulty) throw new TutorError('difficulty must be low, medium, or high', 64);
  const observedEvidence = evidence.trim();
  if (!observedEvidence) throw new TutorError('observed student evidence is required', 64);
  const concept = resolveConcept(root, conceptCode);
  const course = openCourse(root);
  const source = options.sourceItemId
    ? course.query(`SELECT q.id AS source_item_id,q.difficulty,q.assessment_ref,s.rubric_json,
        (SELECT a.id FROM content_items a WHERE a.graph_id=q.graph_id AND a.status='active' AND a.kind='answer'
          AND a.source_document_id=q.source_document_id AND a.answer_for_ref=q.assessment_ref ORDER BY a.id LIMIT 1) AS source_answer_id
      FROM content_items q JOIN knowledge_graphs g ON g.id=q.graph_id
      JOIN item_concepts ic ON ic.item_id=q.id JOIN concepts c ON c.id=ic.concept_id
      LEFT JOIN assessment_specs s ON s.question_item_id=q.id
      WHERE q.id=$item AND q.status='active' AND q.kind IN ('question','mcq') AND c.canonical_concept_id=$concept LIMIT 1`).get({
        $item: options.sourceItemId, $concept: concept.canonical_id,
      }) as { source_item_id: string; source_answer_id: string | null; difficulty: string | null; assessment_ref: string; rubric_json: string | null } | null
    : null;
  course.close();
  if (options.sourceItemId && !source) throw new TutorError('assessment item does not belong to the concept', 65);
  if (source?.difficulty && source.difficulty !== difficulty) throw new TutorError('attempt difficulty does not match the assessment item', 65);
  const hintCount = options.hintCount ?? 0;
  if (!Number.isInteger(hintCount) || hintCount < 0 || hintCount > 100) throw new TutorError('hint count must be a whole number between 0 and 100', 64);
  if (options.gradingConfidence !== undefined && (!Number.isFinite(options.gradingConfidence) || options.gradingConfidence < 0 || options.gradingConfidence > 1)) {
    throw new TutorError('grading confidence must be between 0 and 1', 64);
  }
  const rubric = rubricAssessment(source?.rubric_json ?? null, options.rubricScores, hintCount);
  const assessedOutcome = rubric?.outcome ?? outcome;
  const assessedScore = rubric?.score ?? outcomeScore(outcome);
  const eventKind = options.eventKind ?? 'practice';
  if (!['practice', 'review', 'diagnostic'].includes(eventKind)) throw new TutorError('event kind must be practice, review, or diagnostic', 64);
  if (options.pedagogy && !isPedagogy(options.pedagogy)) throw new TutorError('unsupported pedagogy', 64);
  const db = openStudent(root, actor.studentId);
  const prior = db.query('SELECT * FROM learning_events WHERE idempotency_key=$key').get({ $key: idempotencyKey });
  if (prior) {
    const mastery = db.query('SELECT * FROM mastery WHERE concept_code=$code').get({ $code: concept.canonical_id });
    db.close();
    return { idempotent: true, event: prior, mastery };
  }
  const id = newId('evt');
  const traceId = options.traceId ?? idempotencyKey;
  const observedAt = now();
  const masteryBefore = db.query('SELECT band FROM mastery WHERE concept_code=$code').get({ $code: concept.canonical_id }) as { band: string } | null;
  db.query(`INSERT INTO learning_events
    (id,at,concept_code,difficulty,outcome,score,evidence,idempotency_key,event_kind,pedagogy,action_revision,
     source_item_id,source_answer_id,source_assessment_ref,rubric_scores_json,grading_confidence,selected_option,hint_count)
    VALUES ($id,$at,$concept,$difficulty,$outcome,$score,$evidence,$key,$kind,$pedagogy,$revision,
      $sourceItem,$sourceAnswer,$assessmentRef,$rubricScores,$confidence,$selectedOption,$hintCount)`).run({
      $id: id, $at: now(), $concept: concept.canonical_id, $difficulty: difficulty, $outcome: assessedOutcome,
      $score: assessedScore, $evidence: observedEvidence.slice(0, 4000), $key: idempotencyKey,
      $kind: eventKind, $pedagogy: options.pedagogy ?? null, $revision: options.actionRevision ?? null,
      $sourceItem: source?.source_item_id ?? null, $sourceAnswer: source?.source_answer_id ?? null,
      $assessmentRef: source?.assessment_ref ?? null, $rubricScores: rubric?.scores ? JSON.stringify(rubric.scores) : null,
      $confidence: options.gradingConfidence ?? null, $selectedOption: options.selectedOption ?? null, $hintCount: hintCount,
    });
  const rows = db.query(`SELECT at,difficulty,outcome,score,event_kind FROM learning_events
    WHERE concept_code=$code ORDER BY at,id`).all({ $code: concept.canonical_id }) as Array<{
      at: string; difficulty: string; outcome: string; score: number; event_kind: string;
    }>;
  const earliestIndependent = rows.find((row) => row.outcome === 'correct' && row.event_kind !== 'review');
  const delayedReviews = earliestIndependent ? rows.filter((row) =>
    row.event_kind === 'review' && row.outcome === 'correct' &&
    Date.parse(row.at) - Date.parse(earliestIndependent.at) >= 24 * 60 * 60 * 1000).length : 0;
  const independentHigh = rows.filter((row) => row.difficulty === 'high' && row.outcome === 'correct').length;
  const aggregates = {
    attempts: rows.length,
    average: rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length),
    highest: Math.max(...rows.map((row) => row.difficulty === 'high' ? 3 : row.difficulty === 'medium' ? 2 : 1)),
  };
  const priorMastery = db.query('SELECT band FROM mastery WHERE concept_code=$code').get({ $code: concept.canonical_id }) as { band: string } | null;
  const computedBand = bandFor(aggregates.average, aggregates.highest, aggregates.attempts);
  const band = regressOnNegativeEvidence(computedBand, priorMastery?.band, assessedOutcome);
  db.query(`INSERT INTO mastery
    (concept_code,band,attempt_count,weighted_score,last_evidence_at,delayed_review_count,independent_high_count,last_band_change_at)
    VALUES ($code,$band,$count,$score,$at,$reviews,$high,$changed)
    ON CONFLICT(concept_code) DO UPDATE SET band=excluded.band,attempt_count=excluded.attempt_count,
    weighted_score=excluded.weighted_score,last_evidence_at=excluded.last_evidence_at,
    delayed_review_count=excluded.delayed_review_count,independent_high_count=excluded.independent_high_count,
    last_band_change_at=excluded.last_band_change_at`).run({
      $code: concept.canonical_id, $band: band, $count: aggregates.attempts, $score: aggregates.average, $at: observedAt,
      $reviews: delayedReviews, $high: independentHigh,
      $changed: priorMastery?.band === band ? null : observedAt,
    });
  const mastery = db.query('SELECT * FROM mastery WHERE concept_code=$code').get({ $code: concept.canonical_id });
  if (eventKind === 'review' && assessedOutcome === 'correct') {
    db.query(`UPDATE review_schedule SET status='completed',completed_at=$at,updated_at=$at
      WHERE concept_code=$code AND status IN ('pending','delivered') AND (due_at IS NULL OR due_at<=$at)`).run({
        $at: observedAt, $code: concept.canonical_id,
      });
  }
  appendTrace(db, actor.studentId, traceId, 'assessment', concept.canonical_id, {
    event_id: id, difficulty, outcome: assessedOutcome, event_kind: eventKind, score: assessedScore,
    pedagogy: options.pedagogy ?? null, evidence_length: evidence.length,
    source_item_id: source?.source_item_id ?? null, source_answer_id: source?.source_answer_id ?? null,
    rubric_scored: Boolean(rubric), grading_confidence: options.gradingConfidence ?? null, hint_count: hintCount,
  });
  appendTrace(db, actor.studentId, traceId, 'mastery', concept.canonical_id, {
    before: masteryBefore?.band ?? 'low', after: (mastery as Record<string, unknown>).band,
    attempt_count: (mastery as Record<string, unknown>).attempt_count,
    weighted_score: (mastery as Record<string, unknown>).weighted_score,
    delayed_review_count: (mastery as Record<string, unknown>).delayed_review_count,
  });
  db.close();
  audit(root, actor.role, actor.actorId, 'learning.record_attempt', 'concept', concept.canonical_id, {
    id, difficulty, outcome: assessedOutcome, eventKind, pedagogy: options.pedagogy ?? null, band, delayedReviews,
    sourceItemId: source?.source_item_id ?? null,
  });
  return {
    idempotent: false, event_id: id, mastery,
    assessment: source ? {
      source_item_id: source.source_item_id, source_answer_id: source.source_answer_id,
      assessment_ref: source.assessment_ref, rubric_scored: Boolean(rubric), score: assessedScore, outcome: assessedOutcome,
    } : null,
  };
}

export function mastery(root: string, actor: ActorContext, conceptCode?: string): unknown {
  requireStudent(actor);
  const canonical = conceptCode ? resolveConcept(root, conceptCode).canonical_id : null;
  const db = openStudent(root, actor.studentId);
  try {
    return canonical
      ? db.query('SELECT * FROM mastery WHERE concept_code=$code').get({ $code: canonical }) ?? { concept_code: canonical, band: 'low', attempt_count: 0, weighted_score: 0 }
      : db.query('SELECT * FROM mastery ORDER BY concept_code').all();
  } finally { db.close(); }
}

export interface ActionOptions {
  pedagogy?: Pedagogy;
  reasonCode?: string;
  retrieval?: unknown[];
  priority?: number;
  traceId?: string;
  sourceItemId?: string;
  sourceAnswerId?: string;
}

export function setAction(root: string, actor: ActorContext, conceptCode: string, actionType: string, prompt: string, expectedEvidence: string, difficultyValue: string, options: ActionOptions = {}): unknown {
  requireStudent(actor);
  const difficulty = canonicalDifficulty(difficultyValue);
  if (!difficulty) throw new TutorError('difficulty must be low, medium, or high', 64);
  const concept = resolveConcept(root, conceptCode);
  const db = openStudent(root, actor.studentId);
  const prior = db.query('SELECT revision FROM current_state WHERE id=1').get() as { revision: number } | null;
  const revision = (prior?.revision ?? 0) + 1;
  if (options.pedagogy && !isPedagogy(options.pedagogy)) throw new TutorError('unsupported pedagogy', 64);
  db.query(`INSERT INTO current_state
    (id,concept_code,action_type,prompt,expected_evidence,difficulty,revision,updated_at,pedagogy,reason_code,retrieval_json,priority,status,completed_at,source_item_id,source_answer_id)
    VALUES (1,$concept,$type,$prompt,$expected,$difficulty,$revision,$at,$pedagogy,$reason,$retrieval,$priority,'pending',NULL,$sourceItem,$sourceAnswer)
    ON CONFLICT(id) DO UPDATE SET concept_code=excluded.concept_code,action_type=excluded.action_type,
    prompt=excluded.prompt,expected_evidence=excluded.expected_evidence,difficulty=excluded.difficulty,
    revision=excluded.revision,updated_at=excluded.updated_at,pedagogy=excluded.pedagogy,
    reason_code=excluded.reason_code,retrieval_json=excluded.retrieval_json,priority=excluded.priority,
    status='pending',completed_at=NULL,source_item_id=excluded.source_item_id,source_answer_id=excluded.source_answer_id`).run({
      $concept: concept.canonical_id, $type: actionType, $prompt: prompt.slice(0, 8000), $expected: expectedEvidence.slice(0, 2000),
      $difficulty: difficulty, $revision: revision, $at: now(), $pedagogy: options.pedagogy ?? null,
      $reason: options.reasonCode ?? null, $retrieval: JSON.stringify(options.retrieval ?? []), $priority: options.priority ?? 0,
      $sourceItem: options.sourceItemId ?? null, $sourceAnswer: options.sourceAnswerId ?? null,
    });
  const row = db.query('SELECT * FROM current_state WHERE id=1').get();
  if (options.traceId) appendTrace(db, actor.studentId, options.traceId, 'action', concept.canonical_id, {
    revision, action_type: actionType, difficulty, pedagogy: options.pedagogy ?? null,
    reason_code: options.reasonCode ?? null, priority: options.priority ?? 0,
    source_item_id: options.sourceItemId ?? null, source_answer_id: options.sourceAnswerId ?? null,
  });
  db.close();
  return row;
}

export function completeAction(root: string, actor: ActorContext, revision: number): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  const row = db.query('SELECT revision,status FROM current_state WHERE id=1').get() as { revision: number; status: string } | null;
  if (!row) { db.close(); throw new TutorError('current action not found', 66); }
  if (row.revision !== revision) { db.close(); throw new TutorError('current action revision is stale', 65); }
  if (row.status === 'completed') { const prior = db.query('SELECT * FROM current_state WHERE id=1').get(); db.close(); return { idempotent: true, action: prior }; }
  db.query(`UPDATE current_state SET status='completed',completed_at=$at,updated_at=$at WHERE id=1`).run({ $at: now() });
  const action = db.query('SELECT * FROM current_state WHERE id=1').get();
  db.close();
  return { idempotent: false, action };
}

export function recordMisconception(root: string, actor: ActorContext, conceptCode: string, description: string, confidence: number, evidenceEventId?: string): unknown {
  requireStudent(actor);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new TutorError('confidence must be between 0 and 1', 64);
  const concept = resolveConcept(root, conceptCode);
  const db = openStudent(root, actor.studentId);
  if (evidenceEventId && !db.query('SELECT 1 FROM learning_events WHERE id=$id').get({ $id: evidenceEventId })) {
    db.close(); throw new TutorError('evidence event not found', 66);
  }
  const existing = db.query(`SELECT id,occurrence_count FROM misconceptions
    WHERE concept_code=$concept AND lower(description)=lower($description) AND status!='resolved' LIMIT 1`).get({
      $concept: concept.canonical_id, $description: description.slice(0, 4000),
    }) as { id: string; occurrence_count: number } | null;
  if (existing) {
    db.query(`UPDATE misconceptions SET confidence=MAX(confidence,$confidence),evidence_event_id=COALESCE($event,evidence_event_id),
      occurrence_count=occurrence_count+1,updated_at=$at WHERE id=$id`).run({
        $confidence: confidence, $event: evidenceEventId ?? null, $at: now(), $id: existing.id,
    });
    const result = db.query('SELECT * FROM misconceptions WHERE id=$id').get({ $id: existing.id });
    appendTrace(db, actor.studentId, evidenceEventId ?? existing.id, 'misconception', concept.canonical_id, {
      action: 'reinforced', misconception_id: existing.id, confidence,
    });
    db.close();
    return { reinforced: true, misconception: result };
  }
  const id = newId('mis');
  db.query(`INSERT INTO misconceptions (id,concept_code,description,confidence,evidence_event_id,status,created_at)
    VALUES ($id,$concept,$description,$confidence,$event,'active',$at)`).run({
      $id: id, $concept: concept.canonical_id, $description: description.slice(0, 4000), $confidence: confidence,
      $event: evidenceEventId ?? null, $at: now(),
    });
  appendTrace(db, actor.studentId, evidenceEventId ?? id, 'misconception', concept.canonical_id, {
    action: 'created', misconception_id: id, confidence,
  });
  db.close();
  return { reinforced: false, id, concept_code: concept.canonical_id, display_code: concept.display_code, status: 'active' };
}

export function updateMisconception(root: string, actor: ActorContext, id: string, status: 'remediating' | 'resolved', evidenceEventId: string): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  const event = db.query('SELECT outcome FROM learning_events WHERE id=$id').get({ $id: evidenceEventId }) as { outcome: string } | null;
  if (!event) { db.close(); throw new TutorError('evidence event not found', 66); }
  const misconception = db.query('SELECT * FROM misconceptions WHERE id=$id').get({ $id: id }) as Record<string, unknown> | null;
  if (!misconception) { db.close(); throw new TutorError('misconception not found', 66); }
  if (status === 'resolved' && event.outcome !== 'correct') { db.close(); throw new TutorError('resolution requires correct evidence', 65); }
  db.query(`UPDATE misconceptions SET status=$status,evidence_event_id=$event,updated_at=$at,
    resolved_at=CASE WHEN $status='resolved' THEN $at ELSE NULL END WHERE id=$id`).run({
      $status: status, $event: evidenceEventId, $at: now(), $id: id,
  });
  const result = db.query('SELECT * FROM misconceptions WHERE id=$id').get({ $id: id });
  appendTrace(db, actor.studentId, evidenceEventId, 'misconception', String(misconception.concept_code), {
    action: status, misconception_id: id, evidence_event_id: evidenceEventId,
  });
  db.close();
  return result;
}

export function computeFrontier(root: string, actor: ActorContext, traceId?: string): unknown {
  requireStudent(actor);
  const course = openCourse(root);
  const student = openStudent(root, actor.studentId);
  try {
    const priorTrace = student.query(`SELECT state_json FROM learning_traces WHERE stage='frontier' ORDER BY at DESC,id DESC LIMIT 1`).get() as { state_json: string } | null;
    let priorEligible = new Set<string>();
    if (priorTrace) {
      try {
        const state = JSON.parse(priorTrace.state_json) as { eligible?: Array<{ concept_code: string }> };
        priorEligible = new Set((state.eligible ?? []).map((row) => row.concept_code));
      } catch { priorEligible = new Set(); }
    }
    const conceptRows = course.query(`SELECT c.id,c.code,c.canonical_concept_id,c.title,g.version AS revision FROM concepts c
      JOIN knowledge_graphs g ON g.id=c.graph_id WHERE c.status='active' ORDER BY c.code`).all() as Array<{
        id: string; code: string; canonical_concept_id: string | null; title: string; revision: number;
      }>;
    const concepts = [...conceptRows.reduce((map, row) => {
      const key = row.canonical_concept_id ?? row.code;
      const prior = map.get(key);
      if (!prior || prior.revision < row.revision) map.set(key, {
        canonical_id: key, display_code: row.code, title: row.title, revision: row.revision,
      });
      return map;
    }, new Map<string, { canonical_id: string; display_code: string; title: string; revision: number }>()).values()];
    const edges = course.query(`SELECT COALESCE(a.canonical_concept_id,a.code) AS prerequisite,
        COALESCE(b.canonical_concept_id,b.code) AS target FROM concept_edges e
      JOIN concepts a ON a.id=e.from_concept_id JOIN concepts b ON b.id=e.to_concept_id
      WHERE e.status='active' AND a.status='active' AND b.status='active' AND e.type='prerequisite_of'`).all() as Array<{ prerequisite: string; target: string }>;
    const masteryRows = student.query('SELECT concept_code,band,attempt_count FROM mastery').all() as Array<{ concept_code: string; band: string; attempt_count: number }>;
    const bands = new Map(masteryRows.map((row) => [row.concept_code, row.band]));
    const attempts = new Map(masteryRows.map((row) => [row.concept_code, row.attempt_count]));
    const activeMisconceptions = new Set((student.query(`SELECT concept_code FROM misconceptions WHERE status!='resolved'`).all() as Array<{ concept_code: string }>).map((row) => row.concept_code));
    const dueReviews = new Set((student.query(`SELECT concept_code FROM review_schedule
      WHERE status='pending' AND (due_at IS NULL OR due_at<=$now)`).all({ $now: now() }) as Array<{ concept_code: string }>).map((row) => row.concept_code));
    const assigned = new Set((student.query(`SELECT concept_code FROM assignments
      WHERE status='pending' AND concept_code IS NOT NULL`).all() as Array<{ concept_code: string }>).map((row) => row.concept_code));
    const eligible = concepts.map((concept) => {
      const prerequisites = [...new Set(edges.filter((edge) => edge.target === concept.canonical_id).map((edge) => edge.prerequisite))];
      const unmet = prerequisites.filter((code) => bandRank(bands.get(code) ?? 'low') < 2 || activeMisconceptions.has(code));
      const currentBand = bands.get(concept.canonical_id) ?? 'low';
      const due = dueReviews.has(concept.canonical_id);
      const misconception = activeMisconceptions.has(concept.canonical_id);
      const eligibility = unmet.length > 0 ? 'blocked' : currentBand === 'high' && !due && !misconception ? 'mastered' : 'eligible';
      const reason = eligibility === 'blocked'
        ? `unmet prerequisites or misconceptions: ${unmet.join(', ')}`
        : due ? 'due spaced review'
          : misconception ? 'active misconception requires remediation'
            : assigned.has(concept.canonical_id) ? 'tutor assignment'
              : eligibility === 'mastered' ? 'high mastery evidence; later negative evidence can reopen practice'
                : prerequisites.length ? 'prerequisites met' : 'root concept';
      const priority = due ? 100 : misconception ? 95 : assigned.has(concept.canonical_id) ? 90 : currentBand === 'medium' ? 70 : 60;
      const action_type = due ? 'review' : misconception ? 'remediate' : assigned.has(concept.canonical_id) ? 'assignment' : attempts.get(concept.canonical_id) ? 'practice' : 'teach';
      const difficulty = due || currentBand === 'medium' ? 'high' : (attempts.get(concept.canonical_id) ?? 0) >= 1 ? 'medium' : 'low';
      student.query(`INSERT INTO frontier (concept_code,eligibility,reason,course_revision,updated_at)
        VALUES ($code,$eligibility,$reason,$revision,$at)
        ON CONFLICT(concept_code) DO UPDATE SET eligibility=excluded.eligibility,reason=excluded.reason,
        course_revision=excluded.course_revision,updated_at=excluded.updated_at`).run({
          $code: concept.canonical_id, $eligibility: eligibility, $reason: reason, $revision: concept.revision, $at: now(),
        });
      return {
        concept_code: concept.canonical_id, display_code: concept.display_code, title: concept.title, mastery_band: currentBand, eligibility, reason,
        reason_code: due ? 'due_review' : misconception ? 'active_misconception' : assigned.has(concept.canonical_id) ? 'assignment' : eligibility,
        action_type, difficulty, priority, course_revision: concept.revision,
      };
    });
    const currentEligible = eligible.filter((row) => row.eligibility === 'eligible')
      .sort((a, b) => b.priority - a.priority || a.concept_code.localeCompare(b.concept_code));
    if (traceId) appendTrace(student, actor.studentId, traceId, 'frontier', currentEligible[0]?.concept_code ?? null, {
      eligible: currentEligible.map((row) => ({ concept_code: row.concept_code, priority: row.priority, reason_code: row.reason_code })),
      blocked: eligible.filter((row) => row.eligibility === 'blocked').length,
      mastered: eligible.filter((row) => row.eligibility === 'mastered').length,
      newly_unlocked: currentEligible.filter((row) => !priorEligible.has(row.concept_code)).map((row) => row.concept_code),
      course_revisions: [...new Set(eligible.map((row) => row.course_revision))],
    });
    return {
      student_id: actor.studentId,
      eligible: currentEligible,
      all: eligible,
    };
  } finally { course.close(); student.close(); }
}

export function planNextAction(root: string, actor: ActorContext, idempotencyKey: string, preferredPedagogy?: string): unknown {
  requireStudent(actor);
  const frontier = computeFrontier(root, actor, idempotencyKey) as {
    eligible: Array<{ concept_code: string; title: string; action_type: string; difficulty: string; priority: number; reason_code: string; course_revision: number }>;
  };
  const selectedConcept = frontier.eligible[0];
  if (!selectedConcept) throw new TutorError('no eligible frontier action', 66);
  const db = openStudent(root, actor.studentId);
  const prior = db.query('SELECT * FROM teaching_decisions WHERE idempotency_key=$key').get({ $key: idempotencyKey });
  if (prior) { db.close(); return { idempotent: true, decision: prior }; }
  const events = db.query(`SELECT outcome FROM learning_events WHERE concept_code=$concept ORDER BY at DESC,id DESC LIMIT 20`).all({
    $concept: selectedConcept.concept_code,
  }) as Array<{ outcome: string }>;
  const preference = db.query('SELECT preferences_json FROM profile WHERE id=1').get() as { preferences_json: string } | null;
  let preferences: Record<string, unknown> = {};
  try { preferences = JSON.parse(preference?.preferences_json ?? '{}') as Record<string, unknown>; } catch { preferences = {}; }
  const activeMisconception = Boolean(db.query(`SELECT 1 FROM misconceptions WHERE concept_code=$concept AND status!='resolved' LIMIT 1`).get({ $concept: selectedConcept.concept_code }));
  const dueReview = Boolean(db.query(`SELECT 1 FROM review_schedule WHERE concept_code=$concept AND status='pending'
    AND (due_at IS NULL OR due_at<=$now) LIMIT 1`).get({ $concept: selectedConcept.concept_code, $now: now() }));
  const assessment = selectAssessmentItem(root, actor.studentId, selectedConcept.concept_code, selectedConcept.difficulty);
  const actionDifficulty = assessment?.difficulty ?? selectedConcept.difficulty;
  const candidates = rankPedagogies({
    dueReview,
    activeMisconception,
    attemptCount: events.length,
    lastOutcome: events[0]?.outcome,
    hintedRatio: events.length ? events.filter((event) => event.outcome === 'hinted').length / events.length : 0,
    relatedEligibleCount: frontier.eligible.length,
    visualPreference: preferences.learning_style === 'visual' || preferences.visuals === true,
    analogyPreference: preferences.learning_style === 'analogy' || preferences.analogies === true,
    sourceQuestionAvailable: Boolean(assessment),
    sourceQuestionAttemptCount: assessment?.prior_attempts,
    sourceQuestionLastOutcome: assessment?.last_outcome ?? undefined,
    sourceAnswerAvailable: assessment?.answer_available,
  });
  const requested = preferredPedagogy ? candidates.find((candidate) => candidate.pedagogy === preferredPedagogy) : undefined;
  if (preferredPedagogy && (!isPedagogy(preferredPedagogy) || !requested)) {
    db.close(); throw new TutorError('preferred pedagogy is outside the eligible candidate set', 65);
  }
  const pedagogy = requested ?? candidates[0];
  const id = stableId('decision', actor.studentId, idempotencyKey);
  db.query(`INSERT INTO teaching_decisions
    (id,at,concept_code,difficulty,pedagogy,reason_code,candidate_json,frontier_revision,idempotency_key,source_item_id,source_answer_id)
    VALUES ($id,$at,$concept,$difficulty,$pedagogy,$reason,$candidates,$revision,$key,$sourceItem,$sourceAnswer)`).run({
      $id: id, $at: now(), $concept: selectedConcept.concept_code, $difficulty: actionDifficulty,
      $pedagogy: pedagogy.pedagogy, $reason: pedagogy.reason_code, $candidates: JSON.stringify(candidates),
      $revision: selectedConcept.course_revision, $key: idempotencyKey,
      $sourceItem: assessment?.source_item_id ?? null, $sourceAnswer: assessment?.source_answer_id ?? null,
    });
  appendTrace(db, actor.studentId, idempotencyKey, 'decision', selectedConcept.concept_code, {
    selected: { concept_code: selectedConcept.concept_code, difficulty: actionDifficulty, ...pedagogy },
    candidates, frontier_priority: selectedConcept.priority, frontier_reason_code: selectedConcept.reason_code,
    assessment: assessment ? {
      source_item_id: assessment.source_item_id, source_answer_id: assessment.source_answer_id,
      assessment_ref: assessment.assessment_ref, prior_attempts: assessment.prior_attempts,
      last_outcome: assessment.last_outcome, answer_available: assessment.answer_available,
      canonical_concept_id: assessment.canonical_concept_id, display_code: assessment.display_code,
      cognitive_level: assessment.cognitive_level, rubric: assessment.rubric,
      acceptable_answers: assessment.acceptable_answers, misconceptions: assessment.misconceptions,
      distractors: assessment.distractors, tags: assessment.tags, age_fit: assessment.age_fit,
      blueprint: assessment.blueprint,
    } : null,
  });
  db.close();
  const action = setAction(
    root, actor, selectedConcept.concept_code, selectedConcept.action_type,
    assessment?.prompt ?? `${pedagogy.pedagogy}: ${selectedConcept.title}`,
    assessment?.expected_answer ?? `Assess ${selectedConcept.concept_code} at ${selectedConcept.difficulty} difficulty`,
    actionDifficulty,
    {
      pedagogy: pedagogy.pedagogy, reasonCode: pedagogy.reason_code, priority: selectedConcept.priority, traceId: idempotencyKey,
      sourceItemId: assessment?.source_item_id, sourceAnswerId: assessment?.source_answer_id ?? undefined,
      retrieval: assessment ? [{ ...assessment.provenance, assessment_ref: assessment.assessment_ref }] : [],
    },
  );
  return {
    idempotent: false,
    decision: {
      id, concept_code: selectedConcept.concept_code, difficulty: actionDifficulty, ...pedagogy, candidates,
      assessment: assessment ? {
        source_item_id: assessment.source_item_id, source_answer_id: assessment.source_answer_id,
        assessment_ref: assessment.assessment_ref, prior_attempts: assessment.prior_attempts,
        last_outcome: assessment.last_outcome, answer_available: assessment.answer_available,
        canonical_concept_id: assessment.canonical_concept_id, display_code: assessment.display_code,
        cognitive_level: assessment.cognitive_level, rubric: assessment.rubric,
        acceptable_answers: assessment.acceptable_answers, misconceptions: assessment.misconceptions,
        distractors: assessment.distractors, tags: assessment.tags, age_fit: assessment.age_fit,
        blueprint: assessment.blueprint,
      } : null,
    },
    action,
  };
}

export function currentContext(root: string, actor: ActorContext): unknown {
  const classDb = openClass(root);
  const audience = classDb.query(`SELECT grade_level,age_min,age_max,target_age,explanation_level FROM class_config WHERE id=1`).get();
  classDb.close();
  if (actor.role === 'tutor') return { role: 'tutor', actor_id: actor.actorId, routing: actor.routing, audience };
  const db = openStudent(root, actor.studentId);
  try {
    return {
      role: 'student', student_id: actor.studentId, display_name: actor.displayName,
      routing: actor.routing, audience,
      current_action: db.query('SELECT * FROM current_state WHERE id=1').get() ?? null,
      mastery_summary: db.query(`SELECT band,COUNT(*) AS concepts FROM mastery GROUP BY band ORDER BY band`).all(),
      active_misconceptions: db.query(`SELECT concept_code,description,confidence FROM misconceptions WHERE status='active' ORDER BY created_at DESC LIMIT 10`).all(),
    };
  } finally { db.close(); }
}

export function remember(root: string, actor: ActorContext, title: string, content: string): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  const contentHash = sha256(content.trim().toLowerCase());
  const existing = db.query(`SELECT id FROM student_memories WHERE content_hash=$hash AND status='active'`).get({ $hash: contentHash }) as { id: string } | null;
  const id = existing?.id ?? newId('mem');
  if (existing) {
    db.query(`UPDATE student_memories SET title=$title,content=$content,updated_at=$at WHERE id=$id`).run({ $title: title, $content: content, $at: now(), $id: id });
  } else {
    db.query(`INSERT INTO student_memories (id,title,content,content_hash,status,created_at,updated_at)
      VALUES ($id,$title,$content,$hash,'active',$at,$at)`).run({ $id: id, $title: title, $content: content, $hash: contentHash, $at: now() });
  }
  db.query(`INSERT INTO memory_events (memory_id,action,at,detail_json) VALUES ($id,$action,$at,$detail)`).run({
    $id: id, $action: existing ? 'revise' : 'remember', $at: now(), $detail: JSON.stringify({ title }),
  });
  db.close();
  return { id, revised: Boolean(existing), title };
}

export function recall(root: string, actor: ActorContext, query: string): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  try {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const rows = db.query(`SELECT id,title,content,updated_at FROM student_memories WHERE status='active' ORDER BY updated_at DESC LIMIT 100`).all() as Array<Record<string, string>>;
    const hits = rows.map((row) => ({ ...row, score: terms.filter((term) => `${row.title} ${row.content}`.toLowerCase().includes(term)).length }))
      .filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
    return { hit_count: hits.length, results: hits };
  } finally { db.close(); }
}

export function resolveStudent(root: string, friendly: string): { id: string; display_name: string; status: string } {
  const db = openClass(root);
  try {
    const exact = db.query(`SELECT id,display_name,status FROM students WHERE lower(display_name)=lower($name) OR id=$name`).all({ $name: friendly }) as Array<{ id: string; display_name: string; status: string }>;
    if (exact.length !== 1) throw new TutorError(exact.length ? 'student reference is ambiguous' : 'student not found', 66);
    if (exact[0].status === 'archived') throw new TutorError('student is archived', 77);
    return exact[0];
  } finally { db.close(); }
}

export function roster(root: string, actor: ActorContext): unknown {
  requireTutor(actor);
  const db = openClass(root);
  try { return db.query('SELECT id,display_name,status,instructor_approved_at FROM students ORDER BY display_name').all(); }
  finally { db.close(); }
}

export function exportProfileMemory(root: string, actor: ActorContext, friendly: string): unknown {
  requireTutor(actor);
  const target = resolveStudent(root, friendly);
  const db = openStudent(root, target.id);
  const payload = {
    schema: 1, exported_at: now(), student: target,
    profile: db.query('SELECT * FROM profile WHERE id=1').get(),
    memories: db.query(`SELECT id,title,content,status,created_at,updated_at,expires_at FROM student_memories ORDER BY updated_at`).all(),
  };
  db.close();
  const hash = sha256(JSON.stringify(payload));
  const dir = path.join(paths(root).reportsDir, target.id);
  ensureDir(dir);
  const file = path.join(dir, `profile-memory-${Date.now()}.json`);
  writeJsonAtomic(file, { ...payload, sha256: hash });
  audit(root, actor.role, actor.actorId, 'admin.export_profile_memory', 'student', target.id, { file, hash });
  return { student_id: target.id, display_name: target.display_name, file, sha256: hash };
}

export function interventionCommand(root: string, actor: ActorContext, friendly: string, conceptCode: string, difficultyValue: string, schedule: string, idempotency: string): unknown {
  requireTutor(actor);
  const target = resolveStudent(root, friendly);
  const concept = resolveConcept(root, conceptCode);
  const difficulty = canonicalDifficulty(difficultyValue);
  if (!difficulty) throw new TutorError('difficulty must be low, medium, or high', 64);
  const inbox = path.join(paths(root).studentsDir, target.id, 'inbox');
  ensureDir(inbox);
  const id = stableId('cmd', target.id, idempotency);
  const existing = path.join(inbox, `${id}.json`);
  if (fs.existsSync(existing)) return JSON.parse(fs.readFileSync(existing, 'utf8'));
  const unsigned = {
    schema: 1, id, target_student_id: target.id, action: 'schedule_review', concept_code: concept.canonical_id,
    difficulty, schedule, idempotency_key: idempotency, created_by: actor.actorId, created_at: now(),
  };
  const command = { ...unsigned, hash: sha256(JSON.stringify(unsigned)) };
  writeJsonAtomic(existing, command);
  audit(root, actor.role, actor.actorId, 'admin.intervention_command', 'student', target.id, { id, conceptCode: concept.canonical_id, difficulty, schedule });
  return { command_id: id, target_student_id: target.id, display_name: target.display_name, hash: command.hash, receipt: 'INTERVENTION QUEUED' };
}

export function applyInbox(root: string, actor: ActorContext): unknown {
  requireStudent(actor);
  const inbox = path.join(paths(root).studentsDir, actor.studentId, 'inbox');
  ensureDir(inbox);
  const db = openStudent(root, actor.studentId);
  const applied: string[] = [];
  const rejected: string[] = [];
  for (const file of fs.readdirSync(inbox).filter((name) => name.endsWith('.json')).sort()) {
    const command = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8')) as Record<string, unknown>;
    if (command.target_student_id !== actor.studentId) { rejected.push(file); continue; }
    const { hash, ...unsigned } = command;
    if (sha256(JSON.stringify(unsigned)) !== hash) { rejected.push(file); continue; }
    if (db.query('SELECT 1 FROM applied_commands WHERE command_id=$id').get({ $id: command.id })) continue;
    if (command.action === 'schedule_review') {
      db.query(`INSERT OR IGNORE INTO review_schedule
        (id,concept_code,difficulty,schedule_text,status,created_at,reason,due_at,cadence,timezone,quiet_start,quiet_end,revision,updated_at)
        VALUES ($id,$concept,$difficulty,$schedule,'pending',$at,$reason,$due,$cadence,$timezone,$quietStart,$quietEnd,1,$at)`).run({
        $id: command.id, $concept: command.concept_code, $difficulty: command.difficulty,
          $schedule: command.schedule, $at: now(), $reason: command.reason ?? 'tutor intervention',
          $due: command.due_at ?? null, $cadence: command.cadence ?? null, $timezone: command.timezone ?? 'UTC',
          $quietStart: command.quiet_start ?? null, $quietEnd: command.quiet_end ?? null,
        });
    } else if (command.action === 'assignment_add' || command.action === 'guidance_add') {
      const body = command.action === 'guidance_add' ? `Tutor guidance: ${String(command.guidance ?? '')}` : String(command.body ?? '');
      db.query(`INSERT OR IGNORE INTO assignments
        (id,concept_code,body,status,due_at,created_at,idempotency_key,updated_at)
        VALUES ($id,$concept,$body,'pending',$due,$at,$key,$at)`).run({
          $id: command.id, $concept: command.concept_code ?? null, $body: body.slice(0, 8000),
          $due: command.due_at ?? null, $at: now(), $key: command.idempotency_key ?? command.id,
        });
    } else { rejected.push(file); continue; }
    const receipt = { command_id: command.id, action: command.action, applied_at: now() };
    db.query(`INSERT INTO applied_commands (command_id,command_hash,applied_at,receipt_json)
      VALUES ($id,$hash,$at,$receipt)`).run({ $id: command.id, $hash: hash, $at: receipt.applied_at, $receipt: JSON.stringify(receipt) });
    appendTrace(db, actor.studentId, String(command.id), 'receipt', command.concept_code ? String(command.concept_code) : null, receipt);
    applied.push(String(command.id));
  }
  db.close();
  return { student_id: actor.studentId, applied_count: applied.length, applied, rejected_count: rejected.length, rejected };
}
