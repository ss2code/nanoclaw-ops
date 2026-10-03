/**
 * trip-admin — config-driven trip instantiation for Trip Companion.
 *
 * A "trip" is one agent group plus its wiring: members (allowlist), chat
 * wires (CLI / Telegram / WhatsApp), destinations, model. This script makes
 * the whole infra layer declarative: one JSON config in, validated, applied
 * idempotently. The conversational roster setup ("@trip set up the trip")
 * stays in chat — this covers everything beneath it.
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/trip-admin.ts apply  <config.json>     # create or update (idempotent)
 *   pnpm exec tsx scripts/trip-admin.ts status <trip-id|config.json> [--json]
 *   pnpm exec tsx scripts/trip-admin.ts list
 *   pnpm exec tsx scripts/trip-admin.ts delete <trip-id> --yes
 *
 * Config example: trips/example.trip.json. Validations run before any write;
 * all errors are reported at once.
 *
 * Known constraints encoded here (learned during the Goa build):
 *   - agent-group ids must match ^[a-z][a-z0-9-]{0,49}$ (OneCLI identifier rule)
 *   - the group folder/config must be initialized (initGroupFilesystem), not just the DB row
 *   - every wire needs a destinations row, or agent replies are silently dropped
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { createAgentGroup, getAgentGroup, getAllAgentGroups } from '../src/db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
  updateMessagingGroupAgent,
} from '../src/db/messaging-groups.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { createDestination, getDestinations, hasDestination, normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUser, upsertUser } from '../src/modules/permissions/db/users.js';
import { namespacedPlatformId } from '../src/platform-id.js';

// ── config schema + validation (pure; unit-tested in trip-admin.test.ts) ──

export interface TripWireConfig {
  channel: string; // cli | telegram | whatsapp | ...
  platformId: string;
  engageMode?: 'mention' | 'mention-sticky' | 'pattern';
  engagePattern?: string;
  senderScope?: 'all' | 'known';
  ignoredMessagePolicy?: 'drop' | 'accumulate';
  sessionMode?: 'shared' | 'per-thread' | 'agent-shared';
  name?: string;
}

export interface TripMemberConfig {
  user: string; // "<channel>:<handle>"
  displayName?: string;
}

export interface TripConfig {
  id: string;
  name: string;
  folder: string;
  model?: string;
  maxMessagesPerPrompt: number;
  members: TripMemberConfig[];
  wires: TripWireConfig[];
}

/** Return the exact platform-id shape emitted by the installed adapter. */
export function normalizeTripWirePlatformId(channel: string, platformId: string): string {
  return namespacedPlatformId(channel, platformId);
}

const ID_RE = /^[a-z][a-z0-9-]{0,49}$/;
const FOLDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const USER_RE = /^[a-z0-9_-]+:.+$/i;
const ENGAGE_MODES = new Set(['mention', 'mention-sticky', 'pattern']);
const KNOWN_MODELS = new Set(['haiku', 'sonnet', 'opus']);

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Normalize + validate raw JSON. Returns the resolved config and ALL errors found. */
export function parseTripConfig(raw: unknown): { config: TripConfig | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: null, errors: ['config must be a JSON object'], warnings };
  }
  const o = raw as Record<string, unknown>;

  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) errors.push('"name" is required (display name of the trip)');

  const id = typeof o.id === 'string' ? o.id : name ? `ag-${slug(name)}` : '';
  if (!ID_RE.test(id)) {
    errors.push(`"id" must match ${ID_RE} (start with a letter; lowercase letters, digits, hyphens — OneCLI identifier rule). Got "${id}"`);
  }

  const folder = typeof o.folder === 'string' ? o.folder : name ? slug(name) : '';
  if (!FOLDER_RE.test(folder)) errors.push(`"folder" must match ${FOLDER_RE}. Got "${folder}"`);

  const model = o.model === undefined ? undefined : String(o.model);
  if (model !== undefined && !KNOWN_MODELS.has(model) && !model.startsWith('claude-')) {
    warnings.push(`"model" = "${model}" is not one of ${[...KNOWN_MODELS].join('/')} or a full claude-* id — passing through as-is`);
  }

  // Context-aware mention carries ~30 banked messages into each wake (design §4).
  const maxMessagesPerPrompt = o.maxMessagesPerPrompt === undefined ? 30 : Number(o.maxMessagesPerPrompt);
  if (!Number.isInteger(maxMessagesPerPrompt) || maxMessagesPerPrompt < 1) {
    errors.push(`"maxMessagesPerPrompt" must be a positive integer (default 30). Got "${String(o.maxMessagesPerPrompt)}"`);
  }

  const members: TripMemberConfig[] = [];
  if (!Array.isArray(o.members) || o.members.length === 0) {
    errors.push('"members" must be a non-empty array — without members and sender_scope=known, nobody can talk to the trip');
  } else {
    const seen = new Set<string>();
    o.members.forEach((m, i) => {
      const mm = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
      const user = typeof mm.user === 'string' ? mm.user : '';
      if (!USER_RE.test(user)) errors.push(`members[${i}].user must look like "<channel>:<handle>" (e.g. "telegram:12345"). Got "${user}"`);
      if (seen.has(user)) warnings.push(`members[${i}]: duplicate user "${user}" — ignored`);
      else if (user) {
        seen.add(user);
        members.push({ user, displayName: typeof mm.displayName === 'string' ? mm.displayName : undefined });
      }
    });
  }

  const wires: TripWireConfig[] = [];
  if (!Array.isArray(o.wires) || o.wires.length === 0) {
    errors.push('"wires" must be a non-empty array — a trip with no wires can never receive a message');
  } else {
    const seen = new Set<string>();
    o.wires.forEach((w, i) => {
      const ww = (typeof w === 'object' && w !== null ? w : {}) as Record<string, unknown>;
      const channel = typeof ww.channel === 'string' ? ww.channel : '';
      const platformId = typeof ww.platformId === 'string' ? ww.platformId : '';
      if (!channel) errors.push(`wires[${i}].channel is required (cli, telegram, whatsapp, ...)`);
      if (!platformId) errors.push(`wires[${i}].platformId is required (chat id / socket platform id)`);
      // Context-aware mention is the confirmed trip default (design §4): real
      // channels wake only on @mention. CLI can't set isMention, so it stays
      // pattern (@trip) — the dev/test transport.
      const engageMode = (ww.engageMode as TripWireConfig['engageMode']) ?? (channel === 'cli' ? 'pattern' : 'mention');
      if (!ENGAGE_MODES.has(engageMode)) errors.push(`wires[${i}].engageMode must be one of ${[...ENGAGE_MODES].join(', ')}`);
      const engagePattern = typeof ww.engagePattern === 'string' ? ww.engagePattern : engageMode === 'pattern' ? '@trip' : undefined;
      if (engageMode === 'pattern' && engagePattern) {
        try {
          new RegExp(engagePattern);
        } catch {
          errors.push(`wires[${i}].engagePattern "${engagePattern}" is not a valid regex`);
        }
      }
      if (channel === 'cli' && engageMode !== 'pattern') {
        warnings.push(`wires[${i}]: the CLI adapter never sets isMention — "${engageMode}" can never engage there; use engageMode "pattern"`);
      }
      const key = `${channel}/${platformId}`;
      if (seen.has(key)) {
        warnings.push(`wires[${i}]: duplicate wire ${key} — ignored`);
        return;
      }
      seen.add(key);
      if (channel && platformId) {
        wires.push({
          channel,
          platformId,
          engageMode,
          engagePattern,
          senderScope: (ww.senderScope as TripWireConfig['senderScope']) ?? 'known',
          // accumulate (not drop): un-mentioned chatter is banked as silent
          // context with wake=0, then carried into the next @mention wake
          // (design §4). drop would discard the context the trip is meant to see.
          ignoredMessagePolicy: (ww.ignoredMessagePolicy as TripWireConfig['ignoredMessagePolicy']) ?? 'accumulate',
          sessionMode: (ww.sessionMode as TripWireConfig['sessionMode']) ?? 'shared',
          name: typeof ww.name === 'string' ? ww.name : undefined,
        });
      }
    });
  }

  if (errors.length > 0) return { config: null, errors, warnings };
  return { config: { id, name, folder, model, maxMessagesPerPrompt, members, wires }, errors, warnings };
}

// ── apply (create-or-update, idempotent) ──

function apply(config: TripConfig): void {
  const now = new Date().toISOString();
  const actions: string[] = [];

  let group = getAgentGroup(config.id);
  if (!group) {
    group = { id: config.id, name: config.name, folder: config.folder, agent_provider: null, created_at: now };
    createAgentGroup(group);
    actions.push(`agent group ${config.id} created`);
  }
  // Folder + container config + .claude-shared — idempotent, and REQUIRED
  // before first spawn (a bare DB row cannot spawn a container).
  initGroupFilesystem(group);

  const cc = getContainerConfig(config.id);
  if (config.model && cc?.model !== config.model) {
    updateContainerConfigScalars(config.id, { model: config.model });
    actions.push(`model → ${config.model} (takes effect on next container start)`);
  }
  if (cc?.max_messages_per_prompt !== config.maxMessagesPerPrompt) {
    updateContainerConfigScalars(config.id, { max_messages_per_prompt: config.maxMessagesPerPrompt });
    actions.push(`maxMessagesPerPrompt → ${config.maxMessagesPerPrompt} (context-aware mention; takes effect on next container start)`);
  }

  for (const m of config.members) {
    if (!getUser(m.user)) {
      upsertUser({ id: m.user, kind: m.user.split(':')[0], display_name: m.displayName ?? null, created_at: now });
      actions.push(`user ${m.user} created`);
    }
    addMember({ user_id: m.user, agent_group_id: config.id, added_by: null, added_at: now }); // INSERT OR IGNORE
  }

  for (const w of config.wires) {
    const platformId = normalizeTripWirePlatformId(w.channel, w.platformId);
    let mg = getMessagingGroupByPlatform(w.channel, platformId);
    if (!mg) {
      mg = {
        id: `mg-${Date.now()}-${randomUUID().slice(0, 6)}`,
        channel_type: w.channel,
        platform_id: platformId,
        name: w.name ?? `${config.name} (${w.channel})`,
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: now,
      } as Parameters<typeof createMessagingGroup>[0];
      createMessagingGroup(mg);
      actions.push(`messaging group ${w.channel}/${platformId} created`);
    }
    const existingWire = getMessagingGroupAgentByPair(mg.id, config.id);
    if (!existingWire) {
      createMessagingGroupAgent({
        id: randomUUID(),
        messaging_group_id: mg.id,
        agent_group_id: config.id,
        engage_mode: w.engageMode!,
        engage_pattern: w.engageMode === 'pattern' ? (w.engagePattern ?? '@trip') : null,
        sender_scope: w.senderScope!,
        ignored_message_policy: w.ignoredMessagePolicy!,
        session_mode: w.sessionMode!,
        priority: 0,
        created_at: now,
      } as Parameters<typeof createMessagingGroupAgent>[0]);
      actions.push(`wired ${w.channel}/${platformId} → ${config.id} (${w.engageMode})`);
    } else {
      const desired = {
        engage_mode: w.engageMode!,
        engage_pattern: w.engageMode === 'pattern' ? (w.engagePattern ?? '@trip') : null,
        sender_scope: w.senderScope!,
        ignored_message_policy: w.ignoredMessagePolicy!,
        session_mode: w.sessionMode!,
        priority: existingWire.priority,
      };
      const patch: Partial<typeof desired> = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        if (existingWire[key] !== desired[key]) patch[key] = desired[key] as never;
      }
      if (Object.keys(patch).length) {
        updateMessagingGroupAgent(existingWire.id, patch);
        actions.push(`wire ${w.channel}/${platformId} reconciled (${w.engageMode}/${w.ignoredMessagePolicy})`);
      }
    }
    if (!hasDestination(config.id, 'channel', mg.id)) {
      createDestination({
        agent_group_id: config.id,
        local_name: normalizeName(`${w.channel}-${w.platformId}`),
        target_type: 'channel',
        target_id: mg.id,
        created_at: now,
      });
      actions.push(`destination added for ${w.channel}/${platformId} (replies routable)`);
    }
  }

  console.log(actions.length ? actions.map((a) => `  ✓ ${a}`).join('\n') : '  ✓ nothing to do — config already applied');
  console.log(`\nTrip "${config.name}" (${config.id}) is ready. Status: pnpm exec tsx scripts/trip-admin.ts status ${config.id}`);
}

// ── status ──

function ledgerSummary(folder: string): Record<string, unknown> | null {
  const dbPath = path.join(path.dirname(DATA_DIR), 'groups', folder, 'trip.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasTable = (name: string): boolean =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
    const trip = db.prepare('SELECT * FROM trip WHERE id = 1').get() as
      | { name: string; status: string; base_currency: string }
      | undefined;
    const financeConfigured = hasTable('expenses') && hasTable('settlements');
    const expenses = financeConfigured
      ? (db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE voided_at IS NULL').get() as { n: number }).n
      : 0;
    const voided = financeConfigured
      ? (db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE voided_at IS NOT NULL').get() as { n: number }).n
      : 0;
    const settlements = financeConfigured
      ? (db.prepare('SELECT COUNT(*) AS n FROM settlements').get() as { n: number }).n
      : 0;
    const members = hasTable('members')
      ? (db.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n
      : 0;
    const lastJournal = db.prepare('SELECT at FROM journal ORDER BY id DESC LIMIT 1').get() as { at: string } | undefined;
    const currencies = financeConfigured
      ? (db.prepare('SELECT DISTINCT currency FROM expenses').all() as Array<{ currency: string }>).map((r) => r.currency)
      : [];
    return {
      trip: trip ? { name: trip.name, status: trip.status, base_currency: trip.base_currency } : 'not configured in chat yet',
      members,
      financeConfigured,
      expenses,
      voided,
      settlements,
      currencies,
      lastActivity: lastJournal?.at ?? null,
    };
  } catch (error) {
    return { error: `trip.db unreadable: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    db.close();
  }
}

function status(idOrConfig: string, asJson: boolean): void {
  let id = idOrConfig;
  if (idOrConfig.endsWith('.json')) {
    const parsed = parseTripConfig(JSON.parse(fs.readFileSync(idOrConfig, 'utf8')));
    if (!parsed.config) {
      console.error('config invalid:\n' + parsed.errors.map((e) => `  ✗ ${e}`).join('\n'));
      process.exit(1);
    }
    id = parsed.config.id;
  }
  const group = getAgentGroup(id);
  if (!group) {
    console.error(`no agent group "${id}" — run: pnpm exec tsx scripts/trip-admin.ts apply <config.json>`);
    process.exit(1);
  }
  const cc = getContainerConfig(id);
  const wires = getMessagingGroupsByAgentGroup(id).map((mg) => {
    const mga = getMessagingGroupAgentByPair(mg.id, id)!;
    return {
      channel: mg.channel_type,
      platformId: mg.platform_id,
      engage: mga.engage_mode + (mga.engage_pattern ? `(${mga.engage_pattern})` : ''),
      senderScope: mga.sender_scope,
      hasDestination: hasDestination(id, 'channel', mg.id),
    };
  });
  const dbh = initedDb!;
  const members = dbh
    .prepare(
      `SELECT u.id, u.display_name FROM agent_group_members m JOIN users u ON u.id = m.user_id WHERE m.agent_group_id = ?`,
    )
    .all(id) as { id: string; display_name: string | null }[];
  const sessions = dbh
    .prepare('SELECT id, container_status, last_active FROM sessions WHERE agent_group_id = ?')
    .all(id) as { id: string; container_status: string; last_active: string | null }[];

  const out = {
    trip: { id, name: group.name, folder: group.folder },
    model: cc?.model ?? '(default)',
    cliScope: cc?.cli_scope ?? '(default)',
    wires,
    members,
    destinations: getDestinations(id).map((d) => d.local_name),
    sessions,
    ledger: ledgerSummary(group.folder),
  };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`Trip: ${group.name} (${id}) · folder groups/${group.folder} · model ${out.model}`);
  console.log(`Wires (${wires.length}):`);
  for (const w of wires) {
    console.log(`  ${w.channel}/${w.platformId} · engage ${w.engage} · senders ${w.senderScope}` + (w.hasDestination ? '' : ' · ⚠ NO DESTINATION — replies will be dropped'));
  }
  console.log(`Members (${members.length}): ${members.map((m) => m.display_name ?? m.id).join(', ')}`);
  console.log(`Sessions: ${sessions.length ? sessions.map((s) => `${s.id} (${s.container_status})`).join(', ') : 'none yet'}`);
  if (out.ledger) {
    const l = out.ledger as Record<string, unknown>;
    console.log(`Ledger: ${JSON.stringify(l.trip)} · roster ${l.members} · ${l.expenses} expenses (+${l.voided} voided) · ${l.settlements} settlements · currencies ${(l.currencies as string[]).join('+') || '—'} · last activity ${l.lastActivity ?? '—'}`);
  } else {
    console.log('Ledger: not created yet (happens on first "@trip set up the trip" in chat)');
  }
}

// ── main ──

let initedDb: import('better-sqlite3').Database | null = null;

function main(): void {
  const [verb, target] = process.argv.slice(2);
  if (!verb || ['help', '--help'].includes(verb)) {
    console.log('usage: trip-admin <apply <config.json> | status <id|config.json> [--json] | list | delete <id> --yes>');
    return;
  }
  initedDb = initDb(path.join(DATA_DIR, 'v2.db'));

  switch (verb) {
    case 'create': // alias
    case 'apply': {
      if (!target) throw new Error('apply needs a config file path');
      const { config, errors, warnings } = parseTripConfig(JSON.parse(fs.readFileSync(target, 'utf8')));
      for (const w of warnings) console.warn(`  ⚠ ${w}`);
      if (!config) {
        console.error('config invalid:\n' + errors.map((e) => `  ✗ ${e}`).join('\n'));
        process.exit(1);
      }
      apply(config);
      break;
    }
    case 'status':
      if (!target) throw new Error('status needs a trip id or config file');
      status(target, process.argv.includes('--json'));
      break;
    case 'list': {
      for (const g of getAllAgentGroups()) {
        const wires = getMessagingGroupsByAgentGroup(g.id).map((m) => `${m.channel_type}/${m.platform_id}`);
        console.log(`${g.id} · ${g.name} · groups/${g.folder} · wires: ${wires.join(', ') || 'none'}`);
      }
      break;
    }
    case 'delete': {
      if (!target) throw new Error('delete needs a trip id');
      if (!process.argv.includes('--yes')) {
        console.error(`refusing to delete "${target}" without --yes. This removes the agent group, wirings, members, sessions (groups/<folder>/ on disk is kept).`);
        process.exit(1);
      }
      // ncl owns the FK-ordered cascade — reuse it instead of duplicating.
      execFileSync('pnpm', ['exec', 'tsx', 'src/cli/client.ts', 'groups', 'delete', '--id', target], { stdio: 'inherit' });
      break;
    }
    default:
      throw new Error(`unknown verb "${verb}" — run with help`);
  }
}

const invokedDirectly = process.argv[1]?.endsWith('trip-admin.ts');
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
