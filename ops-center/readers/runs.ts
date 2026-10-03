/**
 * Read-only execution traces from Claude SDK JSONL transcripts.
 *
 * A "run" is one transcript file under data/v2-sessions/<group>/.claude-shared/
 * projects/ — one SDK session, resumed across many container wakes. Since one
 * session can span days, the run is segmented into TURNS: each real user prompt
 * (a chat message, a scheduled task, an a2a forward, a wake nudge) starts a turn
 * that runs until the next prompt. Turns are the primary observability unit —
 * "what happened when I asked X" — while the run remains the container.
 *
 * The parser reads the full file (bounded, mtime-cached) and correlates
 * tool_use → tool_result so each step carries duration, error state, and an
 * output preview. Scripts the agent writes (Write tool or bash heredoc) are
 * surfaced as artifacts with an intent blurb pulled from their leading comments.
 */
import fs from 'fs';
import path from 'path';

import { loadConfig, PATHS } from '../config.js';
import { listJsonlFiles, type TokenLane } from './tokens.js';
import { readCodexRuns } from './codex-runs.js';
import { readOpenCodeRuns } from './opencode-runs.js';
import { readPiRuns } from './pi-runs.js';

export interface RunModelCall {
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  /** Claude message.id; null for older/synthetic transcript entries. */
  id: string | null;
  /** The visible assistant response for this call (internal blocks removed). */
  text: string | null;
  /** Provider-exposed reasoning/thinking text, retained separately from the visible response. */
  reasoning?: string | null;
  /** Tool uses issued by this call. */
  toolNames: string[];
  stopReason: string | null;
  /** Provider-recorded cost (OpenCode), preferred over the list-price estimate. */
  nativeCostUsd?: number | null;
  durationMs?: number | null;
}

export interface RunMemoryOp {
  op: 'recall' | 'remember' | 'forget' | 'reflect' | 'admin';
  detail: string;
  hits: number | null;
  error: boolean;
}

export interface RunToolCall {
  ts: string;
  name: string;
  summary: string;
  detail: string | null;
  /** Milliseconds from tool_use to its tool_result line; null when unmatched. */
  durationMs?: number | null;
  /** True when the tool_result came back with is_error. */
  error?: boolean;
  /** First ~200 chars of the tool_result content. */
  resultPreview?: string | null;
  /** Full Task/Agent prompt, retained solely for exact child-transcript linking. */
  taskPrompt?: string | null;
}

export interface RunOutboundAction {
  kind: 'message' | 'file' | 'reaction' | 'edit' | 'unknown';
  tool: string;
  summary: string;
}

/** Successful NanoClaw delivery tools are response evidence even when the provider emits no final text. */
export function outboundActionForTool(name: string, resultPreview: string | null): RunOutboundAction | null {
  const lower = name.toLowerCase();
  const kind = lower.endsWith('send_message')
    ? 'message'
    : lower.endsWith('send_file')
      ? 'file'
      : lower.endsWith('add_reaction')
        ? 'reaction'
        : lower.endsWith('edit_message')
          ? 'edit'
          : null;
  return kind ? { kind, tool: name, summary: resultPreview ?? 'Outbound action acknowledged.' } : null;
}

export type ToolLatencyClass = 'browser-wait' | 'browser-action' | 'explicit-sleep' | 'shell' | 'other';

/** Classify the work hidden inside generic shell tools before interpreting latency drift. */
export function classifyToolLatency(tool: Pick<RunToolCall, 'name' | 'detail'>): ToolLatencyClass {
  const name = tool.name.toLowerCase();
  const detail = (tool.detail ?? '').toLowerCase();
  const text = `${name} ${detail}`;
  if (text.includes('agent-browser')) {
    return /\b(?:wait|sleep)\b|networkidle|--load\b/.test(text) ? 'browser-wait' : 'browser-action';
  }
  if (/\b(?:sleep|usleep|timeout)\b/.test(detail)) return 'explicit-sleep';
  if (name === 'bash' || name === 'shell' || name === 'exec') return 'shell';
  return 'other';
}

export type TriggerKind =
  | 'chat'
  | 'a2a'
  | 'schedule'
  | 'system'
  | 'wake'
  | 'compact-resume'
  | 'task-note'
  | 'delegated'
  | 'unknown';

export interface TurnTrigger {
  kind: TriggerKind;
  /** Short human label: sender names, skill name, or a generic tag. */
  label: string;
  /** One-line intent: first sentence of the human-relevant prompt text. */
  intent: string;
}

export interface RunArtifact {
  file: string;
  kind: 'script' | 'doc' | 'data' | 'other';
  /** Leading shebang/comment lines of a written script — what it was FOR. */
  intent: string | null;
  via: 'write' | 'heredoc';
}

/**
 * Deterministic per-turn verdict. This is the missing denominator for "token
 * efficiency": spend alone is meaningless, spend-per-SUCCESSFUL-turn is not.
 *
 * Deliberately conservative and rule-based — no model call, no heuristics that
 * need tuning. The rules only read signals the transcript states outright:
 *
 *   failed    the turn produced no visible response at all, or ended with an
 *             unresolved tool error and nothing to show for it
 *   degraded  it answered, but paid a tax on the way: tool errors, or context
 *             compaction fired mid-turn
 *   ok        answered cleanly
 *   idle      no model calls and no tools — bookkeeping, not work. Excluded
 *             from every efficiency ratio so empty wakes can't flatter the
 *             numbers.
 *
 * A turn still in flight (the container is mid-work) reads as `failed` under
 * these rules, so callers that care about live sessions should exclude the
 * newest turn of an active run. `summarizeOutcomes` takes a cutoff for this.
 */
export type TurnOutcome = 'ok' | 'degraded' | 'failed' | 'idle';

export function classifyOutcome(turn: {
  modelCalls: unknown[];
  tools: unknown[];
  outMessages: unknown[];
  outboundActions?: unknown[];
  responsePreview: string | null;
  errorCount: number;
  compactions: number;
}): TurnOutcome {
  if (!turn.modelCalls.length && !turn.tools.length) return 'idle';
  const answered =
    turn.outMessages.length > 0 || (turn.outboundActions?.length ?? 0) > 0 || Boolean(turn.responsePreview);
  if (!answered) return 'failed';
  if (turn.errorCount > 0 || turn.compactions > 0) return 'degraded';
  return 'ok';
}

/**
 * Context is the prompt-side input, not the output token count. A provider can
 * emit a usage object without any prompt usage fields (for example, a partial
 * or synthetic event). Treat that as unknown instead of manufacturing a zero
 * measurement that looks like a fresh conversation.
 */
export function observedContextTokens(
  call: Pick<RunModelCall, 'inputTokens' | 'cacheRead' | 'cacheCreate'>,
): number | null {
  const total = call.inputTokens + call.cacheRead + call.cacheCreate;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Convert a Claude usage object into a comparable prompt-context measure. */
export function contextTokensFromUsage(usage: Record<string, unknown>): number | null {
  const read = (key: string): number => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return observedContextTokens({
    inputTokens: read('input_tokens'),
    cacheRead: read('cache_read_input_tokens'),
    cacheCreate: read('cache_creation_input_tokens'),
  });
}

export interface RunTurn {
  index: number;
  startedAt: string;
  endedAt: string;
  trigger: TurnTrigger;
  tools: RunToolCall[];
  modelCalls: RunModelCall[];
  /** Wall-clock with idle gaps (>2 min between events) excluded. */
  activeMs: number;
  errorCount: number;
  /** Context-compaction boundaries that fired during this turn. */
  compactions: number;
  /** Append-only provider context edits, currently emitted by Pi 0.87+. */
  contextEdits?: number;
  /** First outbound <message> (or plain text) the agent produced this turn. */
  responsePreview: string | null;
  outMessages: { to: string; preview: string }[];
  /** Provider-native outbound actions acknowledged by NanoClaw's delivery tools. */
  outboundActions?: RunOutboundAction[];
  artifacts: RunArtifact[];
  /** Prompt context size at the turn's last model call (input+cache tokens). */
  contextTokens: number | null;
  /** Estimated $ for the turn's model calls; null if every model is unpriced. */
  costUsd: number | null;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreate: number;
    modelCalls: number;
    toolCalls: number;
  };
  memoryOps: RunMemoryOp[];
  memoryInjected: { count: number; titles: string[] } | null;
  /** Skills invoked during THIS turn (run-level `skills` is the union of all turns). */
  skillsInvoked: string[];
  /** Deterministic verdict — see TurnOutcome. Assigned in the finalize pass. */
  outcome: TurnOutcome;
}

export interface ExecutionRun {
  id: string;
  groupId: string;
  sessionId: string;
  lane: TokenLane;
  file: string;
  startedAt: string | null;
  lastAt: string | null;
  modelCalls: RunModelCall[];
  tools: RunToolCall[];
  skills: string[];
  files: string[];
  debugTag: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreate: number;
    modelCalls: number;
    toolCalls: number;
  };
  /** Turn segmentation; empty for sources without prompt structure (OpenCode). */
  turns: RunTurn[];
  /** Sum of per-turn active time — "the agent actually worked this long". */
  activeMs: number;
  errorCount: number;
  compactions: number;
  /** Sum of append-only provider context edits across the run. */
  contextEdits?: number;
  costUsd: number | null;
  artifacts: RunArtifact[];
  parentSessionId?: string | null;
  costIsExact?: boolean;
  /** Whitespace-normalized first user prompt; capped to bound cached run size. */
  openingPrompt?: string | null;
}

// --------------------------------------------------------------- cost estimate
/** $ per MTok, keyed by shortModelName. Cache read ≈0.1× input, write ≈1.25×. */
const MODEL_PRICES = loadConfig().pricing;

export function callCostUsd(call: RunModelCall): number | null {
  if (call.nativeCostUsd != null && Number.isFinite(call.nativeCostUsd)) return call.nativeCostUsd;
  const model = shortModelName(call.model).toLowerCase();
  const price = Object.entries(MODEL_PRICES).find(([key]) => model.includes(key.toLowerCase()))?.[1];
  if (!price) return null;
  return (
    (call.inputTokens * price.input +
      call.outputTokens * price.output +
      call.cacheRead * price.input * 0.1 +
      call.cacheCreate * price.input * 1.25) /
    1_000_000
  );
}

export function detectMemoryOp(command: string): Pick<RunMemoryOp, 'op' | 'detail'> | null {
  const script = /(?:\/|^)(?:trip-)?memory\.(?:ts|cjs|mjs|py)\b|scripts\/memory\.cjs/;
  if (!script.test(command)) return null;
  const verb = command.match(/\b(recall|remember|forget|reflect|stats|events|list)\b/);
  const op: RunMemoryOp['op'] = !verb
    ? 'admin'
    : verb[1] === 'recall'
      ? 'recall'
      : verb[1] === 'remember'
        ? 'remember'
        : verb[1] === 'forget'
          ? 'forget'
          : verb[1] === 'reflect'
            ? 'reflect'
            : 'admin';
  const detail =
    op === 'recall'
      ? (command
          .match(/recall\s+"([^"]+)"|recall\s+(\S+)/)
          ?.slice(1)
          .find(Boolean) ?? '')
      : op === 'remember'
        ? (command.match(/--title\s+"([^"]+)"/)?.[1] ?? '')
        : (verb?.[1] ?? 'admin');
  return { op, detail };
}

function sumCosts(calls: RunModelCall[]): number | null {
  let total = 0;
  let priced = false;
  for (const call of calls) {
    const cost = callCostUsd(call);
    if (cost != null) {
      total += cost;
      priced = true;
    }
  }
  return priced ? total : null;
}

// ------------------------------------------------------------------- utilities
function basenameNoExt(file: string): string {
  return path.basename(file).replace(/\.jsonl$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

/** Multi-line detail (bash commands, scripts): keep newlines, cap length. */
function rawDetail(value: unknown, max = 4000): string {
  const s = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}\n… (+${s.length - max} chars)` : s;
}

/** Stable prompt comparison shared by Task → child transcript links. */
export function normWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function firstSentence(s: string, max = 140): string {
  const n = s.replace(/\s+/g, ' ').trim();
  const cut = n.search(/[.!?](\s|$)/);
  const sentence = cut > 0 ? n.slice(0, cut + 1) : n;
  return sentence.length > max ? sentence.slice(0, max - 1).trimEnd() + '…' : sentence;
}

const SCRIPT_EXT = /\.(sh|bash|zsh|ts|tsx|js|mjs|cjs|py|rb|pl)$/i;
const DOC_EXT = /\.(md|html|txt|rst)$/i;
const DATA_EXT = /\.(json|csv|yaml|yml|toml|xml|sql)$/i;

function artifactKind(file: string): RunArtifact['kind'] {
  if (SCRIPT_EXT.test(file)) return 'script';
  if (DOC_EXT.test(file)) return 'doc';
  if (DATA_EXT.test(file)) return 'data';
  return 'other';
}

/** Shebang + first comment lines of a script body — the author's stated intent. */
export function scriptIntent(body: string, maxLines = 3, max = 220): string | null {
  const lines = body.split('\n').slice(0, 12);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#!')) continue; // shebang carries no intent
    const m = t.match(/^(?:#|\/\/)\s?(.*)$/);
    if (m) {
      if (m[1].trim()) out.push(m[1].trim());
      if (out.length >= maxLines) break;
      continue;
    }
    break; // first non-comment code line ends the header
  }
  const joined = out.join(' — ');
  return joined ? (joined.length > max ? joined.slice(0, max - 1) + '…' : joined) : null;
}

/** Detect `cat > file << 'EOF' ... EOF` script writes inside a bash command. */
function heredocArtifacts(command: string): RunArtifact[] {
  const out: RunArtifact[] = [];
  const re = /cat\s*>\s*(\S+)\s*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)(?:\n\2\b|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const file = m[1];
    out.push({ file, kind: artifactKind(file), intent: scriptIntent(m[3]), via: 'heredoc' });
  }
  return out;
}

// --------------------------------------------------------------- tool summary
interface ToolMeta {
  summary: string;
  detail: string | null;
  file: string | null;
  skill: string | null;
  artifact: RunArtifact | null;
  extraArtifacts: RunArtifact[];
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function toolSummary(name: string, input: unknown): ToolMeta {
  const none: ToolMeta = { summary: name, detail: null, file: null, skill: null, artifact: null, extraArtifacts: [] };
  if (!isRecord(input)) return none;
  const file =
    firstString(input, ['file_path', 'path', 'notebook_path']) ??
    (name === 'Write' || name === 'Edit' || name === 'MultiEdit' ? firstString(input, ['filename']) : null);
  const skill = firstString(input, ['skill', 'skill_id', 'name']);
  if (name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return {
      summary: clean(input.description ?? command, 120) || 'Bash command',
      detail: rawDetail(command),
      file: null,
      skill: null,
      artifact: null,
      extraArtifacts: heredocArtifacts(command),
    };
  }
  if (name === 'Write' || name === 'NotebookEdit') {
    const body = typeof input.content === 'string' ? input.content : '';
    const artifact: RunArtifact | null = file
      ? { file, kind: artifactKind(file), intent: scriptIntent(body), via: 'write' }
      : null;
    return { summary: file ? `${name} ${file}` : name, detail: null, file, skill: null, artifact, extraArtifacts: [] };
  }
  if (name === 'Read' || name === 'Edit' || name === 'MultiEdit') {
    return {
      summary: file ? `${name} ${file}` : name,
      detail: null,
      file,
      skill: null,
      artifact: null,
      extraArtifacts: [],
    };
  }
  if (name === 'Skill') {
    return {
      summary: skill ? `Skill ${skill}` : 'Skill call',
      detail: clean(input),
      file: null,
      skill,
      artifact: null,
      extraArtifacts: [],
    };
  }
  if (name === 'Task' || name === 'Agent') {
    return {
      summary: clean(input.description ?? input.subagent_type ?? 'Subagent'),
      detail: clean(input.prompt ?? input, 600),
      file: null,
      skill: null,
      artifact: null,
      extraArtifacts: [],
    };
  }
  return { summary: name, detail: clean(input), file: null, skill: null, artifact: null, extraArtifacts: [] };
}

// --------------------------------------------------------- trigger classifier
function stripGrounding(text: string): string {
  // Host-injected grounding blocks precede the actual message; skip past them.
  return text.replace(/<trip_grounding[\s\S]*?<\/trip_grounding>\s*/g, '').trim();
}

// Inbound envelope: attr order varies (`<message id=".." from=".." sender="..">`),
// so capture the whole attr string and pull from/sender out of it separately.
const MSG_IN_RE = /<message\b([^>]*)>([\s\S]*?)(?:<\/message>|$)/g;

function attrOf(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : '';
}

export function classifyTrigger(rawText: string): TurnTrigger {
  const text = stripGrounding(rawText);
  if (/^This session is being continued from a previous conversation/.test(text)) {
    return { kind: 'compact-resume', label: 'compaction resume', intent: 'Session resumed after context compaction' };
  }
  if (text.includes('<task-notification>')) {
    return { kind: 'task-note', label: 'background task', intent: 'Background task finished — result delivered' };
  }
  const agentMsg = text.match(/<agent-message\b([^>]*)>/);
  if (agentMsg) {
    return {
      kind: 'a2a',
      label: attrOf(agentMsg[1], 'from') || 'agent message',
      intent: firstSentence(text.replace(/<[^>]+>/g, ' ')),
    };
  }
  if (/^<system>/.test(text)) {
    return { kind: 'system', label: 'system notice', intent: firstSentence(text.replace(/<\/?system>/g, '')) };
  }
  if (/^Continue from where you left off\b/.test(text) || /^Continue\b.{0,30}$/.test(text)) {
    return { kind: 'wake', label: 'wake / continue', intent: 'Container wake — continue pending work' };
  }
  const skillBase = text.match(/^Base directory for this skill:\s*\S*\/skills\/([\w-]+)/);
  if (skillBase) {
    return {
      kind: 'schedule',
      label: `skill: ${skillBase[1]}`,
      intent: firstSentence(text.split('\n').slice(1).join(' ') || `Run skill ${skillBase[1]}`),
    };
  }
  const task = text.match(/<task\b([^>]*)>([\s\S]*?)(?:<\/task>|$)/);
  if (task) {
    const body = task[2].replace(/^\s*Instructions:\s*/i, '').trim();
    return { kind: 'schedule', label: 'scheduled task', intent: firstSentence(body || 'Scheduled task') };
  }
  if (/^\/[\w-]+/.test(text)) {
    return { kind: 'chat', label: 'command', intent: firstSentence(text) };
  }
  MSG_IN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const senders: string[] = [];
  let firstBody = '';
  let anyAgent = false;
  while ((m = MSG_IN_RE.exec(text))) {
    const attrs = m[1] ?? '';
    if (/\bto="/.test(attrs) && !/\bfrom="/.test(attrs)) continue; // outbound echo, not a trigger
    const from = attrOf(attrs, 'from');
    const sender = attrOf(attrs, 'sender').trim();
    if (/(^|:)agent:/.test(from)) anyAgent = true;
    const who = isUsableSender(sender) ? sender : from;
    if (who && !senders.includes(who)) senders.push(who);
    if (!firstBody) firstBody = m[2].trim();
  }
  if (senders.length || firstBody) {
    return {
      kind: anyAgent ? 'a2a' : 'chat',
      label: senders.join(', ') || (anyAgent ? 'agent' : 'chat'),
      intent: firstSentence(firstBody || text),
    };
  }
  if (/^(Scheduled task|\[scheduled)/i.test(text) || text.includes('<scheduled-task')) {
    return { kind: 'schedule', label: 'scheduled task', intent: firstSentence(text) };
  }
  return { kind: 'unknown', label: 'prompt', intent: firstSentence(text) };
}

function isUsableSender(value: string): boolean {
  return Boolean(value && !/^(?:unknown|anonymous)$/i.test(value.trim()));
}

// -------------------------------------------------- assistant text extraction
const MSG_OUT_RE = /<message\s+to="([^"]*)"[^>]*>([\s\S]*?)(?:<\/message>|$)/g;

function extractOutMessages(text: string): { to: string; preview: string }[] {
  MSG_OUT_RE.lastIndex = 0;
  const out: { to: string; preview: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = MSG_OUT_RE.exec(text))) {
    out.push({ to: m[1], preview: clean(m[2], 240) });
  }
  return out;
}

// ------------------------------------------------------------------ the parser
const ACTIVE_GAP_MS = 2 * 60 * 1000; // gaps longer than this are idle, not work

interface PendingCall {
  call: RunToolCall;
  tsMs: number;
  memoryOp?: RunMemoryOp;
}

function newTurn(index: number, startedAt: string, trigger: TurnTrigger): RunTurn {
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

function injectedMemory(raw: string): RunTurn['memoryInjected'] {
  const block = raw.match(/<trip_grounding[\s\S]*?<\/trip_grounding>/)?.[0];
  const line = block?.match(/^\s*Memory:\s*(.+)$/im)?.[1];
  if (!line) return null;
  try {
    const rows: unknown = JSON.parse(line);
    if (!Array.isArray(rows)) return null;
    return {
      count: rows.length,
      titles: rows.flatMap((row) => (isRecord(row) && typeof row.title === 'string' ? [row.title] : [])).slice(0, 6),
    };
  } catch {
    return null;
  }
}

export function parseRunJsonl(text: string, meta: { groupId: string; file: string; lane: TokenLane }): ExecutionRun {
  const turns: RunTurn[] = [];
  const skills = new Set<string>();
  const files = new Set<string>();
  const pending = new Map<string, PendingCall>();
  const callsByMessageId = new Map<string, RunModelCall>();
  let startedAt: string | null = null;
  let lastAt: string | null = null;
  let openingPrompt: string | null = null;
  let current: RunTurn | null = null;
  let lastEventMs: number | null = null;

  const ensureTurn = (ts: string, trigger?: TurnTrigger): RunTurn => {
    if (trigger || !current) {
      current = newTurn(
        turns.length,
        ts,
        trigger ?? { kind: 'unknown', label: 'prompt', intent: '(truncated or implicit start)' },
      );
      turns.push(current);
      lastEventMs = Date.parse(ts) || null;
    }
    return current;
  };

  const touch = (ts: string | null) => {
    if (!ts || !current) return;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) return;
    if (lastEventMs != null && ms > lastEventMs) {
      const gap = ms - lastEventMs;
      if (gap <= ACTIVE_GAP_MS) current.activeMs += gap;
    }
    if (ts > current.endedAt) current.endedAt = ts;
    lastEventMs = ms;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!lastAt || ts > lastAt) lastAt = ts;
    }
    const type = obj.type;
    // Skip harness bookkeeping lines; they carry no execution signal.
    if (
      type === 'queue-operation' ||
      type === 'attachment' ||
      type === 'ai-title' ||
      type === 'last-prompt' ||
      type === 'mode'
    ) {
      continue;
    }
    const message = isRecord(obj.message) ? obj.message : null;

    if (type === 'system') {
      if (obj.subtype === 'compact_boundary') {
        ensureTurn(ts ?? '').compactions += 1;
      }
      touch(ts);
      continue;
    }

    if (type === 'user') {
      const content = message?.content;
      let promptText: string | null = null;
      if (typeof content === 'string') {
        promptText = content;
      } else if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => isRecord(b) && b.type === 'tool_result');
        if (hasToolResult) {
          // Tool results: correlate back to their tool_use for duration/error.
          const turn = ensureTurn(ts ?? '');
          for (const block of content) {
            if (!isRecord(block) || block.type !== 'tool_result') continue;
            const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
            const hit = id ? pending.get(id) : null;
            if (hit) {
              pending.delete(id!);
              const ms = ts ? Date.parse(ts) : NaN;
              if (Number.isFinite(ms) && Number.isFinite(hit.tsMs)) hit.call.durationMs = Math.max(0, ms - hit.tsMs);
              hit.call.error = block.is_error === true;
              hit.call.resultPreview = clean(block.content, 200) || null;
              if (block.is_error === true) turn.errorCount += 1;
              if (block.is_error !== true) {
                const action = outboundActionForTool(hit.call.name, hit.call.resultPreview ?? null);
                if (action) turn.outboundActions?.push(action);
              }
              if (hit.memoryOp) {
                hit.memoryOp.error = block.is_error === true;
                const result = typeof block.content === 'string' ? block.content : clean(block.content, 400);
                hit.memoryOp.hits = Number(result.match(/(\d+)\s+(?:hit|result|row|memor)/i)?.[1] ?? NaN) || null;
              }
            }
          }
          touch(ts);
          continue;
        }
        const textBlock = content.find((b) => isRecord(b) && typeof b.text === 'string') as
          | { text: string }
          | undefined;
        promptText = textBlock?.text ?? null;
      }
      if (promptText != null && promptText.trim()) {
        if (openingPrompt == null) openingPrompt = normWs(promptText).slice(0, 2000) || null;
        const trigger = classifyTrigger(promptText);
        // A subagent's opening prompt IS the parent's Task prompt — label it so.
        if (trigger.kind === 'unknown' && meta.lane === 'subagent') {
          trigger.kind = 'delegated';
          trigger.label = 'delegated task';
        }
        const turn = ensureTurn(ts ?? '', trigger);
        turn.memoryInjected = injectedMemory(promptText);
      }
      touch(ts);
      continue;
    }

    if (type === 'assistant') {
      const turn = ensureTurn(ts ?? '');
      const usage = isRecord(message?.usage) ? message.usage : null;
      const messageId = typeof message?.id === 'string' ? message.id : null;
      let modelCall: RunModelCall | null = null;
      if (usage) {
        const call: RunModelCall = {
          ts: ts ?? '',
          model: typeof message?.model === 'string' ? message.model : 'unknown',
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cacheRead: Number(usage.cache_read_input_tokens ?? 0),
          cacheCreate: Number(usage.cache_creation_input_tokens ?? 0),
          id: messageId,
          text: null,
          toolNames: [],
          stopReason: typeof message?.stop_reason === 'string' ? message.stop_reason : null,
        };
        modelCall = messageId ? (callsByMessageId.get(messageId) ?? null) : null;
        if (modelCall) Object.assign(modelCall, call, { text: modelCall.text, toolNames: modelCall.toolNames });
        else {
          turn.modelCalls.push(call);
          modelCall = call;
          if (messageId) callsByMessageId.set(messageId, call);
        }
        turn.contextTokens = contextTokensFromUsage(usage);
      }
      const content = Array.isArray(message?.content) ? message.content : Array.isArray(obj.content) ? obj.content : [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          const msgs = extractOutMessages(block.text);
          if (msgs.length) {
            turn.outMessages.push(...msgs);
            turn.responsePreview = msgs[0].preview;
          } else if (!block.text.includes('<internal>')) {
            turn.responsePreview = clean(block.text, 240) || turn.responsePreview;
          }
          if (modelCall && !block.text.includes('<internal>')) {
            const visible = block.text.replace(/<message\b[^>]*>([\s\S]*?)<\/message>/g, '$1').trim();
            if (visible) modelCall.text = clean([modelCall.text, visible].filter(Boolean).join(' '), 300) || null;
          }
          continue;
        }
        if (block.type !== 'tool_use') continue;
        const name = typeof block.name === 'string' ? block.name : 'tool';
        const summary = toolSummary(name, block.input);
        if (summary.file) files.add(summary.file);
        if (summary.skill && name === 'Skill') {
          skills.add(summary.skill);
          if (!turn.skillsInvoked.includes(summary.skill)) turn.skillsInvoked.push(summary.skill);
        }
        if (summary.artifact) turn.artifacts.push(summary.artifact);
        if (summary.extraArtifacts.length) turn.artifacts.push(...summary.extraArtifacts);
        const call: RunToolCall = {
          ts: ts ?? '',
          name,
          summary: summary.summary,
          detail: summary.detail,
          durationMs: null,
          error: false,
          resultPreview: null,
          taskPrompt:
            (name === 'Task' || name === 'Agent') && isRecord(block.input) && typeof block.input.prompt === 'string'
              ? normWs(block.input.prompt).slice(0, 2000)
              : null,
        };
        turn.tools.push(call);
        const command = isRecord(block.input) && typeof block.input.command === 'string' ? block.input.command : null;
        const memory = name === 'Bash' && command ? detectMemoryOp(command) : null;
        const memoryOp = memory ? { ...memory, hits: null, error: false } : undefined;
        if (memoryOp) turn.memoryOps.push(memoryOp);
        if (modelCall && !modelCall.toolNames.includes(name)) modelCall.toolNames.push(name);
        const id = typeof block.id === 'string' ? block.id : null;
        const tsMs = ts ? Date.parse(ts) : NaN;
        if (id) pending.set(id, { call, tsMs, memoryOp });
      }
      touch(ts);
      continue;
    }
    touch(ts);
  }

  // Finalize per-turn aggregates.
  for (const turn of turns) {
    turn.totals = turn.modelCalls.reduce(
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
    turn.costUsd = sumCosts(turn.modelCalls);
    // A turn whose prompt IS a skill invocation (classifyTrigger's `skill: <id>`
    // form) never issues a Skill tool_use — the harness already expanded it.
    // Count it anyway, or skill-attribution silently misses every slash command.
    const fromTrigger = turn.trigger.label.startsWith('skill: ') ? turn.trigger.label.slice(7) : null;
    if (fromTrigger && !turn.skillsInvoked.includes(fromTrigger)) {
      turn.skillsInvoked.push(fromTrigger);
      skills.add(fromTrigger);
    }
    turn.skillsInvoked.sort();
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

  const sessionId = basenameNoExt(meta.file);
  return {
    id: `${meta.groupId}:${sessionId}`,
    groupId: meta.groupId,
    sessionId,
    lane: meta.lane,
    file: meta.file,
    startedAt,
    lastAt,
    modelCalls,
    tools,
    skills: [...skills].sort(),
    files: [...files].sort(),
    debugTag: `group=${meta.groupId} session=${sessionId}`,
    totals,
    turns,
    activeMs: turns.reduce((sum, turn) => sum + turn.activeMs, 0),
    errorCount: turns.reduce((sum, turn) => sum + turn.errorCount, 0),
    compactions: turns.reduce((sum, turn) => sum + turn.compactions, 0),
    costUsd: sumCosts(modelCalls),
    artifacts,
    openingPrompt,
  };
}

// ------------------------------------------------------------------ file pool
/** mtime+size-keyed parse cache — the ops-center process is long-lived, and a
 * full pool read happens on every /runs request. Only changed files re-parse. */
const parseCache = new Map<string, { mtimeMs: number; size: number; run: ExecutionRun }>();

export function readExecutionRuns(
  opts: {
    sessionsRoot?: string;
    groupId?: string;
    limit?: number;
    maxFileBytes?: number;
  } = {},
): ExecutionRun[] {
  const sessionsRoot = opts.sessionsRoot ?? PATHS.sessionsDir;
  // Full-file parse (turn segmentation needs the head); very large transcripts
  // fall back to a tail read so one pathological file can't blow up the page.
  const maxFileBytes = opts.maxFileBytes ?? 48 * 1024 * 1024;
  const runs: ExecutionRun[] = [];
  for (const file of listJsonlFiles(sessionsRoot)) {
    if (opts.groupId && file.groupId !== opts.groupId) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.file);
    } catch {
      continue;
    }
    const cached = parseCache.get(file.file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      runs.push(cached.run);
      continue;
    }
    let text: string;
    try {
      const start = Math.max(0, stat.size - maxFileBytes);
      const fd = fs.openSync(file.file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const run = parseRunJsonl(text, file);
    parseCache.set(file.file, { mtimeMs: stat.mtimeMs, size: stat.size, run });
    runs.push(run);
  }
  // OpenCode-provider groups (e.g. the Errand Runner) don't write JSONL transcripts;
  // their runs come from the OpenCode SQLite store. Merge them into the same pool so
  // the shared filter/sort/slice below applies uniformly. The two sources are disjoint
  // by construction — a JSONL group has no opencode.db and vice-versa.
  runs.push(...readOpenCodeRuns({ sessionsRoot, groupId: opts.groupId }));
  // Codex persists native rollout JSONL under each group's `.codex-shared`
  // state tree. Adapt those rollouts into this same provider-neutral pool.
  runs.push(...readCodexRuns({ sessionsRoot, groupId: opts.groupId, maxFileBytes }));
  // Pi persists native session JSONL under each host session's `pi-sessions`
  // tree. Adapt those transcripts into the same provider-neutral pool.
  runs.push(...readPiRuns({ sessionsRoot, groupId: opts.groupId, maxFileBytes }));
  // Normalize derived fields across all providers. Provider adapters do
  // not expose skills identically: Claude has a Skill tool, OpenCode stores a
  // `skill` part, Codex commonly exposes a /skills/<id> path, and Pi records
  // native tool calls. Bringing all forms together here prevents provider
  // choice from biasing the digest.
  for (const run of runs) {
    const runSkills = new Set(run.skills);
    for (const turn of run.turns) {
      turn.outcome = classifyOutcome(turn);
      turn.skillsInvoked = inferTurnSkills(turn);
      for (const skill of turn.skillsInvoked) runSkills.add(skill);
    }
    run.skills = [...runSkills].sort();
  }
  return runs
    .filter((run) => run.modelCalls.length || run.tools.length)
    .sort((a, b) => (a.lastAt ?? '').localeCompare(b.lastAt ?? ''))
    .reverse()
    .slice(0, opts.limit ?? 80);
}

/** Provider-neutral skill attribution from already-parsed turn metadata. */
export function inferTurnSkills(turn: {
  trigger: TurnTrigger;
  tools: Pick<RunToolCall, 'name' | 'summary' | 'detail'>[];
  skillsInvoked: string[];
}): string[] {
  const skills = new Set(turn.skillsInvoked.filter(Boolean));
  if (turn.trigger.label.startsWith('skill: ')) {
    skills.add(turn.trigger.label.slice('skill: '.length));
  }
  for (const tool of turn.tools) {
    const text = `${tool.summary} ${tool.detail ?? ''}`;
    for (const match of text.matchAll(/(?:^|\s)Skill\s+([\w-]+)/gi)) skills.add(match[1]);
    for (const match of text.matchAll(/\/skills\/([^/\s"'`]+)/g)) skills.add(match[1]);
    if (tool.name.toLowerCase() === 'skill') {
      const direct = text.match(/(?:name|skill|skill_id)["':=\s]+([\w-]+)/i);
      if (direct) skills.add(direct[1]);
    }
  }
  return [...skills].sort();
}

// ------------------------------------------------------- efficiency accounting
// Shared vocabulary for the reflection lanes. Pure functions over already-parsed
// turns — no IO, no model calls. Everything the reflector reasons about is
// derived here first so the LLM never has to do arithmetic over raw transcripts.

export interface OutcomeCounts {
  ok: number;
  degraded: number;
  failed: number;
  idle: number;
  /** ok + degraded + failed — the denominator for every efficiency ratio. */
  working: number;
}

export function summarizeOutcomes(turns: { outcome: TurnOutcome }[]): OutcomeCounts {
  const counts: OutcomeCounts = { ok: 0, degraded: 0, failed: 0, idle: 0, working: 0 };
  for (const turn of turns) counts[turn.outcome] += 1;
  counts.working = counts.ok + counts.degraded + counts.failed;
  return counts;
}

/**
 * Fraction of a turn's prompt context that was served from cache:
 *   cacheRead / (input + cacheRead + cacheCreate)
 *
 * cacheCreate MUST be in the denominator. Under prompt caching, `input_tokens`
 * is only the small uncached tail — a turn whose prefix churned shows up as a
 * large `cache_creation`, not a large `input`. Leaving cacheCreate out makes any
 * turn with a nonzero cacheRead read as ~100%, so partial churn (half the prefix
 * re-written every turn, the expensive and common case) becomes invisible.
 *
 * Returns null when the turn had no prompt input at all.
 */
export function cacheHitRatio(totals: { inputTokens: number; cacheRead: number; cacheCreate: number }): number | null {
  const denom = totals.inputTokens + totals.cacheRead + totals.cacheCreate;
  return denom > 0 ? totals.cacheRead / denom : null;
}

/**
 * Repeated identical tool calls within one turn — the cheapest reliable signal
 * of an agent looping. Keyed on name+detail (the args), so re-reading the same
 * file counts and reading two different files does not. Returns the calls that
 * were a repeat, i.e. the waste, not the first legitimate call.
 */
export function redundantToolCalls(turn: { tools: RunToolCall[] }): { key: string; count: number }[] {
  const seen = new Map<string, number>();
  for (const call of turn.tools) {
    const key = `${call.name}\u241f${call.detail ?? call.summary}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key: key.replace('\u241f', ' '), count }))
    .sort((a, b) => b.count - a.count);
}

/** Turn cost, falling back to a token proxy when no model in the turn is priced. */
export function turnWeight(turn: RunTurn): number {
  if (turn.costUsd != null) return turn.costUsd;
  return (turn.totals.inputTokens + turn.totals.outputTokens + turn.totals.cacheRead) / 1e6;
}

// --------------------------------------------------------- filtering & faceting
// Pure helpers over an already-parsed run pool. The Ops Center Runs page reads
// the full pool once (readExecutionRuns({ limit: Infinity })), then filters,
// sorts, and computes facet counts in memory. Everything a filter needs is
// already on ExecutionRun, so this stays a predicate exercise — no re-parsing.

export type RunSort = 'recent' | 'output' | 'tools' | 'duration' | 'cost' | 'errors';

export interface RunFilters {
  groupId?: string;
  /** OR within: run matches if its lane is any of these. */
  lanes?: string[];
  /** OR within: run matches if it used any of these skills. */
  skills?: string[];
  /** OR within: run matches if it called any of these tools (by name). */
  tools?: string[];
  /** OR within: run matches if it used any of these models (short name). */
  models?: string[];
  /** OR within: run matches if any turn was triggered by any of these kinds. */
  triggers?: string[];
  /** Only runs with at least one tool error. */
  errorsOnly?: boolean;
  /** Only runs with transcript-detected memory activity or injected grounding. */
  memoryOnly?: boolean;
  /** Case-insensitive substring over touched file paths. */
  file?: string;
  /** Case-insensitive substring over debug tag / session / files / tool summaries / skills. */
  query?: string;
  /** Lower bound on lastAt, epoch ms. Runs without a parseable lastAt are excluded. */
  sinceMs?: number | null;
  /** Minimum total output tokens. */
  minOutput?: number;
}

/** Normalize a model id for display + filtering: "claude-opus-4-8" -> "opus-4-8". */
export function shortModelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** Wall-clock span of a run in ms (0 when timestamps are missing or degenerate). */
export function runDurationMs(run: ExecutionRun): number {
  if (!run.startedAt || !run.lastAt) return 0;
  const ms = Date.parse(run.lastAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function runToolNames(run: ExecutionRun): string[] {
  return [...new Set(run.tools.map((t) => t.name))];
}

function runModelNames(run: ExecutionRun): string[] {
  return [...new Set(run.modelCalls.map((c) => shortModelName(c.model)))];
}

function runTriggerKinds(run: ExecutionRun): string[] {
  return [...new Set(run.turns.map((t) => t.trigger.kind))];
}

/** Free-text haystack for the `query` filter. */
function runHaystack(run: ExecutionRun): string {
  return [
    run.debugTag,
    run.sessionId,
    run.groupId,
    run.skills.join(' '),
    run.files.join(' '),
    run.tools.map((t) => `${t.name} ${t.summary}`).join(' '),
    run.turns.map((t) => `${t.trigger.label} ${t.trigger.intent}`).join(' '),
    run.turns.flatMap((t) => t.memoryOps.map((op) => `${op.op} ${op.detail}`)).join(' '),
    run.artifacts.map((a) => `${a.file} ${a.intent ?? ''}`).join(' '),
  ]
    .join(' ')
    .toLowerCase();
}

export function runMatchesFilters(run: ExecutionRun, f: RunFilters): boolean {
  if (f.groupId && run.groupId !== f.groupId) return false;
  if (f.lanes?.length && !f.lanes.includes(run.lane)) return false;
  if (f.skills?.length && !f.skills.some((s) => run.skills.includes(s))) return false;
  if (f.tools?.length) {
    const names = new Set(run.tools.map((t) => t.name));
    if (!f.tools.some((t) => names.has(t))) return false;
  }
  if (f.models?.length) {
    const names = new Set(runModelNames(run));
    if (!f.models.some((m) => names.has(m))) return false;
  }
  if (f.triggers?.length) {
    const kinds = new Set(runTriggerKinds(run));
    if (!f.triggers.some((t) => kinds.has(t))) return false;
  }
  if (f.errorsOnly && !run.errorCount) return false;
  if (f.memoryOnly && !run.turns.some((turn) => turn.memoryOps.length || turn.memoryInjected)) return false;
  if (f.file) {
    const needle = f.file.toLowerCase();
    if (!run.files.some((file) => file.toLowerCase().includes(needle))) return false;
  }
  if (f.query && !runHaystack(run).includes(f.query.toLowerCase())) return false;
  if (f.sinceMs != null) {
    const at = run.lastAt ? Date.parse(run.lastAt) : NaN;
    if (!Number.isFinite(at) || at < f.sinceMs) return false;
  }
  if (f.minOutput && run.totals.outputTokens < f.minOutput) return false;
  return true;
}

export function applyRunFilters(runs: ExecutionRun[], f: RunFilters): ExecutionRun[] {
  return runs.filter((run) => runMatchesFilters(run, f));
}

export function sortRuns(runs: ExecutionRun[], sort: RunSort): ExecutionRun[] {
  const copy = [...runs];
  switch (sort) {
    case 'output':
      return copy.sort((a, b) => b.totals.outputTokens - a.totals.outputTokens);
    case 'tools':
      return copy.sort((a, b) => b.totals.toolCalls - a.totals.toolCalls);
    case 'duration':
      return copy.sort((a, b) => runDurationMs(b) - runDurationMs(a));
    case 'cost':
      return copy.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));
    case 'errors':
      return copy.sort((a, b) => b.errorCount - a.errorCount);
    case 'recent':
    default:
      return copy.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface RunFacets {
  lane: FacetValue[];
  trigger: FacetValue[];
  skill: FacetValue[];
  tool: FacetValue[];
  model: FacetValue[];
}

type FacetDimension = 'lane' | 'trigger' | 'skill' | 'tool' | 'model';

function runValuesForDimension(run: ExecutionRun, dim: FacetDimension): string[] {
  switch (dim) {
    case 'lane':
      return [run.lane];
    case 'trigger':
      return runTriggerKinds(run);
    case 'skill':
      return run.skills;
    case 'tool':
      return runToolNames(run);
    case 'model':
      return runModelNames(run);
  }
}

/** Drop one dimension's own selections so its counts reflect what *adding* a value would yield. */
function filtersExcluding(f: RunFilters, dim: FacetDimension): RunFilters {
  switch (dim) {
    case 'lane':
      return { ...f, lanes: undefined };
    case 'trigger':
      return { ...f, triggers: undefined };
    case 'skill':
      return { ...f, skills: undefined };
    case 'tool':
      return { ...f, tools: undefined };
    case 'model':
      return { ...f, models: undefined };
  }
}

function facetFor(
  runs: ExecutionRun[],
  f: RunFilters,
  dim: FacetDimension,
  active: string[],
  topN: number,
): FacetValue[] {
  // Count runs matching every OTHER filter, so a facet's own multi-select stays OR
  // and each chip reads as "runs I'd get if this value were (also) selected".
  const base = applyRunFilters(runs, filtersExcluding(f, dim));
  const counts = new Map<string, number>();
  for (const run of base) {
    for (const value of new Set(runValuesForDimension(run, dim))) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  // Always surface active selections even if they now match nothing.
  for (const value of active) if (!counts.has(value)) counts.set(value, 0);
  const activeSet = new Set(active);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => {
      const activeDelta = (activeSet.has(b.value) ? 1 : 0) - (activeSet.has(a.value) ? 1 : 0);
      if (activeDelta) return activeDelta;
      if (a.count !== b.count) return b.count - a.count;
      return a.value.localeCompare(b.value);
    })
    .slice(0, Math.max(topN, activeSet.size));
}

export function computeRunFacets(
  runs: ExecutionRun[],
  f: RunFilters,
  opts: { topSkills?: number; topTools?: number; topModels?: number } = {},
): RunFacets {
  return {
    lane: facetFor(runs, f, 'lane', f.lanes ?? [], 2),
    trigger: facetFor(runs, f, 'trigger', f.triggers ?? [], 8),
    skill: facetFor(runs, f, 'skill', f.skills ?? [], opts.topSkills ?? 12),
    tool: facetFor(runs, f, 'tool', f.tools ?? [], opts.topTools ?? 14),
    model: facetFor(runs, f, 'model', f.models ?? [], opts.topModels ?? 8),
  };
}
