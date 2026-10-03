/** Generic workflow receipt tool for templates and skills. */
import { getCurrentTurnId } from '../current-batch.js';
import { emitWorkflowEvent, type WorkflowSource, type WorkflowStatus } from '../workflow-events.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const SOURCES = new Set<WorkflowSource>(['application', 'skill', 'provider']);
const STATUSES = new Set<WorkflowStatus>(['started', 'completed', 'failed', 'skipped', 'observed']);

function result(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

export const recordWorkflowEvent: McpToolDefinition = {
  tool: {
    name: 'record_workflow_event',
    description: 'Record a bounded workflow step for RUNS observability. Use for application or skill stages; never include secrets or raw private conversation text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', enum: ['application', 'skill', 'provider'], description: 'Who owns this workflow step.' },
        name: { type: 'string', description: 'Stable namespaced step name, e.g. frontier.loaded or report.generated.' },
        status: { type: 'string', enum: ['started', 'completed', 'failed', 'skipped', 'observed'] },
        trace_id: { type: 'string', description: 'Opaque application trace ID, if one exists.' },
        data: { type: 'object', description: 'Small non-sensitive structured metadata.' },
      },
      required: ['source', 'name', 'status'],
    },
  },
  async handler(args) {
    const source = String(args.source ?? '') as WorkflowSource;
    const name = String(args.name ?? '').trim();
    const status = String(args.status ?? '') as WorkflowStatus;
    if (!SOURCES.has(source)) return result('Error: source must be application, skill, or provider', true);
    if (!name) return result('Error: name is required', true);
    if (!STATUSES.has(status)) return result('Error: invalid workflow status', true);
    const event = emitWorkflowEvent({
      source,
      name,
      status,
      traceId: typeof args.trace_id === 'string' ? args.trace_id : null,
      turnId: getCurrentTurnId(),
      data: args.data,
    });
    return event ? result(`Workflow event recorded: ${event.name} (${event.status})`) : result('Workflow event could not be recorded', true);
  },
};

registerTools([recordWorkflowEvent]);
