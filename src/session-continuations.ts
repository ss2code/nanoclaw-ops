import type Database from 'better-sqlite3';

/** Delete provider-owned continuation keys while preserving other session state. */
export function clearProviderContinuations(db: Database.Database): number {
  return db.prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%'").run().changes;
}
