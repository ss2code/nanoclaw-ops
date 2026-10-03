import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from './db/index.js';
import {
  beginAgentGroupWake,
  canWakeAgentGroup,
  getAgentGroupControl,
  markAgentGroupWakeFailed,
  markAgentGroupWakeSucceeded,
  recoverAgentGroupLifecycle,
  setAgentGroupDesiredState,
} from './agent-group-lifecycle.js';

describe('per-agent-group lifecycle controls', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-lifecycle',
      name: 'Lifecycle test',
      folder: 'lifecycle-test',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => closeDb());

  it('defaults new groups to running/idle and preserves stopped groups for future messages', () => {
    expect(getAgentGroupControl('ag-lifecycle')).toMatchObject({
      desired_state: 'running',
      lifecycle_status: 'idle',
    });

    setAgentGroupDesiredState('ag-lifecycle', 'stopped', 'ops-center');

    expect(canWakeAgentGroup('ag-lifecycle', 'message').allowed).toBe(true);
    expect(canWakeAgentGroup('ag-lifecycle', 'scheduled').allowed).toBe(true);
    expect(getAgentGroupControl('ag-lifecycle')).toMatchObject({
      desired_state: 'stopped',
      lifecycle_status: 'stopped',
      updated_by: 'ops-center',
    });
    expect(
      getDb().prepare('SELECT event, from_state, to_state, actor FROM agent_group_lifecycle_audit').all() as unknown[],
    ).toEqual([{ event: 'desired_state', from_state: 'running', to_state: 'stopped', actor: 'ops-center' }]);
  });

  it('blocks all non-manual wakes while paused, including scheduled work', () => {
    setAgentGroupDesiredState('ag-lifecycle', 'paused', 'ops-center');

    expect(canWakeAgentGroup('ag-lifecycle', 'message').allowed).toBe(false);
    expect(canWakeAgentGroup('ag-lifecycle', 'automatic').allowed).toBe(false);
    expect(canWakeAgentGroup('ag-lifecycle', 'scheduled').allowed).toBe(false);
    expect(canWakeAgentGroup('ag-lifecycle', 'manual').allowed).toBe(false);
  });

  it('invalidates an in-flight wake when Pause wins the race', () => {
    const lease = beginAgentGroupWake('ag-lifecycle', 'message');
    expect(lease?.revision).toBe(0);

    setAgentGroupDesiredState('ag-lifecycle', 'paused', 'ops-center');
    expect(markAgentGroupWakeSucceeded('ag-lifecycle', lease!)).toBe(false);
    expect(getAgentGroupControl('ag-lifecycle')).toMatchObject({
      desired_state: 'paused',
      lifecycle_status: 'paused',
      revision: 1,
    });
  });

  it('clears a stale error when an operator recovers an idle group', () => {
    const lease = beginAgentGroupWake('ag-lifecycle', 'message');
    expect(markAgentGroupWakeFailed('ag-lifecycle', lease!, 'container exited with code 137')).toBe(true);
    expect(getAgentGroupControl('ag-lifecycle')).toMatchObject({
      lifecycle_status: 'error',
      last_error: 'container exited with code 137',
    });

    expect(recoverAgentGroupLifecycle('ag-lifecycle', 'ops-center')).toBe(true);
    expect(getAgentGroupControl('ag-lifecycle')).toMatchObject({
      desired_state: 'running',
      lifecycle_status: 'idle',
      last_error: null,
      updated_by: 'ops-center',
    });
  });
});
