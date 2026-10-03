/**
 * File delivery via the outbox.
 *
 * The staged bytes and the messages_out file reference must stay in lockstep.
 * This helper owns that contract for model-driven send_file calls and
 * harness-generated provider file events.
 */
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from './db/messages-out.js';

function outboxBase(): string {
  return process.env.NANOCLAW_OUTBOX_DIR ?? '/workspace/outbox';
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface FileOutRouting {
  platform_id: string;
  channel_type: string;
  thread_id: string | null;
  in_reply_to?: string | null;
}

export interface EnqueueFileOut {
  srcPath: string;
  routing: FileOutRouting;
  text?: string;
  filename?: string;
}

export function enqueueFileOut(opts: EnqueueFileOut): { id: string; filename: string; seq: number } {
  const id = generateId();
  const filename = opts.filename ?? path.basename(opts.srcPath);
  const outboxDir = path.join(outboxBase(), id);

  fs.mkdirSync(outboxDir, { recursive: true });
  fs.copyFileSync(opts.srcPath, path.join(outboxDir, filename));

  const seq = writeMessageOut({
    id,
    in_reply_to: opts.routing.in_reply_to ?? null,
    kind: 'chat',
    platform_id: opts.routing.platform_id,
    channel_type: opts.routing.channel_type,
    thread_id: opts.routing.thread_id,
    content: JSON.stringify({ text: opts.text ?? '', files: [filename] }),
  });

  return { id, filename, seq };
}
