/** NanoClaw extension task parser for Agent Plugin directories. */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { parse } from 'yaml';

import { TIMEZONE } from '../config.js';
import { insertTask } from '../modules/scheduling/db.js';
import { inboundDbPath, openInboundDb, resolveTaskSession } from '../session-manager.js';

export interface TemplateTask {
  name: string;
  schedule: string;
  script?: string;
  prompt: string;
  source: string;
}

export interface PreparedTemplateTask extends TemplateTask {
  processAfter: string;
}

export const MAX_DAILY_FIRES = 4;

/** Stable task-name slug used for collision detection and readable row ids. */
export function taskNameSlug(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
}

function enforceRecurrenceLimit(task: TemplateTask, timezone: string): void {
  if (task.script) return;
  const horizon = Date.now() + 24 * 60 * 60 * 1000;
  const interval = CronExpressionParser.parse(task.schedule, { tz: timezone });
  let fires = 0;
  while (fires <= MAX_DAILY_FIRES) {
    if (interval.next().getTime() > horizon) break;
    fires++;
  }
  if (fires > MAX_DAILY_FIRES) {
    throw new Error(`Template task ${task.source} runs more than ${MAX_DAILY_FIRES} times per day without a script`);
  }
}

/** Validate all template task schedules before any group state is created. */
export function prepareTemplateTasks(tasks: TemplateTask[], timezone: string = TIMEZONE): PreparedTemplateTask[] {
  const slugs = new Map<string, string>();
  return tasks.map((task) => {
    const slug = taskNameSlug(task.name);
    if (!slug)
      throw new Error(`Template task ${task.source}: name "${task.name}" produces an empty id slug; rename it`);
    const collision = slugs.get(slug);
    if (collision !== undefined) {
      throw new Error(`Template tasks "${collision}" and "${task.name}" collide on id slug "${slug}"; rename one`);
    }
    slugs.set(slug, task.name);
    let processAfter: string;
    try {
      enforceRecurrenceLimit(task, timezone);
      const next = CronExpressionParser.parse(task.schedule, { tz: timezone }).next().toISOString();
      if (!next) throw new Error('schedule produced no next occurrence');
      processAfter = next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid template task ${task.source}: ${message}`, { cause: err });
    }
    return { ...task, processAfter };
  });
}

/** Create each extension task paused in its isolated system session. */
export function createTemplateTasks(agentGroupId: string, tasks: PreparedTemplateTask[]): void {
  for (const task of tasks) {
    const id = `template-${task.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)}-${randomUUID().slice(0, 6)}`;
    const { session } = resolveTaskSession(agentGroupId, id);
    if (!fs.existsSync(inboundDbPath(agentGroupId, session.id)))
      throw new Error('task system session inbound.db not found');
    const db = openInboundDb(agentGroupId, session.id);
    try {
      insertTask(db, {
        id,
        processAfter: task.processAfter,
        recurrence: task.schedule,
        platformId: null,
        channelType: null,
        threadId: null,
        content: JSON.stringify({ prompt: task.prompt, script: task.script ?? null, originSessionId: null }),
      });
      db.prepare("UPDATE messages_in SET status = 'paused' WHERE id = ?").run(id);
    } finally {
      db.close();
    }
  }
}

export function readTasks(tasksDir: string, sourcePrefix: string): TemplateTask[] {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => parseTaskFile(tasksDir, entry.name, sourcePrefix));
}

function parseTaskFile(tasksDir: string, file: string, sourcePrefix: string): TemplateTask {
  const source = `${sourcePrefix}/${file}`;
  const name = path.basename(file, '.md');
  const lines = fs.readFileSync(path.join(tasksDir, file), 'utf-8').split(/\r?\n/);
  if (!name) throw new Error(`Template task ${source} has no task name`);
  if (lines[0] !== '---') throw new Error(`Template task ${source} must start with --- frontmatter`);
  const closing = lines.indexOf('---', 1);
  if (closing === -1) throw new Error(`Template task ${source} is missing the closing ---`);

  let metadata: unknown;
  try {
    metadata = parse(lines.slice(1, closing).join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Template task ${source} has invalid YAML frontmatter: ${message}`, { cause: err });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`Template task ${source} frontmatter must be a YAML mapping`);
  }
  const unknownFields = Object.keys(metadata).filter((key) => key !== 'schedule' && key !== 'script');
  if (unknownFields.length > 0) throw new Error(`Template task ${source} frontmatter accepts only schedule and script`);

  const scheduleValue = Reflect.get(metadata, 'schedule');
  if (typeof scheduleValue !== 'string' || !scheduleValue.trim()) {
    throw new Error(`Template task ${source} schedule must be a nonempty string`);
  }
  const scriptValue = Reflect.get(metadata, 'script');
  if (scriptValue !== undefined && (typeof scriptValue !== 'string' || !scriptValue.trim())) {
    throw new Error(`Template task ${source} script must be a nonempty string`);
  }
  const prompt = lines
    .slice(closing + 1)
    .join('\n')
    .trim();
  if (!prompt) throw new Error(`Template task ${source} prompt is required`);
  return {
    name,
    schedule: scheduleValue.trim(),
    ...(typeof scriptValue === 'string' ? { script: scriptValue } : {}),
    prompt,
    source,
  };
}
