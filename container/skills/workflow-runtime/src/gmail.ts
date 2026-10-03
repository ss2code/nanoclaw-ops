export interface GmailAddressedDraft {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  plainText: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface GmailApiRequest {
  method: 'POST';
  url: string;
  body: Record<string, unknown>;
}

export interface GmailApiPayload {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailApiPayload[];
}

export interface GmailApiMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailApiPayload;
}

export interface NormalizedGmailPayload {
  untrusted: true;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  messageId: string | null;
  threadId: string | null;
  date: string | null;
  text: string;
  headers: Record<string, string>;
  attachments: Array<{ filename: string; mimeType: string; size: number | null; id: string | null }>;
  links: string[];
}

export type NormalizedGmailInbound =
  | {
      kind: 'actionable';
      eventType: 'gmail_reply';
      source: 'gmail';
      externalId: string;
      payload: NormalizedGmailPayload;
    }
  | {
      kind: 'quarantine';
      reason: 'missing_gmail_identity' | 'uncorrelated_gmail' | 'unknown_sender';
      source: 'gmail';
      externalId: string | null;
      payload: Omit<NormalizedGmailPayload, 'text'> & { text: null };
    };

export interface InboundGmailPolicy {
  correlatedThreadIds?: Iterable<string>;
  correlatedMessageIds?: Iterable<string>;
  allowedSenders?: string[];
  allowedDomains?: string[];
  maxBodyChars?: number;
}

export interface WorkflowDraftSelection {
  draftId: string;
  reason: 'human_selected';
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function headerLine(name: string, value: string | null | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed ? [`${name}: ${trimmed.replace(/\r?\n/g, ' ')}`] : [];
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string | undefined): string {
  if (!value) return '';
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function normalizeAddressList(addresses: string[] | undefined, label: string): string[] {
  const normalized = (addresses ?? []).map((address) => requireNonEmpty(address, label));
  if (label === 'to' && normalized.length === 0) throw new Error('to must include at least one address');
  return normalized;
}

export function buildRfc2822Draft(input: GmailAddressedDraft): string {
  const to = normalizeAddressList(input.to, 'to');
  const cc = normalizeAddressList(input.cc, 'cc');
  const bcc = normalizeAddressList(input.bcc, 'bcc');
  const subject = requireNonEmpty(input.subject, 'subject');
  const body = requireNonEmpty(input.plainText, 'plainText');
  return [
    ...headerLine('To', to.join(', ')),
    ...headerLine('Cc', cc.join(', ')),
    ...headerLine('Bcc', bcc.join(', ')),
    ...headerLine('Subject', subject),
    ...headerLine('In-Reply-To', input.inReplyTo),
    ...headerLine('References', input.references),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}

export function buildGmailDraftCreateRequest(input: GmailAddressedDraft, userId = 'me'): GmailApiRequest {
  const message: Record<string, unknown> = {
    raw: base64Url(buildRfc2822Draft(input)),
  };
  if (input.threadId) message.threadId = input.threadId;
  return {
    method: 'POST',
    url: `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/drafts`,
    body: { message },
  };
}

export function buildGmailDraftSendRequest(input: { draftId: string }, userId = 'me'): GmailApiRequest {
  return {
    method: 'POST',
    url: `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}/drafts/send`,
    body: { id: requireNonEmpty(input.draftId, 'draftId') },
  };
}

export function refuseDirectGmailSend(): never {
  throw new Error('workflow Gmail sends must use an existing human-reviewed Gmail draft');
}

export function selectHumanReviewedGmailDraft(draftId: string): WorkflowDraftSelection {
  return { draftId: requireNonEmpty(draftId, 'draftId'), reason: 'human_selected' };
}

export class OneCliGmailConnector {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async createDraft(input: GmailAddressedDraft, userId = 'me'): Promise<unknown> {
    const request = buildGmailDraftCreateRequest(input, userId);
    return this.sendRequest(request);
  }

  async sendDraft(input: { draftId: string }, userId = 'me'): Promise<unknown> {
    const request = buildGmailDraftSendRequest(input, userId);
    return this.sendRequest(request);
  }

  async sendDirect(): Promise<never> {
    refuseDirectGmailSend();
  }

  private async sendRequest(request: GmailApiRequest): Promise<unknown> {
    const response = await this.fetchImpl(request.url, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body ? JSON.stringify((body as { error: unknown }).error) : text;
      throw new Error(`Gmail request failed (${response.status}): ${message}`);
    }
    return body;
  }
}

function headers(message: GmailApiMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of message.payload?.headers ?? []) {
    if (header.name) out[header.name.toLowerCase()] = header.value ?? '';
  }
  return out;
}

function splitAddresses(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function emailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

function collectText(payload: GmailApiPayload | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain') return decodeBase64Url(payload.body?.data);
  return (payload.parts ?? []).map((part) => collectText(part)).join('\n').trim();
}

function collectAttachments(payload: GmailApiPayload | undefined): NormalizedGmailPayload['attachments'] {
  if (!payload) return [];
  const own =
    payload.filename
      ? [
          {
            filename: payload.filename,
            mimeType: payload.mimeType ?? 'application/octet-stream',
            size: payload.body?.size ?? null,
            id: payload.body?.attachmentId ?? null,
          },
        ]
      : [];
  return [...own, ...(payload.parts ?? []).flatMap((part) => collectAttachments(part))];
}

function links(text: string): string[] {
  return Array.from(text.matchAll(/\bhttps?:\/\/[^\s<>"')]+/g), (match) => match[0]);
}

function contains(set: Iterable<string> | undefined, value: string | null | undefined): boolean {
  if (!value) return false;
  return new Set(set ?? []).has(value);
}

function knownSender(from: string, policy: InboundGmailPolicy): boolean {
  const address = emailAddress(from);
  const domain = address.includes('@') ? address.split('@').pop()! : '';
  return new Set(policy.allowedSenders ?? []).has(address) || new Set(policy.allowedDomains ?? []).has(domain);
}

export function normalizeInboundGmail(message: GmailApiMessage, policy: InboundGmailPolicy = {}): NormalizedGmailInbound {
  const h = headers(message);
  const threadId = message.threadId ?? null;
  const messageId = message.id ?? h['message-id'] ?? null;
  const externalId = threadId ?? messageId;
  const rawText = collectText(message.payload);
  const maxBodyChars = policy.maxBodyChars ?? 20_000;
  const payload: NormalizedGmailPayload = {
    untrusted: true,
    subject: h.subject ?? '',
    from: h.from ?? '',
    to: splitAddresses(h.to),
    cc: splitAddresses(h.cc),
    messageId,
    threadId,
    date: h.date ?? null,
    text: rawText.slice(0, maxBodyChars),
    headers: h,
    attachments: collectAttachments(message.payload),
    links: links(rawText),
  };
  const correlated =
    contains(policy.correlatedThreadIds, threadId) || contains(policy.correlatedMessageIds, messageId);
  if (externalId && (correlated || knownSender(payload.from, policy))) {
    return { kind: 'actionable', eventType: 'gmail_reply', source: 'gmail', externalId, payload };
  }
  const quarantinePayload = { ...payload, text: null };
  if (!externalId) return { kind: 'quarantine', reason: 'missing_gmail_identity', source: 'gmail', externalId: null, payload: quarantinePayload };
  return {
    kind: 'quarantine',
    reason: payload.from && !knownSender(payload.from, policy) ? 'unknown_sender' : 'uncorrelated_gmail',
    source: 'gmail',
    externalId,
    payload: quarantinePayload,
  };
}
