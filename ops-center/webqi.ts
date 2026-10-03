import fs from 'node:fs';
/**
 * Optional WebQI surface for the Ops Center.
 *
 * This module is intentionally the only WebQI UI/command seam. It discovers
 * consultation state through readers/consult.ts and sends canonical /consult
 * commands through the existing CLI routed transport. To deprecate WebQI,
 * disable WEBQI_ENABLED and remove this module plus its reader/tests; the
 * NanoClaw router and consult skill remain untouched.
 */
import { esc } from './ui.js';
import {
  findWebQiSession,
  listWebQiSnapshot,
  readConsultationGraphFile,
  readConsultationConversation,
  readConsultationRoot,
  readConsultationSource,
  readWebQiActivity,
  type ConsultAddress,
  type ConsultRootDetail,
  type ConsultSession,
  type WebQiSnapshot,
} from './readers/consult.js';
import { ensureWebChat, sendViaCliSockRoute, webChatPlatformId, type CliSockAddress } from './chat.js';
import { WEBQI_HELP_PATH } from './webqi-help.js';
import type { ActionResult } from './lifecycle.js';

export { WEBQI_HELP_PATH, webQiHelpBody } from './webqi-help.js';

export const WEBQI_ENABLED = process.env.NANOCLAW_WEBQI !== '0';
export const WEBQI_PATH = '/chat/webqi';
export const WEBQI_BOOTSTRAP_PATH = '/api/webqi/bootstrap';
export const WEBQI_GRAPH_PATH = '/api/webqi/graph';
export const WEBQI_GRAPH_FILE_PATH = '/api/webqi/graph-file';
export const WEBQI_CONVERSATION_PATH = '/api/webqi/conversation';
export const WEBQI_SOURCE_PATH = '/api/webqi/source';
export const WEBQI_ACTION_PATH = '/api/webqi/action';
export const WEBQI_ACTIVITY_PATH = '/api/webqi/activity';

export const WEBQI_LENSES = [
  { value: 'distill', title: 'Distill', description: 'Integrate sources while preserving gaps and disagreement.' },
  { value: 'critique', title: 'Critique', description: 'Find errors, weak reasoning, assumptions, and omissions.' },
  { value: 'counsel', title: 'Counsel', description: 'Turn the evidence into practical advice and next questions.' },
  { value: 'steelman', title: 'Steelman', description: 'Strengthen each position before weighing it.' },
  { value: 'extend', title: 'Extend', description: 'Draw out implications, alternatives, and missing ideas.' },
  { value: 'contrast', title: 'Contrast', description: 'Explain concrete disagreements without forcing a synthesis.' },
  { value: 'referee', title: 'Referee', description: 'Weigh support and uncertainty, then recommend an action.' },
] as const;

export const WEBQI_PROTOCOLS = [
  { value: 'quick', title: 'Quick', maxTargets: 2, description: 'Fast independent comparison.' },
  { value: 'deep', title: 'Deep', maxTargets: 3, description: 'Broader panel with fuller synthesis.' },
  { value: 'verify', title: 'Verify', maxTargets: 3, description: 'Check facts, assumptions, and omissions.' },
  { value: 'decide', title: 'Decide', maxTargets: 3, description: 'Compare positions and recommend an action.' },
  { value: 'explore', title: 'Explore', maxTargets: 3, description: 'Find implications and alternatives.' },
  { value: 'debate', title: 'Debate', maxTargets: 2, description: 'Expose concrete disagreements.' },
  { value: 'redteam', title: 'Red team', maxTargets: 2, description: 'Search aggressively for failure modes.' },
  { value: 'forecast', title: 'Forecast', maxTargets: 3, description: 'Compare predictions and signposts.' },
] as const;

type WebQiAction =
  | 'new'
  | 'continue'
  | 'branch'
  | 'reprocess'
  | 'roster'
  | 'close'
  | 'reopen'
  | 'reopen-continue'
  | 'delete'
  | 'restore';

export interface WebQiCommandInput {
  action: WebQiAction;
  rootId?: string;
  ref?: string;
  question?: string;
  protocol?: string;
  lens?: string;
  tag?: string;
  targets?: string[];
  tiers?: Record<string, string>;
}

function token(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} contains unsupported characters`);
  return value;
}

function reference(value: string): string {
  if (!/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/.test(value)) throw new Error('invalid consultation reference');
  return value;
}

function cleanTag(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function cleanQuestion(value: string): string {
  const question = value.trim();
  if (!question) throw new Error('question is required');
  if (question.length > 8000) throw new Error('question too long (8000 character max)');
  return question;
}

function selectionFlags(input: WebQiCommandInput): string[] {
  const targets = [...new Set((input.targets ?? []).map((value) => token(value, 'target')))].filter(Boolean);
  const tiers = input.tiers ?? {};
  for (const [name, level] of Object.entries(tiers)) {
    if (!targets.includes(name)) throw new Error(`tier override ${name} is not one of the selected targets`);
    if (!['high', 'medium', 'low'].includes(level)) throw new Error(`invalid tier for ${name}`);
  }
  const flags = [`--to ${targets.length ? targets.join(',') : 'auto'}`];
  const tierEntries = Object.entries(tiers);
  if (tierEntries.length)
    flags.push(`--tier ${tierEntries.map(([name, level]) => `${token(name, 'target')}=${level}`).join(',')}`);
  return flags;
}

export function buildWebQiCommand(input: WebQiCommandInput): string {
  if (input.action === 'roster') return '/consult roster --refresh';
  if (input.action === 'reopen-continue') {
    return buildWebQiCommand({ ...input, action: 'continue' });
  }
  if (
    input.action === 'close' ||
    input.action === 'reopen' ||
    input.action === 'delete' ||
    input.action === 'restore'
  ) {
    return `/consult ${input.action} ${reference(input.rootId ?? '')}`;
  }
  const lens = input.lens ?? 'distill';
  if (!WEBQI_LENSES.some((entry) => entry.value === lens)) throw new Error(`unknown lens: ${lens}`);
  if (input.action === 'reprocess') {
    return `/consult lens ${reference(input.ref || input.rootId || '')} ${lens}`;
  }
  const protocol = input.protocol ?? 'quick';
  const protocolInfo = WEBQI_PROTOCOLS.find((entry) => entry.value === protocol);
  if (!protocolInfo) throw new Error(`unknown protocol: ${protocol}`);
  const targets = [...new Set(input.targets ?? [])];
  if (targets.length > protocolInfo.maxTargets) {
    throw new Error(`${protocol} supports at most ${protocolInfo.maxTargets} explicit targets`);
  }
  const flags = selectionFlags(input);
  flags.push(`--lens ${lens}`);
  if (input.action === 'new') {
    const tag = input.tag ? cleanTag(input.tag) : '';
    if (input.tag && !tag) throw new Error('tag must contain letters or numbers');
    if (tag) flags.unshift(`--tag ${tag}`);
    return `/consult ${protocol} ${flags.join(' ')} ${cleanQuestion(input.question ?? '')}`;
  }
  if (input.action !== 'continue' && input.action !== 'branch')
    throw new Error(`unsupported WebQI action: ${input.action}`);
  const ref = reference(input.ref || input.rootId || '');
  flags.unshift(`--protocol ${protocol}`);
  return `/consult ${input.action} ${ref} ${flags.join(' ')} ${cleanQuestion(input.question ?? '')}`;
}

function publicSession(
  session: ConsultSession,
): Omit<ConsultSession, 'dir' | 'route'> & { route?: never; dir?: never } {
  const { dir: _dir, route: _route, ...safe } = session;
  return safe;
}

export function webQiBootstrap(): unknown {
  const snapshot = listWebQiSnapshot();
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => ({
      ...group,
      sessions: group.sessions.map((session) => publicSession(session)),
    })),
  };
}

function sessionOrThrow(groupId: string, sessionId: string): ConsultSession {
  const session = findWebQiSession(groupId, sessionId);
  if (!session) throw new Error('unknown group or session');
  return session;
}

function rootOrThrow(session: ConsultSession, rootId: string): ConsultRootDetail {
  const root = readConsultationRoot(session.dir, rootId);
  if (!root) throw new Error('unknown consultation root');
  return root;
}

export function webQiGraph(
  groupId: string,
  sessionId: string,
  rootId: string,
): { ok: true; session: unknown; root: ConsultRootDetail; graphFile: { path: string; url: string } } {
  const session = sessionOrThrow(groupId, sessionId);
  const root = rootOrThrow(session, rootId);
  const query = new URLSearchParams({ group: groupId, session: sessionId, root: root.id });
  return {
    ok: true,
    session: publicSession(session),
    root,
    graphFile: { path: root.graphPath, url: `${WEBQI_GRAPH_FILE_PATH}?${query.toString()}` },
  };
}

export function webQiGraphFile(groupId: string, sessionId: string, rootId: string): string | null {
  const session = sessionOrThrow(groupId, sessionId);
  const root = rootOrThrow(session, rootId);
  return readConsultationGraphFile(session.dir, root.id);
}

export function webQiConversation(groupId: string, sessionId: string, rootId: string): string | null {
  const session = sessionOrThrow(groupId, sessionId);
  const root = rootOrThrow(session, rootId);
  return readConsultationConversation(session.dir, root.id);
}

export function webQiSource(groupId: string, sessionId: string, rootId: string, node: string): string | null {
  const session = sessionOrThrow(groupId, sessionId);
  return readConsultationSource(session.dir, rootId, node);
}

export function webQiActivity(groupId: string, sessionId?: string, rootId?: string, rootTag?: string): unknown {
  return { ok: true, ...readWebQiActivity(groupId, { sessionId, rootId, rootTag }) };
}

function actionAddress(session: ConsultSession, root: ConsultRootDetail | null): ConsultAddress {
  const rootAddress = root?.origin;
  const sessionAddress = session.route;
  const rootMatchesSession =
    Boolean(rootAddress && sessionAddress) &&
    rootAddress!.channelType === sessionAddress!.channelType &&
    rootAddress!.platformId === sessionAddress!.platformId &&
    rootAddress!.threadId === sessionAddress!.threadId;
  const address = rootMatchesSession ? rootAddress : sessionAddress;
  // A2A-only sessions have no user-facing messaging-group route. In that
  // case the dedicated Web Chat route is the safe fallback for a new root;
  // existing roots normally carry their original origin in root.json.
  if (!address?.channelType || !address.platformId) return webRoute(session.groupId);
  return address;
}

function targetValidation(session: ConsultSession, input: WebQiCommandInput): void {
  const targets = [...new Set(input.targets ?? [])];
  const available = new Map(session.targets.map((target) => [target.name, target]));
  for (const name of targets) {
    if (!available.has(name)) throw new Error(`unknown consulting target: ${name}`);
  }
  for (const [name, level] of Object.entries(input.tiers ?? {})) {
    const target = available.get(name);
    if (!target) throw new Error(`unknown consulting target for tier: ${name}`);
    if (!target.tiers[level] && !(target.provider ?? '').toLowerCase().includes('claude')) {
      throw new Error(`${name} does not advertise a ${level} tier in this session's roster`);
    }
  }
}

function webRoute(groupId: string): CliSockAddress {
  return { channelType: 'cli', platformId: webChatPlatformId(groupId), threadId: null };
}

export async function runWebQiAction(raw: Record<string, unknown>): Promise<ActionResult> {
  const action = String(raw.action ?? '') as WebQiAction;
  if (
    ![
      'new',
      'continue',
      'branch',
      'reprocess',
      'roster',
      'close',
      'reopen',
      'reopen-continue',
      'delete',
      'restore',
    ].includes(action)
  ) {
    return { ok: false, message: 'unsupported WebQI action' };
  }
  const groupId = String(raw.groupId ?? '');
  const sessionId = String(raw.sessionId ?? '');
  try {
    const session = sessionOrThrow(groupId, sessionId);
    const rootId = typeof raw.rootId === 'string' ? raw.rootId : '';
    const root =
      rootId && action !== 'new' && action !== 'roster' && action !== 'restore' ? rootOrThrow(session, rootId) : null;
    const input: WebQiCommandInput = {
      action,
      rootId: rootId || undefined,
      ref: typeof raw.ref === 'string' ? raw.ref : undefined,
      question: typeof raw.question === 'string' ? raw.question : undefined,
      protocol: typeof raw.protocol === 'string' ? raw.protocol : undefined,
      lens: typeof raw.lens === 'string' ? raw.lens : undefined,
      tag: typeof raw.tag === 'string' ? raw.tag : undefined,
      targets: Array.isArray(raw.targets)
        ? raw.targets.filter((value): value is string => typeof value === 'string')
        : [],
      tiers:
        raw.tiers && typeof raw.tiers === 'object' && !Array.isArray(raw.tiers)
          ? Object.fromEntries(Object.entries(raw.tiers).filter(([, value]) => typeof value === 'string'))
          : {},
    };
    if (action === 'new' || action === 'continue' || action === 'branch' || action === 'reopen-continue') {
      targetValidation(session, input);
    }
    const command = buildWebQiCommand(input);
    const wired = await ensureWebChat(groupId, groupId);
    if (!wired.ok) return { ok: false, message: `web chat wiring failed: ${wired.message}` };
    const destination = actionAddress(session, root);
    if (action === 'reopen-continue') {
      const reopened = await sendViaCliSockRoute(
        buildWebQiCommand({ ...input, action: 'reopen' }),
        destination,
        webRoute(groupId),
      );
      if (!reopened.ok) return { ok: false, message: `WebQI reopen failed: ${reopened.message}` };
    }
    const sent = await sendViaCliSockRoute(command, destination, webRoute(groupId));
    if (!sent.ok) return sent;
    const message =
      action === 'reopen-continue'
        ? 'Reopen and follow-up requested. Watch the conversation for the result.'
        : 'Request sent. Watch the conversation for the result.';
    return { ok: true, message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function chatSubnav(active: string): string {
  if (!WEBQI_ENABLED) return '';
  return `<div class="subnav"><a href="/chat" class="${active === '/chat' ? 'active' : ''}">Chat</a><a href="${WEBQI_PATH}" class="${active === WEBQI_PATH ? 'active' : ''}">Consult <span class="navhint">second opinion</span></a></div>`;
}

function lensOptions(): string {
  return WEBQI_LENSES.map((lens) => `<option value="${lens.value}">${lens.title} — ${lens.description}</option>`).join(
    '',
  );
}

function protocolOptions(): string {
  return WEBQI_PROTOCOLS.map(
    (protocol) => `<option value="${protocol.value}">${protocol.title} · ${protocol.description}</option>`,
  ).join('');
}

export function webQiBody(): string {
  return `${chatSubnav(WEBQI_PATH)}
<style>${fs.readFileSync(new URL('./webqi.css', import.meta.url), 'utf8')}</style>
<div class="webqi-intro"><div><h2>Consult</h2><p class="muted">Ask other models and compare their answers.</p></div><a class="btn" href="${WEBQI_HELP_PATH}">How to use Consult</a></div>
<div class="consult-layout">
  <aside class="card consult-sidebar">
    <label for="wi-group">Agent</label><select id="wi-group"></select>
    <label for="wi-session">Conversation</label><select id="wi-session"></select>
    <p id="wi-session-meta" class="muted small"></p>
    <div class="webqi-section-head"><h3>Topics</h3><button class="btn" id="wi-new-root">+ New topic</button></div>
    <div id="wi-roots"></div>
    <details><summary>Manage topics</summary><p class="muted small">Closed topics follow retention settings. Deleted topics go to recoverable trash.</p><button class="btn" id="wi-close">Finish topic</button> <button class="btn" id="wi-delete">Move to trash</button><p id="wi-undo" hidden><button class="btn" id="wi-restore">Undo move to trash</button></p></details>
  </aside>
  <main class="consult-main">
    <div class="consult-topic-heading"><h2 id="wi-title">Get a second opinion</h2><span id="wi-topic-status" class="muted small"></span></div>
    <p id="wi-summary" class="muted"></p>
    <div id="wi-conversation" aria-live="polite"></div>
    <div id="wi-live" role="status" class="muted small"></div>
    <form id="wi-form" class="card consult-composer">
      <label for="wi-question" id="wi-question-label">Your question</label>
      <textarea id="wi-question" rows="3" maxlength="8000" placeholder="What would you like another perspective on?" required></textarea>
      <div class="consult-send-row"><span id="wi-context" class="muted small"></span><button class="btn primary" id="wi-submit" type="submit">Get second opinion</button></div>
      <button id="wi-cancel-branch" class="linkbtn" type="button" hidden>Return to whole topic</button>
      <details id="wi-options"><summary>Options</summary>
        <label for="wi-preset">What do you need?</label><select id="wi-preset"><option value="quick">Second opinion</option><option value="verify">Check reasoning</option><option value="decide">Help me decide</option><option value="custom">Custom</option></select>
        <p id="wi-panel-summary" class="muted small"></p>
        <details><summary>Choose models</summary><p class="muted small">Leave unchecked for automatic selection. Each model uses its configured settings.</p><div id="wi-targets"></div><button class="btn" id="wi-roster" type="button">Refresh available models</button></details>
        <details id="wi-advanced"><summary>Advanced settings</summary><label for="wi-protocol">Panel method</label><select id="wi-protocol">${protocolOptions()}</select><label for="wi-lens">Answer style</label><select id="wi-lens">${lensOptions()}</select><label for="wi-tag">Topic alias (new topics only, optional)</label><input id="wi-tag" maxlength="48" placeholder="vendor-choice"></details>
      </details>
    </form>
    <details id="wi-details" class="card"><summary>Details and full history</summary><p id="wi-graph-file"></p><div id="wi-badges" class="chips"></div><div id="wi-graph"></div><details><summary>Delivery activity</summary><div id="wi-activity"></div></details><button class="btn" id="wi-refresh">Refresh</button></details>
  </main>
</div>
<script>
${fs.readFileSync(new URL('./webqi-client.js', import.meta.url), 'utf8')}
</script>`;
}
