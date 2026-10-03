#!/usr/bin/env bun
// Trip-specific workflow payload/template helpers. Durable state lives in
// workflow-runtime; this script only renders app meaning.
import { Database } from 'bun:sqlite';

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
  const v = str(flags, key);
  if (!v) throw new Error(`--${key} is required`);
  return v;
}

function int(flags: Args['flags'], key: string, fallback: number): number {
  const raw = str(flags, key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${key} must be a non-negative integer`);
  return n;
}

function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item[0]?.toUpperCase() ?? ''}${item.slice(1)}`).join('\n');
}

function derivedMissing(flags: Args['flags']): string[] {
  const explicit = str(flags, 'missing');
  if (explicit) return csv(explicit);
  const dbPath = need(flags, 'db'); const source = need(flags, 'from');
  const match = source.match(/^(stays|legs):(\d+)$/);
  if (!match) throw new Error('--from must be stays:<id> or legs:<id>');
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query(`SELECT * FROM ${match[1]} WHERE id=$id`).get({ $id: Number(match[2]) }) as any;
    if (!row) throw new Error(`${match[1]} ${match[2]} not found`);
    const out: string[] = [];
    if (!row.ref) out.push('confirmation number');
    if (match[1] === 'stays' && !row.check_in) out.push('check-in time');
    if (match[1] === 'legs') { if (!row.depart) out.push('departure time'); if (!row.arrive) out.push('arrival time'); }
    if (!row.booking_url) out.push('booking link/receipt');
    if (!out.length) throw new Error('nothing to chase — all fields present');
    return out;
  } finally { db.close(); }
}

function vendorPayload(flags: Args['flags']) {
  return {
    tripId: need(flags, 'trip-id'),
    recipient: need(flags, 'recipient'),
    recipientLabel: str(flags, 'recipient-label') ?? need(flags, 'recipient'),
    missingInfo: derivedMissing(flags),
    replyDeadlineHours: int(flags, 'reply-deadline-hours', 48),
    maxReminders: int(flags, 'max-reminders', 2),
    gmailDestination: str(flags, 'gmail-destination') ?? 'gmail-vendors',
    notifyDestination: str(flags, 'notify-destination') ?? 'trip-whatsapp',
  };
}

function vendorDraft(flags: Args['flags']): { subject: string; plainText: string } {
  const tripName = str(flags, 'trip-name') ?? 'the trip';
  const recipientLabel = str(flags, 'recipient-label') ?? 'there';
  const missing = derivedMissing(flags);
  return {
    subject: `Booking confirmation details for ${tripName}`,
    plainText: [
      `Hello ${recipientLabel},`,
      '',
      `Could you please confirm the booking details for ${tripName}?`,
      '',
      'We are missing:',
      bullets(missing),
      '',
      'Please reply on this thread when convenient.',
      '',
      'Thank you,',
      `${tripName} coordinator`,
    ].join('\n'),
  };
}

function travelerPayload(flags: Args['flags']) {
  const fields = csv(str(flags, 'fields') ?? 'passport name,dietary preference,rooming constraints');
  return {
    tripId: need(flags, 'trip-id'),
    recipient: need(flags, 'recipient'),
    traveler: need(flags, 'traveler'),
    fields,
    gmailDestination: str(flags, 'gmail-destination') ?? 'gmail-travelers',
    notifyDestination: str(flags, 'notify-destination') ?? 'trip-whatsapp',
    stopOnReply: true,
    steps: [
      {
        id: 'initial_request',
        delayHours: 0,
        purpose: `Ask for ${fields.join(', ')}`,
      },
      {
        id: 'gentle_followup',
        delayHours: int(flags, 'followup-hours', 72),
        purpose: 'Ask only for fields still missing',
      },
      {
        id: 'final_reminder',
        delayHours: int(flags, 'final-hours', 144),
        purpose: 'Final reminder before organizer manual follow-up',
      },
    ],
  };
}

function travelerDraft(flags: Args['flags']): { subject: string; plainText: string } {
  const tripName = str(flags, 'trip-name') ?? 'the trip';
  const traveler = need(flags, 'traveler');
  const fields = csv(str(flags, 'fields') ?? 'passport name,dietary preference,rooming constraints');
  return {
    subject: `A few details for ${tripName} planning`,
    plainText: [
      `Hi ${traveler},`,
      '',
      'Could you send these when you get a chance?',
      '',
      fields.map((field, index) => `${index + 1}. ${field}`).join('\n'),
      '',
      'Reply on this thread. If something is not decided yet, just say that and we will track it.',
      '',
      'Thanks,',
      `${tripName} coordinator`,
    ].join('\n'),
  };
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [domain, command] = positional;
  if (domain === 'vendor' && command === 'payload') {
    console.log(JSON.stringify(vendorPayload(flags), null, 2));
    return;
  }
  if (domain === 'vendor' && command === 'draft') {
    console.log(JSON.stringify(vendorDraft(flags), null, 2));
    return;
  }
  if (domain === 'traveler' && command === 'sequence-payload') {
    console.log(JSON.stringify(travelerPayload(flags), null, 2));
    return;
  }
  if (domain === 'traveler' && command === 'draft') {
    console.log(JSON.stringify(travelerDraft(flags), null, 2));
    return;
  }
  throw new Error('usage: trip-workflows vendor payload|draft ... OR trip-workflows traveler sequence-payload|draft ...');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
