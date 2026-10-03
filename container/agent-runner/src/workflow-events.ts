/**
 * Provider- and domain-neutral workflow receipts.
 *
 * Applications and skills may emit bounded, structured events here without
 * making RUNS import their code. The file lives in the host-backed session
 * directory and is best effort: observability must never make a user turn fail.
 */
import fs from 'node:fs';
import path from 'node:path';

export type WorkflowSource = 'nanoclaw' | 'application' | 'skill' | 'provider';
export type WorkflowStatus = 'started' | 'completed' | 'failed' | 'skipped' | 'observed';

export interface WorkflowEventInput {
  file?: string;
  source: WorkflowSource;
  name: string;
  status: WorkflowStatus;
  traceId?: string | null;
  turnId?: string | null;
  data?: unknown;
}

export interface WorkflowEvent {
  schema: 1;
  at: string;
  source: WorkflowSource;
  name: string;
  status: WorkflowStatus;
  trace_id: string | null;
  turn_id: string | null;
  data: unknown;
}

export const DEFAULT_WORKFLOW_EVENTS_FILE = '/workspace/workflow-events.jsonl';
const MAX_STRING = 240;
const MAX_DATA_JSON = 4_000;
const SECRET_KEY = /(secret|token|password|credential|api[_-]?key|authorization|cookie)/i;

function boundedString(value: unknown): string | null {
  if (typeof value !== 'string') return value == null ? null : String(value).slice(0, MAX_STRING);
  return value.trim().slice(0, MAX_STRING);
}

function scrubData(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => scrubData(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, item]) => [key.slice(0, MAX_STRING), SECRET_KEY.test(key) ? '[redacted]' : scrubData(item, depth + 1)]),
  );
}

function boundedData(value: unknown): unknown {
  const scrubbed = scrubData(value ?? {});
  let json: string;
  try { json = JSON.stringify(scrubbed); } catch { return { note: 'unserializable workflow data' }; }
  if (json.length <= MAX_DATA_JSON) return scrubbed;
  return { note: 'workflow data truncated', preview: json.slice(0, MAX_DATA_JSON - 32) };
}

/** Append one safe workflow event. Returns the normalized event or null on IO failure. */
export function emitWorkflowEvent(input: WorkflowEventInput): WorkflowEvent | null {
  const event: WorkflowEvent = {
    schema: 1,
    at: new Date().toISOString(),
    source: input.source,
    name: boundedString(input.name) ?? 'unnamed',
    status: input.status,
    trace_id: boundedString(input.traceId),
    turn_id: boundedString(input.turnId),
    data: boundedData(input.data),
  };
  const file = input.file ?? process.env.NANOCLAW_WORKFLOW_EVENTS_FILE ?? DEFAULT_WORKFLOW_EVENTS_FILE;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
    return event;
  } catch (error) {
    console.error(`[workflow-events] unable to append ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
