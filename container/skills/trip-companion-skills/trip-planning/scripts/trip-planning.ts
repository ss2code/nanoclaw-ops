#!/usr/bin/env bun
// trip-planning — deterministic dawn-to-dusk plan CLI for the Trip Companion skill.
// The LLM curates (which fort, which café); this script owns the plan structure,
// the completeness gate, the feasibility checks, the board render, and the cost
// rollups (§10: the LLM judges, the script computes). Built on trip-core.
//
// Usage: bun trip-planning.ts --db <path> <group> <verb> [options]

import { baseCurrency, openPlanningDb, type PlanStatus, type PlanTable } from './db';
import { toMinor } from '../../trip-finance/scripts/money';
import { addPlace, safetyCard, setPlace, setPlaceInfo, setReviewDigest, stayCard, unsetPlaceInfo } from './places';
import { addDay, addDestination, addEvent, addHop, addItem, addLeg, addMeal, addStay, setStatus } from './items';
import { renderBoard } from './board';
import { validatePlan } from './validate';
import { checkPlan } from './feasibility';
import { rollup } from './rollup';
import { exportPlan, snapshotPlan } from './export';
import { commitDecision } from './consensus';
import { appendJournal } from '../../trip-core/scripts/db';

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
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
function str(f: Args['flags'], k: string): string | undefined {
  return typeof f[k] === 'string' ? (f[k] as string) : undefined;
}
function need(f: Args['flags'], k: string): string {
  const v = str(f, k);
  if (v === undefined) throw new Error(`--${k} is required`);
  return v;
}
function intFlag(f: Args['flags'], k: string): number | undefined {
  const v = str(f, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`--${k} must be an integer`);
  return n;
}
function floatFlag(f: Args['flags'], k: string): number | undefined {
  const v = str(f, k);
  return v === undefined ? undefined : Number(v);
}
const truthy = (v: string | boolean | undefined): boolean => v === true || v === 'true';

const HELP = `trip-planning — dawn-to-dusk plan model (built on trip-core)

Global: --db <path>  --json  --at <iso>  --by <memberId>

Plan    plan show                live board (badges + completeness % + ⚠️ feasibility)
        plan validate            completeness gate (§8) + feasibility; gate for plan_ready
        plan check               feasibility only (errors block, warnings inform)
        plan rollup              cost rollup per currency / per person
        plan snapshot [--validated]   freeze the committed set into plan_versions
        plan export [--draft] [--out file]   watermarked HTML plan

Places  place add --name <n> [--kind --map-url --address --lat --lng --gmaps-id]
        place review --id <id> --rating <r> --reviews <n> [--summary --source]
        info set --place <id> --key <key> --value <value> [--source-url] --by <id>
        info unset --place <id> --key <key> --by <id>
        stay card [--stay <id>] | safety card [--destination <id>]

Items   destination add --place <id> --order <n> --nights <n> [--rationale --trivia]
        leg add --member <id> --direction inbound|outbound [--from --to --mode --carrier --depart --arrive --cost <major> --currency --booking-url --ref]
        hop add [--from --to --mode --depart --arrive --travel-minutes --cost <major> --currency --booking-url --buffer]
        stay add --place <id> --check-in <d> --check-out <d> --nights <n> [--destination --tier --cost-per-night <major> --currency --breakfast --booking-url --ref]
        day add --date <d> [--base-place --theme]
        item add --day <id> --slot <dawn..night> --title <t> [--type --start --end --place --travel-from --travel-mode --travel-minutes --cost <major> --currency --booking-required --booking-url --ticket-deadline --info-url --notes --alternate-for <itemId>]
        meal add --day <id> --slot breakfast|lunch|dinner [--place --veg-ok --cost <major> --currency --url --included]
        event add --date <d> --title <t> [--kind attend|avoid --place --source-url --booking-required --ticket-deadline --cost <major> --currency]
        <table> status <id> --to candidate|shortlisted|committed|rejected

Consensus commit --decision <id> --outcome <text> --items destinations:5,stays:2
`;

function minor(f: Args['flags'], db: ReturnType<typeof openPlanningDb>, key = 'cost'): number | undefined {
  const v = str(f, key);
  if (v === undefined) return undefined;
  const cur = str(f, 'currency') ?? baseCurrency(db);
  return toMinor(v, cur);
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [group, verb, ...rest] = positional;
  const dbPath = str(flags, 'db') ?? './trip.db';
  const at = str(flags, 'at') ?? new Date().toISOString();
  const json = flags.json === true;
  const by = intFlag(flags, 'by') ?? null;
  if (!group || group === 'help') {
    console.log(HELP);
    return;
  }
  const db = openPlanningDb(dbPath);
  const cur = () => str(flags, 'currency') ?? null;
  const cmd = `${group} ${verb ?? ''}`.trim();

  switch (cmd) {
    case 'plan show': {
      const errors = checkPlan(db, { now: str(flags, 'now') }).errors;
      const board = renderBoard(db, { errors });
      console.log(json ? JSON.stringify(board) : board.text);
      break;
    }
    case 'plan validate': {
      const v = validatePlan(db);
      const feas = checkPlan(db, { now: str(flags, 'now') });
      const ok = v.ok && feas.errors.length === 0;
      if (json) {
        console.log(JSON.stringify({ ok, missing: v.missing, errors: feas.errors, warnings: feas.warnings }));
      } else {
        console.log(ok ? '✓ Plan is complete and feasible — ready to lock (after the URL gate).' : '✗ Plan not ready:');
        for (const m of v.missing) console.log(`  · missing: ${m}`);
        for (const e of feas.errors) console.log(`  · conflict: ${e.message}`);
        for (const w of feas.warnings) console.log(`  ⚠ ${w.message}`);
        if (!ok) console.log('Reminder: links are verified separately by the URL gate (eval/links.ts).');
      }
      process.exit(ok ? 0 : 1);
    }
    case 'plan check': {
      const feas = checkPlan(db, { now: str(flags, 'now') });
      if (json) console.log(JSON.stringify(feas));
      else {
        for (const e of feas.errors) console.log(`✗ ${e.message}`);
        for (const w of feas.warnings) console.log(`⚠ ${w.message}`);
        if (!feas.errors.length && !feas.warnings.length) console.log('✓ No feasibility issues.');
      }
      break;
    }
    case 'plan rollup': {
      console.log(JSON.stringify(rollup(db), null, json ? 0 : 2));
      break;
    }
    case 'plan snapshot': {
      const v = snapshotPlan(db, truthy(flags.validated), at);
      console.log(json ? JSON.stringify({ version: v }) : `✓ Plan snapshot v${v} frozen`);
      break;
    }
    case 'plan export': {
      const html = exportPlan(db, { draft: truthy(flags.draft) });
      const out = str(flags, 'out');
      if (out) {
        Bun.write(out, html);
        console.log(`✓ Plan written to ${out}`);
      } else console.log(html);
      break;
    }

    case 'place add': {
      const id = addPlace(
        db,
        {
          name: need(flags, 'name'),
          kind: str(flags, 'kind') ?? null,
          address: str(flags, 'address') ?? null,
          lat: floatFlag(flags, 'lat') ?? null,
          lng: floatFlag(flags, 'lng') ?? null,
          gmapsPlaceId: str(flags, 'gmaps-id') ?? null,
          mapUrl: str(flags, 'map-url') ?? null,
        },
        by,
        at,
      );
      console.log(json ? JSON.stringify({ id }) : `Place #${id}: ${need(flags, 'name')}`);
      break;
    }
    case 'place review': {
      setReviewDigest(db, intFlag(flags, 'id')!, floatFlag(flags, 'rating') ?? null, intFlag(flags, 'reviews') ?? null, str(flags, 'summary') ?? null, str(flags, 'source') ?? null, at);
      console.log('✓ Review digest set');
      break;
    }
    case 'place set': {
      const id = intFlag(flags, 'id')!;
      if (!Number.isSafeInteger(id)) throw new Error('--id must be an integer');
      setPlace(db, id, { name: str(flags, 'name'), mapUrl: str(flags, 'map-url'), openHours: str(flags, 'open-hours') }, by, at);
      console.log('✓ Place updated'); break;
    }
    case 'config set-pace': {
      const minutes = intFlag(flags, 'minutes');
      if (minutes === undefined || minutes < 0) throw new Error('--minutes must be a non-negative integer');
      const before = db.query('SELECT pace_cap_minutes FROM trip WHERE id=1').get() as any;
      db.query('UPDATE trip SET pace_cap_minutes=$value WHERE id=1').run({ $value: minutes || null });
      appendJournal(db, { at, actorId: by, action: 'plan.pace.set', entity: 'trip:1', before, after: { pace_cap_minutes: minutes || null } });
      console.log(minutes ? `✓ Pace cap set to ${minutes} minutes` : '✓ Pace cap cleared'); break;
    }
    case 'info set': {
      setPlaceInfo(db, intFlag(flags, 'place')!, need(flags, 'key'), need(flags, 'value'), str(flags, 'source-url') ?? null, by, at);
      console.log('✓ Place info saved'); break;
    }
    case 'info unset': {
      unsetPlaceInfo(db, intFlag(flags, 'place')!, need(flags, 'key'), by, at);
      console.log('✓ Place info removed'); break;
    }
    case 'stay card': {
      const card = stayCard(db, at.slice(0, 10), intFlag(flags, 'stay'));
      if (json) console.log(JSON.stringify(card));
      else console.log([`🏠 ${card.stay.name}`, card.stay.address, card.stay.map_url, `Check-in ${card.stay.check_in} · check-out ${card.stay.check_out}`, ...card.info.map((i: any) => `${i.key}: ${i.value}`), `Missing: ${card.missing.join(', ') || 'none'}`].filter(Boolean).join('\n'));
      break;
    }
    case 'safety card': {
      const card = safetyCard(db, at.slice(0, 10), intFlag(flags, 'destination'));
      if (json) console.log(JSON.stringify(card));
      else console.log([`🛟 ${card.destination.name}`, ...card.info.map((i: any) => `${i.key}: ${i.value}`), `Missing: ${card.missing.join(', ') || 'none'}`].join('\n'));
      break;
    }
    case 'destination add': {
      const id = addDestination(db, { placeId: intFlag(flags, 'place')!, orderIndex: intFlag(flags, 'order') ?? 0, nights: intFlag(flags, 'nights') ?? 0, rationale: str(flags, 'rationale') ?? null, trivia: str(flags, 'trivia') ?? null }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Destination #${id}`);
      break;
    }
    case 'leg add': {
      const id = addLeg(db, { memberId: intFlag(flags, 'member') ?? null, fromPlaceId: intFlag(flags, 'from') ?? null, toPlaceId: intFlag(flags, 'to') ?? null, mode: str(flags, 'mode') ?? null, carrier: str(flags, 'carrier') ?? null, depart: str(flags, 'depart') ?? null, arrive: str(flags, 'arrive') ?? null, cost: minor(flags, db) ?? null, currency: cur(), bookingUrl: str(flags, 'booking-url') ?? null, ref: str(flags, 'ref') ?? null, direction: str(flags, 'direction') ?? null }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Leg #${id}`);
      break;
    }
    case 'hop add': {
      const id = addHop(db, { fromPlaceId: intFlag(flags, 'from') ?? null, toPlaceId: intFlag(flags, 'to') ?? null, mode: str(flags, 'mode') ?? null, depart: str(flags, 'depart') ?? null, arrive: str(flags, 'arrive') ?? null, travelMinutes: intFlag(flags, 'travel-minutes') ?? null, cost: minor(flags, db) ?? null, currency: cur(), bookingUrl: str(flags, 'booking-url') ?? null, buffer: intFlag(flags, 'buffer') ?? null }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Hop #${id}`);
      break;
    }
    case 'stay add': {
      const id = addStay(db, { destinationId: intFlag(flags, 'destination') ?? null, placeId: intFlag(flags, 'place')!, tier: str(flags, 'tier') ?? null, checkIn: need(flags, 'check-in'), checkOut: need(flags, 'check-out'), nights: intFlag(flags, 'nights') ?? 0, costPerNight: minor(flags, db, 'cost-per-night') ?? null, currency: cur(), breakfastIncluded: truthy(flags.breakfast), bookingUrl: str(flags, 'booking-url') ?? null, ref: str(flags, 'ref') ?? null }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Stay #${id}`);
      break;
    }
    case 'day add': {
      const id = addDay(db, { date: need(flags, 'date'), basePlaceId: intFlag(flags, 'base-place') ?? null, theme: str(flags, 'theme') ?? null }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Day #${id}`);
      break;
    }
    case 'item add': {
      const alternateFor = intFlag(flags, 'alternate-for');
      if (alternateFor == null && (intFlag(flags, 'day') == null || str(flags, 'slot') == null)) throw new Error('--day and --slot are required unless --alternate-for is supplied');
      const id = addItem(db, { dayId: intFlag(flags, 'day') ?? 0, slot: str(flags, 'slot') ?? '', start: str(flags, 'start') ?? null, end: str(flags, 'end') ?? null, placeId: intFlag(flags, 'place') ?? null, type: str(flags, 'type') ?? 'activity', title: need(flags, 'title'), travelFromPlaceId: intFlag(flags, 'travel-from') ?? null, travelMode: str(flags, 'travel-mode') ?? null, travelMinutes: intFlag(flags, 'travel-minutes') ?? null, cost: minor(flags, db) ?? null, currency: cur(), bookingRequired: truthy(flags['booking-required']), bookingUrl: str(flags, 'booking-url') ?? null, ticketDeadline: str(flags, 'ticket-deadline') ?? null, infoUrl: str(flags, 'info-url') ?? null, notes: str(flags, 'notes') ?? null, alternateForItemId: alternateFor ?? null }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Item #${id}`);
      break;
    }
    case 'meal add': {
      const id = addMeal(db, { dayId: intFlag(flags, 'day')!, slot: need(flags, 'slot'), placeId: intFlag(flags, 'place') ?? null, vegOk: flags['veg-ok'] === undefined ? true : truthy(flags['veg-ok']), cost: minor(flags, db) ?? null, currency: cur(), url: str(flags, 'url') ?? null, includedInStay: truthy(flags.included) }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Meal #${id}`);
      break;
    }
    case 'event add': {
      const id = addEvent(db, { date: need(flags, 'date'), placeId: intFlag(flags, 'place') ?? null, title: need(flags, 'title'), kind: str(flags, 'kind') ?? 'attend', sourceUrl: str(flags, 'source-url') ?? null, bookingRequired: truthy(flags['booking-required']), ticketDeadline: str(flags, 'ticket-deadline') ?? null, cost: minor(flags, db) ?? null, currency: cur() }, by, at);
      console.log(json ? JSON.stringify({ id }) : `Event #${id}`);
      break;
    }
    case 'consensus commit': {
      const items = (need(flags, 'items').split(',').map((s) => s.trim()).filter(Boolean)).map((pair) => {
        const [table, id] = pair.split(':');
        return { table: table as PlanTable, id: Number(id) };
      });
      commitDecision(db, { decisionId: intFlag(flags, 'decision')!, outcome: need(flags, 'outcome'), items }, by, at);
      console.log('✓ Decision committed and written through to plan state');
      break;
    }
    case 'day shuffle': {
      const date = need(flags, 'date'); const drop = intFlag(flags, 'drop');
      if (drop === undefined) throw new Error('--drop is required');
      const run = () => {
        const day = db.query("SELECT id FROM days WHERE date=$date AND status='committed'").get({ $date: date }) as { id: number } | null;
        if (!day) throw new Error(`no committed day for ${date}`);
        const item = db.query("SELECT * FROM itinerary_items WHERE id=$id AND day_id=$day AND status='committed'").get({ $id: drop, $day: day.id }) as any;
        if (!item) throw new Error(`item ${drop} is not committed on ${date}`);
        const alt = db.query('SELECT * FROM itinerary_items WHERE alternate_for_item_id=$id ORDER BY id LIMIT 1').get({ $id: drop }) as any;
        db.query("UPDATE itinerary_items SET status='rejected' WHERE id=$id").run({ $id: drop });
        if (alt) db.query("UPDATE itinerary_items SET status='committed' WHERE id=$id").run({ $id: alt.id });
        const board = db.query("SELECT slot,title,status FROM itinerary_items WHERE day_id=$day AND status='committed' ORDER BY slot,id").all({ $day: day.id });
        const feas = checkPlan(db, { now: at });
        return { alt, board, feasibility: { errors: feas.errors.filter((x) => x.day === day.id), warnings: feas.warnings.filter((x) => x.day === day.id) } };
      };
      db.exec('BEGIN');
      try { const result = run(); if (truthy(flags.commit)) { db.exec('COMMIT'); appendJournal(db, { at, actorId: by, action: 'item.reject', entity: `itinerary_item:${drop}`, before: null, after: { status: 'rejected' } }); if (result.alt) appendJournal(db, { at, actorId: by, action: 'item.promote_alternate', entity: `itinerary_item:${result.alt.id}`, before: null, after: { status: 'committed' } }); } else db.exec('ROLLBACK'); console.log(json ? JSON.stringify(result) : `${result.alt ? `↩ promoted alternate: ${result.alt.title}` : 'no alternate stored — slot now open'}\n${JSON.stringify(result.board)}\n${JSON.stringify(result.feasibility)}`); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
      break;
    }

    default: {
      // <table> status <id> --to <status>
      if (verb === 'status') {
        const id = Number(rest[0]);
        if (!Number.isSafeInteger(id)) throw new Error(`usage: ${group} status <id> --to <status>`);
        setStatus(db, group as PlanTable, id, need(flags, 'to') as PlanStatus, by, at);
        console.log(`✓ ${group} #${id} → ${need(flags, 'to')}`);
        break;
      }
      throw new Error(`unknown command "${cmd}" — run \`trip-planning help\``);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
