/**
 * Token telemetry from the Claude SDK JSONL logs under
 * data/v2-sessions/<group>/.claude-shared/projects/.
 *
 * Incremental: a byte offset per file is kept in ops.db meta (key jsonl:<path>)
 * so each tick parses only newly appended lines. Collector logic adapted from
 * the add-dashboard skill's proven JSONL parser.
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getMeta, setMeta } from '../opsdb.js';
import { PATHS } from '../config.js';
import { listCodexRolloutFiles, parseCodexUsageChunk, parseCodexUsageLines } from './codex-runs.js';

export type TokenLane = 'main' | 'subagent';

export interface TokenDelta {
  groupId: string;
  model: string;
  lane: TokenLane;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  requests: number;
}

export interface SubagentSighting {
  groupId: string;
  file: string;
  model: string;
  firstTimestamp: string;
  /** Human reason for the delegation: the parent Task's `description` when it can
   * be correlated, else the first sentence of the subagent's own prompt. '' if
   * neither is readable (callers fall back to a generic label). */
  reason: string;
}

export interface CompactionSighting {
  groupId: string;
  firstTimestamp: string;
  sessionId?: string;
}

export interface TokenCollectResult {
  deltas: TokenDelta[];
  newSubagents: SubagentSighting[];
  newCompactions: CompactionSighting[];
}

export interface ContextWindow {
  groupId: string;
  file: string;
  model: string;
  contextTokens: number;
  usagePercent: number;
  timestamp: string;
}

export function listJsonlFiles(
  sessionsRoot: string = PATHS.sessionsDir,
): { groupId: string; file: string; lane: TokenLane }[] {
  const out: { groupId: string; file: string; lane: TokenLane }[] = [];
  if (!fs.existsSync(sessionsRoot)) return out;
  for (const groupId of fs.readdirSync(sessionsRoot)) {
    const projects = path.join(sessionsRoot, groupId, '.claude-shared', 'projects');
    if (!fs.existsSync(projects)) continue;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const p = path.join(dir, entry);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        // Subagent transcripts live under a `subagents/` directory (incl. workflow nesting).
        else if (entry.endsWith('.jsonl'))
          out.push({ groupId, file: p, lane: p.includes(`${path.sep}subagents${path.sep}`) ? 'subagent' : 'main' });
      }
    };
    walk(projects);
  }
  return out;
}

export function parseUsageLines(
  text: string,
): { model: string; input: number; output: number; cacheRead: number; cacheCreate: number; timestamp: string }[] {
  const out: {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
    timestamp: string;
  }[] = [];
  const byMessageId = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant' || !obj.message?.usage) continue;
      const u = obj.message.usage;
      const usage = {
        model: obj.message.model ?? 'unknown',
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        timestamp: obj.timestamp ?? '',
      };
      const id = typeof obj.message.id === 'string' ? obj.message.id : null;
      if (id && byMessageId.has(id)) out[byMessageId.get(id)!] = usage;
      else {
        if (id) byMessageId.set(id, out.length);
        out.push(usage);
      }
    } catch {
      /* partial line or non-JSON */
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Read the first complete JSONL record (one line) of a file, bounded in size. */
function readFirstRecord(file: string, maxBytes = 1_000_000): Record<string, unknown> | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, size));
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, read);
    const nl = text.indexOf('\n');
    const obj = JSON.parse(nl === -1 ? text : text.slice(0, nl));
    return isRecord(obj) ? obj : null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** Extract the prompt/user text from a transcript record (content is a string or block array). */
function recordText(obj: Record<string, unknown>): string {
  const msg = isRecord(obj.message) ? obj.message : null;
  const content = msg?.content ?? obj.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (typeof b === 'string') return b;
      if (isRecord(b) && typeof b.text === 'string') return b.text;
    }
  }
  return '';
}

/** First sentence of a prompt, whitespace-collapsed and length-capped — the fallback reason. */
function firstSentence(s: string, max = 100): string {
  const n = normWs(s);
  const cut = n.search(/[.!?](\s|$)/);
  const sentence = cut > 0 ? n.slice(0, cut + 1) : n;
  return sentence.length > max ? sentence.slice(0, max - 1).trimEnd() + '…' : sentence;
}

/**
 * Crisp reason for a subagent spawn: the parent Task/Agent tool_use `description`.
 * Subagent transcripts live at `<parentSessionId>/subagents/agent-*.jsonl`; the
 * parent transcript is the sibling `<parentSessionId>.jsonl`. Match the child's
 * full opening prompt to a parent Task block's full prompt — full-string equality
 * disambiguates fan-outs (many siblings share a prompt prefix). Only a unique match
 * is accepted; a wrong description is worse than none, so ambiguity → null (caller
 * falls back to the child's own prompt). Absent for workflow/script spawns (no
 * sibling transcript), which correctly fall back too.
 */
function crispDescriptionFromParent(childFile: string, childPrompt: string): string | null {
  const subDir = path.dirname(childFile);
  if (path.basename(subDir) !== 'subagents') return null;
  const parent = path.dirname(subDir) + '.jsonl';
  const want = normWs(childPrompt);
  if (!want || !fs.existsSync(parent)) return null;
  let text: string;
  try {
    const size = fs.statSync(parent).size;
    const from = Math.max(0, size - 2 * 1024 * 1024); // recent Task call sits near EOF
    const fd = fs.openSync(parent, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use') || !line.includes('"prompt"')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tail may start mid-record; skip partial lines
    }
    const content = isRecord(obj) && isRecord(obj.message) ? obj.message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isRecord(b) || b.type !== 'tool_use') continue;
      if (b.name !== 'Task' && b.name !== 'Agent') continue;
      const input = isRecord(b.input) ? b.input : null;
      if (!input || typeof input.prompt !== 'string') continue;
      if (normWs(input.prompt) !== want) continue;
      if (typeof input.description === 'string' && input.description.trim()) matches.push(input.description.trim());
    }
  }
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}

/** Best-effort human reason for a newly-detected subagent transcript. */
export function deriveSubagentReason(childFile: string): string {
  const rec = readFirstRecord(childFile);
  const prompt = rec ? recordText(rec) : '';
  if (!prompt) return '';
  const crisp = crispDescriptionFromParent(childFile, prompt);
  return crisp ? normWs(crisp).slice(0, 120) : firstSentence(prompt);
}

/** Never-throw wrapper — a single bad transcript must not abort a collector tick. */
function safeReason(childFile: string): string {
  try {
    return deriveSubagentReason(childFile);
  } catch {
    return '';
  }
}

/** Compact-boundary records mark a transcript context-window summary. */
function parseCompactionSightings(text: string, groupId: string, sessionId: string): CompactionSighting[] {
  const out: CompactionSighting[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('compact_boundary')) continue;
    try {
      const obj: unknown = JSON.parse(line);
      if (!isRecord(obj) || obj.type !== 'system' || obj.subtype !== 'compact_boundary') continue;
      out.push({
        groupId,
        firstTimestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
        sessionId: sessionId || undefined,
      });
    } catch {
      /* malformed record */
    }
  }
  return out;
}

/**
 * One-time backfill: attach a `reason` to historical `subagent_spawn` events whose
 * detail predates reason capture, so the Events table and routing card describe
 * past delegations too. Idempotent via a meta flag; per-event it only fills a
 * missing reason and only when the subagent transcript is still on disk (rotated
 * ones are left as-is). Returns the number of events updated.
 */
export function backfillSubagentReasons(db: Database.Database, sessionsRoot: string = PATHS.sessionsDir): number {
  if (getMeta(db, 'subagent_reasons_backfilled')) return 0;
  const byName = new Map<string, string>(); // agent-*.jsonl basename -> full path
  for (const f of listJsonlFiles(sessionsRoot)) {
    if (f.lane === 'subagent') byName.set(path.basename(f.file), f.file);
  }
  const rows = db.prepare("SELECT rowid AS rid, detail FROM events WHERE kind = 'subagent_spawn'").all() as {
    rid: number;
    detail: string;
  }[];
  const update = db.prepare('UPDATE events SET detail = ? WHERE rowid = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      let det: { model?: string; file?: string; reason?: string };
      try {
        det = JSON.parse(r.detail);
      } catch {
        continue;
      }
      if (det.reason || !det.file) continue;
      const full = byName.get(det.file);
      if (!full) continue;
      const reason = safeReason(full);
      if (!reason) continue;
      det.reason = reason;
      update.run(JSON.stringify(det), r.rid);
      n++;
    }
  })();
  setMeta(db, 'subagent_reasons_backfilled', new Date().toISOString());
  return n;
}

/** Parse only bytes appended since the stored offset; advance offsets. */
export function collectTokenDeltas(
  opsDb: Database.Database,
  sessionsRoot: string = PATHS.sessionsDir,
): TokenCollectResult {
  const byKey = new Map<string, TokenDelta>();
  const newSubagents: SubagentSighting[] = [];
  const newCompactions: CompactionSighting[] = [];
  for (const { groupId, file, lane } of listJsonlFiles(sessionsRoot)) {
    const size = fs.statSync(file).size;
    const metaKey = `jsonl:${file}`;
    let offset = Number(getMeta(opsDb, metaKey) ?? 0);
    if (offset > size) offset = 0; // file truncated/rotated — re-read
    if (size <= offset) continue;
    const fd = fs.openSync(file, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // Only consume up to the last complete line; the tail may still be mid-write.
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) continue;
    const consumed = chunk.slice(0, lastNl + 1);
    setMeta(opsDb, metaKey, String(offset + Buffer.byteLength(consumed, 'utf8')));
    const usages = parseUsageLines(consumed);
    newCompactions.push(...parseCompactionSightings(consumed, groupId, path.basename(file, '.jsonl')));
    // A subagent file is "new" until we've recorded its first model-bearing line.
    if (lane === 'subagent' && usages.length > 0 && getMeta(opsDb, `subseen:${file}`) == null) {
      setMeta(opsDb, `subseen:${file}`, usages[0].timestamp || new Date().toISOString());
      const reason = safeReason(file);
      newSubagents.push({ groupId, file, model: usages[0].model, firstTimestamp: usages[0].timestamp, reason });
    }
    for (const u of usages) {
      const key = `${groupId}|${u.model}|${lane}`;
      const agg = byKey.get(key) ?? {
        groupId,
        model: u.model,
        lane,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreate: 0,
        requests: 0,
      };
      agg.inputTokens += u.input;
      agg.outputTokens += u.output;
      agg.cacheRead += u.cacheRead;
      agg.cacheCreate += u.cacheCreate;
      agg.requests += 1;
      byKey.set(key, agg);
    }
  }
  // Codex app-server writes its own rollout JSONL tree. Keep a separate byte
  // offset per file and merge its native token_count records into the same
  // provider-neutral deltas that drive Overview and group usage charts.
  for (const { groupId, file, lane } of listCodexRolloutFiles(sessionsRoot)) {
    const size = fs.statSync(file).size;
    const metaKey = `codex-jsonl:${file}`;
    let offset = Number(getMeta(opsDb, metaKey) ?? 0);
    if (offset > size) offset = 0;
    if (size <= offset) continue;
    const fd = fs.openSync(file, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) continue;
    const consumed = chunk.slice(0, lastNl + 1);
    setMeta(opsDb, metaKey, String(offset + Buffer.byteLength(consumed, 'utf8')));
    const modelKey = `codex-model:${file}`;
    const parsed = parseCodexUsageChunk(consumed, getMeta(opsDb, modelKey) ?? 'codex');
    const usages = parsed.usages;
    setMeta(opsDb, modelKey, parsed.model);
    newCompactions.push(...parseCodexCompactionSightings(consumed, groupId, path.basename(file, '.jsonl')));
    for (const u of usages) {
      const key = `${groupId}|${u.model}|${lane}`;
      const agg = byKey.get(key) ?? {
        groupId,
        model: u.model,
        lane,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreate: 0,
        requests: 0,
      };
      agg.inputTokens += u.input;
      agg.outputTokens += u.output;
      agg.cacheRead += u.cacheRead;
      agg.cacheCreate += u.cacheCreate;
      agg.requests += 1;
      byKey.set(key, agg);
    }
  }
  return { deltas: [...byKey.values()], newSubagents, newCompactions };
}

function parseCodexCompactionSightings(text: string, groupId: string, sessionId: string): CompactionSighting[] {
  const out: CompactionSighting[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('context_compacted') && !line.includes('"type":"compacted"')) continue;
    try {
      const obj = JSON.parse(line) as { timestamp?: string; type?: string; payload?: { type?: string } };
      if (obj.type !== 'compacted' && !(obj.type === 'event_msg' && obj.payload?.type === 'context_compacted'))
        continue;
      out.push({ groupId, firstTimestamp: obj.timestamp ?? '', sessionId });
    } catch {
      // A partial or malformed rollout line is ignored like Claude JSONL.
    }
  }
  return out;
}

const MAX_CONTEXT = 200_000;

/** Context-window usage per JSONL file (last assistant turn; reads the file tail). */
export function collectContextWindows(sessionsRoot: string = PATHS.sessionsDir): ContextWindow[] {
  const out: ContextWindow[] = [];
  for (const { groupId, file } of listJsonlFiles(sessionsRoot)) {
    const size = fs.statSync(file).size;
    const readFrom = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(file, 'r');
    let tail: string;
    try {
      const buf = Buffer.alloc(size - readFrom);
      fs.readSync(fd, buf, 0, buf.length, readFrom);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const usages = parseUsageLines(tail);
    const last = usages[usages.length - 1];
    if (!last) continue;
    const contextTokens = last.input + last.cacheRead + last.cacheCreate;
    out.push({
      groupId,
      file: path.basename(file),
      model: last.model,
      contextTokens,
      usagePercent: Math.round((contextTokens / MAX_CONTEXT) * 100),
      timestamp: last.timestamp,
    });
  }
  for (const { groupId, file } of listCodexRolloutFiles(sessionsRoot)) {
    const size = fs.statSync(file).size;
    const readFrom = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(file, 'r');
    let tail: string;
    try {
      const buf = Buffer.alloc(size - readFrom);
      fs.readSync(fd, buf, 0, buf.length, readFrom);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const last = parseCodexUsageLines(tail).at(-1);
    if (!last) continue;
    const contextTokens = last.input + last.cacheRead + last.cacheCreate;
    const maxContext = last.contextWindow ?? MAX_CONTEXT;
    out.push({
      groupId,
      file: path.basename(file),
      model: last.model,
      contextTokens,
      usagePercent: Math.round((contextTokens / maxContext) * 100),
      timestamp: last.timestamp,
    });
  }
  return out;
}
