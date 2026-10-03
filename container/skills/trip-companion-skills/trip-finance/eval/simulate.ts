#!/usr/bin/env bun
// Gate 4 simulator (design §8 layer 2–4): replays the Goa 2026 trip as multiple
// distinct members through the REAL pipeline — CLI socket → router → container
// agent → trip-finance CLI → trip.db — and asserts DB state after each step.
//
// Injection: routed messages over data/cli.sock with per-persona sender ids.
// Assertion: the group workspace ledger (groups/trip-goa/trip.db) and the
// session's outbound.db (agent replies). Replies to a non-`local` CLI platform
// are not echoed on the socket, so the DBs are the source of truth here.
//
// Usage: bun simulate.ts [--steps N] [--from N] [--quiet-ms 4000]

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../../../..');
const SOCK = join(ROOT, 'data', 'cli.sock');
const CENTRAL = join(ROOT, 'data', 'v2.db');
const TRIP_DB = join(ROOT, 'groups', 'trip-goa', 'trip.db');
const AGENT_GROUP = 'ag-trip-goa';
// Each run uses its own messaging group (--run <name>) → its own session with
// fresh conversation history. Reusing a session after wiping trip.db makes the
// agent "remember" a ledger that no longer exists; never reset that way.
const RUN = (() => {
  const i = process.argv.indexOf('--run');
  return i >= 0 ? process.argv[i + 1] : 'trip-sim';
})();
const PLATFORM = RUN;

function ncl(...args: string[]): string {
  const proc = Bun.spawnSync(['pnpm', 'exec', 'tsx', 'src/cli/client.ts', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc.stdout.toString() + proc.stderr.toString();
}

/** Idempotently create the messaging group + wiring + destination for this run. */
function ensureRunWiring(): void {
  ncl('messaging-groups', 'create', '--channel-type', 'cli', '--platform-id', PLATFORM,
    '--name', `Goa sim ${PLATFORM}`, '--is-group', '1', '--unknown-sender-policy', 'strict');
  const central = new Database(CENTRAL, { readonly: true });
  const mg = central
    .query("SELECT id FROM messaging_groups WHERE channel_type = 'cli' AND platform_id = $p")
    .get({ $p: PLATFORM }) as { id: string } | null;
  central.close();
  if (!mg) throw new Error(`failed to create/find messaging group for ${PLATFORM}`);
  ncl('wirings', 'create', '--messaging-group-id', mg.id, '--agent-group-id', AGENT_GROUP,
    '--engage-mode', 'pattern', '--engage-pattern', '@trip', '--sender-scope', 'known',
    '--ignored-message-policy', 'drop', '--session-mode', 'shared');
  ncl('destinations', 'add', '--agent-group-id', AGENT_GROUP, '--local-name', PLATFORM,
    '--target-type', 'channel', '--target-id', mg.id);
}

const STEP_TIMEOUT_MS = 420_000; // Haiku in a cold container can take a while
const POLL_MS = 2_000;
const QUIESCE_MS = 14_000; // outbound stream must be quiet this long before the next step

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ── transport ──

function send(sender: string, senderId: string, text: string): Promise<void> {
  return new Promise((res, rej) => {
    const sock = net.connect(SOCK);
    sock.on('error', rej);
    sock.on('connect', () => {
      sock.write(
        JSON.stringify({
          text,
          sender,
          senderId,
          to: { channelType: 'cli', platformId: PLATFORM, threadId: null },
        }) + '\n',
      );
      sock.end();
      res();
    });
  });
}

// ── DB peeking (read-only; journal_mode=DELETE makes cross-process reads safe) ──

function tripDb(): Database | null {
  if (!existsSync(TRIP_DB)) return null;
  const db = new Database(TRIP_DB, { readonly: true });
  return db;
}

function one<T>(db: Database, sql: string, params: Record<string, unknown> = {}): T {
  return db.query(sql).get(params) as T;
}

function counts(): { expenses: number; voided: number; settlements: number; members: number; families: number } {
  const db = tripDb();
  if (!db) return { expenses: 0, voided: 0, settlements: 0, members: 0, families: 0 };
  try {
    return {
      // ALL expense events, voided included — step thresholds count "events
      // logged", and a later void must not shift every subsequent threshold.
      expenses: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM expenses').n,
      voided: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM expenses WHERE voided_at IS NOT NULL').n,
      settlements: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM settlements').n,
      members: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM members').n,
      families: one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM families').n,
    };
  } catch {
    return { expenses: 0, voided: 0, settlements: 0, members: 0, families: 0 };
  } finally {
    db.close();
  }
}

/** Net balance per member display_name per currency, computed from trip.db raw tables. */
function balancesByName(): Record<string, Record<string, number>> {
  const db = tripDb();
  if (!db) return {};
  try {
    const names = new Map(
      (db.query('SELECT id, display_name FROM members').all() as { id: number; display_name: string }[]).map(
        (m) => [m.id, m.display_name],
      ),
    );
    const out: Record<string, Record<string, number>> = {};
    const add = (cur: string, id: number, v: number) => {
      const name = names.get(id) ?? `#${id}`;
      out[cur] ??= {};
      out[cur][name] = (out[cur][name] ?? 0) + v;
    };
    for (const e of db
      .query('SELECT id, amount, currency, payer_member_id FROM expenses WHERE voided_at IS NULL')
      .all() as { id: number; amount: number; currency: string; payer_member_id: number }[]) {
      add(e.currency, e.payer_member_id, e.amount);
      for (const s of db
        .query('SELECT member_id, share_amount FROM expense_shares WHERE expense_id = $id')
        .all({ $id: e.id }) as { member_id: number; share_amount: number }[]) {
        add(e.currency, s.member_id, -s.share_amount);
      }
    }
    for (const s of db.query('SELECT from_member, to_member, amount, currency FROM settlements').all() as {
      from_member: number; to_member: number; amount: number; currency: string;
    }[]) {
      add(s.currency, s.from_member, s.amount);
      add(s.currency, s.to_member, -s.amount);
    }
    return out;
  } finally {
    db.close();
  }
}

// ── outbound.db reply peeking ──

function sessionDir(): string | null {
  const db = new Database(CENTRAL, { readonly: true });
  try {
    const row = db
      .query(
        `SELECT s.id FROM sessions s
         JOIN messaging_groups mg ON mg.id = s.messaging_group_id
         WHERE s.agent_group_id = $ag AND mg.platform_id = $p
         ORDER BY s.created_at DESC LIMIT 1`,
      )
      .get({ $ag: AGENT_GROUP, $p: PLATFORM }) as { id: string } | null;
    if (!row) return null;
    const dir = join(ROOT, 'data', 'v2-sessions', AGENT_GROUP, row.id);
    return existsSync(dir) ? dir : null;
  } finally {
    db.close();
  }
}

function lastReplies(afterSeq: number): { seq: number; text: string }[] {
  const dir = sessionDir();
  if (!dir || !existsSync(join(dir, 'outbound.db'))) return [];
  const db = new Database(join(dir, 'outbound.db'), { readonly: true });
  try {
    return (
      db
        .query('SELECT seq, content FROM messages_out WHERE seq > $s ORDER BY seq')
        .all({ $s: afterSeq }) as { seq: number; content: string }[]
    ).map((r) => {
      try {
        const c = JSON.parse(r.content);
        return { seq: r.seq, text: typeof c.text === 'string' ? c.text : r.content };
      } catch {
        return { seq: r.seq, text: r.content };
      }
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function maxSeq(): number {
  const r = lastReplies(-1);
  return r.length ? r[r.length - 1].seq : 0;
}

// ── step engine ──

type Persona = [name: string, id: string];
const P: Record<string, Persona> = {
  arjun: ['Arjun', 'cli:arjun'], diya: ['Diya', 'cli:diya'], raj: ['Raj', 'cli:raj'],
  meera: ['Meera', 'cli:meera'], vik: ['Vik', 'cli:vik'], lakshmi: ['Lakshmi', 'cli:lakshmi'],
  dev: ['Dev', 'cli:dev'], tara: ['Tara', 'cli:tara'],
};

interface Step {
  label: string;
  persona: Persona;
  text: string;
  /** Wait until this predicate over trip.db counts holds (the DB effect of the step). */
  until?: (c: ReturnType<typeof counts>) => boolean;
  /** Steps that must NOT wake the agent / change anything (small-talk). */
  expectNoEffect?: boolean;
  /** Extra assertion run once `until` holds. Receives the agent's reply texts
   *  for this step so rendered reports can be asserted, not just DB state. */
  check?: (replies: string[]) => void;
  /** Confirm-loop: if a reply arrives but `until` hasn't held yet, answer this. */
  confirmWith?: string;
}

const failures: string[] = [];
let transcript: string[] = [];

/** Wait until the agent has gone quiet (no new outbound rows for QUIESCE_MS). */
async function quiesce(): Promise<void> {
  let last = maxSeq();
  let quietSince = Date.now();
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    const now = maxSeq();
    if (now !== last) {
      for (const r of lastReplies(last)) transcript.push(`<< ${r.text}`);
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= QUIESCE_MS) {
      return;
    }
  }
}

async function runStep(i: number, step: Step): Promise<void> {
  // Steps must not bleed into each other: the agent batches queued messages
  // and can reply late, so wait for silence before attributing anything.
  await quiesce();
  const before = counts();
  const seq0 = maxSeq();
  await send(step.persona[0], step.persona[1], step.text);
  transcript.push(`>> [${step.persona[0]}] ${step.text}`);

  if (step.expectNoEffect) {
    await Bun.sleep(25_000);
    const after = counts();
    const replies = lastReplies(seq0);
    if (JSON.stringify(after) !== JSON.stringify(before) || replies.length > 0) {
      failures.push(`${step.label}: expected silence, got effect/replies: ${replies.map((r) => r.text).join(' | ').slice(0, 200)}`);
      console.log(`  ✗ ${step.label} (should have been ignored)`);
    } else {
      console.log(`  ✓ ${step.label} (correctly ignored)`);
    }
    return;
  }

  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let confirmed = 0;
  let lastSeq = seq0;
  while (Date.now() < deadline) {
    const c = counts();
    if (!step.until || step.until(c)) {
      const replies = lastReplies(seq0);
      for (const r of replies) transcript.push(`<< ${r.text}`);
      try {
        step.check?.(replies.map((r) => r.text));
        console.log(`  ✓ ${step.label}`);
      } catch (err) {
        failures.push(`${step.label}: ${err}`);
        console.log(`  ✗ ${step.label}: ${err}`);
      }
      return;
    }
    // confirm-before-commit loop: if the agent replied (likely a playback
    // asking for confirmation) and the DB effect hasn't landed, say yes once.
    const replies = lastReplies(lastSeq);
    if (replies.length > 0) {
      for (const r of replies) transcript.push(`<< ${r.text}`);
      lastSeq = replies[replies.length - 1].seq;
      if (step.confirmWith && confirmed < 2) {
        confirmed++;
        await Bun.sleep(1_500);
        await send(step.persona[0], step.persona[1], step.confirmWith);
        transcript.push(`>> [${step.persona[0]}] ${step.confirmWith}`);
      }
    }
    await Bun.sleep(POLL_MS);
  }
  failures.push(`${step.label}: TIMEOUT waiting for DB effect`);
  console.log(`  ✗ ${step.label}: TIMEOUT`);
}

// ── assertions ──

/** Number of non-voided expenses with this exact minor amount. */
function countExpenseAmount(amountMinor: number, currency = 'INR'): number {
  const db = tripDb();
  if (!db) return 0;
  try {
    const row = db
      .query(
        'SELECT COUNT(*) AS n FROM expenses WHERE voided_at IS NULL AND amount = $a AND currency = $c',
      )
      .get({ $a: amountMinor, $c: currency }) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}
const hasExpenseAmount = (amountMinor: number, currency = 'INR') => countExpenseAmount(amountMinor, currency) > 0;

/** Assert the agent's rendered reply contains each expected figure (digits, en-IN grouping tolerated). */
function assertReplyHasFigures(replies: string[], figures: string[], label: string): void {
  const blob = replies.join('\n').replace(/[,\s]/g, '');
  const missing = figures.filter((f) => !blob.includes(f.replace(/[,\s]/g, '')));
  if (missing.length) {
    throw new Error(`${label}: rendered reply missing figures ${missing.join(', ')} — got: ${replies.join(' | ').slice(0, 300)}`);
  }
}

function assertBalance(cur: string, golden: Record<string, number>): void {
  const all = balancesByName();
  const got = all[cur] ?? {};
  const errs: string[] = [];
  for (const [name, want] of Object.entries(golden)) {
    if ((got[name] ?? 0) !== want) errs.push(`${name}: got ${got[name] ?? 0}, want ${want}`);
  }
  if (errs.length) throw new Error(`${cur} balance mismatch — ${errs.join('; ')}`);
}

// ── scenario (smoke slice: roster + day 1–2 of Goa 2026 + checkpoint) ──

// Day-2 golden from the unit fixture, keyed by name (paise).
const DAY2_INR: Record<string, number> = {
  Arjun: 4_070_000, Diya: -150_000, Kabir: -550_000, Mira: -550_000, Raj: -60_834,
  Meera: -540_833, Rohan: -580_833, Vik: -122_500, Lakshmi: -722_500, Dev: -792_500,
};

const STEPS: Step[] = [
  {
    label: 'setup: init trip + roster',
    persona: P.arjun,
    text:
      '@trip set up the trip. Trip name "Goa 2026", base currency INR, 20–27 Dec 2026, default split equal-all. ' +
      'Roster — Kapoor family: Arjun, Diya, and kids Kabir and Mira. Mehta family: Raj, Meera, and kid Rohan. ' +
      'Iyer family: Vik and Lakshmi. Standalone: Dev. Bhola is our driver — add him but exclude him from all splits. ' +
      'Everyone joined 20 Dec. Add them exactly in the order I listed. This is all confirmed, go ahead and create it.',
    // Day-1 roster is 11 (Tara joins day 3): Kapoor 4 + Mehta 3 + Iyer 2 + Dev + excluded driver.
    until: (c) => c.members >= 11 && c.families >= 3,
    confirmWith: '@trip yes, confirmed — create exactly that.',
    check: () => {
      const db = tripDb()!;
      try {
        const excluded = db.query("SELECT excluded_from_splits FROM members WHERE display_name = 'Bhola'").get() as
          | { excluded_from_splits: number }
          | null;
        if (!excluded || excluded.excluded_from_splits !== 1) throw new Error('Bhola not excluded from splits');
      } finally {
        db.close();
      }
    },
  },
  {
    label: 'E1 hotel 40000 equal-all (Arjun)',
    persona: P.arjun,
    text: '@trip I paid 40000 for the hotel advance, split equally among everyone.',
    until: (c) => c.expenses >= 1,
    confirmWith: '@trip yes, correct.',
  },
  {
    label: 'E2 lunch 4800 by-family (Diya)',
    persona: P.diya,
    text: '@trip I paid 4800 for lunch, split it by families.',
    until: (c) => c.expenses >= 2,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E3 taxi 2000 equal-all, payer ≠ sender (Meera logs, Raj paid)',
    persona: P.meera,
    text: '@trip Raj paid 2000 for the taxi, split equally among everyone.',
    until: (c) => c.expenses >= 3,
    confirmWith: '@trip yes, Raj paid it.',
    check: () => {
      const db = tripDb()!;
      try {
        const row = db
          .query(
            `SELECT m.display_name AS payer FROM expenses e JOIN members m ON m.id = e.payer_member_id
             WHERE e.voided_at IS NULL ORDER BY e.id DESC LIMIT 1`,
          )
          .get() as { payer: string };
        if (row.payer !== 'Raj') throw new Error(`payer recorded as ${row.payer}, want Raj (sender was Meera)`);
      } finally {
        db.close();
      }
    },
  },
  {
    label: 'small-talk must not wake (Vik)',
    persona: P.vik,
    text: 'the beach was amazing today, see everyone at the shack at 7',
    expectNoEffect: true,
  },
  {
    label: 'E4 snacks 550 equal-all (Dev)',
    persona: P.dev,
    text: '@trip I paid 550 for snacks, split equally among everyone.',
    until: (c) => c.expenses >= 4,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E5 dinner 6000 by-family (Vik)',
    persona: P.vik,
    text: '@trip I paid 6000 for the beach shack dinner, split by families.',
    until: (c) => c.expenses >= 5,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E6 water sports 7000 adults only (Arjun)',
    persona: P.arjun,
    text: '@trip I paid 7000 for water sports — split equally but exclude the kids (Kabir, Mira, Rohan).',
    until: (c) => c.expenses >= 6,
    confirmWith: '@trip yes, exactly.',
  },
  {
    label: 'E7 groceries 1200 equal-all (Meera)',
    persona: P.meera,
    text: '@trip I paid 1200 for groceries, split equally among everyone.',
    until: (c) => c.expenses >= 7,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E8 ice cream 600 kids only, payer not in split (Dev)',
    persona: P.dev,
    text: '@trip I bought the kids ice cream for 600 — split it only between Kabir, Mira and Rohan, 200 each. My treat for them, I am not in it.',
    until: (c) => c.expenses >= 8,
    confirmWith: '@trip yes, kids only.',
  },
  {
    label: 'E9 fuel 4000 by-family (Raj)',
    persona: P.raj,
    text: '@trip I paid 4000 for fuel, split by families.',
    until: (c) => c.expenses >= 9,
    confirmWith: '@trip yes.',
  },
  {
    label: 'CHECKPOINT day-2 golden balances',
    persona: P.arjun,
    text: '@trip balance please',
    until: () => true,
    check: (replies) => {
      assertBalance('INR', DAY2_INR);
      // The chat-rendered report must carry the script's numbers (retrieval test).
      assertReplyHasFigures(replies, ['40,700', '7,925'], 'day-2 rendered balance');
    },
  },

  // ── Day 3 (22 Dec): Tara joins; USD enters; first repayment ──
  {
    label: 'config: Tara joins day 3',
    persona: P.arjun,
    text: '@trip Tara is joining the trip today, 22 Dec, as a standalone traveller (not part of any family). Add her from today — past expenses stay as they are. Confirmed, go ahead.',
    until: (c) => c.members >= 12,
    confirmWith: '@trip yes, add her.',
  },
  {
    label: 'E10 breakfast 1100 equal-all incl Tara (Tara)',
    persona: P.tara,
    text: '@trip I paid 1100 for breakfast, split equally among everyone (I am in it too now).',
    until: (c) => c.expenses >= 10,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E11 museum 2200 adults only (Diya)',
    persona: P.diya,
    text: '@trip I paid 2200 for the museum, split equally among the adults — exclude the kids.',
    until: (c) => c.expenses >= 11,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E12 parasailing $200 USD equal-all (Dev)',
    persona: P.dev,
    text: '@trip I paid 200 US dollars for parasailing, split equally among everyone. Keep it in USD, do not convert.',
    until: (c) => c.expenses >= 12,
    confirmWith: '@trip yes, in USD.',
  },
  {
    label: 'E13 dinner 5500 by-family (Vik)',
    persona: P.vik,
    text: '@trip I paid 5500 for dinner, split by families.',
    until: (c) => c.expenses >= 13,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E14 settlement Diya→Arjun 1500',
    persona: P.diya,
    text: '@trip I just sent Arjun 1500, record the repayment.',
    until: (c) => c.settlements >= 1,
    confirmWith: '@trip yes.',
  },

  // ── Day 4 (23 Dec) ──
  {
    label: 'E15 scuba 9900 family ratio 5:3:2 (Arjun)',
    persona: P.arjun,
    text: '@trip I paid 9900 for scuba. Split it between the three families only, in the ratio Kapoor 5 : Mehta 3 : Iyer 2. Dev and Tara are not part of this one.',
    until: (c) => c.expenses >= 14,
    confirmWith: '@trip yes, exactly that ratio.',
  },
  {
    label: 'E16 lunch 3300 equal-all (Raj)',
    persona: P.raj,
    text: '@trip I paid 3300 for lunch, split equally among everyone.',
    until: (c) => c.expenses >= 15,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E17 kids rides 900 explicit, Tara treat (Tara)',
    persona: P.tara,
    text: "@trip I paid 900 for the kids' rides — my treat for the kids only: Kabir 300, Mira 300, Rohan 300. I'm not in the split.",
    until: (c) => c.expenses >= 16,
    confirmWith: '@trip yes, kids only.',
  },
  {
    label: 'E18 fuel 2000 by-family (Dev)',
    persona: P.dev,
    text: '@trip I paid 2000 for fuel, split by families.',
    until: (c) => c.expenses >= 17,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E19 dinner $330 USD adults only (Vik)',
    persona: P.vik,
    text: '@trip I paid 330 US dollars for dinner — split equally among the adults, exclude the kids. Keep it in USD.',
    until: (c) => c.expenses >= 18,
    confirmWith: '@trip yes.',
  },

  // ── Day 5 (24 Dec) ──
  {
    label: 'E20 boat trip 8800 equal-all (Meera)',
    persona: P.meera,
    text: '@trip I paid 8800 for the boat trip, split equally among everyone.',
    until: (c) => c.expenses >= 19,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E21 groceries 1210 equal-all (Diya)',
    persona: P.diya,
    text: '@trip I paid 1210 for groceries, split equally among everyone.',
    until: (c) => c.expenses >= 20,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E22 settlement Dev→Arjun 5000',
    persona: P.dev,
    text: '@trip I transferred 5000 to Arjun against what I owe. Record it.',
    until: (c) => c.settlements >= 2,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E23 cafe 280 adults only (Tara)',
    persona: P.tara,
    text: '@trip I paid 280 at the cafe — adults only, exclude the kids.',
    until: (c) => c.expenses >= 21,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E24 souvenirs 450 explicit Dev+Tara (Lakshmi)',
    persona: P.lakshmi,
    text: "@trip I paid 450 for souvenirs for Dev and Tara — split it 225 each between just the two of them, I'm not in it.",
    until: (c) => c.expenses >= 22,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E25 dinner 3600 adults only (Raj) — edited later',
    persona: P.raj,
    text: '@trip I paid 3600 for dinner tonight, adults only — exclude the kids.',
    until: (c) => c.expenses >= 23,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E26 taxi 1500 equal-all duplicate (Vik) — voided later',
    persona: P.vik,
    text: '@trip I paid 1500 for the taxi, split equally among everyone.',
    until: (c) => c.expenses >= 24,
    confirmWith: '@trip yes.',
  },
  {
    label: 'CHECKPOINT day-5 golden balances (INR + USD)',
    persona: P.arjun,
    text: '@trip balance please',
    until: () => true,
    check: (replies) => {
      assertBalance('INR', DAY5_INR);
      assertBalance('USD', DAY5_USD);
      // Arjun's INR credit and Vik's USD credit as rendered figures.
      assertReplyHasFigures(replies, ['40,281.14', '270.57'], 'day-5 rendered balance');
    },
  },

  // ── Day 6 (25 Dec): edit + void + more ──
  {
    label: 'EDIT E25: dinner 3600 → 4000 (Diya)',
    persona: P.diya,
    text: "@trip fix Raj's 3600 dinner from last night — the actual bill was 4000, same split (adults only, exclude kids), Raj still the payer. Look it up with the expenses list if you need the id.",
    // E9 fuel is already a ₹4,000 expense, so require a SECOND 400000 row and the 360000 gone.
    until: () => countExpenseAmount(400_000) >= 2 && !hasExpenseAmount(360_000),
    confirmWith: '@trip yes, change it to 4000.',
  },
  {
    label: 'VOID E26: duplicate taxi (Vik)',
    persona: P.vik,
    text: '@trip the 1500 taxi I logged yesterday was a duplicate — please delete it.',
    until: (c) => c.voided >= 1,
    confirmWith: '@trip yes, delete it.',
  },
  {
    label: 'E27 brunch 6600 equal-all (Arjun)',
    persona: P.arjun,
    text: '@trip I paid 6600 for Christmas brunch, split equally among everyone.',
    until: (c) => c.expenses >= 25,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E28 snacks 1000 equal-all (Tara)',
    persona: P.tara,
    text: '@trip I paid 1000 for snacks, split equally among everyone.',
    until: (c) => c.expenses >= 26,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E29 cab 2500 by-family (Raj)',
    persona: P.raj,
    text: '@trip I paid 2500 for the cab, split by families.',
    until: (c) => c.expenses >= 27,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E30 golf $150 USD explicit three players (Arjun)',
    persona: P.arjun,
    text: '@trip I paid 150 US dollars for golf — split between just me, Vik and Dev, 50 dollars each. Keep it in USD.',
    until: (c) => c.expenses >= 28,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E31 spa 5000 member ratio 1:1:2:1 (Lakshmi)',
    persona: P.lakshmi,
    text: '@trip I paid 5000 for the spa. Split it between Diya, Meera, me and Tara in the ratio 1 : 1 : 2 : 1 (my share is the 2). No one else is in it.',
    until: (c) => c.expenses >= 29,
    confirmWith: '@trip yes, exactly.',
  },
  {
    label: 'E32 settlement Meera→Vik 1000',
    persona: P.meera,
    text: '@trip I paid Vik back 1000, record the settlement.',
    until: (c) => c.settlements >= 3,
    confirmWith: '@trip yes.',
  },

  // ── Day 7 (26 Dec) ──
  {
    label: 'E33 fancy dinner 7700 equal-all (Vik)',
    persona: P.vik,
    text: '@trip I paid 7700 for the fancy dinner, split equally among everyone.',
    until: (c) => c.expenses >= 30,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E34 drinks 1200 named subset (Dev)',
    persona: P.dev,
    text: '@trip I paid 1200 for drinks — split equally between just me, Arjun, Raj, Vik, Lakshmi and Tara. Nobody else.',
    until: (c) => c.expenses >= 31,
    confirmWith: '@trip yes, just the six of us.',
  },
  {
    label: 'E35 arcade 900 kids explicit (Diya)',
    persona: P.diya,
    text: '@trip I paid 900 for the kids at the arcade — Kabir 300, Mira 300, Rohan 300, just the kids.',
    until: (c) => c.expenses >= 32,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E36 beach club 4400 by-family (Tara)',
    persona: P.tara,
    text: '@trip I paid 4400 for the beach club, split by families.',
    until: (c) => c.expenses >= 33,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E37 coffee $99 USD equal-all (Dev)',
    persona: P.dev,
    text: '@trip I paid 99 US dollars for the coffee run, split equally among everyone. Keep it in USD.',
    until: (c) => c.expenses >= 34,
    confirmWith: '@trip yes.',
  },

  // ── Day 8 (27 Dec) ──
  {
    label: 'E38 checkout brunch 3300 equal-all (Raj)',
    persona: P.raj,
    text: '@trip I paid 3300 for the checkout brunch, split equally among everyone.',
    until: (c) => c.expenses >= 35,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E39 driver tip 2000 equal-all (Arjun)',
    persona: P.arjun,
    text: '@trip I paid 2000 as the tip for Bhola — split it equally among all of us travellers (Bhola is not in the split, obviously).',
    until: (c) => c.expenses >= 36,
    confirmWith: '@trip yes.',
  },
  {
    label: 'E40 settlement Lakshmi→Vik 6000',
    persona: P.lakshmi,
    text: '@trip I sent Vik 6000 to square us up, record it.',
    until: (c) => c.settlements >= 4,
    confirmWith: '@trip yes.',
  },
  {
    label: 'CHECKPOINT trip-end golden balances (INR + USD)',
    persona: P.arjun,
    text: '@trip final balance and settle-up plan please',
    until: () => true,
    check: (replies) => {
      assertBalance('INR', END_INR);
      assertBalance('USD', END_USD);
      // Arjun's final INR credit + his USD credit, as rendered.
      assertReplyHasFigures(replies, ['46,549.70', '31.57'], 'trip-end rendered balance');
    },
  },
];

// Hand-computed goldens (same derivation as the unit fixture), keyed by name.
const DAY5_INR: Record<string, number> = {
  Arjun: 4_028_114, Diya: -40_886, Kabir: -885_886, Mira: -885_886, Raj: 259_529,
  Meera: -30_469, Rohan: -904_468, Vik: 182_860, Lakshmi: -1_072_136, Dev: -485_636, Tara: -165_136,
};
const DAY5_USD: Record<string, number> = {
  Arjun: -5_943, Diya: -5_943, Kabir: -1_818, Mira: -1_818, Raj: -5_943, Meera: -5_943,
  Rohan: -1_818, Vik: 27_057, Lakshmi: -5_943, Dev: 14_055, Tara: -5_943,
};
const END_INR: Record<string, number> = {
  Arjun: 4_654_970, Diya: -264_021, Kabir: -1_124_021, Mira: -1_124_021, Raj: 634_892,
  Meera: -255_103, Rohan: -1_154_102, Vik: -164_771, Lakshmi: -439_771, Dev: -702_271, Tara: -61_781,
};
const END_USD: Record<string, number> = {
  Arjun: 3_157, Diya: -6_843, Kabir: -2_718, Mira: -2_718, Raj: -6_843, Meera: -6_843,
  Rohan: -2_718, Vik: 21_157, Lakshmi: -6_843, Dev: 18_055, Tara: -6_843,
};

async function main(): Promise<void> {
  if (!existsSync(SOCK)) {
    console.error(`socket not found at ${SOCK} — is the NanoClaw service running?`);
    process.exit(2);
  }
  ensureRunWiring();
  if (process.argv.includes('--fresh')) {
    const { unlinkSync } = await import('node:fs');
    try {
      unlinkSync(TRIP_DB);
    } catch {}
    ncl('groups', 'restart', '--id', AGENT_GROUP);
    console.log('fresh run: ledger wiped, containers restarted, new session via', PLATFORM);
  }
  const from = Number(arg('from', '0'));
  const limit = Number(arg('steps', String(STEPS.length)));
  const steps = STEPS.slice(from, from + limit);
  console.log(`Goa 2026 simulator — ${steps.length} steps via real pipeline (cli.sock → container → trip.db)\n`);

  for (let i = 0; i < steps.length; i++) {
    console.log(`[${i + 1}/${steps.length}] ${steps[i].label}`);
    await runStep(i, steps[i]);
  }

  console.log('\n── transcript ──');
  for (const line of transcript) console.log(line.length > 300 ? line.slice(0, 300) + '…' : line);

  console.log(`\n── Gate 4 result: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} ──`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
