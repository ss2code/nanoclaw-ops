import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emitWorkflowEvent } from './workflow-events.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('generic workflow event protocol', () => {
  it('writes bounded, source-labelled events without depending on a domain app', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-workflow-events-'));
    roots.push(root);
    const file = path.join(root, 'workflow-events.jsonl');

    emitWorkflowEvent({
      file,
      source: 'skill',
      name: 'frontier.loaded',
      status: 'completed',
      traceId: 'turn-1',
      turnId: 'inbound-1',
      data: { concept: 'C01', secret: 'token=abc123' },
    });

    const event = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      schema: 1,
      source: 'skill',
      name: 'frontier.loaded',
      status: 'completed',
      trace_id: 'turn-1',
      turn_id: 'inbound-1',
    });
    expect(typeof event.at).toBe('string');
    expect(JSON.stringify(event)).not.toContain('token=abc123');
  });
});
