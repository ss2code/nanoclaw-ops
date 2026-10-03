#!/usr/bin/env bun
// trip-core — deterministic shared trip domain CLI (identity, roster,
// relationships, lifecycle, participation, decisions, scratchpad, assets, recap).
// The LLM parses language into these commands; this script owns every state
// mutation and the legal-transition table (§10: the script computes, the LLM judges).
//
// Usage: bun trip-core.ts --db <path> <group> <verb> [options]
// Run `help` for the command list.

import { allMembers, appendJournal, openCoreDb } from './db';
import { addFamily, addMember, setTrip, updateMember } from './config';
import { type Stage, cancel, getStage, legalTransitions, proposeTransition, regress, transition } from './lifecycle';
import { participantsForStage, setParticipation } from './participation';
import { addRelationship, listRelationships } from './relationships';
import { addNote, allNotes, openNotes, resolveNote } from './scratchpad';
import {
  closeDecision,
  closedDecisions,
  dueForAutoCommit,
  openDecision,
  openDecisions,
  recordObjection,
  recordVote,
  tally,
} from './decisions';
import { indexAsset, listAssets } from './assets';
import { addChecklistItem, checklistBoard, claimGear, confirmItem, doneItem, dropItem, seedPacking, seedReadiness, unclaimGear, readinessDue } from './checklists';
import { openRollcall, checkIn, closeRollcall, rollcallStatus } from './rollcall';
import { addDiary, diaryEntries } from './diary';
import { dayOf } from './dayof';
import { heartbeat } from './heartbeat';
import { migratePlanning } from '../../trip-planning/scripts/db';
import { buildRecap, renderRecap } from './recap';
import {
  addRecommendation,
  applyVoteProxies,
  bookingReadiness,
  buildCatchupCard,
  buildDecisionBoard,
  renderActivitySignups,
  renderProxyList,
  renderRecommendationList,
  setActivitySignup,
  setVoteProxy,
} from './planning-ux';

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

// Capabilities surfaced by `help`, filtered to the stages they apply to (§17).
const CAPABILITIES: { line: string; stages: Stage[] | 'all' }[] = [
  { line: 'recap — read back the current plan state (stage, roster, decisions, notes)', stages: 'all' },
  { line: 'status — stage + per-stage roster + open decisions', stages: 'all' },
  { line: 'stage propose/confirm/regress/cancel — move the trip along its lifecycle', stages: 'all' },
  {
    line: 'member/family/relationship — manage who is on the trip and how they relate',
    stages: ['planning', 'plan_ready', 'start_trip'],
  },
  { line: 'participation — set who is in for a given stage (planning ≠ on-trip)', stages: 'all' },
  {
    line: 'note — jot ungated working notes (leanings, vetoes, to-research)',
    stages: ['planning', 'plan_ready', 'start_trip', 'on_trip'],
  },
  {
    line: 'decision — open a proposal-with-deadline or a poll; tally; close',
    stages: ['planning', 'plan_ready', 'start_trip', 'on_trip'],
  },
  {
    line: 'decision board / catchup / booking readiness — planning-stage cockpit, late-joiner brief, and booking gate',
    stages: ['planning', 'plan_ready'],
  },
  {
    line: 'proxy / recommendation / activity — mirror votes, source confidence, and optional activity signups',
    stages: ['planning', 'plan_ready', 'on_trip'],
  },
  { line: 'asset — index a doc / photo / ticket into the trip folder', stages: 'all' },
  { line: 'packing / shared gear / readiness / roll-call / diary', stages: 'all' },
];

function helpText(stage: Stage): string {
  const lines = ['trip-core — shared trip domain', '', `Current stage: ${stage}`, '', 'What I can do here:'];
  for (const c of CAPABILITIES) {
    if (c.stages === 'all' || c.stages.includes(stage)) lines.push(`  · ${c.line}`);
  }
  lines.push('', 'Run `trip-core <group> --help`-style by reading the source; common: ');
  lines.push('  recap | status | stage show | member list | decisions | notes');
  return lines.join('\n');
}

function memberNamer(db: ReturnType<typeof openCoreDb>): (id: number | null) => string {
  const all = allMembers(db);
  return (id) => (id == null ? '—' : (all.find((m) => m.id === id)?.display_name ?? `member#${id}`));
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [group, verb, ...rest] = positional;
  const dbPath = str(flags, 'db') ?? './trip.db';
  const at = str(flags, 'at') ?? new Date().toISOString();
  const json = flags.json === true;
  const actor = intFlag(flags, 'actor') ?? intFlag(flags, 'by') ?? null;

  if (!group || group === 'help') {
    const db = openCoreDb(dbPath);
    let stage: Stage = 'planning';
    try {
      stage = getStage(db);
    } catch {
      /* not configured yet */
    }
    console.log(helpText(stage));
    return;
  }

  const db = openCoreDb(dbPath);
  migratePlanning(db);
  const name = memberNamer(db);
  const out = (text: string, obj?: unknown) => console.log(json && obj !== undefined ? JSON.stringify(obj) : text);

  switch (`${group} ${verb ?? ''}`.trim()) {
    case 'setup ensure': {
      // openCoreDb already migrated. Optionally converge trip config if provided.
      if (str(flags, 'name')) {
        setTrip(
          db,
          {
            name: need(flags, 'name'),
            baseCurrency: str(flags, 'base-currency'),
            startDate: str(flags, 'start'),
            endDate: str(flags, 'end'),
            defaultSplitRule: str(flags, 'default-split'),
          },
          actor,
          at,
        );
      }
      const stage = getStageSafe(db);
      out(`trip-core ready · stage ${stage}`, { ok: true, stage });
      break;
    }

    case 'status': {
      const stage = getStageSafe(db);
      const trip = db.query('SELECT name, base_currency FROM trip WHERE id = 1').get() as {
        name: string;
        base_currency: string;
      } | null;
      const roster = participantsForStage(db, stage);
      const open = openDecisions(db);
      if (json) {
        out('', { trip, stage, roster, openDecisions: open.length });
      } else {
        out(trip ? `Trip: ${trip.name} · base ${trip.base_currency} · stage ${stage}` : 'Trip: not configured');
        out(
          `Roster (${stage}): ` +
            (roster.length ? roster.map((r) => `${r.display_name} [${r.status}]`).join(', ') : '(none)'),
        );
        out(`Open decisions: ${open.length}`);
      }
      break;
    }

    case 'recap': {
      const recap = buildRecap(db);
      out(renderRecap(recap), recap);
      break;
    }
    case 'heartbeat': {
      console.log(JSON.stringify(heartbeat(db, at, str(flags, 'edition') ?? 'auto', str(flags, 'memory-db'))));
      break;
    }

    // ── lifecycle ──
    case 'stage show': {
      const stage = getStageSafe(db);
      out(`Stage: ${stage} · legal next: ${legalTransitions(stage).join(', ') || '(terminal)'}`, {
        stage,
        legal: legalTransitions(stage),
      });
      break;
    }
    case 'stage propose': {
      const to = need(flags, 'to') as Stage;
      const c = proposeTransition(db, to, actor, at);
      out(
        c.ok
          ? `Proposed ${c.from} → ${to} (legal). Confirm with: stage confirm --to ${to}`
          : `Cannot move ${c.from} → ${to}. Legal: ${c.legal.join(', ') || 'none'}`,
        c,
      );
      break;
    }
    case 'stage confirm': {
      const to = need(flags, 'to') as Stage;
      transition(db, to, actor, at);
      out(`✓ Stage → ${to}`, { stage: to });
      break;
    }
    case 'stage regress': {
      regress(db, actor, at);
      out(`✓ Regressed to ${getStage(db)}`, { stage: getStage(db) });
      break;
    }
    case 'stage cancel': {
      cancel(db, actor, at);
      out('✓ Trip cancelled', { stage: 'cancelled' });
      break;
    }

    // ── roster ──
    case 'family add': {
      const id = addFamily(db, need(flags, 'name'), actor, at);
      out(`Family #${id}: ${need(flags, 'name')}`, { id });
      break;
    }
    case 'family list':
    case 'families list': {
      const rows = db.query('SELECT id, name FROM families ORDER BY id').all() as { id: number; name: string }[];
      out(rows.map((f) => `#${f.id} ${f.name}`).join('\n'), rows);
      break;
    }
    case 'member add': {
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
        actor,
        at,
      );
      out(`Member #${id}: ${need(flags, 'name')}`, { id });
      break;
    }
    case 'member set': {
      const id = Number(rest[0]);
      if (!Number.isSafeInteger(id)) throw new Error('usage: member set <id> [--flags]');
      updateMember(
        db,
        id,
        {
          displayName: str(flags, 'name'),
          aliases: str(flags, 'aliases')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          familyId: intFlag(flags, 'family'),
          platformId: str(flags, 'platform'),
          leftAt: str(flags, 'left'),
          excludedFromSplits:
            flags.excluded === undefined ? undefined : flags.excluded === true || flags.excluded === 'true',
        },
        actor,
        at,
      );
      out(`Member #${id} updated`, { id });
      break;
    }
    case 'member list':
    case 'members list': {
      const rows = allMembers(db);
      if (json) out('', rows);
      else {
        for (const m of rows) {
          const bits = [
            `#${m.id} ${m.display_name}`,
            m.family_id != null ? `family ${m.family_id}` : 'standalone',
            m.excluded_from_splits ? 'EXCLUDED from splits' : '',
            m.left_at ? `left ${m.left_at}` : '',
          ].filter(Boolean);
          console.log(bits.join(' · '));
        }
      }
      break;
    }
    case 'member mentions':
    case 'members mentions': {
      const rows = allMembers(db);
      const lines = rows.map((m) => {
        const match = m.platform_id?.match(/^whatsapp:(\d+)@s\.whatsapp\.net$/);
        return match
          ? `#${m.id} ${m.display_name} → @${match[1]}`
          : `#${m.id} ${m.display_name} → (no WhatsApp platform id)`;
      });
      out(lines.join('\n'), rows);
      break;
    }
    case 'relationship add': {
      const id = addRelationship(
        db,
        Number(need(flags, 'member')),
        Number(need(flags, 'related')),
        need(flags, 'kind'),
        str(flags, 'note') ?? null,
        actor,
        at,
      );
      out(`Relationship #${id} recorded`, { id });
      break;
    }
    case 'relationship list':
    case 'relationships list': {
      const rows = listRelationships(db);
      out(rows.map((r) => `#${r.id} ${name(r.member_id)} —${r.kind}— ${name(r.related_member_id)}`).join('\n'), rows);
      break;
    }

    // ── participation ──
    case 'participation set': {
      setParticipation(
        db,
        Number(need(flags, 'member')),
        need(flags, 'stage'),
        str(flags, 'status') ?? 'in',
        str(flags, 'note') ?? null,
        actor,
        at,
      );
      out('✓ Participation set');
      break;
    }
    case 'participation show': {
      const rows = participantsForStage(db, need(flags, 'stage'));
      out(rows.map((r) => `${r.display_name} [${r.status}]${r.note ? ` — ${r.note}` : ''}`).join('\n'), rows);
      break;
    }

    // ── scratchpad ──
    case 'note add': {
      const id = addNote(
        db,
        { authorMemberId: actor, topic: str(flags, 'topic') ?? null, note: need(flags, 'note') },
        at,
      );
      out(`Note #${id} added`, { id });
      break;
    }
    case 'note resolve': {
      const id = Number(rest[0]);
      resolveNote(db, id, at);
      out(`✓ Note #${id} resolved`, { id });
      break;
    }
    case 'note list':
    case 'notes list': {
      const all = flags.all === true || flags.all === 'true';
      const rows = all ? allNotes(db) : openNotes(db);
      out(rows.map((n) => `#${n.id} [${n.status}]${n.topic ? ` (${n.topic})` : ''} ${n.note}`).join('\n'), rows);
      break;
    }

    // ── decisions ──
    case 'decision open': {
      const id = openDecision(
        db,
        {
          question: need(flags, 'question'),
          mode: (str(flags, 'mode') as 'propose' | 'poll' | undefined) ?? 'propose',
          options: str(flags, 'options')
            ?.split('|')
            .map((s) => s.trim())
            .filter(Boolean),
          commitBy: str(flags, 'commit-by') ?? null,
          stage: str(flags, 'stage') ?? null,
          openedBy: actor,
        },
        at,
      );
      out(`Decision #${id} opened`, { id });
      break;
    }
    case 'decision vote': {
      recordVote(db, Number(need(flags, 'id')), Number(need(flags, 'member')), need(flags, 'choice'), at);
      out('✓ Vote recorded');
      break;
    }
    case 'decision objection': {
      recordObjection(db, Number(need(flags, 'id')), Number(need(flags, 'member')), at);
      out('✓ Objection recorded');
      break;
    }
    case 'decision tally': {
      const t = tally(db, Number(rest[0]));
      out(
        `Tally: ${
          Object.entries(t.counts)
            .map(([o, c]) => `${o} ${c}`)
            .join(' · ') || '(no votes)'
        } · leading: ${t.leader ?? '—'}`,
        t,
      );
      break;
    }
    case 'decision close': {
      closeDecision(db, Number(rest[0]), need(flags, 'outcome'), at);
      out(`✓ Decision #${rest[0]} closed → ${need(flags, 'outcome')}`);
      break;
    }
    case 'decision due': {
      const due = dueForAutoCommit(db, at);
      out(due.map((d) => `#${d.id} ${d.question}`).join('\n') || '(none due)', due);
      break;
    }
    case 'decision list':
    case 'decisions list': {
      const open = openDecisions(db);
      const closed = closedDecisions(db);
      if (json) out('', { open, closed });
      else {
        for (const d of open) console.log(`⏳ #${d.id} ${d.question}${d.commit_by ? ` (locks ${d.commit_by})` : ''}`);
        for (const d of closed) console.log(`✅ #${d.id} ${d.question} → ${d.outcome ?? '—'}`);
      }
      break;
    }
    case 'decision board':
    case 'decisions board': {
      const board = buildDecisionBoard(db, at, { staleDays: intFlag(flags, 'stale-days') });
      out(board.text, board);
      break;
    }

    // ── planning-stage UX projections ──
    case 'catchup':
    case 'catchup card': {
      const card = buildCatchupCard(db, at);
      out(card.text, card);
      break;
    }
    case 'booking readiness': {
      const readiness = bookingReadiness(db);
      out(readiness.text, readiness);
      break;
    }
    case 'proxy set': {
      const id = setVoteProxy(
        db,
        {
          fromMemberId: Number(need(flags, 'member')),
          toMemberId: Number(need(flags, 'follows')),
          decisionId: intFlag(flags, 'decision') ?? null,
          scope: str(flags, 'scope') ?? 'all',
          note: str(flags, 'note') ?? null,
        },
        actor,
        at,
      );
      out(`Proxy #${id} set`, { id });
      break;
    }
    case 'proxy list':
    case 'proxies list': {
      out(renderProxyList(db));
      break;
    }
    case 'proxy apply': {
      const decisionId = intFlag(flags, 'decision') ?? Number(rest[0]);
      if (!Number.isSafeInteger(decisionId)) throw new Error('usage: proxy apply --decision <id>');
      const result = applyVoteProxies(db, decisionId, at);
      out(`Applied ${result.applied.length} proxy vote(s); skipped ${result.skipped.length}`, result);
      break;
    }
    case 'recommendation add': {
      const id = addRecommendation(
        db,
        {
          category: need(flags, 'category'),
          title: need(flags, 'title'),
          status: str(flags, 'status') ?? 'researching',
          sourceUrl: str(flags, 'source-url') ?? null,
          sourceCheckedAt: str(flags, 'source-checked-at') ?? null,
          confidence: str(flags, 'confidence') ?? 'unknown',
          freshnessDays: intFlag(flags, 'freshness-days') ?? null,
          note: str(flags, 'note') ?? null,
        },
        actor,
        at,
      );
      out(`Recommendation #${id} added`, { id });
      break;
    }
    case 'recommendation list':
    case 'recommendations list': {
      out(renderRecommendationList(db));
      break;
    }
    case 'activity signup': {
      setActivitySignup(
        db,
        {
          activity: need(flags, 'activity'),
          memberId: Number(need(flags, 'member')),
          status: str(flags, 'status') ?? 'interested',
          note: str(flags, 'note') ?? null,
        },
        actor,
        at,
      );
      out('✓ Activity signup recorded');
      break;
    }
    case 'activity list':
    case 'activities list': {
      out(renderActivitySignups(db));
      break;
    }

    // ── assets ──
    case 'asset index': {
      const id = indexAsset(
        db,
        {
          kind: need(flags, 'kind'),
          label: str(flags, 'label') ?? null,
          path: need(flags, 'path'),
          addedBy: actor,
          stage: str(flags, 'stage') ?? null,
          tags: str(flags, 'tags')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          dayDate: str(flags, 'day') ?? null,
          placeId: intFlag(flags, 'place') ?? null,
        },
        at,
      );
      out(`Asset #${id} indexed`, { id });
      break;
    }
    case 'asset list':
    case 'assets list': {
      const rows = listAssets(db, { kind: str(flags, 'kind'), dayDate: str(flags, 'day'), placeId: intFlag(flags, 'place') });
      out(rows.map((a) => `#${a.id} [${a.kind}] ${a.label ?? a.path} — ${a.path}`).join('\n'), rows);
      break;
    }

    case 'gear add': { const id = addChecklistItem(db, 'gear', { label: need(flags, 'label'), note: str(flags, 'note') ?? null }, actor, at); out(`Gear #${id} added`, { id }); break; }
    case 'gear claim': { const id = Number(rest[0]); if (!Number.isSafeInteger(id)) throw new Error('usage: gear claim <itemId> --member <id>'); claimGear(db, id, Number(need(flags, 'member')), false, actor, at); out('✓ Gear claimed'); break; }
    case 'gear unclaim': { const id = Number(rest[0]); if (!Number.isSafeInteger(id)) throw new Error('usage: gear unclaim <itemId> --member <id>'); unclaimGear(db, id, Number(need(flags, 'member')), flags.force === true, actor, at); out('✓ Gear unclaimed'); break; }
    case 'gear board': { const rows = checklistBoard(db, 'gear'); out(rows.map((i) => `#${i.id} ${i.label} — ${i.claimed_name ?? 'unclaimed'}`).join('\n'), rows); break; }
    case 'packing seed': { const ids = seedPacking(db, need(flags, 'template'), actor, at); out(`✓ Packing seeded (${ids.length} items)`, { ids }); break; }
    case 'packing add': { const id = addChecklistItem(db, 'packing', { label: need(flags, 'label'), perMember: flags['per-member'] === true }, actor, at); out(`Packing #${id} added`, { id }); break; }
    case 'packing board': { const rows = checklistBoard(db, 'packing'); out(rows.map((i) => `#${i.id} ${i.label} — ${i.status}`).join('\n'), rows); break; }
    case 'readiness seed': { const ids = seedReadiness(db, actor, at); out(`✓ Readiness seeded (${ids.length} items)`, { ids }); break; }
    case 'readiness confirm': { const id = Number(rest[0]); confirmItem(db, id, Number(need(flags, 'member')), actor, at); out('✓ Readiness confirmed'); break; }
    case 'readiness done': { const id = Number(rest[0]); doneItem(db, id, actor, at); out('✓ Readiness item done'); break; }
    case 'readiness due': { const rows = readinessDue(db, str(flags, 'at') ?? at); out(rows.map((i) => `#${i.id} ${i.label}${i.missing?.length ? ` — missing: ${i.missing.map((m: any) => m.name).join(', ')}` : ''}`).join('\n'), rows); break; }
    case 'check drop': { const id = Number(rest[0]); dropItem(db, id, actor, at); out('✓ Checklist item dropped'); break; }
    case 'rollcall open': { const id = openRollcall(db, need(flags, 'label'), actor, at); out(`✓ Roll-call #${id} opened`, { id }); break; }
    case 'rollcall in': { checkIn(db, Number(need(flags, 'member')), str(flags, 'note') ?? null, actor, at); out('✓ Checked in'); break; }
    case 'rollcall status': { const status = rollcallStatus(db); out(`Roll-call: ${status.rollcall.label}\nIn: ${status.in.map((m) => m.display_name).join(', ') || 'none'}\nMissing: ${status.missing.map((m) => m.display_name).join(', ') || 'none'}${status.complete ? '\n✓ Complete' : ''}`, status); break; }
    case 'rollcall close': { closeRollcall(db, actor, at); out('✓ Roll-call closed'); break; }
    case 'diary add': { const id = addDiary(db, { date: need(flags, 'date'), entry: need(flags, 'entry'), memberId: intFlag(flags, 'member') ?? null }, actor, at); out(`Diary #${id} saved`, { id }); break; }
    case 'diary show': { const rows = diaryEntries(db, str(flags, 'date')); out(rows.map((d) => `${d.date} · ${d.display_name ?? 'Group'}: ${d.entry}`).join('\n'), rows); break; }
    case 'dayof': { const rows = dayOf(db, str(flags, 'date') ?? at.slice(0, 10), intFlag(flags, 'member')); out(rows.length ? rows.map((m) => `${m.name}\n${m.legs.map((l: any) => `  ${l.mode ?? 'travel'} ${l.carrier ?? ''} ${l.depart ?? ''} → ${l.arrive ?? ''} ${l.ref ?? ''}`).join('\n')}${m.stay ? `\n  Stay: ${m.stay.place_name} · ${m.stay.address ?? ''}${m.stay.host_phone ? ` · host ${m.stay.host_phone}` : ''}` : ''}`).join('\n') : 'no travel today', rows); break; }

    default:
      throw new Error(`unknown command "${`${group} ${verb ?? ''}`.trim()}" — run \`trip-core help\``);
  }
}

function getStageSafe(db: ReturnType<typeof openCoreDb>): Stage {
  try {
    return getStage(db);
  } catch {
    return 'planning';
  }
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
