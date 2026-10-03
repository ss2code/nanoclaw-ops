import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dedupeConsultDestinations,
  readConsultationConversation,
  readConsultationGraphFile,
  readConsultationRoot,
  readConsultationSource,
  readConsultationStore,
  readWebQiActivity,
} from './consult.js';

let dir: string;
let rootDir: string;

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-reader-'));
  rootDir = path.join(dir, 'consultations', 'roots', 'C007');
  write(
    path.join(dir, 'consultations', 'index.json'),
    JSON.stringify({
      version: 1,
      activeRootId: 'C007',
      roster: {
        refreshedAt: '2026-08-30T10:00:00.000Z',
        entries: {
          'ag-atlas': {
            responder: {
              assistantName: 'Atlas',
              agentGroupId: 'ag-atlas',
              providerName: 'claude',
              configuredModel: 'claude-sonnet',
              modelTiers: { high: 'claude-opus', default: 'medium' },
              defaultTier: 'medium',
              modelKey: 'claude-sonnet',
            },
          },
        },
      },
    }),
  );
  write(
    path.join(rootDir, 'root.json'),
    JSON.stringify({
      version: 1,
      id: 'C007',
      tag: 'reader-fixture',
      status: 'open',
      protocol: 'quick',
      defaultLens: 'distill',
      createdAt: '2026-08-30T10:00:00.000Z',
      updatedAt: '2026-08-30T10:01:00.000Z',
      questionNodeId: 'C007:Q0',
      origin: { channelType: 'whatsapp', platformId: 'phone:1', threadId: null },
      source: {
        assistantName: 'Jeeves',
        agentGroupId: 'ag-jeeves',
        providerName: 'codex',
        configuredModel: 'gpt-5',
      },
      rosterSnapshot: [],
    }),
  );
  write(
    path.join(rootDir, 'graph.json'),
    JSON.stringify({
      version: 1,
      rootId: 'C007',
      nodes: [
        {
          id: 'C007:Q0',
          type: 'question',
          status: 'complete',
          label: 'Root question',
          createdAt: '2026-08-30T10:00:00.000Z',
          contentPath: 'content/Q0.txt',
          content: 'What should we investigate?',
          sha256: 'question-hash',
        },
        {
          id: 'C007:A1',
          type: 'answer',
          status: 'complete',
          label: 'Answer from Atlas',
          sourceName: 'atlas',
          sourceAgentGroupId: 'ag-atlas',
          createdAt: '2026-08-30T10:00:30.000Z',
          contentPath: 'content/A1.txt',
          content: 'The exact external answer.',
        },
        {
          id: 'C007:C1',
          type: 'critique',
          status: 'pending',
          label: 'Critique',
          contentPath: '../outside.txt',
        },
      ],
      edges: [{ from: 'C007:Q0', to: 'C007:A1', type: 'answers', createdAt: '2026-08-30T10:00:30.000Z' }],
    }),
  );
  write(path.join(rootDir, 'content', 'Q0.txt'), 'What should we investigate?');
  write(path.join(rootDir, 'content', 'A1.txt'), 'The exact external answer.');
  write(path.join(dir, 'consultations', 'outside.txt'), 'must not be followed');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('consultation reader', () => {
  it('discovers session-local roots, previews content, and preserves roster metadata', () => {
    const store = readConsultationStore(dir);
    expect(store.exists).toBe(true);
    expect(store.activeRootId).toBe('C007');
    expect(store.roster.refreshedAt).toBe('2026-08-30T10:00:00.000Z');
    expect(store.roster.entries['ag-atlas'].responder.configuredModel).toBe('claude-sonnet');
    expect(store.roots[0]).toMatchObject({ id: 'C007', tag: 'reader-fixture', graphPath: 'consultations/roots/C007/graph.json', nodeCount: 3, edgeCount: 1 });
  });

  it('reads a graph detail and exact source without trusting a graph path', () => {
    const root = readConsultationRoot(dir, 'C007');
    expect(root?.origin).toMatchObject({ channelType: 'whatsapp', platformId: 'phone:1' });
    expect(root?.nodes.find((node) => node.id === 'C007:Q0')).toMatchObject({
      preview: 'What should we investigate?',
      content: 'What should we investigate?',
      hasContent: true,
    });
    expect(root?.nodes.find((node) => node.id === 'C007:C1')).toMatchObject({ hasContent: false, preview: null });
    expect(readConsultationSource(dir, 'C007', 'C007:A1')).toBe('The exact external answer.');
    expect(root?.nodes.find((node) => node.id === 'C007:A1')?.content).toBe('The exact external answer.');
    expect(root?.nodes.find((node) => node.id === 'C007:C1')?.content).toBeNull();
    expect(readConsultationSource(dir, 'C007', 'C007:C1')).toBeNull();
    const graph = JSON.parse(readConsultationGraphFile(dir, 'C007')!);
    expect(graph.nodes.find((node: { id: string }) => node.id === 'C007:Q0').content).toBe('What should we investigate?');
  });

  it('renders the full tagged conversation with an explicit flow and node sections', () => {
    const conversation = readConsultationConversation(dir, 'C007');
    expect(conversation).toContain('FULL CONSULTATION CONVERSATION');
    expect(conversation).toContain('Tag: reader-fixture');
    expect(conversation).toContain('FLOW');
    expect(conversation).toContain('C007:Q0 [question] --answers--> C007:A1 [answer]');
    expect(conversation).toContain('===== NODE 1 / 3 · QUESTION · C007:Q0 =====');
    expect(conversation).toContain('What should we investigate?');
    expect(conversation).toContain('The exact external answer.');
    expect(conversation).toContain('[content unavailable: node is pending or its exact source capture is missing]');
    expect(readConsultationConversation(dir, 'missing')).toBeNull();
  });

  it('rejects unknown roots and node references', () => {
    expect(readConsultationRoot(dir, '../C007')).toBeNull();
    expect(readConsultationSource(dir, 'C007', 'C007:missing')).toBeNull();
    expect(readConsultationGraphFile(dir, '../C007')).toBeNull();
  });

  it('keeps one visible destination when aliases point to the same agent group', () => {
    expect(
      dedupeConsultDestinations([
        { name: 'errand-runner', displayName: 'Errand Runner', agentGroupId: 'ag-errand' },
        { name: 'atlas', displayName: 'Atlas', agentGroupId: 'ag-atlas' },
        { name: 'scout', displayName: 'Errand Runner', agentGroupId: 'ag-errand' },
      ]),
    ).toEqual([
      { name: 'scout', displayName: 'Errand Runner', agentGroupId: 'ag-errand' },
      { name: 'atlas', displayName: 'Atlas', agentGroupId: 'ag-atlas' },
    ]);
  });

  it('reads routed WebQI messages across source sessions and reports processing state', () => {
    const sessionDir = path.join(dir, 'ag-activity', 'sess-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const inbound = new Database(path.join(sessionDir, 'inbound.db'));
    inbound.exec(`
      CREATE TABLE messages_in (id TEXT PRIMARY KEY, kind TEXT, status TEXT, timestamp TEXT, channel_type TEXT, platform_id TEXT, content TEXT);
      INSERT INTO messages_in VALUES ('in-1', 'chat', 'pending', '2026-08-30T10:02:00.000Z', 'cli', 'web:ag-activity', '{"text":"Continue this thread."}');
      INSERT INTO messages_in VALUES ('in-2', 'chat', 'pending', '2026-08-30T10:03:00.000Z', 'cli', 'web:ag-activity', '{"text":"A later completed request."}');
    `);
    inbound.close();
    const outbound = new Database(path.join(sessionDir, 'outbound.db'));
    outbound.exec(`
      CREATE TABLE messages_out (id TEXT PRIMARY KEY, kind TEXT, timestamp TEXT, channel_type TEXT, platform_id TEXT, content TEXT);
      CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO processing_ack VALUES ('in-1', 'processing');
      INSERT INTO processing_ack VALUES ('in-2', 'completed');
      INSERT INTO messages_out VALUES ('out-1', 'chat', '2026-08-30T10:02:01.000Z', 'cli', 'web:ag-activity', '{"text":"Working on it."}');
    `);
    outbound.close();

    expect(readWebQiActivity('ag-activity', { sessionsRoot: dir })).toMatchObject({
      status: 'working',
      activeSessionId: 'sess-1',
      messages: [
        { id: 'in-1', role: 'user', text: 'Continue this thread.' },
        { id: 'out-1', role: 'agent', text: 'Working on it.' },
        { id: 'in-2', role: 'user', text: 'A later completed request.' },
      ],
    });
  });

  it('can scope activity to the latest turn for the selected session and root', () => {
    const sessionDir = path.join(dir, 'ag-activity', 'sess-scoped');
    fs.mkdirSync(sessionDir, { recursive: true });
    const inbound = new Database(path.join(sessionDir, 'inbound.db'));
    inbound.exec(`
      CREATE TABLE messages_in (id TEXT PRIMARY KEY, kind TEXT, status TEXT, timestamp TEXT, channel_type TEXT, platform_id TEXT, content TEXT);
      INSERT INTO messages_in VALUES ('old-in', 'chat', 'completed', '2026-08-30T10:00:00.000Z', 'cli', 'web:ag-activity', '{"text":"/consult continue C001:Q0 Old turn"}');
      INSERT INTO messages_in VALUES ('new-in', 'chat', 'pending', '2026-08-30T10:05:00.500Z', 'cli', 'web:ag-activity', '{"text":"/consult continue C002:Q0 New turn"}');
    `);
    inbound.close();
    const outbound = new Database(path.join(sessionDir, 'outbound.db'));
    outbound.exec(`
      CREATE TABLE messages_out (id TEXT PRIMARY KEY, kind TEXT, timestamp TEXT, channel_type TEXT, platform_id TEXT, content TEXT);
      CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO processing_ack VALUES ('old-in', 'completed');
      INSERT INTO processing_ack VALUES ('new-in', 'processing');
      INSERT INTO messages_out VALUES ('old-out', 'chat', '2026-08-30T10:00:01.000Z', 'cli', 'web:ag-activity', '{"text":"Old answer","consult":{"rootId":"C001"}}');
      INSERT INTO messages_out VALUES ('new-out', 'chat', '2026-08-30T10:05:00.000Z', 'cli', 'web:ag-activity', '{"text":"New answer","consult":{"rootId":"C002","rootTag":"new-turn"}}');
    `);
    outbound.close();

    expect(
      readWebQiActivity('ag-activity', {
        sessionsRoot: dir,
        sessionId: 'sess-scoped',
        rootId: 'C002',
        rootTag: 'new-turn',
      }),
    ).toMatchObject({
      status: 'working',
      activeSessionId: 'sess-scoped',
      messages: [
        { id: 'new-in', role: 'user', text: '/consult continue C002:Q0 New turn' },
        { id: 'new-out', role: 'agent', text: 'New answer' },
      ],
    });
  });
});
