/**
 * Scheduling MCP tools: schedule_task, list_tasks, cancel_task, pause_task, resume_task.
 *
 * With the two-DB split, the container cannot write to inbound.db (host-owned).
 * Scheduling operations are sent as system actions via messages_out — the host
 * reads them during delivery and applies the changes to inbound.db.
 */
import { getOutboundDb, openInboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface TaskActionResponse {
  type: 'task_response';
  requestId: string;
  ok: boolean;
  text: string;
  result?: unknown;
}

function requestId(): string {
  return `task-request-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wait for the host to apply a task action. The response is a system row in
 * inbound.db, so it never enters the provider's normal prompt. A fresh
 * inbound connection per poll is required for cross-mount SQLite visibility.
 */
function pollTaskResponse(id: string, timeoutMs = 30_000): TaskActionResponse | null {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const inbound = openInboundDb();
    try {
      const rows = inbound
        .prepare("SELECT id, content FROM messages_in WHERE status = 'pending' AND kind = 'system' AND content LIKE ?")
        .all(`%${id}%`) as Array<{ id: string; content: string }>;

      for (const row of rows) {
        let parsed: TaskActionResponse;
        try {
          parsed = JSON.parse(row.content) as TaskActionResponse;
        } catch {
          continue;
        }
        if (parsed.type !== 'task_response' || parsed.requestId !== id) continue;

        // The main poll loop ignores system rows. Ack this one explicitly so
        // it cannot be found again if the MCP call or provider turn retries.
        getOutboundDb()
          .prepare(
            "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
          )
          .run(row.id);
        return parsed;
      }
    } finally {
      inbound.close();
    }

    Bun.sleepSync(200);
  }

  return null;
}

function taskAction(action: string, payload: Record<string, unknown>) {
  const id = requestId();
  writeMessageOut({
    id: `sys-${id}`,
    kind: 'system',
    content: JSON.stringify({ action, requestId: id, ...payload }),
  });

  const response = pollTaskResponse(id);
  if (!response) return err(`The host did not confirm ${action} within 30 seconds.`);
  if (!response.ok) return err(response.text || `${action} did not match a live task.`);
  return ok(response.text);
}

export const scheduleTask: McpToolDefinition = {
  tool: {
    name: 'schedule_task',
    description: `Schedule a one-shot or recurring task. The user's timezone is declared in the <context timezone="..."/> header of your prompt — interpret the user's "9pm" etc. in that zone. Cron expressions are interpreted in the user's timezone too.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'Task instructions/prompt' },
        processAfter: {
          type: 'string',
          description: `ISO 8601 timestamp for the first run. Accepts either UTC (ending in "Z" or "+00:00") or a naive local timestamp (no offset) which is interpreted in the user's timezone (e.g. "2026-01-15T21:00:00" = 9pm user-local). Prefer naive local.`,
        },
        recurrence: {
          type: 'string',
          description:
            'Cron expression for recurring tasks (e.g., "0 9 * * 1-5" = weekdays at 9am user-local). Evaluated in the user\'s timezone.',
        },
        script: { type: 'string', description: 'Optional pre-agent script to run before processing' },
        delegateTo: {
          type: 'string',
          enum: ['jeeves', 'errand-runner'],
          description:
            'Execution plane. Use "errand-runner" only for stateless public/research work; omit or use "jeeves" for private, authenticated, state-changing, or final-delivery work.',
        },
      },
      required: ['prompt', 'processAfter'],
    },
  },
  async handler(args) {
    const prompt = args.prompt as string;
    const processAfterIn = args.processAfter as string;
    if (!prompt || !processAfterIn) return err('prompt and processAfter are required');

    let processAfter: string;
    try {
      const d = parseZonedToUtc(processAfterIn, TIMEZONE);
      if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${processAfterIn}`);
      processAfter = d.toISOString();
    } catch {
      return err(`invalid processAfter: ${processAfterIn}`);
    }

    const id = generateId();
    const r = routing();
    const recurrence = (args.recurrence as string) || null;
    const script = (args.script as string) || null;
    const delegateTo = args.delegateTo === 'errand-runner' ? 'errand-runner' : null;

    const response = taskAction('schedule_task', {
      taskId: id,
      prompt,
      script,
      ...(delegateTo ? { delegateTo } : {}),
      processAfter,
      recurrence,
      platformId: r.platform_id,
      channelType: r.channel_type,
      threadId: r.thread_id,
    });

    log(
      `schedule_task: ${id} at ${processAfter}${recurrence ? ` (recurring: ${recurrence})` : ''}${delegateTo ? ` [delegateTo=${delegateTo}]` : ''}`,
    );
    return response;
  },
};

export const listTasks: McpToolDefinition = {
  tool: {
    name: 'list_tasks',
    description:
      'List scheduled tasks across all conversations handled by this agent. Returns one row per series — the live (pending or paused) occurrence. The id shown is the series id, which is what update_task / cancel_task / pause_task / resume_task expect.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending or paused (default: both)' },
      },
    },
  },
  async handler(args) {
    const status = args.status as string | undefined;
    return taskAction('list_tasks', status ? { status } : {});
  },
};

export const cancelTask: McpToolDefinition = {
  tool: {
    name: 'cancel_task',
    description: 'Cancel a scheduled task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to cancel' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    const response = taskAction('cancel_task', { taskId });
    log(`cancel_task: ${taskId}`);
    return response;
  },
};

export const pauseTask: McpToolDefinition = {
  tool: {
    name: 'pause_task',
    description: 'Pause a scheduled task. It will not run until resumed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to pause' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    const response = taskAction('pause_task', { taskId });
    log(`pause_task: ${taskId}`);
    return response;
  },
};

export const resumeTask: McpToolDefinition = {
  tool: {
    name: 'resume_task',
    description: 'Resume a paused task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Task ID to resume' },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');
    const response = taskAction('resume_task', { taskId });
    log(`resume_task: ${taskId}`);
    return response;
  },
};

export const updateTask: McpToolDefinition = {
  tool: {
    name: 'update_task',
    description:
      'Update a scheduled task. Pass the series id from list_tasks. Any field omitted is left unchanged. Use this instead of cancel + reschedule when adjusting an existing task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'Series id of the task to update (as shown by list_tasks)' },
        prompt: { type: 'string', description: 'New task prompt (optional)' },
        recurrence: {
          type: 'string',
          description: 'New cron expression (optional). Pass empty string to clear and make the task one-shot.',
        },
        processAfter: {
          type: 'string',
          description: `New ISO 8601 timestamp for the next run (optional). Accepts either UTC (ending in "Z" / "+00:00") or a naive local timestamp interpreted in the user's timezone.`,
        },
        script: {
          type: 'string',
          description: 'New pre-agent script (optional). Pass empty string to clear.',
        },
        delegateTo: {
          type: 'string',
          enum: ['jeeves', 'errand-runner'],
          description:
            'Change the execution plane. Use "errand-runner" only for stateless public/research work; use "jeeves" to keep the task in Jeeves.',
        },
      },
      required: ['taskId'],
    },
  },
  async handler(args) {
    const taskId = args.taskId as string;
    if (!taskId) return err('taskId is required');

    const update: Record<string, unknown> = { taskId };
    if (typeof args.prompt === 'string') update.prompt = args.prompt;
    if (typeof args.processAfter === 'string') {
      try {
        const d = parseZonedToUtc(args.processAfter, TIMEZONE);
        if (Number.isNaN(d.getTime())) return err(`invalid processAfter: ${args.processAfter}`);
        update.processAfter = d.toISOString();
      } catch {
        return err(`invalid processAfter: ${args.processAfter}`);
      }
    }
    // Empty string clears recurrence/script; undefined leaves them as-is.
    if (typeof args.recurrence === 'string') update.recurrence = args.recurrence === '' ? null : args.recurrence;
    if (typeof args.script === 'string') update.script = args.script === '' ? null : args.script;
    if (args.delegateTo === 'jeeves' || args.delegateTo === 'errand-runner') update.delegateTo = args.delegateTo;

    if (Object.keys(update).length === 1) return err('at least one field to update is required');

    const response = taskAction('update_task', update);
    log(`update_task: ${taskId}`);
    return response;
  },
};

registerTools([scheduleTask, listTasks, updateTask, cancelTask, pauseTask, resumeTask]);
