import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { DestinationEntry } from './destinations.js';
import type { ModelTiers } from './providers/types.js';

export interface ConsultIdentity {
  assistantName?: string;
  agentGroupId?: string;
  providerName: string;
  configuredModel?: string;
  effort?: string;
  modelTiers?: ModelTiers;
}

export interface ConsultEngineContext extends ConsultIdentity {
  destinations: DestinationEntry[];
}

export interface ConsultEngineResponse {
  text: string;
  file?: string;
  filename?: string;
}

export interface ConsultEngineOutgoing {
  destinationName: string | null;
  platformId: string | null;
  channelType: string;
  threadId: string | null;
  content: Record<string, unknown> & { text: string };
}

export interface ConsultCapture {
  rootId: string;
  nodeId: string;
  lens: string;
}

export interface ConsultEngineResult {
  action: 'pass' | 'handled' | 'rewrite';
  responses: ConsultEngineResponse[];
  outgoing: ConsultEngineOutgoing[];
  rootId?: string;
  rewrittenText?: string;
  rewrittenContent?: Record<string, unknown> & { text: string };
  capture?: ConsultCapture;
  rewriteRouting?: { platformId: string | null; channelType: string | null; threadId: string | null } | null;
}

export interface ConsultRuntimeInput {
  stateDir: string;
  now?: string;
  message: {
    id: string;
    kind: string;
    text: string;
    content: Record<string, unknown>;
    channelType: string | null;
    platformId: string | null;
    threadId: string | null;
  };
  context: ConsultEngineContext;
}

export function consultStateDir(): string {
  return process.env.NANOCLAW_CONSULT_STATE_DIR || '/workspace/consultations';
}

function consultScript(): string {
  const sourceTreeScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../skills/consult/scripts/consult.mjs',
  );
  const candidates = [
    process.env.NANOCLAW_CONSULT_SKILL_SCRIPT,
    '/app/skills/consult/scripts/consult.mjs',
    path.resolve(process.cwd(), 'container/skills/consult/scripts/consult.mjs'),
    sourceTreeScript,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('consult skill runtime is not mounted');
  return found;
}

export function invokeConsultEngine<T>(command: string, input: unknown): T {
  const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url');
  const child = spawnSync(process.execPath, [consultScript(), command, '--input', encoded], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || `consult runtime exited ${child.status}`).trim());
  }
  return JSON.parse(child.stdout) as T;
}

export function parseContent(content: string): Record<string, unknown> & { text?: string } {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { text: content };
  } catch {
    return { text: content };
  }
}

export function shouldRunConsult(text: string, content: Record<string, unknown>): boolean {
  if (/^\/consult(?:\s|$)/i.test(text.trim())) return true;
  const meta = content.consult;
  return Boolean(meta && typeof meta === 'object' && !Array.isArray(meta));
}
