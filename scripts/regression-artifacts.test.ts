import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { cleanupRegressionArtifacts } from './regression-artifacts.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      platform_id TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE messaging_group_agents (
      id TEXT PRIMARY KEY,
      messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id TEXT NOT NULL REFERENCES agent_groups(id)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      messaging_group_id TEXT REFERENCES messaging_groups(id),
      status TEXT NOT NULL
    );
    CREATE TABLE pending_questions (question_id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id));
    CREATE TABLE pending_approvals (approval_id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), channel_type TEXT, platform_id TEXT);
    CREATE TABLE pending_channel_approvals (messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id));
    CREATE TABLE pending_sender_approvals (id TEXT PRIMARY KEY, messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id));
    CREATE TABLE user_dms (user_id TEXT, channel_type TEXT, messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id));
    CREATE TABLE unregistered_senders (messaging_group_id TEXT);
    CREATE TABLE agent_destinations (
      agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      local_name TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (agent_group_id, local_name)
    );
  `);
  return db;
}

describe('cleanupRegressionArtifacts', () => {
  it('removes only reserved regression channels and their dependent artifacts', () => {
    const db = createDb();
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-regression-cleanup-'));
    try {
      db.exec(`
        INSERT INTO agent_groups VALUES ('ag-test'), ('ag-real');
        INSERT INTO messaging_groups VALUES
          ('mg-test-1', 'cli', 'jeeves-chief-of-staff-regression-shared-1'),
          ('mg-test-2', 'cli', 'jeeves-chief-of-staff-regression-cos-01-2'),
          ('mg-real', 'cli', 'local');
        INSERT INTO messaging_group_agents VALUES
          ('mga-test-1', 'mg-test-1', 'ag-test'),
          ('mga-test-2', 'mg-test-2', 'ag-test'),
          ('mga-real', 'mg-real', 'ag-real');
        INSERT INTO sessions VALUES
          ('sess-test-1', 'ag-test', 'mg-test-1', 'closed'),
          ('sess-test-2', 'ag-test', 'mg-test-2', 'active'),
          ('sess-real', 'ag-real', 'mg-real', 'active');
        INSERT INTO pending_questions VALUES ('question-1', 'sess-test-1');
        INSERT INTO pending_approvals VALUES ('approval-1', 'sess-test-2', 'cli', 'jeeves-chief-of-staff-regression-cos-01-2');
        INSERT INTO pending_channel_approvals VALUES ('mg-test-1');
        INSERT INTO pending_sender_approvals VALUES ('sender-1', 'mg-test-2');
        INSERT INTO user_dms VALUES ('cli:test', 'cli', 'mg-test-1');
        INSERT INTO unregistered_senders VALUES ('mg-test-2');
        INSERT INTO agent_destinations VALUES
          ('ag-test', 'regression-one', 'channel', 'mg-test-1'),
          ('ag-test', 'regression-two', 'channel', 'mg-test-2'),
          ('ag-real', 'local', 'channel', 'mg-real');
      `);
      for (const sessionId of ['sess-test-1', 'sess-test-2']) {
        fs.mkdirSync(path.join(sessionRoot, 'ag-test', sessionId), { recursive: true });
        fs.writeFileSync(path.join(sessionRoot, 'ag-test', sessionId, 'marker'), 'test');
      }

      const summary = cleanupRegressionArtifacts(db, {
        channelType: 'cli',
        platformPrefix: 'jeeves-chief-of-staff-regression',
        sessionRoot,
      });

      expect(summary).toEqual({ messagingGroups: 2, wirings: 2, sessions: 2, destinations: 2, sessionDirs: 2 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM messaging_groups').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM messaging_group_agents').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM pending_questions').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM pending_approvals').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM agent_destinations').get()).toEqual({ count: 1 });
      expect(fs.existsSync(path.join(sessionRoot, 'ag-test', 'sess-test-1'))).toBe(false);
      expect(fs.existsSync(path.join(sessionRoot, 'ag-test', 'sess-test-2'))).toBe(false);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(sessionRoot, { recursive: true, force: true });
    }
  });
});
