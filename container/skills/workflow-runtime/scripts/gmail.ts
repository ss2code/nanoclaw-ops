#!/usr/bin/env bun
// Gmail connector CLI for workflow-runtime.
//
// Network calls use ordinary HTTPS fetch so OneCLI can inject credentials at
// the proxy boundary. No OAuth token or API key is accepted by this script.

import { readFileSync } from 'node:fs';

import {
  OneCliGmailConnector,
  buildGmailDraftCreateRequest,
  buildGmailDraftSendRequest,
  type GmailAddressedDraft,
} from '../src/gmail';

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function need(flags: Args['flags'], key: string): string {
  const value = str(flags, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readText(flags: Args['flags'], key: string, fileKey = `${key}-file`): string {
  const file = str(flags, fileKey);
  if (file) return readFileSync(file, 'utf8');
  return need(flags, key);
}

function draftInput(flags: Args['flags']): GmailAddressedDraft {
  return {
    to: csv(need(flags, 'to')),
    cc: csv(str(flags, 'cc')),
    bcc: csv(str(flags, 'bcc')),
    subject: need(flags, 'subject'),
    plainText: readText(flags, 'body'),
    threadId: str(flags, 'thread-id') ?? null,
    inReplyTo: str(flags, 'in-reply-to') ?? null,
    references: str(flags, 'references') ?? null,
  };
}

function help(): string {
  return [
    'workflow-runtime Gmail commands:',
    '  draft-request --to a,b [--cc c] --subject <s> --body <text|--body-file file> [--thread-id id]',
    '  send-request --draft-id <gmail-draft-id>',
    '  create-draft --to a,b [--cc c] --subject <s> --body <text|--body-file file> [--thread-id id]',
    '  send-draft --draft-id <gmail-draft-id>',
    '',
    'create-draft and send-draft call Gmail over ordinary HTTPS for OneCLI proxy injection.',
    'send-draft must only be used after an explicit human-selected draft command.',
  ].join('\n');
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command] = positional;
  const userId = str(flags, 'user-id') ?? 'me';
  if (!command || command === 'help') {
    console.log(help());
    return;
  }
  if (command === 'draft-request') {
    console.log(JSON.stringify(buildGmailDraftCreateRequest(draftInput(flags), userId), null, 2));
    return;
  }
  if (command === 'send-request') {
    console.log(JSON.stringify(buildGmailDraftSendRequest({ draftId: need(flags, 'draft-id') }, userId), null, 2));
    return;
  }
  const connector = new OneCliGmailConnector();
  if (command === 'create-draft') {
    console.log(JSON.stringify(await connector.createDraft(draftInput(flags), userId), null, 2));
    return;
  }
  if (command === 'send-draft') {
    console.log(JSON.stringify(await connector.sendDraft({ draftId: need(flags, 'draft-id') }, userId), null, 2));
    return;
  }
  throw new Error(`unknown command "${command}"`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
