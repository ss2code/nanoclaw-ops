import type Database from 'better-sqlite3';

import { getMeta, setMeta } from './opsdb.js';

export type RuntimeDesiredState = 'running' | 'stopped';

const RUNTIME_DESIRED_STATE_KEY = 'runtime_desired_state';

/** Existing installs default to running so the historical recovery behavior is preserved. */
export function getRuntimeDesiredState(db: Database.Database): RuntimeDesiredState {
  return getMeta(db, RUNTIME_DESIRED_STATE_KEY) === 'stopped' ? 'stopped' : 'running';
}

export function setRuntimeDesiredState(db: Database.Database, state: RuntimeDesiredState): void {
  setMeta(db, RUNTIME_DESIRED_STATE_KEY, state);
}
