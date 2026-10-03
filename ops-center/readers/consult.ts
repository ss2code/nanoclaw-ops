/**
 * Read-only discovery for the session-local /consult stores.
 *
 * The consult skill deliberately keeps graph state inside the invoking
 * session's consultations/ directory. This reader mirrors that boundary:
 * it discovers known session directories, reads their graph snapshots, and
 * never mutates a consultation file or central DB row.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { PATHS } from '../config.js';
import { listAgentGroups, withCentral, type AgentGroupInfo } from './central.js';
import { listSessionDirs, toUtcMs, type SessionDirs } from './sessiondbs.js';

const PREVIEW_CHARS = 560;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;

export interface ConsultAddress {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export interface ConsultRosterResponder {
  assistantName: string;
  agentGroupId: string;
  providerName: string;
  configuredModel: string;
  effort: string | null;
  modelTiers: Record<string, string> | null;
  defaultTier: string | null;
  modelKey: string;
}

export interface ConsultRoster {
  refreshedAt: string | null;
  entries: Record<string, { receivedAt?: string; responder: ConsultRosterResponder }>;
}

export interface ConsultNode {
  id: string;
  type: string;
  status: string;
  createdAt: string | null;
  completedAt?: string | null;
  label: string | null;
  lens: string | null;
  protocol: string | null;
  sourceName: string | null;
  sourceAgentGroupId: string | null;
  questionNodeId: string | null;
  requestedTier: string | null;
  modelMode: string | null;
  contentPath: string | null;
  sha256: string | null;
  preview: string | null;
  content?: string | null;
  contentBytes: number | null;
  hasContent: boolean;
}

export interface ConsultEdge {
  from: string;
  to: string;
  type: string;
  createdAt: string | null;
}

export interface ConsultRootSummary {
  id: string;
  tag: string;
  graphPath: string;
  status: string;
  protocol: string;
  defaultLens: string;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  questionNodeId: string;
  question: string;
  nodeCount: number;
  edgeCount: number;
}

export interface ConsultRootDetail extends ConsultRootSummary {
  questionNodeId: string;
  origin: ConsultAddress | null;
  source: ConsultRosterResponder | null;
  rosterSnapshot: ConsultRosterResponder[];
  nodes: ConsultNode[];
  edges: ConsultEdge[];
}

export interface ConsultStore {
  exists: boolean;
  activeRootId: string | null;
  roster: ConsultRoster;
  roots: ConsultRootSummary[];
}

export interface ConsultDestination {
  name: string;
  displayName: string;
  agentGroupId: string | null;
}

export interface ConsultTarget {
  name: string;
  displayName: string;
  agentGroupId: string | null;
  provider: string | null;
  model: string | null;
  defaultTier: string | null;
  tiers: Record<string, string>;
}

export interface ConsultSession {
  id: string;
  groupId: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  conversationName: string;
  isGroup: boolean;
  status: string;
  containerStatus: string | null;
  lastActive: string | null;
  createdAt: string | null;
  dir: string;
  route: ConsultAddress | null;
  destinations: ConsultDestination[];
  targets: ConsultTarget[];
  store: ConsultStore;
}

export interface WebQiGroup {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  modelTiers: Record<string, string>;
  sessions: ConsultSession[];
}

export interface WebQiSnapshot {
  groups: WebQiGroup[];
  checkedAt: string;
}

export interface WebQiActivityMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: string;
  sessionId: string;
}

export interface WebQiActivitySnapshot {
  status: 'idle' | 'queued' | 'working';
  messages: WebQiActivityMessage[];
  updatedAt: string | null;
  activeSessionId: string | null;
}

interface RawRoot {
  id?: unknown;
  tag?: unknown;
  status?: unknown;
  protocol?: unknown;
  defaultLens?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  closedAt?: unknown;
  questionNodeId?: unknown;
  source?: unknown;
  origin?: unknown;
  rosterSnapshot?: unknown;
}

interface RawNode {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  createdAt?: unknown;
  completedAt?: unknown;
  label?: unknown;
  lens?: unknown;
  protocol?: unknown;
  sourceName?: unknown;
  sourceAgentGroupId?: unknown;
  questionNodeId?: unknown;
  requestedTier?: unknown;
  modelMode?: unknown;
  contentPath?: unknown;
  content?: unknown;
  sha256?: unknown;
}

interface RawEdge {
  from?: unknown;
  to?: unknown;
  type?: unknown;
  createdAt?: unknown;
}

interface RawGraph {
  rootId?: unknown;
  root?: unknown;
  nodes?: unknown;
  edges?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeModelTiers(value: unknown): Record<string, string> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.length > 0) entries.push([key, entry]);
  }
  return entries.length ? Object.fromEntries(entries) : null;
}

function responder(value: unknown): ConsultRosterResponder | null {
  if (!isRecord(value)) return null;
  const agentGroupId = stringValue(value.agentGroupId);
  const providerName = stringValue(value.providerName);
  const configuredModel = stringValue(value.configuredModel);
  if (!agentGroupId || !providerName || !configuredModel) return null;
  return {
    assistantName: stringValue(value.assistantName, agentGroupId),
    agentGroupId,
    providerName,
    configuredModel,
    effort: nullableString(value.effort),
    modelTiers: safeModelTiers(value.modelTiers),
    defaultTier: nullableString(value.defaultTier),
    modelKey: stringValue(value.modelKey, configuredModel.toLowerCase()),
  };
}

function address(value: unknown): ConsultAddress | null {
  if (!isRecord(value)) return null;
  const channelType = stringValue(value.channelType);
  const platformId = stringValue(value.platformId);
  if (!channelType || !platformId) return null;
  return { channelType, platformId, threadId: nullableString(value.threadId) };
}

function normalizePreview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine;
}

function safeChildFile(rootDir: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(rootDir);
  const candidate = path.resolve(rootDir, relativePath);
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(candidate);
    const realRel = path.relative(realRoot, realFile);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
    return realFile;
  } catch {
    return null;
  }
}

function readPreview(rootDir: string, contentPath: string | null): { preview: string | null; bytes: number | null; text?: string } {
  if (!contentPath) return { preview: null, bytes: null };
  const file = safeChildFile(rootDir, contentPath);
  if (!file) return { preview: null, bytes: null };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return { preview: null, bytes: stat.size };
    const text = fs.readFileSync(file, 'utf8');
    return { preview: normalizePreview(text), bytes: stat.size, text };
  } catch {
    return { preview: null, bytes: null };
  }
}

function parseNode(rootDir: string, raw: RawNode): ConsultNode | null {
  const id = stringValue(raw.id);
  if (!id) return null;
  const contentPath = nullableString(raw.contentPath);
  const embedded = typeof raw.content === 'string' ? raw.content : null;
  const content = embedded !== null
    ? { preview: normalizePreview(embedded), bytes: Buffer.byteLength(embedded, 'utf8'), text: embedded }
    : readPreview(rootDir, contentPath);
  return {
    id,
    type: stringValue(raw.type, 'unknown'),
    status: stringValue(raw.status, 'unknown'),
    createdAt: nullableString(raw.createdAt),
    completedAt: nullableString(raw.completedAt),
    label: nullableString(raw.label),
    lens: nullableString(raw.lens),
    protocol: nullableString(raw.protocol),
    sourceName: nullableString(raw.sourceName),
    sourceAgentGroupId: nullableString(raw.sourceAgentGroupId),
    questionNodeId: nullableString(raw.questionNodeId),
    requestedTier: nullableString(raw.requestedTier),
    modelMode: nullableString(raw.modelMode),
    contentPath,
    sha256: nullableString(raw.sha256),
    preview: content.preview,
    content: raw.status === 'complete' ? content.text ?? null : null,
    contentBytes: content.bytes,
    hasContent: Boolean(contentPath && content.bytes !== null && content.preview !== null),
  };
}

function parseGraph(rootDir: string, graph: RawGraph): { nodes: ConsultNode[]; edges: ConsultEdge[] } {
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const nodes = rawNodes
    .filter(isRecord)
    .map((raw) => parseNode(rootDir, raw as RawNode))
    .filter(Boolean) as ConsultNode[];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const edges = rawEdges
    .filter(isRecord)
    .map((raw) => {
      const edge = raw as RawEdge;
      return {
        from: stringValue(edge.from),
        to: stringValue(edge.to),
        type: stringValue(edge.type, 'related'),
        createdAt: nullableString(edge.createdAt),
      };
    })
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  return { nodes, edges };
}

function rootDirectory(consultationsDir: string, rootId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(rootId)) return null;
  const roots = path.join(consultationsDir, 'roots');
  const dir = path.join(roots, rootId);
  try {
    if (fs.lstatSync(roots).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) return null;
    if (!fs.statSync(dir).isDirectory()) return null;
    return dir;
  } catch {
    return null;
  }
}

function parseRoot(consultationsDir: string, rootId: string): ConsultRootDetail | null {
  const dir = rootDirectory(consultationsDir, rootId);
  if (!dir) return null;
  const rawGraph = safeJson(path.join(dir, 'graph.json')) as RawGraph | null;
  if (!rawGraph) return null;
  const rawRoot = (safeJson(path.join(dir, 'root.json')) ?? (isRecord(rawGraph.root) ? rawGraph.root : null)) as RawRoot | null;
  if (!rawRoot || !rawGraph) return null;
  const id = stringValue(rawRoot.id, rootId);
  if (id !== rootId || stringValue(rawGraph.rootId, rootId) !== rootId) return null;
  const parsed = parseGraph(dir, rawGraph);
  const questionNodeId = stringValue(rawRoot.questionNodeId, `${rootId}:Q0`);
  const question = parsed.nodes.find((node) => node.id === questionNodeId)?.preview ?? 'Question unavailable';
  const snapshot = Array.isArray(rawRoot.rosterSnapshot)
    ? (rawRoot.rosterSnapshot.map(responder).filter(Boolean) as ConsultRosterResponder[])
    : [];
  return {
    id,
    tag: stringValue(rawRoot.tag, rootId.toLowerCase()),
    graphPath: `consultations/roots/${rootId}/graph.json`,
    status: stringValue(rawRoot.status, 'unknown'),
    protocol: stringValue(rawRoot.protocol, 'quick'),
    defaultLens: stringValue(rawRoot.defaultLens, 'distill'),
    createdAt: nullableString(rawRoot.createdAt),
    updatedAt: nullableString(rawRoot.updatedAt),
    closedAt: nullableString(rawRoot.closedAt),
    question,
    nodeCount: parsed.nodes.length,
    edgeCount: parsed.edges.length,
    questionNodeId,
    origin: address(rawRoot.origin),
    source: responder(rawRoot.source),
    rosterSnapshot: snapshot,
    nodes: parsed.nodes,
    edges: parsed.edges,
  };
}

function listRootIds(consultationsDir: string): string[] {
  const roots = path.join(consultationsDir, 'roots');
  try {
    return fs
      .readdirSync(roots)
      .filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
      .filter((id) => rootDirectory(consultationsDir, id) !== null)
      .filter((id) => fs.existsSync(path.join(roots, id, 'root.json')) || fs.existsSync(path.join(roots, id, 'graph.json')));
  } catch {
    return [];
  }
}

function parseRoster(index: Record<string, unknown> | null): ConsultRoster {
  const rawRoster = index && isRecord(index.roster) ? index.roster : {};
  const entries: ConsultRoster['entries'] = {};
  if (isRecord(rawRoster.entries)) {
    for (const [id, value] of Object.entries(rawRoster.entries)) {
      if (!isRecord(value)) continue;
      const r = responder(value.responder);
      if (r) entries[id] = { receivedAt: nullableString(value.receivedAt) ?? undefined, responder: r };
    }
  }
  return { refreshedAt: nullableString(rawRoster.refreshedAt), entries };
}

/**
 * Multiple destination aliases can point at one agent group. Keep the last
 * alias in the persisted destination order so the UI does not show the same
 * consulting agent twice. The underlying destination map is untouched, so
 * existing /consult commands and routing remain compatible.
 */
export function dedupeConsultDestinations(destinations: ConsultDestination[]): ConsultDestination[] {
  const byAgent = new Map<string, ConsultDestination>();
  for (const destination of destinations) {
    const key = destination.agentGroupId ? `agent:${destination.agentGroupId}` : `name:${destination.name}`;
    byAgent.set(key, destination);
  }
  return [...byAgent.values()];
}

export function readConsultationStore(sessionDir: string): ConsultStore {
  const consultationsDir = path.join(sessionDir, 'consultations');
  const index = safeJson(path.join(consultationsDir, 'index.json'));
  const roots = listRootIds(consultationsDir)
    .map((id) => parseRoot(consultationsDir, id))
    .filter(Boolean)
    .map((root) => root as ConsultRootDetail)
    .sort((a, b) => (toUtcMs(b.updatedAt ?? b.createdAt ?? '') || 0) - (toUtcMs(a.updatedAt ?? a.createdAt ?? '') || 0))
    .map(
      ({ origin: _origin, source: _source, rosterSnapshot: _snapshot, nodes: _nodes, edges: _edges, ...summary }) =>
        summary,
    );
  const activeRootId = index && typeof index.activeRootId === 'string' ? index.activeRootId : null;
  return {
    exists: Boolean(index || roots.length),
    activeRootId,
    roster: parseRoster(index),
    roots,
  };
}

export function readConsultationRoot(sessionDir: string, rootId: string): ConsultRootDetail | null {
  return parseRoot(path.join(sessionDir, 'consultations'), rootId);
}

export function readConsultationSource(sessionDir: string, rootId: string, nodeRef: string): string | null {
  const root = parseRoot(path.join(sessionDir, 'consultations'), rootId);
  if (!root) return null;
  const nodeId = nodeRef.includes(':') ? nodeRef : `${root.id}:${nodeRef}`;
  const node = root.nodes.find((entry) => entry.id === nodeId);
  const dir = rootDirectory(path.join(sessionDir, 'consultations'), root.id);
  if (!dir) return null;
  const rawGraph = safeJson(path.join(dir, 'graph.json')) as RawGraph | null;
  return readNodeContent(dir, nodeId, node, rawGraph);
}

function readNodeContent(rootDir: string, nodeId: string, node: ConsultNode | undefined, graph: RawGraph | null): string | null {
  const rawNode = graph && Array.isArray(graph.nodes)
    ? graph.nodes.find((entry) => isRecord(entry) && stringValue(entry.id) === nodeId) as RawNode | undefined
    : undefined;
  if (typeof rawNode?.content === 'string') return rawNode.content;
  if (!node?.contentPath) return null;
  const file = safeChildFile(rootDir, node.contentPath);
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_SOURCE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Read the canonical per-root graph snapshot without exposing its host path. */
export function readConsultationGraphFile(sessionDir: string, rootId: string): string | null {
  const root = readConsultationRoot(sessionDir, rootId);
  if (!root) return null;
  const dir = rootDirectory(path.join(sessionDir, 'consultations'), root.id);
  if (!dir) return null;
  const file = safeChildFile(dir, 'graph.json');
  if (!file) return null;
  try {
    if (fs.statSync(file).size > MAX_GRAPH_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Render a complete, read-only transcript for one consultation root.
 *
 * The graph snapshot is chronological, so node sections retain that order.
 * The typed edge list is included separately as a compact flow map, making
 * branches and derived processing nodes visible without asking the operator
 * to infer relationships from the node ids.
 */
export function readConsultationConversation(sessionDir: string, rootId: string): string | null {
  const root = readConsultationRoot(sessionDir, rootId);
  if (!root) return null;
  const dir = rootDirectory(path.join(sessionDir, 'consultations'), root.id);
  if (!dir) return null;
  const graph = safeJson(path.join(dir, 'graph.json')) as RawGraph | null;
  const nodeTypes = new Map(root.nodes.map((node) => [node.id, node.type]));

  const incoming = new Map<string, ConsultEdge[]>();
  const outgoing = new Map<string, ConsultEdge[]>();
  for (const edge of root.edges) {
    const inbound = incoming.get(edge.to) ?? [];
    inbound.push(edge);
    incoming.set(edge.to, inbound);
    const outbound = outgoing.get(edge.from) ?? [];
    outbound.push(edge);
    outgoing.set(edge.from, outbound);
  }

  const lines = [
    'FULL CONSULTATION CONVERSATION',
    `Tag: ${root.tag}`,
    `Root: ${root.id}`,
    `Status: ${root.status}`,
    `Protocol: ${root.protocol}`,
    `Default lens: ${root.defaultLens}`,
    `Created: ${root.createdAt ?? 'unknown'}`,
    `Updated: ${root.updatedAt ?? 'unknown'}`,
    `Nodes: ${root.nodes.length} · Edges: ${root.edges.length}`,
    '',
    'FLOW',
    ...(root.edges.length
      ? root.edges.map(
          (edge) =>
            `${edge.from} [${nodeTypes.get(edge.from) ?? 'unknown'}] --${edge.type}--> ${edge.to} [${nodeTypes.get(edge.to) ?? 'unknown'}]`,
        )
      : ['(no graph edges recorded)']),
    '',
    'NODES IN SEQUENCE',
  ];

  root.nodes.forEach((node, index) => {
    const inbound = incoming.get(node.id) ?? [];
    const outbound = outgoing.get(node.id) ?? [];
    const content = readNodeContent(dir, node.id, node, graph);
    lines.push(
      '',
      `===== NODE ${index + 1} / ${root.nodes.length} · ${node.type.toUpperCase()} · ${node.id} =====`,
      `Label: ${node.label ?? '(unlabeled)'}`,
      `Status: ${node.status}`,
      `Created: ${node.createdAt ?? 'unknown'}`,
      ...(node.completedAt ? [`Completed: ${node.completedAt}`] : []),
      ...(node.sourceName ? [`Source: ${node.sourceName}`] : []),
      ...(node.sourceAgentGroupId ? [`Source agent group: ${node.sourceAgentGroupId}`] : []),
      ...(node.questionNodeId ? [`Question node: ${node.questionNodeId}`] : []),
      ...(node.protocol ? [`Protocol: ${node.protocol}`] : []),
      ...(node.lens ? [`Lens: ${node.lens}`] : []),
      ...(node.requestedTier ? [`Requested tier: ${node.requestedTier}`] : []),
      `Incoming: ${inbound.length ? inbound.map((edge) => `${edge.from} --${edge.type}--> ${node.id}`).join(' · ') : '(root node)'}`,
      `Outgoing: ${outbound.length ? outbound.map((edge) => `${node.id} --${edge.type}--> ${edge.to}`).join(' · ') : '(none)'}`,
      '',
      'CONTENT',
      content ?? '[content unavailable: node is pending or its exact source capture is missing]',
    );
  });

  const rendered = lines.join('\n');
  return Buffer.byteLength(rendered, 'utf8') <= MAX_CONVERSATION_BYTES ? rendered : null;
}

function openReadOnly(file: string): Database.Database | null {
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function readDestinations(dir: string): ConsultDestination[] {
  const db = openReadOnly(path.join(dir, 'inbound.db'));
  if (!db) return [];
  try {
    return (
      db
        .prepare("SELECT name, display_name, agent_group_id FROM destinations WHERE type = 'agent' ORDER BY name")
        .all() as { name: string; display_name: string | null; agent_group_id: string | null }[]
    )
      .filter((row) => typeof row.name === 'string' && row.name.length > 0)
      .map((row) => ({ name: row.name, displayName: row.display_name ?? row.name, agentGroupId: row.agent_group_id }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

interface CentralSessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  status: string;
  container_status: string | null;
  last_active: string | null;
  created_at: string | null;
  channel_type: string | null;
  platform_id: string | null;
  conversation_name: string | null;
  is_group: number | null;
}

function centralSessions(): CentralSessionRow[] {
  return withCentral((db) =>
    db
      .prepare(
        `SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id, s.status,
                s.container_status, s.last_active, s.created_at,
                m.channel_type, m.platform_id, m.name AS conversation_name, m.is_group
         FROM sessions s LEFT JOIN messaging_groups m ON m.id = s.messaging_group_id
         ORDER BY COALESCE(s.last_active, s.created_at) DESC`,
      )
      .all(),
  ) as CentralSessionRow[];
}

function groupTiers(group: AgentGroupInfo): Record<string, string> {
  const parsed = safeModelTiers(group.model_tiers);
  return parsed ?? {};
}

function buildTargets(
  destinations: ConsultDestination[],
  store: ConsultStore,
  groups: Map<string, AgentGroupInfo>,
): ConsultTarget[] {
  return dedupeConsultDestinations(destinations).map((destination) => {
    const group = destination.agentGroupId ? groups.get(destination.agentGroupId) : undefined;
    const roster = destination.agentGroupId ? store.roster.entries[destination.agentGroupId]?.responder : undefined;
    const tiers = roster?.modelTiers ?? (group ? groupTiers(group) : {});
    return {
      name: destination.name,
      displayName: destination.displayName,
      agentGroupId: destination.agentGroupId,
      provider: roster?.providerName ?? group?.provider ?? null,
      model: roster?.configuredModel ?? group?.model ?? null,
      defaultTier: roster?.defaultTier ?? tiers.default ?? null,
      tiers,
    };
  });
}

interface ActivityInboundRow {
  id: string;
  status: string;
  timestamp: string;
  content: string;
}

interface ActivityOutboundRow {
  id: string;
  timestamp: string;
  content: string;
}

type ActivityStatus = WebQiActivitySnapshot['status'];

interface ActivityEntry {
  message: WebQiActivityMessage;
  at: number;
  status: ActivityStatus;
  rootId: string | null;
  rootTag: string | null;
}

function textFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && typeof parsed.text === 'string') return parsed.text;
  } catch {
    // Older rows can contain plain text.
  }
  return content;
}

function activityIdentity(content: string, text: string): { rootId: string | null; rootTag: string | null } {
  let rootId: string | null = null;
  let rootTag: string | null = null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && isRecord(parsed.consult)) {
      if (typeof parsed.consult.rootId === 'string') rootId = parsed.consult.rootId;
      if (typeof parsed.consult.rootTag === 'string') rootTag = parsed.consult.rootTag.toLowerCase();
    }
  } catch {
    // Older rows can contain plain text.
  }
  const tag = text.match(/(?:^|\s)--tag\s+([A-Za-z0-9_-]+)/i)?.[1];
  if (tag) rootTag = tag.toLowerCase();
  const reference = text.match(
    /^\/consult\s+(?:continue|branch|lens|judge|challenge|revise|show|sources|raw|use|close|reopen|delete|restore)\s+([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?)/i,
  )?.[1];
  if (reference) {
    const token = reference.split(':')[0];
    if (/^C\d{3,}$/i.test(token)) rootId = token.toUpperCase();
    else rootTag = token.toLowerCase();
  }
  return { rootId, rootTag };
}

function activityStatus(
  row: ActivityInboundRow,
  outDb: Database.Database | null,
): WebQiActivitySnapshot['status'] {
  if (outDb) {
    try {
      const ack = outDb.prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(row.id) as
        | { status: string }
        | undefined;
      if (ack?.status === 'processing') return 'working';
      if (ack?.status === 'completed' || ack?.status === 'failed') return 'idle';
    } catch {
      // Older session DBs may not have processing_ack yet.
    }
  }
  return row.status === 'pending' ? 'queued' : 'idle';
}

/**
 * Read routed WebQI activity across sessions belonging to an agent group.
 * A continuation deliberately runs in the source session, while its response
 * is addressed to the synthetic Web Chat destination. Scanning read-only
 * outboxes lets the page render that response without introducing a second
 * writer or copying messages between session databases. When a session/root
 * is supplied, return only its latest request/response turn.
 */
export function readWebQiActivity(
  groupId: string,
  options: { sessionsRoot?: string; sessionId?: string; rootId?: string; rootTag?: string; limit?: number } = {},
): WebQiActivitySnapshot {
  const sessions = listSessionDirs(options.sessionsRoot ?? PATHS.sessionsDir).filter(
    (entry) => entry.groupId === groupId && (!options.sessionId || entry.sessionId === options.sessionId),
  );
  const platformId = `web:${groupId}`;
  const entries: ActivityEntry[] = [];

  for (const session of sessions) {
    const inDb = openReadOnly(path.join(session.dir, 'inbound.db'));
    const outDb = openReadOnly(path.join(session.dir, 'outbound.db'));
    if (!inDb && !outDb) continue;
    try {
      if (inDb) {
        try {
          const rows = inDb
            .prepare(
              "SELECT id, status, timestamp, content FROM messages_in WHERE kind IN ('chat', 'chat-sdk') AND channel_type = 'cli' AND platform_id = ? ORDER BY timestamp, rowid",
            )
            .all(platformId) as ActivityInboundRow[];
          for (const row of rows) {
            const status = activityStatus(row, outDb);
            const at = toUtcMs(row.timestamp) || 0;
            const text = textFromContent(row.content);
            if (text) {
              const identity = activityIdentity(row.content, text);
              entries.push({
                message: { id: row.id, role: 'user', text, timestamp: row.timestamp, sessionId: session.sessionId },
                at,
                status,
                ...identity,
              });
            }
          }
        } catch {
          // Tolerate a session DB during schema creation or replacement.
        }
      }
      if (outDb) {
        try {
          const rows = outDb
            .prepare(
              "SELECT id, timestamp, content FROM messages_out WHERE kind = 'chat' AND channel_type = 'cli' AND platform_id = ? ORDER BY timestamp, rowid",
            )
            .all(platformId) as ActivityOutboundRow[];
          for (const row of rows) {
            const text = textFromContent(row.content);
            if (text) {
              entries.push({
                message: { id: row.id, role: 'agent', text, timestamp: row.timestamp, sessionId: session.sessionId },
                at: toUtcMs(row.timestamp) || 0,
                status: 'idle',
                ...activityIdentity(row.content, text),
              });
            }
          }
        } catch {
          // Tolerate a session DB during schema creation or replacement.
        }
      }
    } finally {
      inDb?.close();
      outDb?.close();
    }
  }

  entries.sort((a, b) => a.at - b.at || a.message.id.localeCompare(b.message.id));
  const scoped = Boolean(options.sessionId || options.rootId || options.rootTag);
  let visible = entries;
  if (scoped) {
    const rootId = options.rootId?.toUpperCase();
    const rootTag = options.rootTag?.toLowerCase();
    const matchingUsers = entries.filter(
      (entry) =>
        entry.message.role === 'user' &&
        (!rootId || entry.rootId === rootId || (rootTag ? entry.rootTag === rootTag : false)),
    );
    const anchor = (rootId || rootTag ? matchingUsers : entries.filter((entry) => entry.message.role === 'user')).at(-1);
    if (anchor) {
      const anchorIndex = entries.indexOf(anchor);
      // outbound.db timestamps have second precision while inbound.db keeps
      // milliseconds. An immediate error/reply can therefore sort just before
      // its request; retain same-second agent rows when opening the turn.
      const anchorSecond = Math.floor(anchor.at / 1000) * 1000;
      const sameSecondAgent = entries.findIndex(
        (entry, index) => index < anchorIndex && entry.message.role === 'agent' && entry.at >= anchorSecond,
      );
      const start = sameSecondAgent >= 0 ? sameSecondAgent : anchorIndex;
      const nextUser = entries.findIndex((entry, index) => index > anchorIndex && entry.message.role === 'user');
      const turn = entries.slice(start, nextUser < 0 ? entries.length : nextUser);
      // Present the operator's request first even when an outbound row's
      // second-precision timestamp sorted it immediately before the request.
      visible = [anchor, ...turn.filter((entry) => entry !== anchor)];
    } else {
      visible = [];
    }
  }
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 60;
  const recent = visible.slice(-limit);
  const latestMessage = recent.at(-1)?.message;
  const activeEntry = recent
    .filter((entry) => entry.message.role === 'user' && entry.status !== 'idle')
    .sort((a, b) => (a.status === 'working' ? 1 : 0) - (b.status === 'working' ? 1 : 0) || a.at - b.at)
    .at(-1);
  return {
    status: activeEntry?.status ?? 'idle',
    messages: recent.map((entry) => entry.message),
    updatedAt: latestMessage?.timestamp ?? null,
    activeSessionId: activeEntry?.message.sessionId ?? latestMessage?.sessionId ?? null,
  };
}

function sessionFromRow(
  row: CentralSessionRow,
  dirs: Map<string, SessionDirs>,
  groups: Map<string, AgentGroupInfo>,
): ConsultSession | null {
  const disk = dirs.get(`${row.agent_group_id}:${row.id}`);
  if (!disk) return null;
  const store = readConsultationStore(disk.dir);
  const destinations = readDestinations(disk.dir);
  return {
    id: row.id,
    groupId: row.agent_group_id,
    channelType: row.channel_type,
    platformId: row.platform_id,
    threadId: row.thread_id,
    conversationName: row.conversation_name ?? `${row.channel_type ?? 'session'} · ${row.platform_id ?? row.id}`,
    isGroup: row.is_group === 1,
    status: row.status,
    containerStatus: row.container_status,
    lastActive: row.last_active,
    createdAt: row.created_at,
    dir: disk.dir,
    route:
      row.channel_type && row.platform_id
        ? { channelType: row.channel_type, platformId: row.platform_id, threadId: row.thread_id }
        : null,
    destinations,
    targets: buildTargets(destinations, store, groups),
    store,
  };
}

function pendingWebSession(group: AgentGroupInfo, sessionsRoot: string): ConsultSession {
  const store = readConsultationStore(path.join(sessionsRoot, group.id, '__webqi__'));
  return {
    id: '__webqi_new__',
    groupId: group.id,
    channelType: 'cli',
    platformId: `web:${group.id}`,
    threadId: null,
    conversationName: 'Web Chat (new session)',
    isGroup: false,
    status: 'new',
    containerStatus: 'not started',
    lastActive: null,
    createdAt: null,
    dir: path.join(sessionsRoot, group.id, '__webqi__'),
    route: { channelType: 'cli', platformId: `web:${group.id}`, threadId: null },
    destinations: [],
    targets: [],
    store,
  };
}

export function listWebQiSnapshot(options: { sessionsRoot?: string } = {}): WebQiSnapshot {
  const groups = listAgentGroups();
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  const sessionsRoot = options.sessionsRoot ?? PATHS.sessionsDir;
  const dirs = new Map(listSessionDirs(sessionsRoot).map((dir) => [`${dir.groupId}:${dir.sessionId}`, dir]));
  const sessions = centralSessions()
    .map((row) => sessionFromRow(row, dirs, groupMap))
    .filter(Boolean) as ConsultSession[];
  const byGroup = new Map<string, ConsultSession[]>();
  for (const session of sessions) {
    const list = byGroup.get(session.groupId) ?? [];
    list.push(session);
    byGroup.set(session.groupId, list);
  }
  for (const group of groups) {
    const list = byGroup.get(group.id) ?? [];
    if (!list.some((session) => session.channelType === 'cli' && session.platformId === `web:${group.id}`)) {
      list.unshift(pendingWebSession(group, sessionsRoot));
    }
    byGroup.set(group.id, list);
  }
  return {
    checkedAt: new Date().toISOString(),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      provider: group.provider,
      model: group.model,
      modelTiers: groupTiers(group),
      sessions: byGroup.get(group.id) ?? [],
    })),
  };
}

export function findWebQiSession(groupId: string, sessionId: string): ConsultSession | null {
  return (
    listWebQiSnapshot()
      .groups.find((group) => group.id === groupId)
      ?.sessions.find((session) => session.id === sessionId) ?? null
  );
}
