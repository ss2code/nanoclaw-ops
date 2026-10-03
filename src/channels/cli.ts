/**
 * CLI channel — talk to your agent from a local terminal via Unix socket.
 *
 * Always-on, zero-credentials channel that ships with main. The daemon
 * listens on `data/cli.sock`; the `scripts/chat.ts` client connects, writes
 * a JSON line per message, reads JSON lines back. The channel plumbs into
 * the normal router/delivery path like any other adapter — `/clear` and
 * other session-level commands work identically.
 *
 * Wire format: one JSON object per line.
 *
 *   Client → server:
 *     { "text": "user message" }                          # default — talk to cli/local
 *     { "text": "...", "to": {"channelType": "discord",
 *                             "platformId": "discord:@me:149...",
 *                             "threadId": null} }         # route to a specific mg
 *     { "text": "...", "to": {...}, "reply_to": {...} }   # + redirect replies
 *   Server → client:
 *     { "text": "agent reply" }
 *
 * The `to` and `reply_to` addressing is how admin transports (the bootstrap
 * script) inject messages targeting any wired channel. `reply_to` is a
 * router-layer concept — agents cannot set it; it is carried only on
 * inbound events from CLI clients that hold operator privilege (the socket
 * is chmod 0600, so "connected to this socket" ≈ "is the owner").
 *
 * Single-client chat semantics: one connected terminal at a time. A second
 * "chat" connection closes the first with a "superseded" notice. Admin
 * route-opcode connections (`to` set) are one-shot and do NOT evict an
 * active chat client.
 *
 * Delivery requires a connected terminal. A successful socket write returns a
 * synthetic receipt so the host can distinguish an actual write from a
 * disconnected or broken CLI client and retry the latter.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, DeliveryAddress, InboundEvent, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PLATFORM_ID = 'local';

export interface CliRoutedPayload {
  text: string;
  sender?: string;
  senderName?: string;
  senderId?: string;
  isMention?: boolean;
  isGroup?: boolean;
}

interface CliWritable {
  write(data: string): unknown;
}

/** Build the message portion of a CLI admin-transport route. */
export function buildCliRoutedMessage(payload: CliRoutedPayload): InboundEvent['message'] {
  const text = payload.text;
  return {
    id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    // A routed CLI message explicitly targets a channel. Preserve an
    // explicit override, otherwise treat a leading @token as an addressed
    // message so mention-engaged wirings can be exercised via CLI transport.
    isMention: payload.isMention ?? /^@\S+(?:\s|$)/.test(text.trim()),
    isGroup: payload.isGroup === true,
    content: JSON.stringify({
      text,
      sender: payload.sender ?? 'cli',
      ...(payload.senderName ? { senderName: payload.senderName } : {}),
      senderId: payload.senderId ?? `cli:${PLATFORM_ID}`,
    }),
  };
}

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;

  const adapter: ChannelAdapter = {
    name: 'cli',
    channelType: 'cli',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();

      // Stale socket cleanup: a previous run that crashed may have left the
      // file behind, and net.createServer refuses to bind to an existing path.
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          log.warn('Failed to unlink stale CLI socket (will try to bind anyway)', { sock, err });
        }
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          // Tighten perms so only the owner can connect. Unix socket files
          // obey filesystem perms — 0700 on the socket means other local
          // users can't send into this agent.
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
          }
          log.info('CLI channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.end();
        } catch {
          // swallow — teardown is best-effort
        }
        client = null;
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      // Remove the socket file so a relaunch doesn't trip over it.
      try {
        fs.unlinkSync(socketPath());
      } catch {
        // swallow
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      return writeCliDelivery(client, platformId, message);
    },
  };

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    // Defer the chat-slot swap until we see the first line — if it turns out
    // to be a routed (`to`-bearing) one-shot, we leave the existing chat
    // client in place. Only plain chat connections participate in supersede.
    let claimedChatSlot = false;

    const claimChatSlot = () => {
      if (claimedChatSlot) return;
      claimedChatSlot = true;
      if (client && client !== socket) {
        try {
          client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
          client.end();
        } catch {
          // swallow
        }
      }
      client = socket;
      log.info('CLI client connected');
    };

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, config, claimChatSlot);
      }
    });

    socket.on('close', () => {
      if (client === socket) client = null;
      if (claimedChatSlot) log.info('CLI client disconnected');
    });

    socket.on('error', (err) => {
      log.warn('CLI client socket error', { err });
    });
  }

  async function handleLine(line: string, config: ChannelSetup, claimChatSlot: () => void): Promise<void> {
    let payload: {
      text?: unknown;
      to?: unknown;
      reply_to?: unknown;
      sender?: unknown;
      senderName?: unknown;
      senderId?: unknown;
      isMention?: unknown;
      isGroup?: unknown;
    };
    try {
      payload = JSON.parse(line);
    } catch (err) {
      log.warn('CLI: ignoring non-JSON line from client', { line });
      return;
    }
    if (typeof payload.text !== 'string' || payload.text.length === 0) return;

    const to = parseAddress(payload.to);
    const replyTo = parseAddress(payload.reply_to);

    if (to) {
      // Routed message — admin transport. Build a full InboundEvent targeting
      // `to`'s channel/platform, and let `reply_to` (if any) redirect replies.
      // Does NOT claim the chat slot, so an active terminal chat isn't evicted.
      const event: InboundEvent = {
        channelType: to.channelType,
        platformId: to.platformId,
        threadId: to.threadId,
        message: buildCliRoutedMessage({
          text: payload.text,
          sender: typeof payload.sender === 'string' ? payload.sender : undefined,
          senderName: typeof payload.senderName === 'string' ? payload.senderName : undefined,
          senderId: typeof payload.senderId === 'string' ? payload.senderId : undefined,
          isMention: typeof payload.isMention === 'boolean' ? payload.isMention : undefined,
          isGroup: typeof payload.isGroup === 'boolean' ? payload.isGroup : undefined,
        }),
        replyTo: replyTo ?? undefined,
      };
      try {
        await config.onInboundEvent(event);
      } catch (err) {
        log.error('CLI: onInboundEvent threw', { err });
      }
      return;
    }

    // Plain chat — claim the slot (evicting any prior client) and route via
    // the standard onInbound path (adapter injects its own channelType).
    claimChatSlot();
    try {
      await config.onInbound(PLATFORM_ID, null, {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: payload.text,
          sender: 'cli',
          senderId: `cli:${PLATFORM_ID}`,
        },
      });
    } catch (err) {
      log.error('CLI: onInbound threw', { err });
    }
  }

  function parseAddress(raw: unknown): DeliveryAddress | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.channelType !== 'string' || typeof obj.platformId !== 'string') return null;
    const threadId =
      obj.threadId === null || obj.threadId === undefined
        ? null
        : typeof obj.threadId === 'string'
          ? obj.threadId
          : null;
    return {
      channelType: obj.channelType,
      platformId: obj.platformId,
      threadId,
    };
  }

  return adapter;
}

/** Write one CLI response and return the host-side receipt used by delivery. */
export function writeCliDelivery(client: CliWritable | null, platformId: string, message: OutboundMessage): string {
  if (platformId !== PLATFORM_ID) throw new Error(`CLI adapter cannot deliver to platform ${platformId}`);
  if (!client) throw new Error('CLI client is not connected');
  const text = extractText(message);
  if (text === null) throw new Error('CLI message has no displayable text');

  try {
    client.write(JSON.stringify({ text }) + '\n');
  } catch (err) {
    log.warn('Failed to write to CLI client', { err });
    throw err;
  }
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('cli', { factory: createAdapter });
