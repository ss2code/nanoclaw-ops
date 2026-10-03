import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-apps' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-apps';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { getDestinationByName } from '../../modules/agent-to-agent/db/agent-destinations.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import './apps.js';

function now(): string {
  return new Date().toISOString();
}

function readSessionDestinations(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db.prepare('SELECT name, type, agent_group_id FROM destinations ORDER BY name').all() as Array<{
    name: string;
    type: string;
    agent_group_id: string | null;
  }>;
  db.close();
  return rows;
}

describe('apps CLI catalog', () => {
  const JEEVES = 'ag-jeeves';
  const TRIP_GOA = 'ag-trip-goa';
  const OTHER_TRIP = 'ag-other-trip';
  const JEEVES_SESSION = 'sess-jeeves';
  const TRIP_SESSION = 'sess-trip-goa';

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: JEEVES, name: 'Jeeves', folder: 'jeeves', agent_provider: null, created_at: now() });
    createAgentGroup({
      id: TRIP_GOA,
      name: 'Trip Goa',
      folder: 'trip-goa',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: OTHER_TRIP,
      name: 'Trip Goa Replacement',
      folder: 'trip-goa-2',
      agent_provider: null,
      created_at: now(),
    });

    for (const [agentGroupId, sessionId] of [
      [JEEVES, JEEVES_SESSION],
      [TRIP_GOA, TRIP_SESSION],
    ] as const) {
      createSession({
        id: sessionId,
        agent_group_id: agentGroupId,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: now(),
      });
      initSessionFolder(agentGroupId, sessionId);
    }
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  async function createTripGoaApp() {
    return dispatch(
      {
        id: 'req-create',
        command: 'apps-create',
        args: {
          handle: 'goa-trip',
          name: 'Trip Goa',
          kind: 'agent',
          type: 'trip-companion',
          agent_group_id: TRIP_GOA,
          purpose: 'Trip Goa planning, itinerary state, and ledger.',
          read_source: 'ops-center:/trips',
          visibility: 'shared',
        },
      },
      { caller: 'host' },
    );
  }

  it('creates Trip Goa as @goa-trip and projects bidirectional destinations', async () => {
    const resp = await createTripGoaApp();
    expect(resp.ok).toBe(true);

    expect(getDestinationByName(JEEVES, 'goa-trip')).toMatchObject({
      target_type: 'agent',
      target_id: TRIP_GOA,
    });
    expect(getDestinationByName(TRIP_GOA, 'jeeves')).toMatchObject({
      target_type: 'agent',
      target_id: JEEVES,
    });

    expect(readSessionDestinations(JEEVES, JEEVES_SESSION)).toEqual([
      { name: 'goa-trip', type: 'agent', agent_group_id: TRIP_GOA },
    ]);
    expect(readSessionDestinations(TRIP_GOA, TRIP_SESSION)).toEqual([
      { name: 'jeeves', type: 'agent', agent_group_id: JEEVES },
    ]);
  });

  it('resolves exact @handles and does not require callers to strip @', async () => {
    await createTripGoaApp();
    const resp = await dispatch({ id: 'req-get', command: 'apps-get-@goa-trip', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect(resp.data).toMatchObject({ handle: 'goa-trip', name: 'Trip Goa', read_source: 'ops-center:/trips' });
    }
  });

  it('retire soft-deletes the catalog entry and removes derived destinations', async () => {
    await createTripGoaApp();

    const resp = await dispatch({ id: 'req-retire', command: 'apps-retire-goa-trip', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(true);

    expect(getDestinationByName(JEEVES, 'goa-trip')).toBeUndefined();
    expect(getDestinationByName(TRIP_GOA, 'jeeves')).toBeUndefined();
    expect(readSessionDestinations(JEEVES, JEEVES_SESSION)).toEqual([]);
    expect(readSessionDestinations(TRIP_GOA, TRIP_SESSION)).toEqual([]);
    if (resp.ok) expect(resp.data).toMatchObject({ retired: { handle: 'goa-trip', status: 'retired' } });
  });

  it('update rewires @goa-trip when the target agent group changes', async () => {
    await createTripGoaApp();

    const resp = await dispatch(
      {
        id: 'req-update',
        command: 'apps-update-goa-trip',
        args: { agent_group_id: OTHER_TRIP, purpose: 'Replacement Trip Goa workspace.' },
      },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(true);

    expect(getDestinationByName(JEEVES, 'goa-trip')).toMatchObject({
      target_type: 'agent',
      target_id: OTHER_TRIP,
    });
    expect(getDestinationByName(TRIP_GOA, 'jeeves')).toBeUndefined();
    expect(getDestinationByName(OTHER_TRIP, 'jeeves')).toMatchObject({
      target_type: 'agent',
      target_id: JEEVES,
    });
  });
});
