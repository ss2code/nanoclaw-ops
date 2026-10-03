import { PATHS } from '../config.js';
import { tailLines } from './logs.js';

export interface InboundRouteEvent {
  kind: 'inbound';
  clock: string;
  sessionId: string;
  agentGroupId: string;
  agentGroupName: string | null;
  engageMode: string | null;
  channelKind: string | null;
  userId: string | null;
  wake: boolean | null;
  created: boolean | null;
}

export interface ForwardRouteEvent {
  kind: 'forward';
  clock: string;
  fromGroupId: string;
  toGroupId: string;
  targetSession: string;
  messageId: string | null;
  forwardedFileCount: number;
}

export type RouteEvent = InboundRouteEvent | ForwardRouteEvent;

function fields(line: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of line.matchAll(/\b([A-Za-z_][\w-]*)=(?:"([^"]*)"|([^\s]+))/g)) {
    out.set(match[1], match[2] ?? match[3]);
  }
  return out;
}

function bool(value: string | undefined): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null;
}

/** Parse healthy inbound routing and agent-to-agent forwarding from host logs. */
export function parseRouteLine(line: string): RouteEvent | null {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
  const clock = clean.match(/^\[([^\]]+)\]/)?.[1] ?? '';
  const f = fields(clean);
  if (clean.includes('Agent message routed')) {
    const fromGroupId = f.get('from');
    const toGroupId = f.get('to');
    const targetSession = f.get('targetSession');
    if (!fromGroupId || !toGroupId || !targetSession) return null;
    return {
      kind: 'forward',
      clock,
      fromGroupId,
      toGroupId,
      targetSession,
      messageId: f.get('a2aMsgId') ?? null,
      forwardedFileCount: Number(f.get('forwardedFileCount') ?? 0),
    };
  }
  if (!clean.includes('Message routed')) return null;
  const sessionId = f.get('sessionId');
  const agentGroupId = f.get('agentGroup');
  if (!sessionId || !agentGroupId) return null;
  return {
    kind: 'inbound',
    clock,
    sessionId,
    agentGroupId,
    agentGroupName: f.get('agentGroupName') ?? null,
    engageMode: f.get('engage_mode') ?? null,
    channelKind: f.get('kind') ?? null,
    userId: f.get('userId') ?? null,
    wake: bool(f.get('wake')),
    created: bool(f.get('created')),
  };
}

export function recentRouteEvents(limit = 300): RouteEvent[] {
  return tailLines(PATHS.hostLog, Math.max(limit * 8, 500), 2 * 1024 * 1024)
    .map(parseRouteLine)
    .filter((event): event is RouteEvent => event != null)
    .slice(-limit)
    .reverse();
}
