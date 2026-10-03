import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { ensureDir, now, stableId, TutorError } from './util';

export interface TutorRootPaths {
  root: string;
  classDb: string;
  courseDir: string;
  courseDb: string;
  resourcesDir: string;
  documentsDir: string;
  studentsDir: string;
  proposalsDir: string;
  graphsDir: string;
  reportsDir: string;
  auditDir: string;
}

export function paths(root: string): TutorRootPaths {
  return {
    root,
    classDb: path.join(root, 'class.db'),
    courseDir: path.join(root, 'course'),
    courseDb: path.join(root, 'course', 'course.db'),
    resourcesDir: path.join(root, 'course', 'resources'),
    documentsDir: path.join(root, 'course', 'documents'),
    studentsDir: path.join(root, 'students'),
    proposalsDir: path.join(root, 'course', 'proposals'),
    graphsDir: path.join(root, 'course', 'graphs'),
    reportsDir: path.join(root, 'reports'),
    auditDir: path.join(root, 'audit'),
  };
}

function open(file: string): Database {
  ensureDir(path.dirname(file));
  const db = new Database(file, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Backfill canonical identities for graphs created before canonicalization was enforced. */
function backfillCanonicalConcepts(root: string, db: Database): void {
  const classDb = openClass(root);
  const config = classDb.query('SELECT class_name,subject FROM class_config WHERE id=1').get() as { class_name: string; subject: string } | null;
  classDb.close();
  if (!config) return;
  const rows = db.query(`SELECT id,canonical_concept_id,canonical_path,title,aliases_json
    FROM concepts WHERE canonical_concept_id IS NULL OR canonical_concept_id NOT IN (SELECT id FROM canonical_concepts)`).all() as Array<{
    id: string; canonical_concept_id: string | null; canonical_path: string; title: string; aliases_json: string;
  }>;
  for (const row of rows) {
    const canonicalId = stableId('ccpt', config.class_name, config.subject, row.canonical_path);
    db.query(`INSERT INTO canonical_concepts
      (id,class_name,subject,canonical_path,title,aliases_json,status,created_at,updated_at)
      VALUES ($id,$class,$subject,$path,$title,$aliases,'active',$at,$at)
      ON CONFLICT(class_name,subject,canonical_path) DO UPDATE SET title=excluded.title,
      aliases_json=excluded.aliases_json,status='active',updated_at=excluded.updated_at`).run({
        $id: canonicalId, $class: config.class_name, $subject: config.subject, $path: row.canonical_path,
        $title: row.title, $aliases: row.aliases_json || '[]', $at: now(),
      });
    const canonical = db.query(`SELECT id FROM canonical_concepts
      WHERE class_name=$class AND subject=$subject AND canonical_path=$path`).get({
        $class: config.class_name, $subject: config.subject, $path: row.canonical_path,
      }) as { id: string };
    db.query('UPDATE concepts SET canonical_concept_id=$canonical WHERE id=$id').run({ $canonical: canonical.id, $id: row.id });
  }
}

export function openClass(root: string): Database {
  const p = paths(root);
  const db = open(p.classDb);
  db.exec(`
    CREATE TABLE IF NOT EXISTS class_config (
      id INTEGER PRIMARY KEY CHECK (id = 1), agent_group_id TEXT NOT NULL,
      class_name TEXT NOT NULL, subject TEXT NOT NULL, created_at TEXT NOT NULL,
      grade_level TEXT, age_min INTEGER, age_max INTEGER, target_age INTEGER,
      explanation_level TEXT NOT NULL DEFAULT 'age-appropriate'
    );
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','paused','archived')),
      instructor_approved_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_channel_bindings (
      student_id TEXT NOT NULL REFERENCES students(id), messaging_group_id TEXT NOT NULL,
      channel_type TEXT NOT NULL, platform_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id, thread_id), UNIQUE(messaging_group_id)
    );
    CREATE TABLE IF NOT EXISTS tutor_bindings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, messaging_group_id TEXT NOT NULL,
      channel_type TEXT NOT NULL, platform_id TEXT NOT NULL, thread_id TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
      UNIQUE(channel_type, platform_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS policies (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_role TEXT NOT NULL,
      actor_id TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail_json TEXT NOT NULL
    );
  `);
  ensureColumn(db, 'class_config', 'policy_version', "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, 'class_config', 'grade_level', 'TEXT');
  ensureColumn(db, 'class_config', 'age_min', 'INTEGER');
  ensureColumn(db, 'class_config', 'age_max', 'INTEGER');
  ensureColumn(db, 'class_config', 'target_age', 'INTEGER');
  ensureColumn(db, 'class_config', 'explanation_level', "TEXT NOT NULL DEFAULT 'age-appropriate'");
  return db;
}

export function openCourse(root: string): Database {
  const p = paths(root);
  const db = open(p.courseDb);
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_graphs (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, class_name TEXT NOT NULL, subject TEXT NOT NULL,
      scope_type TEXT NOT NULL, scope_label TEXT NOT NULL, title TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, base_document_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES knowledge_graphs(id), code TEXT NOT NULL,
      source_code TEXT, title TEXT NOT NULL, definition TEXT NOT NULL DEFAULT '', objective TEXT NOT NULL DEFAULT '',
      canonical_path TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', aliases_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(graph_id, code)
    );
    CREATE TABLE IF NOT EXISTS canonical_concepts (
      id TEXT PRIMARY KEY, class_name TEXT NOT NULL, subject TEXT NOT NULL, canonical_path TEXT NOT NULL,
      title TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(class_name,subject,canonical_path)
    );
    CREATE TABLE IF NOT EXISTS concept_edges (
      id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES knowledge_graphs(id), from_concept_id TEXT NOT NULL,
      to_concept_id TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1,
      source_document_id TEXT, rationale TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(graph_id, from_concept_id, to_concept_id, type)
    );
    CREATE TABLE IF NOT EXISTS source_documents (
      id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
      role TEXT NOT NULL, original_path TEXT NOT NULL, normalized_path TEXT NOT NULL,
      parser_version TEXT NOT NULL, created_at TEXT NOT NULL, source_sha256 TEXT, source_mime_type TEXT,
      extraction_method TEXT, extractor_version TEXT, canonicalizer_version TEXT, page_count INTEGER,
      ocr_confidence REAL, canonicalizer_prompt_hash TEXT, canonicalizer_model TEXT,
      status TEXT NOT NULL DEFAULT 'active', source_filename TEXT, source_byte_size INTEGER,
      uploader_id TEXT, uploader_role TEXT, uploaded_at TEXT, source_revision_of TEXT,
      revision_number INTEGER NOT NULL DEFAULT 1, storage_path TEXT, UNIQUE(sha256, role, parser_version)
    );
    CREATE TABLE IF NOT EXISTS source_artifacts (
      id TEXT PRIMARY KEY, source_document_id TEXT NOT NULL REFERENCES source_documents(id),
      kind TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL, locator_json TEXT NOT NULL DEFAULT '{}', text_alternative TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, UNIQUE(source_document_id,kind,sha256)
    );
    CREATE TABLE IF NOT EXISTS content_items (
      id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES knowledge_graphs(id), kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL, difficulty TEXT, original_difficulty TEXT,
      source_document_id TEXT NOT NULL REFERENCES source_documents(id), source_locator TEXT NOT NULL,
      provenance_hash TEXT NOT NULL, generated INTEGER NOT NULL DEFAULT 0,
      assessment_ref TEXT, answer_for_ref TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active', item_type TEXT, source_reference TEXT,
      provenance TEXT NOT NULL DEFAULT 'source-authored', confidence REAL NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS item_concepts (
      item_id TEXT NOT NULL REFERENCES content_items(id), concept_id TEXT NOT NULL REFERENCES concepts(id),
      relation TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, PRIMARY KEY(item_id, concept_id, relation)
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      content_hash TEXT PRIMARY KEY, item_id TEXT NOT NULL, model TEXT NOT NULL, vector_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_revisions (
      id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES knowledge_graphs(id), version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL, summary_json TEXT NOT NULL, created_at TEXT NOT NULL,
      revision_kind TEXT NOT NULL DEFAULT 'base', UNIQUE(graph_id, version)
    );
    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id TEXT PRIMARY KEY, graph_id TEXT, document_id TEXT, status TEXT NOT NULL, proposal_hash TEXT NOT NULL,
      warnings_json TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS assessment_specs (
      question_item_id TEXT PRIMARY KEY REFERENCES content_items(id), answer_item_id TEXT,
      rubric_json TEXT NOT NULL DEFAULT '{}', acceptable_answers_json TEXT NOT NULL DEFAULT '[]',
      misconceptions_json TEXT NOT NULL DEFAULT '[]', distractors_json TEXT NOT NULL DEFAULT '[]',
      cognitive_level TEXT, estimated_minutes INTEGER, age_min INTEGER, age_max INTEGER,
      tags_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_blueprints (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL, status TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_item_lineage (
      id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, from_item_id TEXT, to_item_id TEXT,
      assessment_ref TEXT NOT NULL, change_type TEXT NOT NULL,
      evidence_policy TEXT NOT NULL, similarity REAL NOT NULL DEFAULT 0,
      from_revision INTEGER, to_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(graph_id,from_item_id,to_item_id,to_revision)
    );
    CREATE TABLE IF NOT EXISTS instruction_resources (
      id TEXT PRIMARY KEY, canonical_concept_id TEXT REFERENCES canonical_concepts(id), kind TEXT NOT NULL,
      title TEXT NOT NULL, artifact_path TEXT NOT NULL, text_alternative TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]', provenance_json TEXT NOT NULL DEFAULT '[]',
      audience_json TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      artifact_paths_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(content_hash,canonical_concept_id)
    );
  `);
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(item_id UNINDEXED, title, body);');
  } catch {
    // FTS can be absent in a non-production Bun build; search has a bounded LIKE fallback.
  }
  ensureColumn(db, 'content_items', 'assessment_ref', 'TEXT');
  ensureColumn(db, 'content_items', 'answer_for_ref', 'TEXT');
  ensureColumn(db, 'content_items', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'content_items', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'concepts', 'canonical_concept_id', 'TEXT');
  ensureColumn(db, 'concept_edges', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'source_documents', 'source_sha256', 'TEXT');
  ensureColumn(db, 'source_documents', 'source_mime_type', 'TEXT');
  ensureColumn(db, 'source_documents', 'extraction_method', 'TEXT');
  ensureColumn(db, 'source_documents', 'extractor_version', 'TEXT');
  ensureColumn(db, 'source_documents', 'canonicalizer_version', 'TEXT');
  ensureColumn(db, 'source_documents', 'page_count', 'INTEGER');
  ensureColumn(db, 'source_documents', 'ocr_confidence', 'REAL');
  ensureColumn(db, 'source_documents', 'canonicalizer_prompt_hash', 'TEXT');
  ensureColumn(db, 'source_documents', 'canonicalizer_model', 'TEXT');
  ensureColumn(db, 'source_documents', 'source_filename', 'TEXT');
  ensureColumn(db, 'source_documents', 'source_byte_size', 'INTEGER');
  ensureColumn(db, 'source_documents', 'uploader_id', 'TEXT');
  ensureColumn(db, 'source_documents', 'uploader_role', 'TEXT');
  ensureColumn(db, 'source_documents', 'uploaded_at', 'TEXT');
  ensureColumn(db, 'source_documents', 'source_revision_of', 'TEXT');
  ensureColumn(db, 'source_documents', 'revision_number', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'source_documents', 'storage_path', 'TEXT');
  ensureColumn(db, 'source_artifacts', 'text_alternative', 'TEXT');
  ensureColumn(db, 'content_items', 'item_type', 'TEXT');
  ensureColumn(db, 'content_items', 'source_reference', 'TEXT');
  ensureColumn(db, 'content_items', 'provenance', "TEXT NOT NULL DEFAULT 'source-authored'");
  ensureColumn(db, 'content_items', 'confidence', 'REAL NOT NULL DEFAULT 1');
  ensureColumn(db, 'source_documents', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'graph_revisions', 'revision_kind', "TEXT NOT NULL DEFAULT 'base'");
  ensureColumn(db, 'instruction_resources', 'artifact_paths_json', "TEXT NOT NULL DEFAULT '[]'");
  backfillCanonicalConcepts(root, db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_source_documents_revision ON source_documents(source_filename,role,created_at);
    CREATE INDEX IF NOT EXISTS idx_source_artifacts_document ON source_artifacts(source_document_id,status);
    CREATE INDEX IF NOT EXISTS idx_content_items_assessment
      ON content_items(graph_id,source_document_id,kind,assessment_ref);
    CREATE INDEX IF NOT EXISTS idx_content_items_status ON content_items(graph_id,status,kind);
    CREATE INDEX IF NOT EXISTS idx_content_items_answers
      ON content_items(graph_id,source_document_id,answer_for_ref);
    CREATE INDEX IF NOT EXISTS idx_item_concepts_concept ON item_concepts(concept_id,item_id);
    CREATE INDEX IF NOT EXISTS idx_concepts_canonical ON concepts(canonical_concept_id,graph_id);
    CREATE INDEX IF NOT EXISTS idx_assessment_lineage_to ON assessment_item_lineage(to_item_id,evidence_policy);
    CREATE INDEX IF NOT EXISTS idx_instruction_resources_concept ON instruction_resources(canonical_concept_id,status);
  `);
  db.query(`INSERT OR IGNORE INTO assessment_blueprints
    (id,name,config_json,status,version,created_at,updated_at)
    VALUES ('blueprint_default','default',$config,'active',1,$at,$at)`).run({
      $config: JSON.stringify({
        schema: 1,
        difficulty_mix: { low: 0.3, medium: 0.5, high: 0.2 },
        cognitive_mix: { remember: 0.2, understand: 0.3, apply: 0.3, analyze: 0.2 },
        required_tags: [], max_exposures_per_item: 3,
        min_unique_questions_per_concept: 2, transfer_required: false,
      }),
      $at: now(),
    });
  return db;
}

export function studentDbPath(root: string, studentId: string): string {
  if (!/^stu_[a-zA-Z0-9_-]+$/.test(studentId)) throw new TutorError('invalid internal student id', 77);
  const p = path.join(paths(root).studentsDir, studentId, 'student.db');
  const base = path.resolve(paths(root).studentsDir) + path.sep;
  if (!path.resolve(p).startsWith(base)) throw new TutorError('student path escaped application root', 77);
  return p;
}

export function openStudent(root: string, studentId: string): Database {
  const file = studentDbPath(root, studentId);
  const db = open(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), student_id TEXT NOT NULL, display_name TEXT NOT NULL,
      preferences_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, concept_code TEXT NOT NULL, difficulty TEXT NOT NULL,
      outcome TEXT NOT NULL, score REAL NOT NULL, evidence TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL UNIQUE,
      event_kind TEXT NOT NULL DEFAULT 'practice', pedagogy TEXT, action_revision INTEGER,
      source_item_id TEXT, source_answer_id TEXT, source_assessment_ref TEXT,
      rubric_scores_json TEXT, grading_confidence REAL, selected_option TEXT, hint_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mastery (
      concept_code TEXT PRIMARY KEY, band TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      weighted_score REAL NOT NULL, last_evidence_at TEXT NOT NULL,
      delayed_review_count INTEGER NOT NULL DEFAULT 0, independent_high_count INTEGER NOT NULL DEFAULT 0,
      last_band_change_at TEXT
    );
    CREATE TABLE IF NOT EXISTS misconceptions (
      id TEXT PRIMARY KEY, concept_code TEXT NOT NULL, description TEXT NOT NULL,
      confidence REAL NOT NULL, evidence_event_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
      occurrence_count INTEGER NOT NULL DEFAULT 1, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS current_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), concept_code TEXT, action_type TEXT,
      prompt TEXT, expected_evidence TEXT, difficulty TEXT, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      pedagogy TEXT, reason_code TEXT, retrieval_json TEXT NOT NULL DEFAULT '[]', priority REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', completed_at TEXT, source_item_id TEXT, source_answer_id TEXT
    );
    CREATE TABLE IF NOT EXISTS frontier (
      concept_code TEXT PRIMARY KEY, eligibility TEXT NOT NULL, reason TEXT NOT NULL,
      course_revision INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id TEXT PRIMARY KEY, concept_code TEXT, body TEXT NOT NULL, status TEXT NOT NULL, due_at TEXT, created_at TEXT NOT NULL,
      idempotency_key TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS review_schedule (
      id TEXT PRIMARY KEY, concept_code TEXT NOT NULL, difficulty TEXT NOT NULL, schedule_text TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL DEFAULT 'spaced review', due_at TEXT,
      cadence TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', quiet_start TEXT, quiet_end TEXT,
      revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT, delivered_at TEXT, completed_at TEXT,
      delivery_receipt_json TEXT
    );
    CREATE TABLE IF NOT EXISTS student_memories (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, detail_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applied_commands (
      command_id TEXT PRIMARY KEY, command_hash TEXT NOT NULL, applied_at TEXT NOT NULL, receipt_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teaching_decisions (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, concept_code TEXT NOT NULL, difficulty TEXT NOT NULL,
      pedagogy TEXT NOT NULL, reason_code TEXT NOT NULL, candidate_json TEXT NOT NULL,
      frontier_revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
      source_item_id TEXT, source_answer_id TEXT
    );
    CREATE TABLE IF NOT EXISTS visual_artifacts (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, concept_code TEXT,
      title TEXT NOT NULL, svg_path TEXT NOT NULL, html_path TEXT NOT NULL, text_path TEXT NOT NULL,
      provenance_json TEXT NOT NULL, content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_traces (
      id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, sequence INTEGER NOT NULL, at TEXT NOT NULL,
      stage TEXT NOT NULL, concept_code TEXT, state_json TEXT NOT NULL, state_hash TEXT NOT NULL,
      UNIQUE(trace_id,sequence)
    );
  `);
  ensureColumn(db, 'learning_events', 'event_kind', "TEXT NOT NULL DEFAULT 'practice'");
  ensureColumn(db, 'learning_events', 'pedagogy', 'TEXT');
  ensureColumn(db, 'learning_events', 'action_revision', 'INTEGER');
  ensureColumn(db, 'learning_events', 'source_item_id', 'TEXT');
  ensureColumn(db, 'learning_events', 'source_answer_id', 'TEXT');
  ensureColumn(db, 'learning_events', 'source_assessment_ref', 'TEXT');
  ensureColumn(db, 'learning_events', 'rubric_scores_json', 'TEXT');
  ensureColumn(db, 'learning_events', 'grading_confidence', 'REAL');
  ensureColumn(db, 'learning_events', 'selected_option', 'TEXT');
  ensureColumn(db, 'learning_events', 'hint_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'mastery', 'delayed_review_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'mastery', 'independent_high_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'mastery', 'last_band_change_at', 'TEXT');
  ensureColumn(db, 'misconceptions', 'occurrence_count', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'misconceptions', 'updated_at', 'TEXT');
  ensureColumn(db, 'current_state', 'pedagogy', 'TEXT');
  ensureColumn(db, 'current_state', 'reason_code', 'TEXT');
  ensureColumn(db, 'current_state', 'retrieval_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'current_state', 'priority', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'current_state', 'status', "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, 'current_state', 'completed_at', 'TEXT');
  ensureColumn(db, 'current_state', 'source_item_id', 'TEXT');
  ensureColumn(db, 'current_state', 'source_answer_id', 'TEXT');
  ensureColumn(db, 'teaching_decisions', 'source_item_id', 'TEXT');
  ensureColumn(db, 'teaching_decisions', 'source_answer_id', 'TEXT');
  ensureColumn(db, 'assignments', 'idempotency_key', 'TEXT');
  ensureColumn(db, 'assignments', 'updated_at', 'TEXT');
  ensureColumn(db, 'review_schedule', 'reason', "TEXT NOT NULL DEFAULT 'spaced review'");
  ensureColumn(db, 'review_schedule', 'due_at', 'TEXT');
  ensureColumn(db, 'review_schedule', 'cadence', 'TEXT');
  ensureColumn(db, 'review_schedule', 'timezone', "TEXT NOT NULL DEFAULT 'UTC'");
  ensureColumn(db, 'review_schedule', 'quiet_start', 'TEXT');
  ensureColumn(db, 'review_schedule', 'quiet_end', 'TEXT');
  ensureColumn(db, 'review_schedule', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'review_schedule', 'updated_at', 'TEXT');
  ensureColumn(db, 'review_schedule', 'delivered_at', 'TEXT');
  ensureColumn(db, 'review_schedule', 'completed_at', 'TEXT');
  ensureColumn(db, 'review_schedule', 'delivery_receipt_json', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_learning_events_concept ON learning_events(concept_code,at);
    CREATE INDEX IF NOT EXISTS idx_learning_events_source_item ON learning_events(source_item_id,at);
  `);
  return db;
}

export function ensureStudent(root: string, studentId: string, displayName: string): void {
  const db = openStudent(root, studentId);
  db.query(`INSERT INTO profile (id, student_id, display_name, updated_at) VALUES (1, $student, $name, $at)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at`).run({
      $student: studentId, $name: displayName, $at: now(),
    });
  db.close();
  ensureDir(path.join(paths(root).studentsDir, studentId, 'inbox'));
}

export function initializeRoot(root: string): void {
  const p = paths(root);
  for (const dir of [p.root, p.courseDir, p.resourcesDir, p.documentsDir, p.studentsDir, p.proposalsDir, p.graphsDir, p.reportsDir, p.auditDir]) ensureDir(dir);
  openClass(root).close();
  openCourse(root).close();
}

export function audit(root: string, actorRole: string, actorId: string | null, action: string, targetType?: string, targetId?: string, detail: unknown = {}): void {
  const db = openClass(root);
  db.query(`INSERT INTO audit_events (at, actor_role, actor_id, action, target_type, target_id, detail_json)
    VALUES ($at,$role,$actor,$action,$type,$target,$detail)`).run({
      $at: now(), $role: actorRole, $actor: actorId, $action: action,
      $type: targetType ?? null, $target: targetId ?? null, $detail: JSON.stringify(detail),
    });
  db.close();
}

export function classExists(root: string): boolean {
  return fs.existsSync(paths(root).classDb);
}
