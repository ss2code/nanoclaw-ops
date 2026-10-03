/** Read-only Ops Center adapter for native Codex rollout JSONL files. */
import fs from 'node:fs';
import path from 'node:path';

import { PATHS } from '../config.js';
import type { ExecutionRun, RunModelCall, RunToolCall, RunTurn, TriggerKind, TurnTrigger } from './runs.js';
import type { TokenLane } from './tokens.js';

interface CodexRolloutFile {
  groupId: string;
  file: string;
  lane: TokenLane;
}

export interface CodexUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  timestamp: string;
  contextWindow: number | null;
}

interface MutableTurn {
  turn: RunTurn;
  model: string;
  lastResponse: string | null;
  toolByCall: Map<string, RunToolCall>;
  taskStartedMs: number | null;
}

const norm = (value: string) => value.replace(/\s+/g, ' ').trim();
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function listCodexRolloutFiles(sessionsRoot = PATHS.sessionsDir): CodexRolloutFile[] {
  const out: CodexRolloutFile[] = [];
  if (!fs.existsSync(sessionsRoot)) return out;
  for (const groupId of fs.readdirSync(sessionsRoot)) {
    const groupDir = path.join(sessionsRoot, groupId);
    const stateRoots = [path.join(groupDir, '.codex-shared', 'sessions')];
    try {
      // Codex state is per-session so concurrent app-server processes do not
      // collide in Codex's SQLite runtime. Keep the legacy group-level root in
      // the list for installations created before that isolation change.
      for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        stateRoots.push(path.join(groupDir, entry.name, '.codex-shared', 'sessions'));
      }
    } catch {
      continue;
    }
    for (const sessions of stateRoots) {
      if (!fs.existsSync(sessions)) continue;
      walk(sessions, (file) => {
        if (!path.basename(file).startsWith('rollout-') || !file.endsWith('.jsonl')) return;
        out.push({ groupId, file, lane: file.includes(`${path.sep}subagents${path.sep}`) ? 'subagent' : 'main' });
      });
    }
  }
  return out;
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir)) {
    const target = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(target, visit);
    else visit(target);
  }
}

export function parseCodexUsageChunk(text: string, initialModel = 'codex'): { usages: CodexUsage[]; model: string } {
  const usages: CodexUsage[] = [];
  let model = initialModel;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(record.payload);
    if (record.type === 'turn_context' && payload && typeof payload.model === 'string') model = payload.model;
    if (record.type !== 'event_msg' || payload?.type !== 'token_count') continue;
    const info = asRecord(payload.info);
    const usage = asRecord(info?.last_token_usage);
    if (!usage) continue;
    const totalInput = asNumber(usage.input_tokens);
    const cached = asNumber(usage.cached_input_tokens);
    usages.push({
      model,
      input: Math.max(0, totalInput - cached),
      output: asNumber(usage.output_tokens),
      cacheRead: cached,
      cacheCreate: 0,
      timestamp: asString(record.timestamp) ?? '',
      contextWindow: typeof info?.model_context_window === 'number' ? info.model_context_window : null,
    });
  }
  return { usages, model };
}

export function parseCodexUsageLines(text: string, initialModel = 'codex'): CodexUsage[] {
  return parseCodexUsageChunk(text, initialModel).usages;
}

export function parseCodexRunJsonl(
  text: string,
  meta: { groupId: string; file: string; lane?: TokenLane },
): ExecutionRun {
  let sessionId = path.basename(meta.file, '.jsonl');
  let startedAt: string | null = null;
  let lastAt: string | null = null;
  let current: MutableTurn | null = null;
  const turns: RunTurn[] = [];
  const skills = new Set<string>();
  let openingPrompt: string | null = null;

  const ensureTurn = (timestamp: string): MutableTurn => {
    if (current) return current;
    const turn = emptyTurn(turns.length + 1, timestamp);
    current = { turn, model: 'codex', lastResponse: null, toolByCall: new Map(), taskStartedMs: null };
    return current;
  };
  const finishTurn = (timestamp: string, durationMs?: number): void => {
    if (!current) return;
    current.turn.endedAt = timestamp || current.turn.startedAt;
    current.turn.responsePreview = current.lastResponse;
    current.turn.errorCount = current.turn.tools.filter((tool) => tool.error).length;
    current.turn.compactions = current.turn.compactions || 0;
    current.turn.activeMs =
      durationMs != null && durationMs >= 0
        ? durationMs
        : Math.max(0, Date.parse(current.turn.endedAt) - Date.parse(current.turn.startedAt));
    current.turn.contextTokens = lastContextTokens(current.turn.modelCalls);
    current.turn.totals = turnTotals(current.turn);
    turns.push(current.turn);
    current = null;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp: string = asString(record.timestamp) ?? lastAt ?? '';
    if (timestamp) {
      startedAt ??= timestamp;
      lastAt = timestamp;
    }
    const payload = asRecord(record.payload);

    if (record.type === 'session_meta' && payload) {
      sessionId = asString(payload.id) ?? sessionId;
      continue;
    }
    if (record.type === 'turn_context' && payload) {
      const turn = ensureTurn(timestamp);
      turn.model = asString(payload.model) ?? turn.model;
      continue;
    }
    if (record.type === 'compacted' || (record.type === 'event_msg' && payload?.type === 'context_compacted')) {
      ensureTurn(timestamp).turn.compactions += 1;
      continue;
    }
    if (record.type === 'event_msg' && payload) {
      const eventType = asString(payload.type);
      if (eventType === 'task_started') {
        finishTurn(timestamp);
        const turn = ensureTurn(timestamp);
        turn.taskStartedMs = asNumber(payload.started_at) || null;
        continue;
      }
      if (eventType === 'user_message') {
        const message = asString(payload.message) ?? '';
        const turn = ensureTurn(timestamp);
        turn.turn.trigger = triggerFromPrompt(message);
        openingPrompt ??= norm(stripTags(message)).slice(0, 500);
        continue;
      }
      if (eventType === 'agent_message') {
        const message = asString(payload.message);
        if (message) applyResponse(ensureTurn(timestamp), message);
        continue;
      }
      if (eventType === 'token_count') {
        const usage = parseCodexUsageRecord(record, ensureTurn(timestamp).model);
        if (usage) {
          const turn = ensureTurn(timestamp);
          turn.turn.modelCalls.push({
            ts: usage.timestamp,
            model: usage.model,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheRead: usage.cacheRead,
            cacheCreate: usage.cacheCreate,
            id: `${sessionId}:${turn.turn.index}:${turn.turn.modelCalls.length + 1}`,
            text: turn.lastResponse,
            toolNames: [...new Set(turn.turn.tools.map((tool) => tool.name))],
            stopReason: null,
          });
        }
        continue;
      }
      if (eventType === 'task_complete') {
        const lastMessage = asString(payload.last_agent_message);
        if (lastMessage) applyResponse(ensureTurn(timestamp), lastMessage);
        finishTurn(timestamp, asNumber(payload.duration_ms));
        continue;
      }
      if (eventType === 'web_search_end') {
        const turn = ensureTurn(timestamp);
        turn.turn.tools.push({
          ts: timestamp,
          name: 'web_search',
          summary: norm(asString(payload.query) ?? 'web search').slice(0, 160),
          detail: asString(payload.query),
          durationMs: null,
          error: false,
          resultPreview: null,
        });
        continue;
      }
    }
    if (record.type !== 'response_item' || !payload) continue;
    if (payload.type === 'message' && payload.role === 'assistant') {
      const message = contentText(payload.content);
      if (message) applyResponse(ensureTurn(timestamp), message);
      continue;
    }
    if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
      const turn = ensureTurn(timestamp);
      const callId = asString(payload.call_id) ?? `call-${turn.turn.tools.length + 1}`;
      const name = asString(payload.name) ?? 'tool';
      const rawInput = asString(payload.input) ?? asString(payload.arguments) ?? '';
      const detail = toolDetail(rawInput);
      const tool: RunToolCall = {
        ts: timestamp,
        name,
        summary: detail ? `${name}: ${norm(detail).slice(0, 140)}` : name,
        detail: detail || null,
        durationMs: null,
        error: false,
        resultPreview: null,
      };
      turn.turn.tools.push(tool);
      turn.toolByCall.set(callId, tool);
      for (const match of detail.matchAll(/\/skills\/([^/\s"']+)/g)) skills.add(match[1]);
      continue;
    }
    if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
      const turn = ensureTurn(timestamp);
      const tool = turn.toolByCall.get(asString(payload.call_id) ?? '');
      if (!tool) continue;
      const output = outputText(payload.output);
      tool.durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(tool.ts));
      tool.resultPreview = norm(output).slice(0, 240) || null;
      tool.error = outputLooksLikeError(payload.output, output);
    }
  }
  finishTurn(lastAt ?? startedAt ?? '');

  const modelCalls = turns.flatMap((turn) => turn.modelCalls);
  const tools = turns.flatMap((turn) => turn.tools);
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
  return {
    id: `${meta.groupId}:${sessionId}`,
    groupId: meta.groupId,
    sessionId,
    lane: meta.lane ?? 'main',
    file: meta.file,
    startedAt,
    lastAt,
    modelCalls,
    tools,
    skills: [...skills].sort(),
    files: [],
    debugTag: `provider=codex group=${meta.groupId} session=${sessionId}`,
    totals,
    turns,
    activeMs: turns.reduce((sum, turn) => sum + turn.activeMs, 0),
    errorCount: turns.reduce((sum, turn) => sum + turn.errorCount, 0),
    compactions: turns.reduce((sum, turn) => sum + turn.compactions, 0),
    costUsd: null,
    artifacts: [],
    costIsExact: false,
    openingPrompt,
  };
}

export function readCodexRuns(
  opts: { sessionsRoot?: string; groupId?: string; maxFileBytes?: number } = {},
): ExecutionRun[] {
  const root = opts.sessionsRoot ?? PATHS.sessionsDir;
  const maxBytes = opts.maxFileBytes ?? 48 * 1024 * 1024;
  const runs: ExecutionRun[] = [];
  for (const item of listCodexRolloutFiles(root)) {
    if (opts.groupId && item.groupId !== opts.groupId) continue;
    try {
      const stat = fs.statSync(item.file);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(item.file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        runs.push(parseCodexRunJsonl(buffer.toString('utf8'), item));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // A rollout can rotate while Ops Center reads it; omit, never break Runs.
    }
  }
  return runs;
}

function emptyTurn(index: number, timestamp: string): RunTurn {
  return {
    index,
    startedAt: timestamp,
    endedAt: timestamp,
    trigger: { kind: 'unknown', label: 'Codex', intent: '' },
    tools: [],
    modelCalls: [],
    activeMs: 0,
    errorCount: 0,
    compactions: 0,
    responsePreview: null,
    outMessages: [],
    artifacts: [],
    contextTokens: null,
    costUsd: null,
    totals: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
    memoryOps: [],
    memoryInjected: null,
    skillsInvoked: [],
    outcome: 'idle',
  };
}

function parseCodexUsageRecord(record: Record<string, unknown>, model: string): CodexUsage | null {
  const payload = asRecord(record.payload);
  const info = asRecord(payload?.info);
  const usage = asRecord(info?.last_token_usage);
  if (!usage) return null;
  const totalInput = asNumber(usage.input_tokens);
  const cached = asNumber(usage.cached_input_tokens);
  return {
    model,
    input: Math.max(0, totalInput - cached),
    output: asNumber(usage.output_tokens),
    cacheRead: cached,
    cacheCreate: 0,
    timestamp: asString(record.timestamp) ?? '',
    contextWindow: typeof info?.model_context_window === 'number' ? info.model_context_window : null,
  };
}

function triggerFromPrompt(prompt: string): TurnTrigger {
  const skillBase = prompt.match(/^Base directory for this skill:\s*\S*\/skills\/([\w-]+)/);
  if (skillBase) {
    return {
      kind: 'schedule',
      label: `skill: ${skillBase[1]}`,
      intent: norm(stripTags(prompt.split('\n').slice(1).join(' '))).slice(0, 180),
    };
  }
  const message = prompt.match(/<message\b([^>]*)>([\s\S]*?)<\/message>/i);
  if (message) {
    const senderAttr = attr(message[1], 'sender');
    const sender = isUsableSender(senderAttr) ? senderAttr : (attr(message[1], 'from') ?? 'chat');
    return { kind: 'chat', label: sender, intent: norm(stripTags(message[2])).slice(0, 180) };
  }
  const task = prompt.match(/<task\b([^>]*)>([\s\S]*?)<\/task>/i);
  if (task)
    return {
      kind: 'schedule',
      label: attr(task[1], 'from') ?? 'task',
      intent: norm(stripTags(task[2]).replace(/^Instructions:\s*/i, '')).slice(0, 180),
    };
  const a2a = /<a2a\b/i.test(prompt);
  const kind: TriggerKind = a2a ? 'a2a' : 'unknown';
  return { kind, label: a2a ? 'agent' : 'Codex', intent: norm(stripTags(prompt)).slice(0, 180) };
}

function isUsableSender(value: string | null): value is string {
  return Boolean(value && !/^(?:unknown|anonymous)$/i.test(value.trim()));
}

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match?.[1] ?? null;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const record = asRecord(part);
      return asString(record?.text) ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function applyResponse(turn: MutableTurn, message: string): void {
  const clean = norm(stripTags(message));
  if (clean) turn.lastResponse = clean.slice(0, 500);
  for (const match of message.matchAll(/<message\b([^>]*)>([\s\S]*?)<\/message>/gi)) {
    turn.turn.outMessages.push({
      to: attr(match[1], 'to') ?? 'unknown',
      preview: norm(stripTags(match[2])).slice(0, 300),
    });
  }
}

function toolDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['cmd', 'command', 'path', 'query', 'prompt']) {
      if (typeof parsed[key] === 'string') return parsed[key] as string;
    }
  } catch {
    // Some native tools pass a plain string rather than JSON.
  }
  return raw;
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output ?? '');
  }
}

function outputLooksLikeError(raw: unknown, text: string): boolean {
  const record = asRecord(raw);
  if (record?.success === false || record?.is_error === true) return true;
  return /^(error|failed|failure):/i.test(norm(text));
}

function lastContextTokens(calls: RunModelCall[]): number | null {
  const last = calls[calls.length - 1];
  if (!last) return null;
  const total = last.inputTokens + last.cacheRead + last.cacheCreate;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function turnTotals(turn: RunTurn): RunTurn['totals'] {
  return turn.modelCalls.reduce(
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
      modelCalls: turn.modelCalls.length,
      toolCalls: turn.tools.length,
    },
  );
}
