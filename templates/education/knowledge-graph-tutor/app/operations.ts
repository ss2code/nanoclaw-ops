import fs from 'node:fs';
import path from 'node:path';

import { materialQuestionStatistics, questionQualityAnalytics } from './assessment';
import { resolveConcept } from './concepts';
import { type ActorContext, requireStudent, requireTutor } from './context';
import { materialSummary } from './instruction-resources';
import { resolveStudent } from './learning';
import { audit, openClass, openCourse, openStudent, paths } from './store';
import { appendTrace } from './trace';
import { canonicalDifficulty, ensureDir, now, sha256, stableId, TutorError, writeJsonAtomic } from './util';

function validIso(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TutorError(`${name} must be an ISO date`, 64);
  return parsed.toISOString();
}

function validTime(value: string | undefined, name: string): string | null {
  if (!value) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new TutorError(`${name} must use HH:MM`, 64);
  return value;
}

function queueStudentCommand(root: string, actor: ActorContext, friendly: string, action: string, body: Record<string, unknown>, idempotency: string): unknown {
  requireTutor(actor);
  const target = resolveStudent(root, friendly);
  const inbox = path.join(paths(root).studentsDir, target.id, 'inbox');
  ensureDir(inbox);
  const id = stableId('cmd', target.id, action, idempotency);
  const file = path.join(inbox, `${id}.json`);
  if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), idempotent: true };
  const unsigned = {
    schema: 2, id, target_student_id: target.id, action, ...body,
    idempotency_key: idempotency, created_by: actor.actorId, created_at: now(),
  };
  const command = { ...unsigned, hash: sha256(JSON.stringify(unsigned)) };
  writeJsonAtomic(file, command);
  audit(root, actor.role, actor.actorId, `admin.${action}`, 'student', target.id, { id, ...body });
  return { command_id: id, target_student_id: target.id, display_name: target.display_name, action, hash: command.hash, idempotent: false, receipt: 'COMMAND QUEUED' };
}

export function setPolicy(root: string, actor: ActorContext, key: string, value: unknown, idempotency: string): unknown {
  requireTutor(actor);
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(key)) throw new TutorError('invalid policy key', 64);
  const db = openClass(root);
  const prior = db.query('SELECT value_json FROM policies WHERE key=$key').get({ $key: key }) as { value_json: string } | null;
  const valueJson = JSON.stringify(value);
  if (prior?.value_json === valueJson) { db.close(); return { key, value, idempotent: true, receipt: 'POLICY UNCHANGED' }; }
  db.query(`INSERT INTO policies (key,value_json,updated_at) VALUES ($key,$value,$at)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run({
      $key: key, $value: valueJson, $at: now(),
    });
  db.query('UPDATE class_config SET policy_version=policy_version+1 WHERE id=1').run();
  const version = (db.query('SELECT policy_version FROM class_config WHERE id=1').get() as { policy_version: number }).policy_version;
  db.close();
  audit(root, actor.role, actor.actorId, 'admin.policy_set', 'policy', key, { idempotency, version, value });
  return { key, value, policy_version: version, idempotent: false, receipt: 'POLICY UPDATED' };
}

export function getPolicy(root: string, actor: ActorContext, key?: string): unknown {
  requireTutor(actor);
  const db = openClass(root);
  try {
    const rows = key
      ? db.query('SELECT key,value_json,updated_at FROM policies WHERE key=$key').all({ $key: key })
      : db.query('SELECT key,value_json,updated_at FROM policies ORDER BY key').all();
    return (rows as Array<{ key: string; value_json: string; updated_at: string }>).map((row) => ({ ...row, value: JSON.parse(row.value_json), value_json: undefined }));
  } finally { db.close(); }
}

export function queueAssignment(root: string, actor: ActorContext, friendly: string, concept: string, body: string, dueAt: string | undefined, idempotency: string): unknown {
  const canonical = resolveConcept(root, concept);
  return queueStudentCommand(root, actor, friendly, 'assignment_add', {
    concept_code: canonical.canonical_id, body: body.slice(0, 8000), due_at: validIso(dueAt, 'due-at'),
  }, idempotency);
}

export function queueGuidance(root: string, actor: ActorContext, friendly: string, concept: string, guidance: string, idempotency: string): unknown {
  const canonical = resolveConcept(root, concept);
  return queueStudentCommand(root, actor, friendly, 'guidance_add', {
    concept_code: canonical.canonical_id, guidance: guidance.slice(0, 4000),
  }, idempotency);
}

export interface ReviewInput {
  concept: string;
  difficulty: string;
  scheduleText: string;
  dueAt?: string;
  reason?: string;
  cadence?: string;
  timezone?: string;
  quietStart?: string;
  quietEnd?: string;
  idempotency: string;
}

export function addReview(root: string, actor: ActorContext, input: ReviewInput): unknown {
  requireStudent(actor);
  const concept = resolveConcept(root, input.concept);
  const difficulty = canonicalDifficulty(input.difficulty);
  if (!difficulty) throw new TutorError('difficulty must be low, medium, or high', 64);
  const id = stableId('review', actor.studentId, input.idempotency);
  const db = openStudent(root, actor.studentId);
  const prior = db.query('SELECT * FROM review_schedule WHERE id=$id').get({ $id: id });
  if (prior) { db.close(); return { idempotent: true, review: prior }; }
  const at = now();
  db.query(`INSERT INTO review_schedule
    (id,concept_code,difficulty,schedule_text,status,created_at,reason,due_at,cadence,timezone,quiet_start,quiet_end,revision,updated_at)
    VALUES ($id,$concept,$difficulty,$schedule,'pending',$at,$reason,$due,$cadence,$timezone,$quietStart,$quietEnd,1,$at)`).run({
      $id: id, $concept: concept.canonical_id, $difficulty: difficulty, $schedule: input.scheduleText.slice(0, 500),
      $at: at, $reason: (input.reason ?? 'spaced review').slice(0, 1000), $due: validIso(input.dueAt, 'due-at'),
      $cadence: input.cadence?.slice(0, 200) ?? null, $timezone: input.timezone ?? 'UTC',
      $quietStart: validTime(input.quietStart, 'quiet-start'), $quietEnd: validTime(input.quietEnd, 'quiet-end'),
    });
  const review = db.query('SELECT * FROM review_schedule WHERE id=$id').get({ $id: id });
  appendTrace(db, actor.studentId, input.idempotency, 'schedule', concept.canonical_id, {
    action: 'review_add', review_id: id, difficulty, due_at: input.dueAt ?? null,
    cadence: input.cadence ?? null, timezone: input.timezone ?? 'UTC',
  });
  db.close();
  return { idempotent: false, review, receipt: 'REVIEW SCHEDULED' };
}

export function listReviews(root: string, actor: ActorContext): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  try { return db.query('SELECT * FROM review_schedule ORDER BY COALESCE(due_at,created_at),id').all(); }
  finally { db.close(); }
}

export function updateReview(root: string, actor: ActorContext, id: string, action: 'pause' | 'resume' | 'cancel'): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  const row = db.query('SELECT status,revision FROM review_schedule WHERE id=$id').get({ $id: id }) as { status: string; revision: number } | null;
  if (!row) { db.close(); throw new TutorError('review not found', 66); }
  const status = action === 'resume' ? 'pending' : action === 'pause' ? 'paused' : 'cancelled';
  if (row.status === status) { const review = db.query('SELECT * FROM review_schedule WHERE id=$id').get({ $id: id }); db.close(); return { idempotent: true, review }; }
  db.query(`UPDATE review_schedule SET status=$status,revision=revision+1,updated_at=$at WHERE id=$id`).run({
    $status: status, $at: now(), $id: id,
  });
  const review = db.query('SELECT * FROM review_schedule WHERE id=$id').get({ $id: id });
  appendTrace(db, actor.studentId, `${id}:${action}:${row.revision + 1}`, 'schedule', null, {
    action, review_id: id, before_status: row.status, after_status: status, revision: row.revision + 1,
  });
  db.close();
  return { idempotent: false, review, receipt: `REVIEW ${status.toUpperCase()}` };
}

export function recordReviewDelivery(root: string, actor: ActorContext, id: string, revision: number, deliveryId: string): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  const row = db.query('SELECT * FROM review_schedule WHERE id=$id').get({ $id: id }) as Record<string, unknown> | null;
  if (!row) { db.close(); throw new TutorError('review not found', 66); }
  if (Number(row.revision) !== revision) { db.close(); throw new TutorError('review revision is stale', 65); }
  if (row.delivered_at) { db.close(); return { idempotent: true, review: row }; }
  const receipt = { delivery_id: deliveryId, session_student_id: actor.studentId, delivered_at: now(), revision };
  db.query(`UPDATE review_schedule SET status='delivered',delivered_at=$at,updated_at=$at,
    delivery_receipt_json=$receipt WHERE id=$id`).run({
      $at: receipt.delivered_at, $receipt: JSON.stringify(receipt), $id: id,
    });
  const review = db.query('SELECT * FROM review_schedule WHERE id=$id').get({ $id: id });
  appendTrace(db, actor.studentId, `delivery:${deliveryId}`, 'receipt', String(row.concept_code), receipt);
  db.close();
  return { idempotent: false, review, receipt };
}

export function report(root: string, actor: ActorContext, friendly?: string): unknown {
  requireTutor(actor);
  const classDb = openClass(root);
  const targets = friendly
    ? [resolveStudent(root, friendly)]
    : classDb.query(`SELECT id,display_name,status FROM students WHERE status!='archived' ORDER BY display_name`).all() as Array<{ id: string; display_name: string; status: string }>;
  const classConfig = classDb.query('SELECT * FROM class_config WHERE id=1').get();
  classDb.close();
  const students = targets.map((target) => {
    const db = openStudent(root, target.id);
    const result = {
      student: target,
      mastery: db.query(`SELECT band,COUNT(*) AS concepts FROM mastery GROUP BY band ORDER BY band`).all(),
      attempts: (db.query('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number }).n,
      attempts_by_difficulty: db.query(`SELECT difficulty,COUNT(*) AS attempts FROM learning_events GROUP BY difficulty ORDER BY difficulty`).all(),
      outcomes: db.query(`SELECT outcome,COUNT(*) AS attempts,ROUND(AVG(score),3) AS mean_score FROM learning_events GROUP BY outcome ORDER BY outcome`).all(),
      pedagogy_effectiveness: db.query(`SELECT pedagogy,COUNT(*) AS attempts,ROUND(AVG(score),3) AS mean_score,
        SUM(CASE WHEN outcome='correct' THEN 1 ELSE 0 END) AS correct_attempts
        FROM learning_events WHERE pedagogy IS NOT NULL GROUP BY pedagogy ORDER BY pedagogy`).all(),
      evidence_coverage: db.query(`SELECT COUNT(*) AS attempts,
        SUM(CASE WHEN trim(evidence)!='' THEN 1 ELSE 0 END) AS with_evidence
        FROM learning_events`).get(),
      active_misconceptions: (db.query(`SELECT COUNT(*) AS n FROM misconceptions WHERE status!='resolved'`).get() as { n: number }).n,
      pending_assignments: (db.query(`SELECT COUNT(*) AS n FROM assignments WHERE status='pending'`).get() as { n: number }).n,
      pending_reviews: (db.query(`SELECT COUNT(*) AS n FROM review_schedule WHERE status='pending'`).get() as { n: number }).n,
      frontier: db.query(`SELECT concept_code,eligibility,reason,course_revision FROM frontier ORDER BY concept_code`).all(),
      current_action: db.query('SELECT concept_code,action_type,difficulty,pedagogy,reason_code,status,revision,updated_at,source_item_id,source_answer_id FROM current_state WHERE id=1').get() ?? null,
      material_question_statistics: materialQuestionStatistics(root, target.id),
    };
    db.close();
    return result;
  });
  const studentIds = targets.map((target) => target.id);
  const payload = {
    schema: 5, generated_at: now(), class: classConfig, students,
    question_quality: questionQualityAnalytics(root, studentIds),
  };
  const hash = sha256(JSON.stringify(payload));
  const reportDir = path.join(paths(root).reportsDir, friendly ? targets[0].id : 'class');
  ensureDir(reportDir);
  const file = path.join(reportDir, `progress-${Date.now()}.json`);
  writeJsonAtomic(file, { ...payload, sha256: hash });
  audit(root, actor.role, actor.actorId, 'admin.report', friendly ? 'student' : 'class', friendly ? targets[0].id : undefined, { file, hash });
  return { ...payload, file, sha256: hash, receipt: 'REPORT GENERATED' };
}

/** A standardized, messaging-channel-native Tutor Foundry view. */
export function dashboard(root: string, actor: ActorContext, friendly?: string): unknown {
  requireTutor(actor);
  const detailed = report(root, actor, friendly) as Record<string, unknown> & {
    students: Array<Record<string, unknown>>;
    question_quality: { items?: Array<Record<string, unknown>> };
  };
  const course = openCourse(root);
  const migration = course.query(`SELECT change_type,COUNT(*) AS items FROM assessment_item_lineage
    GROUP BY change_type ORDER BY change_type`).all();
  const graphRevisions = course.query(`SELECT slug,version,status FROM knowledge_graphs ORDER BY slug`).all();
  course.close();
  const students = detailed.students.map((entry) => {
    const student = entry.student as { id: string; display_name: string };
    const stats = entry.material_question_statistics as {
      summary?: { coverage_rate?: number; correct_rate_on_attempted?: number; unseen_questions?: number };
      blueprint?: { concept_compliance?: Array<{ satisfied: boolean }> };
    };
    const alerts = [
      Number(entry.attempts) === 0 ? 'no recorded attempts' : null,
      Number(entry.active_misconceptions) > 0 ? `${entry.active_misconceptions} active misconception(s)` : null,
      (stats.blueprint?.concept_compliance ?? []).some((row) => !row.satisfied) ? 'assessment blueprint coverage gap' : null,
    ].filter(Boolean);
    return {
      student_id: student.id, display_name: student.display_name,
      attempts: entry.attempts, mastery: entry.mastery,
      question_coverage_rate: stats.summary?.coverage_rate ?? 0,
      correct_rate_on_attempted: stats.summary?.correct_rate_on_attempted ?? 0,
      unseen_material_questions: stats.summary?.unseen_questions ?? 0,
      alerts,
    };
  });
  const qualityItems = detailed.question_quality?.items ?? [];
  return {
    schema: 1,
    surface: 'tutor_control_messaging_channel',
    delivery: 'Render this structured dashboard in the same tutor-control conversation; do not require Ops Center access.',
    generated_at: detailed.generated_at,
    audience: detailed.class,
    overview: {
      students: students.length,
      total_attempts: students.reduce((sum, student) => sum + Number(student.attempts), 0),
      students_needing_attention: students.filter((student) => student.alerts.length > 0).length,
      question_quality_review_flags: qualityItems.filter((item) => Array.isArray(item.review_signals) && item.review_signals.length > 0).length,
      question_quality_suppressed: qualityItems.filter((item) => item.suppressed === true).length,
    },
    students,
    question_quality: detailed.question_quality,
    materials: materialSummary(root, actor),
    curriculum: { graphs: graphRevisions, assessment_revision_lineage: migration },
    detailed_report: { file: detailed.file, sha256: detailed.sha256 },
    privacy: 'Student rows are available only in the tutor-control route; cohort item distributions remain suppressed below the configured threshold.',
    receipt: 'TUTOR DASHBOARD GENERATED',
  };
}

export function updatePreferences(root: string, actor: ActorContext, patch: Record<string, unknown>): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  const row = db.query('SELECT preferences_json FROM profile WHERE id=1').get() as { preferences_json: string };
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(row.preferences_json) as Record<string, unknown>; } catch { current = {}; }
  const preferences = { ...current, ...patch };
  db.query('UPDATE profile SET preferences_json=$json,updated_at=$at WHERE id=1').run({ $json: JSON.stringify(preferences), $at: now() });
  db.close();
  return { student_id: actor.studentId, preferences, receipt: 'PREFERENCES UPDATED' };
}

export function currentPreferences(root: string, actor: ActorContext): unknown {
  requireStudent(actor);
  const db = openStudent(root, actor.studentId);
  try {
    const row = db.query('SELECT preferences_json,updated_at FROM profile WHERE id=1').get() as { preferences_json: string; updated_at: string } | null;
    let preferences: Record<string, unknown> = {};
    try { preferences = JSON.parse(row?.preferences_json ?? '{}') as Record<string, unknown>; } catch { preferences = {}; }
    return { student_id: actor.studentId, preferences, updated_at: row?.updated_at ?? null };
  } finally { db.close(); }
}
