/**
 * Read-only execution traces from OpenCode's SQLite store.
 *
 * OpenCode-provider groups (e.g. the Errand Runner) never write the Claude SDK
 * JSONL transcripts that readers/runs.ts parses — OpenCode keeps its own store at
 * data/v2-sessions/<group>/<session>/opencode-xdg/opencode/opencode.db (session /
 * message / part tables). Without this reader those groups are invisible on the
 * Runs page. This maps each OpenCode `session` row onto the same ExecutionRun
 * shape the JSONL reader produces, so the Runs page filters, facets, sort, and
 * stat strip work unchanged. Purely read-only, mirroring readers/sessiondbs.ts.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { PATHS } from '../config.js';
import {
  classifyTrigger,
  detectMemoryOp,
  outboundActionForTool,
  scriptIntent,
  type ExecutionRun,
  type RunArtifact,
  type RunModelCall,
  type RunToolCall,
  type RunTurn,
} from './runs.js';

/** Cap sessions read per DB (most recently updated first) so a long-lived group
 * with a huge history can't blow up memory. The outer pool slices again anyway. */
const MAX_SESSIONS_PER_DB = 200;

interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  time_created: number;
  time_updated: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function clean(value: unknown, max = 180): string {
  const s =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > max ? `${v.slice(0, max)}...` : v));
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Epoch-ms integer → ISO string, or '' when absent/invalid. */
function isoFromMs(ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function toNum(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Summarize one OpenCode tool part. OpenCode tool names are lowercase and differ
 * from Claude's (`bash`/`webfetch`/`skill`/`task`/`read`/`write`/`edit`, plus MCP
 * tools like `nanoclaw_send_message`), so this is a distinct summarizer from the
 * JSONL reader's toolSummary.
 */
function summarizeTool(
  name: string,
  input: unknown,
): { summary: string; detail: string | null; file: string | null; skill: string | null } {
  if (!isRecord(input)) return { summary: name, detail: null, file: null, skill: null };
  const file = firstString(input, ['filePath', 'file_path', 'path', 'notebook_path']);
  if (name === 'bash') {
    return { summary: 'Bash command', detail: clean(input.command ?? input), file: null, skill: null };
  }
  if (name === 'webfetch') {
    const url = firstString(input, ['url']);
    return { summary: url ? `webfetch ${url}` : 'webfetch', detail: clean(input), file: null, skill: null };
  }
  if (name === 'skill') {
    const skill = firstString(input, ['name', 'skill', 'skill_id']);
    return { summary: skill ? `Skill ${skill}` : 'Skill call', detail: clean(input), file: null, skill };
  }
  if (name === 'task') {
    return {
      summary: firstString(input, ['description']) ?? 'Subagent task',
      detail: clean(input),
      file: null,
      skill: null,
    };
  }
  if (file && (name === 'read' || name === 'write' || name === 'edit' || name === 'patch')) {
    return { summary: `${name} ${file}`, detail: null, file, skill: null };
  }
  return { summary: name, detail: clean(input), file, skill: null };
}

/**
 * Walk sessionsRoot for OpenCode stores. Most groups use a session-local store
 * at <group>/<session>/opencode-xdg/opencode/opencode.db; native XAI groups use
 * a group-persistent store at <group>/opencode-xdg/opencode/opencode.db so their
 * OAuth state survives NanoClaw session rotation.
 */
export function listOpenCodeDbs(sessionsRoot: string = PATHS.sessionsDir): { groupId: string; db: string }[] {
  const out: { groupId: string; db: string }[] = [];
  const seen = new Set<string>();
  const add = (groupId: string, db: string) => {
    if (!fs.existsSync(db)) return;
    const key = path.resolve(db);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ groupId, db });
  };
  if (!fs.existsSync(sessionsRoot)) return out;
  for (const groupId of fs.readdirSync(sessionsRoot)) {
    if (groupId.startsWith('.')) continue;
    const groupDir = path.join(sessionsRoot, groupId);
    let sessionDirs: string[];
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
      sessionDirs = fs.readdirSync(groupDir);
    } catch {
      continue;
    }
    add(groupId, path.join(groupDir, 'opencode-xdg', 'opencode', 'opencode.db'));
    for (const sessionId of sessionDirs) {
      if (sessionId.startsWith('.')) continue;
      const db = path.join(groupDir, sessionId, 'opencode-xdg', 'opencode', 'opencode.db');
      add(groupId, db);
    }
  }
  return out;
}

function runsFromDb(groupId: string, dbPath: string): ExecutionRun[] {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const sessions = db
      .prepare(
        'SELECT id, parent_id, title, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT ?',
      )
      .all(MAX_SESSIONS_PER_DB) as SessionRow[];
    if (!sessions.length) return [];

    const ids = sessions.map((s) => s.id);
    const placeholders = ids.map(() => '?').join(',');
    const messages = db
      .prepare(
        `SELECT id, session_id AS sid, time_created, data FROM message WHERE session_id IN (${placeholders}) ORDER BY time_created`,
      )
      .all(...ids) as { id: string; sid: string; time_created: number; data: string }[];
    const parts = db
      .prepare(
        `SELECT id, message_id AS mid, session_id AS sid, time_created, data FROM part WHERE session_id IN (${placeholders}) ORDER BY time_created`,
      )
      .all(...ids) as { id: string; mid: string; sid: string; time_created: number; data: string }[];

    const modelCallsBySession = new Map<string, RunModelCall[]>();
    for (const row of messages) {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (d.role !== 'assistant' || typeof d.modelID !== 'string') continue;
      const tokens = isRecord(d.tokens) ? d.tokens : {};
      const cache = isRecord(tokens.cache) ? tokens.cache : {};
      const time = isRecord(d.time) ? d.time : {};
      const list = modelCallsBySession.get(row.sid) ?? [];
      list.push({
        ts: isoFromMs(time.completed ?? time.created),
        model: d.modelID,
        inputTokens: toNum(tokens.input),
        // OpenRouter reports reasoning tokens separately from output; both are
        // model-generated, so fold them together for the "output" column.
        outputTokens: toNum(tokens.output) + toNum(tokens.reasoning),
        cacheRead: toNum(cache.read),
        cacheCreate: toNum(cache.write),
        id: null,
        text: null,
        toolNames: [],
        stopReason: typeof d.finish === 'string' ? d.finish : null,
        nativeCostUsd: typeof d.cost === 'number' ? d.cost : null,
        durationMs: toNum(time.completed) > toNum(time.created) ? toNum(time.completed) - toNum(time.created) : null,
      });
      modelCallsBySession.set(row.sid, list);
    }

    const toolsBySession = new Map<string, RunToolCall[]>();
    const skillsBySession = new Map<string, Set<string>>();
    const filesBySession = new Map<string, Set<string>>();
    for (const row of parts) {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (d.type !== 'tool' || typeof d.tool !== 'string') continue;
      const state = isRecord(d.state) ? d.state : {};
      const stateTime = isRecord(state.time) ? state.time : {};
      const summary = summarizeTool(d.tool, state.input);
      if (summary.file) {
        if (!filesBySession.has(row.sid)) filesBySession.set(row.sid, new Set());
        filesBySession.get(row.sid)!.add(summary.file);
      }
      if (summary.skill) {
        if (!skillsBySession.has(row.sid)) skillsBySession.set(row.sid, new Set());
        skillsBySession.get(row.sid)!.add(summary.skill);
      }
      const list = toolsBySession.get(row.sid) ?? [];
      list.push({ ts: isoFromMs(stateTime.start), name: d.tool, summary: summary.summary, detail: summary.detail });
      toolsBySession.set(row.sid, list);
    }

    const runs: ExecutionRun[] = [];
    for (const s of sessions) {
      const modelCalls = modelCallsBySession.get(s.id) ?? [];
      const tools = toolsBySession.get(s.id) ?? [];
      const skills = [...(skillsBySession.get(s.id) ?? [])].sort();
      const files = [...(filesBySession.get(s.id) ?? [])].sort();
      const startedAt = isoFromMs(s.time_created) || null;
      const lastAt = isoFromMs(s.time_updated) || startedAt;
      const sessionMessages = messages.filter((m) => m.sid === s.id);
      const partsByMessage = new Map<string, typeof parts>();
      for (const part of parts.filter((p) => p.sid === s.id))
        partsByMessage.set(part.mid, [...(partsByMessage.get(part.mid) ?? []), part]);
      const turns: RunTurn[] = [];
      let current: RunTurn | null = null;
      for (const message of sessionMessages) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(message.data);
        } catch {
          continue;
        }
        const messageParts = partsByMessage.get(message.id) ?? [];
        const textParts = messageParts.flatMap((p) => {
          try {
            const d = JSON.parse(p.data);
            return isRecord(d) && typeof d.text === 'string' ? [d.text] : [];
          } catch {
            return [];
          }
        });
        if (data.role === 'user') {
          const prompt =
            textParts
              .join('\n')
              .replace(/^\s*<system>[\s\S]*?<\/system>\s*/, '')
              .trim() || textParts.join('\n');
          current = {
            index: turns.length,
            startedAt: isoFromMs(message.time_created),
            endedAt: isoFromMs(message.time_created),
            trigger: classifyTrigger(prompt),
            tools: [],
            modelCalls: [],
            activeMs: 0,
            errorCount: 0,
            compactions: 0,
            responsePreview: null,
            outMessages: [],
            outboundActions: [],
            artifacts: [],
            contextTokens: null,
            costUsd: null,
            totals: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
            memoryOps: [],
            memoryInjected: null,
            skillsInvoked: [],
            outcome: 'idle',
          };
          turns.push(current);
          continue;
        }
        if (data.role !== 'assistant') continue;
        if (!current) {
          current = {
            index: 0,
            startedAt: isoFromMs(message.time_created),
            endedAt: isoFromMs(message.time_created),
            trigger: { kind: 'unknown', label: 'implicit start', intent: '(no prompt text)' },
            tools: [],
            modelCalls: [],
            activeMs: 0,
            errorCount: 0,
            compactions: 0,
            responsePreview: null,
            outMessages: [],
            outboundActions: [],
            artifacts: [],
            contextTokens: null,
            costUsd: null,
            totals: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
            memoryOps: [],
            memoryInjected: null,
            skillsInvoked: [],
            outcome: 'idle',
          };
          turns.push(current);
        }
        const call = modelCalls.find(
          (c) =>
            c.ts === isoFromMs(message.time_created) ||
            c.ts === isoFromMs(isRecord(data.time) ? data.time.completed : null),
        );
        if (call && !current.modelCalls.includes(call)) current.modelCalls.push(call);
        for (const part of messageParts) {
          try {
            const d = JSON.parse(part.data);
            if (!isRecord(d)) continue;
            if (d.type === 'text' && typeof d.text === 'string') {
              if (call) call.text = clean(d.text.replace(/<message\b[^>]*>([\s\S]*?)<\/message>/g, '$1'), 300) || null;
              current.responsePreview = clean(d.text, 240) || current.responsePreview;
            }
            if (d.type === 'tool' && typeof d.tool === 'string') {
              const state = isRecord(d.state) ? d.state : {};
              const time = isRecord(state.time) ? state.time : {};
              const summary = summarizeTool(d.tool, state.input);
              const tool = {
                ts: isoFromMs(time.start ?? part.time_created),
                name: d.tool,
                summary: summary.summary,
                detail: summary.detail,
                durationMs: toNum(time.end) > toNum(time.start) ? toNum(time.end) - toNum(time.start) : null,
                error: state.status === 'error',
                resultPreview: clean(state.output, 200) || null,
              };
              current.tools.push(tool);
              if (call) call.toolNames.push(d.tool);
              if (tool.error) current.errorCount++;
              if (!tool.error) {
                const action = outboundActionForTool(d.tool, tool.resultPreview ?? null);
                if (action) current.outboundActions?.push(action);
              }
              if (d.tool === 'bash' && isRecord(state.input) && typeof state.input.command === 'string') {
                const memory = detectMemoryOp(state.input.command);
                if (memory) current.memoryOps.push({ ...memory, hits: null, error: tool.error });
              }
            }
          } catch {
            /* malformed part */
          }
        }
        current.endedAt = isoFromMs(message.time_created) || current.endedAt;
      }
      for (const turn of turns) {
        turn.totals = turn.modelCalls.reduce(
          (a, c) => ({
            ...a,
            inputTokens: a.inputTokens + c.inputTokens,
            outputTokens: a.outputTokens + c.outputTokens,
            cacheRead: a.cacheRead + c.cacheRead,
            cacheCreate: a.cacheCreate + c.cacheCreate,
          }),
          {
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheCreate: 0,
            modelCalls: turn.modelCalls.length,
            toolCalls: turn.tools.length,
          },
        );
        turn.costUsd = turn.modelCalls.reduce((n, c) => n + (c.nativeCostUsd ?? 0), 0) || null;
      }
      const totals = modelCalls.reduce(
        (acc, call) => {
          acc.inputTokens += call.inputTokens;
          acc.outputTokens += call.outputTokens;
          acc.cacheRead += call.cacheRead;
          acc.cacheCreate += call.cacheCreate;
          return acc;
        },
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheCreate: 0,
          modelCalls: modelCalls.length,
          toolCalls: tools.length,
        },
      );
      const title = typeof s.title === 'string' ? s.title.replace(/\s+/g, ' ').trim() : '';
      runs.push({
        id: `${groupId}:${s.id}`,
        groupId,
        sessionId: s.id,
        lane: s.parent_id ? 'subagent' : 'main',
        file: dbPath,
        startedAt,
        lastAt,
        modelCalls,
        tools,
        skills,
        files,
        debugTag: `group=${groupId} session=${s.id}${title ? ` title=${JSON.stringify(title)}` : ''}`,
        totals,
        turns,
        activeMs: turns.reduce((n, t) => n + t.activeMs, 0),
        errorCount: turns.reduce((n, t) => n + t.errorCount, 0),
        compactions: 0,
        costUsd: modelCalls.reduce((n, c) => n + (c.nativeCostUsd ?? 0), 0) || null,
        artifacts: [],
        parentSessionId: s.parent_id,
        costIsExact: modelCalls.length > 0 && modelCalls.every((c) => c.nativeCostUsd != null),
      });
    }
    return runs;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Read OpenCode execution runs across all groups (or one, when `groupId` is set).
 * Never throws: a single unreadable/locked DB is skipped so the Runs page still
 * renders. Returned unsorted/unsliced — the caller merges into the JSONL pool and
 * applies the shared filter/sort/slice.
 */
export function readOpenCodeRuns(opts: { sessionsRoot?: string; groupId?: string } = {}): ExecutionRun[] {
  const sessionsRoot = opts.sessionsRoot ?? PATHS.sessionsDir;
  const runs: ExecutionRun[] = [];
  for (const { groupId, db } of listOpenCodeDbs(sessionsRoot)) {
    if (opts.groupId && groupId !== opts.groupId) continue;
    runs.push(...runsFromDb(groupId, db));
  }
  return runs;
}
