/**
 * Read generic NanoClaw workflow receipts emitted by the runner, a template,
 * or a skill. This reader intentionally has no knowledge of tutor/trip/etc.
 */
import fs from 'fs';
import path from 'path';

import type { RunTurn } from './runs.js';

export interface WorkflowEvent {
  schema: 1;
  at: string;
  source: 'nanoclaw' | 'application' | 'skill' | 'provider' | string;
  name: string;
  status: 'started' | 'completed' | 'failed' | 'skipped' | 'observed' | string;
  trace_id: string | null;
  turn_id: string | null;
  data: unknown;
}

function parseLine(line: string): WorkflowEvent | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.schema !== 1 || typeof value.at !== 'string' || typeof value.name !== 'string') return null;
    return {
      schema: 1,
      at: value.at,
      source: typeof value.source === 'string' ? value.source : 'unknown',
      name: value.name,
      status: typeof value.status === 'string' ? value.status : 'observed',
      trace_id: typeof value.trace_id === 'string' ? value.trace_id : null,
      turn_id: typeof value.turn_id === 'string' ? value.turn_id : null,
      data: value.data ?? {},
    };
  } catch {
    return null;
  }
}

export function readWorkflowEvents(sessionDir: string, limit = 2_000): WorkflowEvent[] {
  const file = path.join(sessionDir, 'workflow-events.jsonl');
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text
    .split('\n')
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(10_000, limit)))
    .map(parseLine)
    .filter((event): event is WorkflowEvent => event !== null);
}

/** Match receipts to the transcript turn by a bounded wall-clock window. */
export function readWorkflowEventsByTurn(sessionDir: string, turns: RunTurn[]): Map<number, WorkflowEvent[]> {
  const events = readWorkflowEvents(sessionDir);
  const result = new Map<number, WorkflowEvent[]>();
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const turn = turns.filter((candidate) => {
      const start = Date.parse(candidate.startedAt) - 1_000;
      const end = Date.parse(candidate.endedAt) + 60_000;
      return at >= start && at <= end;
    }).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    if (!turn) continue;
    const list = result.get(turn.index) ?? [];
    list.push(event);
    result.set(turn.index, list);
  }
  return result;
}

export function workflowEventSummary(events: WorkflowEvent[]): { total: number; failed: number; sources: string[] } {
  return {
    total: events.length,
    failed: events.filter((event) => event.status === 'failed').length,
    sources: [...new Set(events.map((event) => event.source))].sort(),
  };
}
