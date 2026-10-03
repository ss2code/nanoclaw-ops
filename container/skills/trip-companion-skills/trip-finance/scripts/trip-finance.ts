#!/usr/bin/env bun
// trip-finance — deterministic finance core CLI for the Trip Companion skill.
// The LLM parses language/images into these commands; this script owns every number.
//
// Usage: bun trip-finance.ts --db <path> <command> [options]
// Run with `help` for the command list.

import { allMembers, appendJournal, openDb } from './db';
import { formatMinor, toMinor } from './money';
import { editExpense, getExpense, getItems, getShares, logExpense, logSettlement, resetLedger, voidExpense, type ItemisedInput } from './ledger';
import { assertZeroSum, computeBalances, consolidate } from './balances';
import { settlementPlan } from './settle';
import { nudgeStatus, recordNudge } from './nudge';
import { addFamily, addMember, setTrip, updateMember } from './config';
import type { CustomSpec, SplitRule } from './split';
import { budgetBurn } from './burn';

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
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
  if (v === undefined) throw new Error(`--${key} is required`);
  return v;
}

function intFlag(flags: Args['flags'], key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`--${key} must be an integer, got "${v}"`);
  return n;
}

function itemised(flags: Args['flags'], currency: string, db: ReturnType<typeof openDb>, at: string): ItemisedInput[] | undefined {
  const raw = str(flags, 'items');
  if (raw === undefined) return undefined;
  if (str(flags, 'rule') !== undefined || str(flags, 'custom') !== undefined) throw new Error('--items cannot be combined with --rule or --custom');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('--items must be a non-empty JSON array');
  const all = new Set((db.query('SELECT id FROM members WHERE joined_at <= $at AND (left_at IS NULL OR left_at > $at)').all({ $at: at }) as { id: number }[]).map((m) => m.id));
  const participants = (db.query('SELECT id FROM members WHERE joined_at <= $at AND (left_at IS NULL OR left_at > $at) AND excluded_from_splits=0').all({ $at: at }) as { id: number }[]).map((m) => m.id);
  return parsed.map((item: any) => {
    if (!item || typeof item.label !== 'string' || item.label.trim() === '') throw new Error('each item needs a non-empty label');
    const ids = item.members === 'all' ? participants : item.members;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !Number.isSafeInteger(id) || !all.has(id))) throw new Error('every item member must be an active member on the expense date');
    return { label: item.label, amountMinor: toMinor(String(item.amount), currency), memberIds: ids };
  });
}

const HELP = `trip-finance — deterministic trip ledger

Global:  --db <path>     SQLite file (default ./trip.db)   --json   machine output
         --at <iso>      override timestamp (default: now)

Config   init            --name <trip> [--base-currency INR] [--start d] [--end d] [--default-split rule]
         add-family      --name <name>
         add-member      --name <name> [--family <id>] [--aliases a,b] [--joined date] [--excluded] [--platform id]
         set-member <id> [--left date] [--excluded true|false] [--family id] [--aliases a,b] [--platform id]
         members | families

Ledger   log             --desc <text> --amount <major> --currency <CUR> --payer <id>
                         [--rule equal-all|by-family|custom] [--custom '<json spec>']
                         [--items '<json array>'] [--by <memberId>] [--source text|upi-image|bill-image]
         edit <id>       [--desc] [--amount] [--currency] [--payer] [--rule] [--custom] --actor <id>
         void <id>       --actor <id>
         settlement      --from <id> --to <id> --amount <major> --currency <CUR> [--by <id>]
         reset           --actor <id> --confirm

Reports  balance         [--consolidate 'USD=84,...' ]   per-currency nets (script math, no LLM)
         settle          [--currency CUR] [--links]      minimal transfer plan (+ UPI links)
         burn            [--at ISO] [--json]             deterministic spend/budget pace
         nudge record [--at ISO] | nudge status           settlement reminder state
         status          trip summary
         journal         [--limit n]
         expense <id>    one expense with shares

Custom split spec (JSON): {"kind":"exclude","memberIds":[3,4]} |
  {"kind":"explicit","shares":{"3":2000}} | {"kind":"ratio-by-unit","weights":{"f1":60,"f2":40}} |
  {"kind":"ratio-by-member","weights":{"2":1,"6":1}}
`;

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  if (!command || command === 'help') {
    console.log(HELP);
    return;
  }
  const dbPath = str(flags, 'db') ?? './trip.db';
  const at = str(flags, 'at') ?? new Date().toISOString();
  const json = flags.json === true;
  const db = openDb(dbPath);
  const memberName = (id: number | null): string => {
    if (id == null) return '—';
    const m = allMembers(db).find((x) => x.id === id);
    return m ? m.display_name : `member#${id}`;
  };

  switch (command) {
    case 'init': {
      setTrip(
        db,
        {
          name: need(flags, 'name'),
          baseCurrency: str(flags, 'base-currency'),
          startDate: str(flags, 'start'),
          endDate: str(flags, 'end'),
          defaultSplitRule: str(flags, 'default-split'),
          status: 'active',
        },
        intFlag(flags, 'actor') ?? null,
        at,
      );
      console.log(`Trip "${need(flags, 'name')}" initialized at ${dbPath}`);
      break;
    }

    case 'add-family': {
      const id = addFamily(db, need(flags, 'name'), intFlag(flags, 'actor') ?? null, at);
      console.log(json ? JSON.stringify({ id }) : `Family #${id}: ${need(flags, 'name')}`);
      break;
    }

    case 'add-member': {
      const id = addMember(
        db,
        {
          displayName: need(flags, 'name'),
          aliases: str(flags, 'aliases')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          familyId: intFlag(flags, 'family') ?? null,
          platformId: str(flags, 'platform') ?? null,
          joinedAt: str(flags, 'joined') ?? at,
          excludedFromSplits: flags.excluded === true || flags.excluded === 'true',
        },
        intFlag(flags, 'actor') ?? null,
        at,
      );
      console.log(json ? JSON.stringify({ id }) : `Member #${id}: ${need(flags, 'name')}`);
      break;
    }

    case 'set-member': {
      const id = Number(rest[0]);
      if (!Number.isSafeInteger(id)) throw new Error('usage: set-member <id> [--flags]');
      updateMember(
        db,
        id,
        {
          leftAt: str(flags, 'left'),
          familyId: intFlag(flags, 'family'),
          platformId: str(flags, 'platform'),
          aliases: str(flags, 'aliases')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          excludedFromSplits:
            flags.excluded === undefined ? undefined : flags.excluded === true || flags.excluded === 'true',
          upiId: str(flags, 'upi') === undefined ? undefined : (str(flags, 'upi') || null),
        },
        intFlag(flags, 'actor') ?? null,
        at,
      );
      console.log(`Member #${id} updated`);
      break;
    }

    case 'members': {
      const rows = allMembers(db);
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        for (const m of rows) {
          const bits = [
            `#${m.id} ${m.display_name}`,
            m.family_id != null ? `family ${m.family_id}` : 'standalone',
            m.excluded_from_splits ? 'EXCLUDED from splits' : '',
            m.left_at ? `left ${m.left_at}` : '',
            (m as any).upi_id ? 'upi:✓' : '',
          ].filter(Boolean);
          console.log(bits.join(' · '));
        }
      }
      break;
    }

    case 'families': {
      const rows = db.query('SELECT * FROM families ORDER BY id').all();
      console.log(json ? JSON.stringify(rows, null, 2) : rows.map((f: any) => `#${f.id} ${f.name}`).join('\n'));
      break;
    }

    case 'log': {
      const currency = need(flags, 'currency');
      const customRaw = str(flags, 'custom');
      const items = itemised(flags, currency, db, at);
      const id = logExpense(db, {
        description: need(flags, 'desc'),
        amountMinor: toMinor(need(flags, 'amount'), currency),
        currency,
        payerId: Number(need(flags, 'payer')),
        rule: (str(flags, 'rule') ?? (customRaw ? 'custom' : 'equal-all')) as SplitRule,
        custom: customRaw ? (JSON.parse(customRaw) as CustomSpec) : null,
        source: (str(flags, 'source') as 'text' | 'upi-image' | 'bill-image' | undefined) ?? 'text',
        loggedBy: intFlag(flags, 'by') ?? null,
        at,
        items,
      });
      if (json) {
        console.log(JSON.stringify({ id, shares: Object.fromEntries(getShares(db, id)) }));
      } else {
        console.log(`✓ Logged expense #${id}`);
        for (const [mid, share] of getShares(db, id)) {
          console.log(`  ${memberName(mid)}: ${formatMinor(share, currency)}`);
        }
      }
      break;
    }

    case 'edit': {
      const id = Number(rest[0]);
      if (!Number.isSafeInteger(id)) throw new Error('usage: edit <expenseId> [--flags] --actor <id>');
      const currency = str(flags, 'currency') ?? getExpense(db, id)?.currency ?? 'INR';
      const customRaw = str(flags, 'custom');
      const items = itemised(flags, currency, db, getExpense(db, id)?.logged_at ?? at);
      editExpense(
        db,
        id,
        {
          description: str(flags, 'desc'),
          amountMinor: str(flags, 'amount') !== undefined ? toMinor(need(flags, 'amount'), currency) : undefined,
          currency: str(flags, 'currency'),
          payerId: intFlag(flags, 'payer'),
          rule: str(flags, 'rule') as SplitRule | undefined,
          custom: customRaw !== undefined ? (JSON.parse(customRaw) as CustomSpec) : undefined,
          items,
        },
        Number(need(flags, 'actor')),
        at,
      );
      console.log(`✓ Edited expense #${id}`);
      break;
    }

    case 'void': {
      const id = Number(rest[0]);
      if (!Number.isSafeInteger(id)) throw new Error('usage: void <expenseId> --actor <id>');
      voidExpense(db, id, Number(need(flags, 'actor')), at);
      console.log(`✓ Voided expense #${id}`);
      break;
    }

    case 'settlement': {
      const currency = need(flags, 'currency');
      const id = logSettlement(db, {
        fromId: Number(need(flags, 'from')),
        toId: Number(need(flags, 'to')),
        amountMinor: toMinor(need(flags, 'amount'), currency),
        currency,
        loggedBy: intFlag(flags, 'by') ?? null,
        at,
      });
      console.log(`✓ Settlement #${id} recorded`);
      break;
    }

    case 'reset': {
      if (flags.confirm !== true)
        throw new Error('reset requires --confirm (owner-only, double-confirmed at the agent layer)');
      resetLedger(db, Number(need(flags, 'actor')), at);
      console.log('✓ Ledger reset (config and journal preserved)');
      break;
    }

    case 'balance': {
      const balances = computeBalances(db);
      assertZeroSum(balances);
      const consolidateSpec = str(flags, 'consolidate');
      if (consolidateSpec) {
        const trip = db.query('SELECT base_currency FROM trip WHERE id = 1').get() as { base_currency: string } | null;
        const base = trip?.base_currency ?? 'INR';
        const rates: Record<string, number> = {};
        for (const pair of consolidateSpec.split(',')) {
          const [cur, rate] = pair.split('=');
          rates[cur.trim().toUpperCase()] = Number(rate);
        }
        const folded = consolidate(balances, base, rates);
        appendJournal(db, {
          at,
          actorId: intFlag(flags, 'actor') ?? null,
          action: 'balance.consolidate',
          entity: 'ledger',
          before: null,
          after: { base, rates },
        });
        if (json) {
          console.log(JSON.stringify({ base, rates, balances: Object.fromEntries(folded) }));
        } else {
          console.log(`Consolidated into ${base} at explicit rates ${consolidateSpec} (journaled):`);
          for (const [id, v] of [...folded].sort((a, b) => a[0] - b[0])) {
            if (v === 0) continue;
            console.log(`  ${memberName(id)}: ${v > 0 ? 'is owed' : 'owes'} ${formatMinor(Math.abs(v), base)}`);
          }
        }
        break;
      }
      if (json) {
        const obj: Record<string, Record<number, number>> = {};
        for (const [cur, per] of balances) obj[cur] = Object.fromEntries(per);
        console.log(JSON.stringify(obj));
      } else {
        for (const [cur, per] of balances) {
          console.log(`${cur}:`);
          for (const [id, v] of [...per].sort((a, b) => a[0] - b[0])) {
            if (v === 0) continue;
            console.log(`  ${memberName(id)}: ${v > 0 ? 'is owed' : 'owes'} ${formatMinor(Math.abs(v), cur)}`);
          }
        }
      }
      break;
    }

    case 'settle': {
      const balances = computeBalances(db);
      assertZeroSum(balances);
      const only = str(flags, 'currency')?.toUpperCase();
      const result: Record<string, { from: number; to: number; amount: number }[]> = {};
      for (const [cur, per] of balances) {
        if (only && cur !== only) continue;
        result[cur] = settlementPlan(per);
      }
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        for (const [cur, transfers] of Object.entries(result)) {
          console.log(`${cur} — ${transfers.length} transfer(s):`);
          for (const t of transfers) {
            const payee = allMembers(db).find((m: any) => m.id === t.to) as any;
            console.log(`  ${memberName(t.from)} → ${memberName(t.to)}: ${formatMinor(t.amount, cur)}`);
            if (flags.links === true) {
              if (cur === 'INR' && payee?.upi_id) {
                const major = (t.amount / 100).toFixed(2);
                console.log(`    upi://pay?pa=${encodeURIComponent(payee.upi_id)}&pn=${encodeURIComponent(payee.display_name)}&am=${major}&cu=INR`);
                console.log(`    ${payee.upi_id} · ${formatMinor(t.amount, cur)}`);
              } else console.log(`    (no UPI on file / non-INR — settle manually)`);
            }
          }
        }
      }
      break;
    }
    case 'burn': {
      const burn = budgetBurn(db, at);
      if (json) console.log(JSON.stringify(burn));
      else if ((burn as any).reason) console.log(`Spend only · ${(burn as any).reason}`);
      else { const b: any = burn; const base = db.query('SELECT base_currency FROM trip WHERE id=1').get() as any; console.log(`Day ${b.daysElapsed}/${b.tripDays} (${b.timePct}% time) · spent ${formatMinor(b.baseSpent, base.base_currency)}${b.budget != null ? ` of ${formatMinor(b.budget, base.base_currency)} (${b.budgetPct}%)` : ''}${b.projection != null ? ` · pace ${formatMinor(Math.round(b.dailyRate), base.base_currency)}/day → projects ${formatMinor(Math.round(b.projection), base.base_currency)}${b.projectionOver ? ' (OVER)' : ''}` : ''}`); }
      break;
    }

    case 'nudge record': {
      const id = recordNudge(db, at, intFlag(flags, 'by') ?? null);
      console.log(json ? JSON.stringify({ id, ...nudgeStatus(db) }) : `✓ Settlement nudge #${id} recorded`);
      break;
    }
    case 'nudge status': {
      const s = nudgeStatus(db);
      console.log(json ? JSON.stringify(s) : `Nudges: ${s.count} · last: ${s.lastNudgeAt ?? 'never'} · edges changed: ${s.edgesChangedSinceLastNudge ? 'yes' : 'no'}`);
      break;
    }

    case 'status': {
      const trip = db.query('SELECT * FROM trip WHERE id = 1').get() as any;
      const nExp = (db.query('SELECT COUNT(*) AS n FROM expenses WHERE voided_at IS NULL').get() as any).n;
      const nVoid = (db.query('SELECT COUNT(*) AS n FROM expenses WHERE voided_at IS NOT NULL').get() as any).n;
      const nSet = (db.query('SELECT COUNT(*) AS n FROM settlements').get() as any).n;
      const nMem = allMembers(db).length;
      if (json) {
        console.log(JSON.stringify({ trip, expenses: nExp, voided: nVoid, settlements: nSet, members: nMem }));
      } else {
        console.log(trip ? `Trip: ${trip.name} (${trip.status}) · base ${trip.base_currency}` : 'Trip: not configured');
        console.log(`Members: ${nMem} · Expenses: ${nExp} active, ${nVoid} voided · Settlements: ${nSet}`);
      }
      break;
    }

    case 'journal': {
      const limit = intFlag(flags, 'limit') ?? 20;
      const rows = db.query('SELECT * FROM journal ORDER BY id DESC LIMIT $n').all({ $n: limit }) as any[];
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        for (const r of rows.reverse()) {
          console.log(`#${r.id} ${r.at} ${memberName(r.actor_member_id)} ${r.action} ${r.entity}`);
        }
      }
      break;
    }

    case 'expenses': {
      const limit = intFlag(flags, 'limit') ?? 15;
      const rows = db
        .query(
          `SELECT e.id, e.description, e.amount, e.currency, e.split_rule, e.voided_at, m.display_name AS payer
           FROM expenses e JOIN members m ON m.id = e.payer_member_id
           ORDER BY e.id DESC LIMIT $n`,
        )
        .all({ $n: limit }) as any[];
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        for (const e of rows.reverse()) {
          console.log(
            `#${e.id} ${e.description} · ${formatMinor(e.amount, e.currency)} · paid by ${e.payer} · ${e.split_rule}${e.voided_at ? ' · VOIDED' : ''}`,
          );
        }
      }
      break;
    }

    case 'expense': {
      const id = Number(rest[0]);
      const e = getExpense(db, id);
      if (!e) throw new Error(`expense ${id} not found`);
      const shares = getShares(db, id);
      if (json) {
        console.log(JSON.stringify({ expense: e, shares: Object.fromEntries(shares), items: getItems(db, id) }));
      } else {
        console.log(
          `#${e.id} ${e.description} · ${formatMinor(e.amount, e.currency)} · paid by ${memberName(e.payer_member_id)}` +
            ` · ${e.split_rule}${e.voided_at ? ' · VOIDED' : ''}`,
        );
        if (e.split_rule === 'itemised') for (const item of getItems(db, id)) console.log(`  ${item.label} · ${formatMinor(item.amount, e.currency)} · ${item.memberIds.map(memberName).join(', ')}`);
        for (const [mid, share] of shares) console.log(`  ${memberName(mid)}: ${formatMinor(share, e.currency)}`);
      }
      break;
    }

    default:
      throw new Error(`unknown command "${command}" — run \`trip-finance help\``);
  }
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
