import { Database } from 'bun:sqlite';

export function openWorkflowDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA foreign_keys = ON');
  migrateWorkflowDb(db);
  return db;
}

export function migrateWorkflowDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id                 TEXT PRIMARY KEY,
      workflow_type      TEXT NOT NULL,
      archetype          TEXT NOT NULL,
      status             TEXT NOT NULL,
      state              TEXT NOT NULL,
      subject_type       TEXT,
      subject_id         TEXT,
      correlation_key    TEXT,
      app_payload_json   TEXT NOT NULL,
      result_json        TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      closed_at          TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      id                 TEXT PRIMARY KEY,
      instance_id         TEXT NOT NULL REFERENCES workflow_instances(id),
      event_type          TEXT NOT NULL,
      source              TEXT NOT NULL,
      external_id         TEXT,
      payload_json        TEXT NOT NULL,
      created_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_timers (
      id                 TEXT PRIMARY KEY,
      instance_id         TEXT NOT NULL REFERENCES workflow_instances(id),
      timer_type          TEXT NOT NULL,
      status              TEXT NOT NULL,
      due_at              TEXT NOT NULL,
      schedule_task_id    TEXT,
      payload_json        TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      fired_at            TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_actions (
      id                 TEXT PRIMARY KEY,
      instance_id         TEXT NOT NULL REFERENCES workflow_instances(id),
      action_type         TEXT NOT NULL,
      status              TEXT NOT NULL,
      idempotency_key     TEXT NOT NULL UNIQUE,
      draft_id            TEXT,
      review_status       TEXT,
      reviewed_by         TEXT,
      sent_method         TEXT,
      sent_at             TEXT,
      payload_json        TEXT NOT NULL,
      result_json         TEXT,
      created_at          TEXT NOT NULL,
      completed_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_correlations (
      key                TEXT PRIMARY KEY,
      instance_id         TEXT NOT NULL REFERENCES workflow_instances(id),
      kind                TEXT NOT NULL,
      value               TEXT NOT NULL,
      created_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_quarantine (
      id                 TEXT PRIMARY KEY,
      reason             TEXT NOT NULL,
      source             TEXT NOT NULL,
      external_id         TEXT,
      payload_json        TEXT NOT NULL,
      created_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_instances_status ON workflow_instances(status);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_instance_created ON workflow_events(instance_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_timers_instance_status ON workflow_timers(instance_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_actions_instance_status ON workflow_actions(instance_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_actions_review ON workflow_actions(review_status, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_correlations_lookup ON workflow_correlations(kind, value);
  `);
}

export function tableCount(db: Database, table: string): number {
  return Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}
