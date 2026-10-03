/** Read-only execution traces from Pi's native session JSONL files. */
import fs from 'node:fs';
import path from 'node:path';

import { PATHS } from '../config.js';
import {
  classifyOutcome,
  classifyTrigger,
  detectMemoryOp,
  outboundActionForTool,
  scriptIntent,
  type ExecutionRun,
  type RunArtifact,
  type RunMemoryOp,
  type RunModelCall,
  type RunToolCall,
  type RunTurn,
} from './runs.js';
import type { TokenLane } from './tokens.js';

const DEFAULT_MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_REASONING_CHARS = 12_000;
const MAX_RESPONSE_CHARS = 300;
const MAX_DETAIL_CHARS = 4_000;
const MAX_RESULT_CHARS = 240;
const ACTIVE_GAP_MS = 2 * 60 * 1000;

export interface PiSessionFile {
  groupId: string;
  file: string;
  lane: TokenLane;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clean(value: unknown, max = 180): string {
  const text =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value, (_key, nested) =>
            typeof nested === 'string' && nested.length > max ? `${nested.slice(0, max)}...` : nested,
          );
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function rawDetail(value: unknown, max = MAX_DETAIL_CHARS): string {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n… (+${text.length - max} chars)` : text;
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n… (+${value.length - max} chars)` : value;
}

function appendBounded(previous: string | null | undefined, next: string, max: number): string | null {
  const value = [previous, next].filter((part): part is string => Boolean(part && part.trim())).join('\n\n');
  return value ? bounded(value, max) : null;
}

function contentBlocks(message: JsonRecord): unknown[] {
  if (Array.isArray(message.content)) return message.content;
  return typeof message.content === 'string' ? [message.content] : [];
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return clean(content, MAX_RESULT_CHARS);
  return content
    .flatMap((block) => {
      if (typeof block === 'string') return [block];
      return isRecord(block) && typeof block.text === 'string' ? [block.text] : [];
    })
    .join('\n');
}

function textFromMessage(message: JsonRecord): string {
  return contentText(message.content);
}

function reasoningFromMessage(message: JsonRecord): string | null {
  const reasoning = contentBlocks(message)
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      if ((block.type === 'thinking' || block.type === 'reasoning') && typeof block.thinking === 'string') {
        return [block.thinking];
      }
      if ((block.type === 'thinking' || block.type === 'reasoning') && typeof block.text === 'string') {
        return [block.text];
      }
      return [];
    })
    .join('\n\n')
    .trim();
  if (reasoning) return bounded(reasoning, MAX_REASONING_CHARS);
  const topLevel = firstString(message, ['thinking', 'reasoning']);
  return topLevel ? bounded(topLevel, MAX_REASONING_CHARS) : null;
}

function extractOutMessages(text: string): { to: string; preview: string }[] {
  const out: { to: string; preview: string }[] = [];
  const re = /<message\s+to="([^"]*)"[^>]*>([\s\S]*?)(?:<\/message>|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push({ to: match[1], preview: clean(match[2], 240) });
  return out;
}

function visibleText(text: string): string {
  const messages = extractOutMessages(text);
  if (messages.length) return messages.map((message) => message.preview).join(' ');
  if (text.includes('<internal>')) return '';
  return text.replace(/<message\s+to="[^"]*"[^>]*>([\s\S]*?)(?:<\/message>|$)/g, '$1').trim();
}

function firstString(input: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function artifactKind(file: string): RunArtifact['kind'] {
  if (/\.(sh|bash|zsh|ts|tsx|js|mjs|cjs|py|rb|pl)$/i.test(file)) return 'script';
  if (/\.(md|html|txt|rst)$/i.test(file)) return 'doc';
  if (/\.(json|csv|yaml|yml|toml|xml|sql)$/i.test(file)) return 'data';
  return 'other';
}

interface ToolSummary {
  summary: string;
  detail: string | null;
  file: string | null;
  skill: string | null;
  artifact: RunArtifact | null;
}

function summarizeTool(name: string, rawInput: unknown): ToolSummary {
  const input = isRecord(rawInput) ? rawInput : {};
  const lower = name.toLowerCase();
  const file = firstString(input, ['file_path', 'filePath', 'path', 'notebook_path', 'filename']);
  const skill = firstString(input, ['skill', 'skill_id', 'skillId', 'name']);
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') {
    const command = typeof input.command === 'string' ? input.command : rawInput;
    return {
      summary: clean(input.description ?? command, 120) || 'Bash command',
      detail: rawDetail(command),
      file: null,
      skill: null,
      artifact: null,
    };
  }
  if (lower === 'read' || lower === 'edit' || lower === 'multiedit' || lower === 'write' || lower === 'notebookedit') {
    const artifact =
      lower === 'write' && file
        ? {
            file,
            kind: artifactKind(file),
            intent: typeof input.content === 'string' ? scriptIntent(input.content) : null,
            via: 'write' as const,
          }
        : null;
    return {
      summary: file ? `${name} ${file}` : name,
      detail: lower === 'write' || lower === 'edit' ? rawDetail(input) : null,
      file,
      skill: null,
      artifact,
    };
  }
  if (lower === 'skill')
    return {
      summary: skill ? `Skill ${skill}` : 'Skill call',
      detail: rawDetail(input),
      file: null,
      skill,
      artifact: null,
    };
  if (lower === 'task' || lower === 'agent') {
    return {
      summary: clean(input.description ?? input.subagent_type ?? 'Subagent'),
      detail: rawDetail(input),
      file: null,
      skill: null,
      artifact: null,
    };
  }
  return { summary: name, detail: rawDetail(input), file, skill: null, artifact: null };
}

function stripInjectedSystem(text: string): string {
  return text.replace(/^\s*<system>[\s\S]*?<\/system>\s*/i, '').trim();
}

function stripInjectedGrounding(text: string): string {
  return text.replace(/<trip_grounding[\s\S]*?<\/trip_grounding>\s*/gi, '').trim();
}

function parseInjectedMemory(raw: string): RunTurn['memoryInjected'] {
  const block = raw.match(/<trip_grounding[\s\S]*?<\/trip_grounding>/)?.[0];
  const line = block?.match(/^\s*Memory:\s*(.+)$/im)?.[1];
  if (!line) return null;
  try {
    const payload: unknown = JSON.parse(line);
    const rows = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.rows)
        ? payload.rows
        : null;
    if (!rows) return null;
    return {
      count: isRecord(payload) && typeof payload.total === 'number' ? Math.max(0, payload.total) : rows.length,
      titles: rows.flatMap((row) => (isRecord(row) && typeof row.title === 'string' ? [row.title] : [])).slice(0, 6),
    };
  } catch {
    return null;
  }
}

function newTurn(index: number, startedAt: string, trigger: RunTurn['trigger']): RunTurn {
  return {
    index,
    startedAt,
    endedAt: startedAt,
    trigger,
    tools: [],
    modelCalls: [],
    activeMs: 0,
    errorCount: 0,
    compactions: 0,
    contextEdits: 0,
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
}

interface PendingTool {
  call: RunToolCall;
  tsMs: number;
  memoryOp?: RunMemoryOp;
}

function usageNumber(usage: JsonRecord, key: string): number {
  return Math.max(0, asNumber(usage[key]));
}

function nativeCost(usage: JsonRecord): number | null {
  if (
    isRecord(usage.cost) &&
    typeof usage.cost.total === 'number' &&
    Number.isFinite(usage.cost.total) &&
    usage.cost.total >= 0
  ) {
    return usage.cost.total;
  }
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
  return null;
}

function modelName(message: JsonRecord, activeModel: string): string {
  const modelId = asString(message.model);
  const provider = asString(message.provider);
  if (modelId && provider && !modelId.includes('/')) return `${provider}/${modelId}`;
  return modelId ?? activeModel;
}

function updateTurnText(turn: RunTurn, call: RunModelCall, raw: string): void {
  const output = extractOutMessages(raw);
  if (output.length) {
    turn.outMessages.push(...output);
    turn.responsePreview = output[0].preview || turn.responsePreview;
  } else {
    const visible = visibleText(raw);
    if (visible) turn.responsePreview = clean(visible, 240) || turn.responsePreview;
  }
  const visible = visibleText(raw);
  if (visible) call.text = appendBounded(call.text, clean(visible, MAX_RESPONSE_CHARS), MAX_RESPONSE_CHARS);
}

function turnTotals(turn: RunTurn): RunTurn['totals'] {
  const totals = turn.modelCalls.reduce(
    (acc, call) => {
      acc.inputTokens += call.inputTokens;
      acc.outputTokens += call.outputTokens;
      acc.cacheRead += call.cacheRead;
      acc.cacheCreate += call.cacheCreate;
      acc.modelCalls += 1;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
  );
  totals.toolCalls = turn.tools.length;
  return totals;
}

function sumNativeCosts(calls: RunModelCall[]): number | null {
  const priced = calls.flatMap((call) => (call.nativeCostUsd != null ? [call.nativeCostUsd] : []));
  return priced.length ? priced.reduce((sum, value) => sum + value, 0) : null;
}

export function listPiSessionFiles(sessionsRoot: string = PATHS.sessionsDir): PiSessionFile[] {
  const out: PiSessionFile[] = [];
  if (!fs.existsSync(sessionsRoot)) return out;
  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const group of groups) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue;
    const groupDir = path.join(sessionsRoot, group.name);
    let hosts: fs.Dirent[];
    try {
      hosts = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const host of hosts) {
      if (!host.isDirectory() || host.name.startsWith('.')) continue;
      const piDir = path.join(groupDir, host.name, 'pi-sessions');
      if (!fs.existsSync(piDir)) continue;
      walkPiFiles(piDir, (file) =>
        out.push({
          groupId: group.name,
          file,
          lane: file.includes(`${path.sep}subagents${path.sep}`) ? 'subagent' : 'main',
        }),
      );
    }
  }
  return out;
}

function walkPiFiles(dir: string, visit: (file: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPiFiles(target, visit);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) visit(target);
  }
}

export function parsePiRunJsonl(text: string, meta: { groupId: string; file: string; lane?: TokenLane }): ExecutionRun {
  const turns: RunTurn[] = [];
  const skills = new Set<string>();
  const files = new Set<string>();
  const pending = new Map<string, PendingTool>();
  let current: RunTurn | null = null;
  let startedAt: string | null = null;
  let lastAt: string | null = null;
  let openingPrompt: string | null = null;
  let lastEventMs: number | null = null;
  let activeModel = 'unknown';

  const touch = (turn: RunTurn, timestamp: string): void => {
    if (!timestamp) return;
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at)) return;
    if (lastEventMs != null && at > lastEventMs && at - lastEventMs <= ACTIVE_GAP_MS) turn.activeMs += at - lastEventMs;
    if (!turn.endedAt || at > Date.parse(turn.endedAt)) turn.endedAt = timestamp;
    lastEventMs = at;
  };

  const ensureTurn = (timestamp: string, trigger?: RunTurn['trigger']): RunTurn => {
    if (!current || trigger) {
      current = newTurn(
        turns.length,
        timestamp,
        trigger ?? { kind: 'unknown', label: 'prompt', intent: '(truncated or implicit start)' },
      );
      turns.push(current);
      lastEventMs = Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : null;
    }
    return current;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    const timestamp = asString(record.timestamp) ?? '';
    if (timestamp) {
      if (!startedAt || timestamp < startedAt) startedAt = timestamp;
      if (!lastAt || timestamp > lastAt) lastAt = timestamp;
    }

    if (record.type === 'model_change') {
      const provider = asString(record.provider);
      const modelId = asString(record.modelId) ?? asString(record.model);
      if (provider && modelId) activeModel = `${provider}/${modelId}`;
      else if (modelId) activeModel = modelId;
      continue;
    }
    if (record.type === 'compaction' || record.type === 'compacted') {
      ensureTurn(timestamp).compactions += 1;
      touch(current!, timestamp);
      continue;
    }
    if (record.type === 'context_edit') {
      const turn = ensureTurn(timestamp);
      turn.contextEdits = (turn.contextEdits ?? 0) + 1;
      touch(turn, timestamp);
      continue;
    }
    if (record.type !== 'message' || !isRecord(record.message)) {
      continue;
    }
    const message = record.message;
    const role = asString(message.role);
    if (role === 'user') {
      const rawPrompt = textFromMessage(message);
      const promptWithGrounding = stripInjectedSystem(rawPrompt);
      const prompt = stripInjectedGrounding(promptWithGrounding);
      if (prompt) {
        openingPrompt ??= prompt.replace(/\s+/g, ' ').trim().slice(0, 2_000) || null;
        const trigger = classifyTrigger(prompt);
        if (trigger.kind === 'unknown' && meta.lane === 'subagent') {
          trigger.kind = 'delegated';
          trigger.label = 'delegated task';
        }
        const turn = ensureTurn(timestamp, trigger);
        turn.memoryInjected = parseInjectedMemory(promptWithGrounding);
        touch(turn, timestamp);
      }
      continue;
    }

    if (role === 'assistant') {
      const turn = ensureTurn(timestamp);
      const usage = isRecord(message.usage) ? message.usage : {};
      const reasoning = reasoningFromMessage(message);
      const model = modelName(message, activeModel);
      const call: RunModelCall = {
        ts: timestamp,
        model,
        inputTokens: usageNumber(usage, 'input'),
        outputTokens: usageNumber(usage, 'output') + usageNumber(usage, 'reasoning'),
        cacheRead: usageNumber(usage, 'cacheRead'),
        cacheCreate: usageNumber(usage, 'cacheWrite'),
        id: asString(record.id),
        text: null,
        reasoning,
        toolNames: [],
        stopReason: asString(message.stopReason),
        nativeCostUsd: nativeCost(usage),
      };
      turn.modelCalls.push(call);
      const context = call.inputTokens + call.cacheRead + call.cacheCreate;
      if (context > 0) turn.contextTokens = context;

      const blocks = contentBlocks(message);
      if (typeof message.content === 'string') updateTurnText(turn, call, message.content);
      for (const block of blocks) {
        if (typeof block === 'string') continue;
        if (!isRecord(block)) continue;
        if (block.type === 'thinking' || block.type === 'reasoning') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          updateTurnText(turn, call, block.text);
          continue;
        }
        if (block.type !== 'toolCall' && block.type !== 'tool_use') continue;
        const name = asString(block.name) ?? asString(block.toolName) ?? 'tool';
        const input = block.arguments ?? block.input;
        const summary = summarizeTool(name, input);
        if (summary.file) files.add(summary.file);
        if (summary.skill) skills.add(summary.skill);
        if (summary.artifact) turn.artifacts.push(summary.artifact);
        if (!call.toolNames.includes(name)) call.toolNames.push(name);
        const tool: RunToolCall = {
          ts: timestamp,
          name,
          summary: summary.summary,
          detail: summary.detail,
          durationMs: null,
          error: false,
          resultPreview: null,
          taskPrompt:
            (name.toLowerCase() === 'task' || name.toLowerCase() === 'agent') &&
            isRecord(input) &&
            typeof input.prompt === 'string'
              ? input.prompt.replace(/\s+/g, ' ').trim().slice(0, 2_000)
              : null,
        };
        turn.tools.push(tool);
        const command = isRecord(input) && typeof input.command === 'string' ? input.command : null;
        const memory = command ? detectMemoryOp(command) : null;
        const memoryOp = memory ? { ...memory, hits: null, error: false } : undefined;
        if (memoryOp) turn.memoryOps.push(memoryOp);
        const id = asString(block.id) ?? asString(block.toolCallId) ?? asString(block.callId);
        if (id) pending.set(id, { call: tool, tsMs: Date.parse(timestamp), memoryOp });
      }
      touch(turn, timestamp);
      continue;
    }

    if (role === 'toolResult' || role === 'tool_result') {
      const turn = ensureTurn(timestamp);
      const id = asString(message.toolCallId) ?? asString(message.tool_call_id);
      const hit = id ? pending.get(id) : undefined;
      if (hit) {
        pending.delete(id!);
        const at = Date.parse(timestamp);
        if (Number.isFinite(at) && Number.isFinite(hit.tsMs)) hit.call.durationMs = Math.max(0, at - hit.tsMs);
        hit.call.error = message.isError === true || message.is_error === true || message.error === true;
        hit.call.resultPreview = clean(contentText(message.content), MAX_RESULT_CHARS) || null;
        if (hit.call.error) turn.errorCount += 1;
        if (!hit.call.error) {
          const action = outboundActionForTool(hit.call.name, hit.call.resultPreview ?? null);
          if (action) turn.outboundActions?.push(action);
        }
        if (hit.memoryOp) {
          hit.memoryOp.error = hit.call.error;
          const result = hit.call.resultPreview ?? '';
          hit.memoryOp.hits = Number(result.match(/(\d+)\s+(?:hit|result|row|memor)/i)?.[1] ?? NaN) || null;
        }
      }
      touch(turn, timestamp);
    }
  }

  for (const turn of turns) {
    turn.totals = turnTotals(turn);
    turn.costUsd = sumNativeCosts(turn.modelCalls);
    const triggerSkill = turn.trigger.label.startsWith('skill: ') ? turn.trigger.label.slice(7) : null;
    if (triggerSkill && !turn.skillsInvoked.includes(triggerSkill)) {
      turn.skillsInvoked.push(triggerSkill);
      skills.add(triggerSkill);
    }
    const toolSkills = turn.tools.flatMap((tool) =>
      tool.name.toLowerCase() === 'skill' ? [tool.summary.replace(/^Skill\s+/, '')] : [],
    );
    turn.skillsInvoked = [...new Set([...turn.skillsInvoked, ...toolSkills])].sort();
    turn.outcome = classifyOutcome(turn);
  }
  const modelCalls = turns.flatMap((turn) => turn.modelCalls);
  const tools = turns.flatMap((turn) => turn.tools);
  const artifacts = turns.flatMap((turn) => turn.artifacts);
  for (const artifact of artifacts) files.add(artifact.file);
  const totals = modelCalls.reduce(
    (acc, call) => {
      acc.inputTokens += call.inputTokens;
      acc.outputTokens += call.outputTokens;
      acc.cacheRead += call.cacheRead;
      acc.cacheCreate += call.cacheCreate;
      acc.modelCalls += 1;
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, modelCalls: 0, toolCalls: 0 },
  );
  totals.toolCalls = tools.length;
  const sessionId = path.basename(meta.file, '.jsonl');
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
    files: [...files].sort(),
    debugTag: `provider=pi group=${meta.groupId} session=${sessionId}`,
    totals,
    turns,
    activeMs: turns.reduce((sum, turn) => sum + turn.activeMs, 0),
    errorCount: turns.reduce((sum, turn) => sum + turn.errorCount, 0),
    compactions: turns.reduce((sum, turn) => sum + turn.compactions, 0),
    contextEdits: turns.reduce((sum, turn) => sum + (turn.contextEdits ?? 0), 0),
    costUsd: sumNativeCosts(modelCalls),
    artifacts,
    costIsExact: modelCalls.length > 0 && modelCalls.every((call) => call.nativeCostUsd != null),
    openingPrompt,
  };
}

const parseCache = new Map<string, { mtimeMs: number; size: number; run: ExecutionRun }>();

export function readPiRuns(
  opts: { sessionsRoot?: string; groupId?: string; maxFileBytes?: number } = {},
): ExecutionRun[] {
  const root = opts.sessionsRoot ?? PATHS.sessionsDir;
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const runs: ExecutionRun[] = [];
  for (const item of listPiSessionFiles(root)) {
    if (opts.groupId && item.groupId !== opts.groupId) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(item.file);
    } catch {
      continue;
    }
    const cached = parseCache.get(item.file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      runs.push(cached.run);
      continue;
    }
    let text: string;
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(item.file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const run = parsePiRunJsonl(text, item);
    parseCache.set(item.file, { mtimeMs: stat.mtimeMs, size: stat.size, run });
    runs.push(run);
  }
  return runs;
}
