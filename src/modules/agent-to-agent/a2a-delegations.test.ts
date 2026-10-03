import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { routeAgentMessage } from './agent-route.js';
import { parseDelegationSignals } from './db/a2a-delegations.js';
import { createDestination } from './db/agent-destinations.js';
import { getDb } from '../../db/connection.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import type { Session } from '../../types.js';
import Database from 'better-sqlite3';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-a2a-ledger' };
});

const TEST_DIR = '/tmp/nanoclaw-test-a2a-ledger';

function now(): string {
  return new Date().toISOString();
}

describe('parseDelegationSignals', () => {
  it('extracts a tier directive', () => {
    const s = parseDelegationSignals('Summarize this doc. [tier:low]');
    expect(s.tier).toBe('low');
    expect(s.escalation).toBeNull();
  });

  it('is case-insensitive and whitespace-tolerant on tier', () => {
    expect(parseDelegationSignals('[Tier: HIGH ] hard problem').tier).toBe('high');
  });

  it('extracts an escalation reason', () => {
    const s = parseDelegationSignals('[escalate: egress-blocked, needs live web access] partial notes follow');
    expect(s.escalation).toBe('egress-blocked, needs live web access');
    expect(s.tier).toBeNull();
  });

  it('marks a bare [escalate] as unspecified', () => {
    expect(parseDelegationSignals('[escalate] could not finish').escalation).toBe('unspecified');
  });

  it('returns null signals for plain text', () => {
    const s = parseDelegationSignals('just a normal message');
    expect(s.tier).toBeNull();
    expect(s.escalation).toBeNull();
    expect(s.summary).toBe('just a normal message');
  });

  it('truncates and collapses whitespace in the summary', () => {
    const s = parseDelegationSignals(`a  b\n\nc ${'x'.repeat(400)}`);
    expect(s.summary.startsWith('a b c x')).toBe(true);
    expect(s.summary.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(s.summary.endsWith('…')).toBe(true);
  });
});

describe('delegation ledger writes on a2a routes', () => {
  const A = 'ag-A';
  const B = 'ag-B';
  let SA: Session;
  let SB: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: A, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'B', folder: 'b', agent_provider: null, created_at: now() });

    SA = {
      id: 'sess-A',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    SB = { ...SA, id: 'sess-B', agent_group_id: B };
    createSession(SA);
    createSession(SB);
    initSessionFolder(A, SA.id);
    initSessionFolder(B, SB.id);

    createDestination({ agent_group_id: A, local_name: 'b', target_type: 'agent', target_id: B, created_at: now() });
    createDestination({ agent_group_id: B, local_name: 'a', target_type: 'agent', target_id: A, created_at: now() });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function ledgerRows() {
    return getDb().prepare('SELECT * FROM a2a_delegations ORDER BY id').all() as Array<Record<string, unknown>>;
  }

  it('records the request leg with its tier directive', async () => {
    await routeAgentMessage(
      {
        id: 'm1',
        platform_id: B,
        content: JSON.stringify({ text: 'Classify these rows. [tier:medium]' }),
        in_reply_to: null,
      },
      SA,
    );

    const rows = ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].from_group).toBe(A);
    expect(rows[0].to_group).toBe(B);
    expect(rows[0].tier).toBe('medium');
    expect(rows[0].escalation).toBeNull();
    expect(rows[0].in_reply_to).toBeNull();
    expect(rows[0].summary).toContain('Classify these rows');
  });

  it('records the reply leg joined to the request and captures escalation', async () => {
    await routeAgentMessage(
      { id: 'm1', platform_id: B, content: JSON.stringify({ text: 'Do the thing. [tier:high]' }), in_reply_to: null },
      SA,
    );
    // The reply references the synthetic a2a id the host wrote into B's inbound.
    const inb = new Database(inboundDbPath(B, SB.id), { readonly: true });
    const a2aId = (inb.prepare('SELECT id FROM messages_in').get() as { id: string }).id;
    inb.close();

    await routeAgentMessage(
      {
        id: 'm2',
        platform_id: A,
        content: JSON.stringify({ text: '[escalate: needs credentials] cannot proceed' }),
        in_reply_to: a2aId,
      },
      SB,
    );

    const rows = ledgerRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].from_group).toBe(B);
    expect(rows[1].in_reply_to).toBe(rows[0].a2a_msg_id);
    expect(rows[1].escalation).toBe('needs credentials');
  });

  it('does not record self-routes', async () => {
    await routeAgentMessage(
      { id: 'm-self', platform_id: A, content: JSON.stringify({ text: 'note to self' }), in_reply_to: null },
      SA,
    );
    expect(ledgerRows()).toHaveLength(0);
  });
});
