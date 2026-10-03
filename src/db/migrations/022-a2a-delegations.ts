import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Durable ledger of agent-to-agent routes, written by the host at routing
 * time (src/modules/agent-to-agent/agent-route.ts). One row per routed
 * message, both directions:
 *
 *  - request leg: Jeeves → errand-runner, `tier` = the `[tier:X]` directive
 *    if the sender attached one, `in_reply_to` NULL.
 *  - reply leg: errand-runner → Jeeves, `in_reply_to` = the request's
 *    `a2a_msg_id` (the container stamps it from the inbound row it is
 *    answering), `escalation` = the reason text when the reply carries an
 *    `[escalate: …]` block.
 *
 * This is the primary historical record for evaluating delegation
 * effectiveness: join request→reply on `a2a_msg_id = in_reply_to`, compute
 * answer rate vs escalation rate per tier, and join to transcripts/Ops
 * Center for the model that actually ran. Survives log rotation — host logs
 * are NOT the source of truth for this.
 */
export const migration022: Migration = {
  version: 22,
  name: 'a2a-delegations',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE a2a_delegations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           TEXT NOT NULL,
        from_group   TEXT NOT NULL,
        to_group     TEXT NOT NULL,
        from_session TEXT NOT NULL,
        to_session   TEXT NOT NULL,
        a2a_msg_id   TEXT NOT NULL UNIQUE,
        in_reply_to  TEXT,
        tier         TEXT,
        escalation   TEXT,
        summary      TEXT NOT NULL,
        file_count   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_a2a_delegations_reply ON a2a_delegations(in_reply_to);
      CREATE INDEX idx_a2a_delegations_from  ON a2a_delegations(from_group, ts);
    `);
  },
};
