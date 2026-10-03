import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readPiRuntimeHealth } from './readers/pi-health.js';
import { piRuntimeCard } from './ui.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Pi runtime observability', () => {
  it('selects the newest session health and summarizes bounded redacted events', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-health-'));
    dirs.push(root);
    const obs = path.join(root, 'ag-pi', 'session-2', 'pi-observability');
    fs.mkdirSync(obs, { recursive: true });
    fs.writeFileSync(path.join(obs, 'mcp-health.json'), JSON.stringify({
      schemaVersion: 1,
      provider: 'pi',
      status: 'degraded',
      updatedAt: '2026-09-03T01:02:03.000Z',
      catalogTools: 12,
      activeTools: 4,
      servers: {
        nanoclaw: { status: 'ready', toolCount: 5, calls: 2, errors: 0, lastLatencyMs: 31, lastCallAt: '2026-09-03T01:02:00.000Z' },
        gmail: { status: 'error', toolCount: 7, calls: 3, errors: 1, lastLatencyMs: 900, lastCallAt: '2026-09-03T01:02:01.000Z', error: 'unauthorized [redacted]' },
      },
    }));
    fs.writeFileSync(path.join(obs, 'events.jsonl'), [
      JSON.stringify({ ts: '2026-09-03T01:01:00.000Z', provider: 'pi', type: 'turn_started', model: 'grok-4.6' }),
      JSON.stringify({ ts: '2026-09-03T01:02:00.000Z', provider: 'pi', type: 'mcp_call_error', server: 'gmail', tool: 'search' }),
    ].join('\n'));

    const health = readPiRuntimeHealth(root, 'ag-pi');
    expect(health).toMatchObject({ status: 'degraded', sessionId: 'session-2', recentEventCount: 2 });
    expect(health?.servers.gmail).toMatchObject({ errors: 1, error: 'unauthorized [redacted]' });
    expect(JSON.stringify(health)).not.toContain('API_KEY');
  });

  it('renders server-level counts and operator-friendly degraded state', () => {
    const html = piRuntimeCard({
      status: 'degraded', updatedAt: '2026-09-03T01:02:03.000Z', sessionId: 's1', catalogTools: 12,
      activeTools: 4, recentEventCount: 2, lastEvent: { ts: '2026-09-03T01:02:00.000Z', type: 'mcp_call_error' },
      servers: { gmail: { status: 'error', toolCount: 7, calls: 3, errors: 1, lastLatencyMs: 900, lastCallAt: null, error: 'unauthorized [redacted]' } },
    });
    expect(html).toContain('Pi runtime');
    expect(html).toContain('degraded');
    expect(html).toContain('gmail');
    expect(html).toContain('3 calls');
    expect(html).toContain('1 errors');
  });
});
