import { type ActorContext, requireTutor } from './context';
import { audit, openCourse } from './store';
import { now, stableId, TutorError } from './util';

export interface AssessmentBlueprint {
  schema: 1;
  difficulty_mix: Record<string, number>;
  cognitive_mix: Record<string, number>;
  required_tags: string[];
  max_exposures_per_item: number;
  min_unique_questions_per_concept: number;
  transfer_required: boolean;
}

function mix(value: unknown, name: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TutorError(`${name} must be an object`, 64);
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.some(([, weight]) => typeof weight !== 'number' || weight < 0 || weight > 1)) {
    throw new TutorError(`${name} values must be numbers between 0 and 1`, 64);
  }
  const total = entries.reduce((sum, [, weight]) => sum + Number(weight), 0);
  if (Math.abs(total - 1) > 0.02) throw new TutorError(`${name} weights must sum to 1`, 64);
  return Object.fromEntries(entries) as Record<string, number>;
}

export function validateBlueprint(input: unknown): AssessmentBlueprint {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TutorError('blueprint must be an object', 64);
  const value = input as Record<string, unknown>;
  const requiredTags = value.required_tags ?? [];
  if (!Array.isArray(requiredTags) || requiredTags.some((tag) => typeof tag !== 'string')) throw new TutorError('required_tags must be a string array', 64);
  const max = Number(value.max_exposures_per_item ?? 3);
  const min = Number(value.min_unique_questions_per_concept ?? 2);
  if (!Number.isInteger(max) || max < 1 || max > 20) throw new TutorError('max_exposures_per_item must be 1-20', 64);
  if (!Number.isInteger(min) || min < 1 || min > 20) throw new TutorError('min_unique_questions_per_concept must be 1-20', 64);
  return {
    schema: 1,
    difficulty_mix: mix(value.difficulty_mix ?? { low: 0.3, medium: 0.5, high: 0.2 }, 'difficulty_mix'),
    cognitive_mix: mix(value.cognitive_mix ?? { remember: 0.2, understand: 0.3, apply: 0.3, analyze: 0.2 }, 'cognitive_mix'),
    required_tags: [...new Set(requiredTags.map(String))],
    max_exposures_per_item: max,
    min_unique_questions_per_concept: min,
    transfer_required: value.transfer_required === true,
  };
}

export function activeBlueprint(root: string): { id: string; name: string; version: number; config: AssessmentBlueprint } {
  const db = openCourse(root);
  try {
    const row = db.query(`SELECT id,name,version,config_json FROM assessment_blueprints
      WHERE status='active' ORDER BY updated_at DESC,id LIMIT 1`).get() as {
        id: string; name: string; version: number; config_json: string;
      } | null;
    if (!row) throw new TutorError('active assessment blueprint not found', 78);
    return { id: row.id, name: row.name, version: row.version, config: validateBlueprint(JSON.parse(row.config_json)) };
  } finally { db.close(); }
}

export function getBlueprint(root: string, actor: ActorContext): unknown {
  requireTutor(actor);
  return activeBlueprint(root);
}

export function setBlueprint(root: string, actor: ActorContext, name: string, input: unknown, idempotency: string): unknown {
  requireTutor(actor);
  if (!/^[a-z][a-z0-9_.-]{1,63}$/i.test(name)) throw new TutorError('invalid blueprint name', 64);
  const config = validateBlueprint(input);
  const db = openCourse(root);
  const existing = db.query('SELECT id,version,config_json,status FROM assessment_blueprints WHERE name=$name').get({ $name: name }) as {
    id: string; version: number; config_json: string; status: string;
  } | null;
  const configJson = JSON.stringify(config);
  if (existing?.config_json === configJson && existing.status === 'active') {
    db.close(); return { id: existing.id, name, version: existing.version, config, idempotent: true };
  }
  const id = existing?.id ?? stableId('blueprint', name);
  const version = (existing?.version ?? 0) + 1;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.query(`UPDATE assessment_blueprints SET status='inactive',updated_at=$at WHERE status='active'`).run({ $at: now() });
    db.query(`INSERT INTO assessment_blueprints (id,name,config_json,status,version,created_at,updated_at)
      VALUES ($id,$name,$config,'active',$version,$at,$at)
      ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,status='active',version=excluded.version,updated_at=excluded.updated_at`).run({
        $id: id, $name: name, $config: configJson, $version: version, $at: now(),
      });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  db.close();
  audit(root, actor.role, actor.actorId, 'assessment.blueprint_set', 'blueprint', id, { name, version, idempotency });
  return { id, name, version, config, idempotent: false, receipt: 'ASSESSMENT BLUEPRINT UPDATED' };
}
