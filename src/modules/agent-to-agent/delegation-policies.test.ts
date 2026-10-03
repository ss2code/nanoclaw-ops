import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delegation-policies' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delegation-policies';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createApp } from '../../db/apps.js';
import { getDb } from '../../db/connection.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import {
  applyDelegationTemplate,
  revokeDelegationPolicy,
  type DelegationPolicyTemplate,
} from './delegation-policies.js';

const JEEVES = 'ag-jeeves';
const TRIP = 'ag-sample-trip';
const SCOUT = 'ag-errand-runner';
const ATLAS = 'ag-atlas';

function now(): string {
  return new Date().toISOString();
}

function directTemplate(overrides: Partial<DelegationPolicyTemplate> = {}): DelegationPolicyTemplate {
  return {
    id: 'sample-trip-direct-workers',
    version: 1,
    description: 'Direct public-work delegation from Sample Trip to Scout and Atlas.',
    mode: 'direct',
    source: { app_handle: 'sample-trip' },
    targets: [
      { app_handle: 'errand-runner', source_local_name: 'scout', target_local_name: 'sample-trip' },
      { app_handle: 'atlas', source_local_name: 'atlas', target_local_name: 'sample-trip' },
    ],
    policy: {
      allowed_work: ['public_research', 'artifact_generation', 'independent_review'],
      credentials: 'never_transfer',
      final_owner: 'source_agent',
      escalation: 'jeeves',
    },
    structure: {
      request: 'self_contained_task',
      response: 'result_and_files_to_source',
      max_hops: 1,
    },
    configuration: {
      bidirectional: true,
      allow_files: true,
      require_explicit_address: true,
    },
    ...overrides,
  };
}

function centralDestinations(): Array<{ agent_group_id: string; local_name: string; target_id: string }> {
  return getDb()
    .prepare(
      `SELECT agent_group_id, local_name, target_id
     FROM agent_destinations
     WHERE target_type = 'agent'
     ORDER BY agent_group_id, local_name`,
    )
    .all() as Array<{ agent_group_id: string; local_name: string; target_id: string }>;
}

describe('direct delegation policies', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);

    for (const [id, name, folder] of [
      [JEEVES, 'Jeeves', 'jeeves'],
      [TRIP, 'Sample Trip', 'sample-trip'],
      [SCOUT, 'Errand Runner', 'errand-runner'],
      [ATLAS, 'Atlas', 'atlas'],
    ] as const) {
      createAgentGroup({ id, name, folder, agent_provider: null, created_at: now() });
    }
    createApp({
      handle: 'sample-trip',
      name: 'Sample Trip',
      kind: 'agent',
      type: 'trip-companion',
      agent_group_id: TRIP,
      purpose: 'Trip planning.',
    });
    createApp({
      handle: 'errand-runner',
      name: 'Errand Runner',
      kind: 'agent',
      type: 'errand-runner',
      agent_group_id: SCOUT,
      purpose: 'Bounded public work.',
    });
    createApp({
      handle: 'atlas',
      name: 'Atlas',
      kind: 'agent',
      type: 'generalist',
      agent_group_id: ATLAS,
      purpose: 'Complex analysis.',
    });

    createSession({
      id: 'sess-trip',
      agent_group_id: TRIP,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(TRIP, 'sess-trip');
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('applies a reusable template idempotently and projects bidirectional routes', async () => {
    const first = await applyDelegationTemplate(directTemplate());
    expect(first.created).toBe(true);
    expect(first.edges).toHaveLength(4);
    expect(centralDestinations()).toEqual([
      { agent_group_id: ATLAS, local_name: 'sample-trip', target_id: TRIP },
      { agent_group_id: SCOUT, local_name: 'sample-trip', target_id: TRIP },
      { agent_group_id: TRIP, local_name: 'atlas', target_id: ATLAS },
      { agent_group_id: TRIP, local_name: 'scout', target_id: SCOUT },
    ]);

    const projected = new Database(inboundDbPath(TRIP, 'sess-trip'), { readonly: true });
    expect(projected.prepare('SELECT name, agent_group_id FROM destinations ORDER BY name').all()).toEqual([
      { name: 'atlas', agent_group_id: ATLAS },
      { name: 'scout', agent_group_id: SCOUT },
    ]);
    projected.close();

    const second = await applyDelegationTemplate(directTemplate());
    expect(second.created).toBe(false);
    expect(centralDestinations()).toHaveLength(4);
  });

  it('revokes only template-owned routes and preserves unrelated Jeeves access', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'agent', ?, ?)`,
    ).run(TRIP, 'jeeves', JEEVES, now());

    await applyDelegationTemplate(directTemplate());
    const result = await revokeDelegationPolicy('sample-trip-direct-workers');

    expect(result.removedEdges).toBe(4);
    expect(centralDestinations()).toEqual([{ agent_group_id: TRIP, local_name: 'jeeves', target_id: JEEVES }]);
  });

  it('fails closed on a local-name collision without partial ACL changes', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'agent', ?, ?)`,
    ).run(TRIP, 'scout', 'wrong-target', now());

    await expect(applyDelegationTemplate(directTemplate())).rejects.toThrow(/destination "scout"/i);
    expect(centralDestinations()).toEqual([{ agent_group_id: TRIP, local_name: 'scout', target_id: 'wrong-target' }]);
  });
});
