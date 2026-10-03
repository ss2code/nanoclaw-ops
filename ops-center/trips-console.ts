import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import QRCode from 'qrcode';

import { normalizeTripWirePlatformId, parseTripConfig, type TripConfig, type TripWireConfig } from '../scripts/trip-admin.js';
import { createPairing, getPairing } from '../src/channels/telegram-pairing.js';
import { withCentral } from './readers/central.js';

const exec = promisify(execFile);

export interface TripConsoleMemberDraft {
  user: string;
  displayName: string;
}

export interface TripConsoleWireDraft extends TripWireConfig {
  channel: string;
  platformId: string;
  engageMode: NonNullable<TripWireConfig['engageMode']>;
  engagePattern: string;
  senderScope: NonNullable<TripWireConfig['senderScope']>;
  ignoredMessagePolicy: NonNullable<TripWireConfig['ignoredMessagePolicy']>;
  sessionMode: NonNullable<TripWireConfig['sessionMode']>;
  name: string;
}

/** Telegram returns this metadata from the bot token; it is display context, not config. */
export interface TripTelegramBotIdentity {
  id: string;
  username: string;
  displayName: string;
}

export interface TripConsoleDraft {
  schema: 1;
  id: string;
  name: string;
  folder: string;
  model: string;
  maxMessagesPerPrompt: number;
  members: TripConsoleMemberDraft[];
  wires: TripConsoleWireDraft[];
  telegramBot?: TripTelegramBotIdentity;
  updatedAt: string;
}

export interface TripDraftValidation {
  errors: string[];
  warnings: string[];
}

export type TripCleanupMode = 'retain' | 'archive';

export type TripCommandRunner = (script: string, args: string[], timeoutMs?: number) => Promise<string>;
export type TripSetupRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
) => Promise<string>;

export interface TripConsoleServiceOptions {
  commandRunner?: TripSetupRunner;
  restartHost?: () => Promise<unknown>;
  telegramBotLookup?: (token: string) => Promise<TripTelegramBotIdentity>;
}

export interface TripOnboardingInput {
  channel: 'telegram' | 'whatsapp';
  platformId: string;
  userId?: string;
  displayName?: string;
  chatName?: string;
  bot?: TripTelegramBotIdentity;
}

export interface TripOnboardingConsumed {
  platformId: string;
  isGroup: boolean;
  name: string | null;
  userId: string;
}

export type TripOnboardingChannel = 'telegram' | 'whatsapp';
export type TripOnboardingStatusValue =
  | 'preparing'
  | 'waiting'
  | 'consumed'
  | 'needs-group'
  | 'invalidated'
  | 'needs-token'
  | 'authenticated'
  | 'failed';

export interface TripOnboardingStatus {
  sessionId: string;
  channel: TripOnboardingChannel;
  status: TripOnboardingStatusValue;
  code?: string;
  pairingCode?: string;
  qrDataUrl?: string;
  error?: string;
  consumed?: TripOnboardingConsumed;
  hostRestart?: 'pending' | 'restarted' | 'failed';
  bot?: TripTelegramBotIdentity;
  instructions: string[];
}

export interface TripDiscoveredChat {
  id: number;
  platformId: string;
  name: string;
  isGroup: boolean;
  instance: string;
}

export interface TripDiscoveredUser {
  id: string;
  displayName: string;
  kind: string;
}

export interface TripDiscoveredChannel {
  channel: TripOnboardingChannel;
  chats: TripDiscoveredChat[];
  users: TripDiscoveredUser[];
}

interface TripOnboardingSession {
  id: string;
  channel: TripOnboardingChannel;
  status: TripOnboardingStatusValue;
  code?: string;
  pairingCode?: string;
  qr?: string;
  error?: string;
  consumed?: TripOnboardingConsumed;
  hostRestart?: 'pending' | 'restarted' | 'failed';
  bot?: TripTelegramBotIdentity;
  child?: ChildProcess;
  outputBuffer?: string;
}

const SAFE_ID = /^[a-z][a-z0-9-]{0,49}$/;

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function defaultTripDraft(): TripConsoleDraft {
  return {
    schema: 1,
    id: '',
    name: '',
    folder: '',
    model: 'sonnet',
    maxMessagesPerPrompt: 30,
    members: [{ user: '', displayName: '' }],
    wires: [{
      channel: 'cli',
      platformId: '',
      engageMode: 'pattern',
      engagePattern: '@trip',
      senderScope: 'known',
      ignoredMessagePolicy: 'accumulate',
      sessionMode: 'shared',
      name: '',
    }],
    updatedAt: new Date(0).toISOString(),
  };
}

export function deriveTripIdentity(input: TripConsoleDraft): TripConsoleDraft {
  const name = input.name.trim();
  const base = slugify(name) || 'new-trip';
  return {
    ...input,
    id: input.id.trim() || `ag-${base}`.slice(0, 50),
    name,
    folder: input.folder.trim() || base.slice(0, 64),
    model: input.model.trim(),
    members: input.members.map((member) => ({
      user: member.user.trim(),
      displayName: member.displayName.trim(),
    })),
    wires: input.wires.map((wire) => ({
      ...wire,
      channel: wire.channel.trim(),
      platformId: wire.platformId.trim(),
      engagePattern: wire.engagePattern.trim(),
      name: wire.name.trim(),
    })),
  };
}

function asTripAdminInput(input: TripConsoleDraft): Record<string, unknown> {
  const draft = deriveTripIdentity(input);
  return {
    name: draft.name,
    id: draft.id,
    folder: draft.folder,
    ...(draft.model ? { model: draft.model } : {}),
    maxMessagesPerPrompt: draft.maxMessagesPerPrompt,
    members: draft.members.map((member) => ({ user: member.user, ...(member.displayName ? { displayName: member.displayName } : {}) })),
    wires: draft.wires.map((wire) => ({
      channel: wire.channel,
      platformId: wire.platformId,
      engageMode: wire.engageMode,
      ...(wire.engagePattern ? { engagePattern: wire.engagePattern } : {}),
      senderScope: wire.senderScope,
      ignoredMessagePolicy: wire.ignoredMessagePolicy,
      sessionMode: wire.sessionMode,
      ...(wire.name ? { name: wire.name } : {}),
    })),
  };
}

export function validateTripDraft(input: TripConsoleDraft): TripDraftValidation {
  const parsed = parseTripConfig(asTripAdminInput(input));
  return { errors: parsed.errors, warnings: parsed.warnings };
}

export function buildTripConfig(input: TripConsoleDraft): TripConfig {
  const parsed = parseTripConfig(asTripAdminInput(input));
  if (!parsed.config) throw new Error(parsed.errors.join('\n'));
  return parsed.config;
}

function safeTripId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error('invalid trip application id');
  return value;
}

function errorText(error: unknown): string {
  const value = error as { stderr?: string; stdout?: string; message?: string };
  return String(value.stderr || value.stdout || value.message || error).trim().slice(0, 4000);
}

function canonicalTripUser(channel: string, userId: string): string {
  return userId.startsWith(`${channel}:`) ? userId : `${channel}:${userId}`;
}

/** Apply a browser-completed channel connection to the persisted trip draft. */
export function applyTripOnboarding(input: TripConsoleDraft, connection: TripOnboardingInput): TripConsoleDraft {
  const draft = deriveTripIdentity(input);
  const channel = connection.channel.trim().toLowerCase() as TripOnboardingChannel;
  if (channel !== 'telegram' && channel !== 'whatsapp') throw new Error('unsupported onboarding channel');
  if (channel === 'telegram' && connection.bot) draft.telegramBot = connection.bot;
  const rawPlatformId = connection.platformId.trim();
  if (rawPlatformId) {
    const platformId = normalizeTripWirePlatformId(channel, rawPlatformId);
    const existingWire = draft.wires.find((wire) => wire.channel === channel && wire.platformId === platformId);
    if (existingWire) {
      if (connection.chatName?.trim()) existingWire.name = connection.chatName.trim();
    } else {
      draft.wires.push({
        channel,
        platformId,
        engageMode: 'mention',
        engagePattern: '',
        senderScope: 'known',
        ignoredMessagePolicy: 'accumulate',
        sessionMode: 'shared',
        name: connection.chatName?.trim() ?? '',
      });
    }
  }

  if (connection.userId?.trim()) {
    const user = canonicalTripUser(channel, connection.userId.trim());
    const existingMember = draft.members.find((member) => member.user === user);
    if (existingMember) {
      if (connection.displayName?.trim()) existingMember.displayName = connection.displayName.trim();
    } else {
      const emptyMember = draft.members.find((member) => !member.user.trim());
      if (emptyMember) {
        emptyMember.user = user;
        emptyMember.displayName = connection.displayName?.trim() ?? '';
      } else {
        draft.members.push({ user, displayName: connection.displayName?.trim() ?? '' });
      }
    }
  }
  return deriveTripIdentity(draft);
}

export class TripConsoleStore {
  readonly root: string;
  readonly draftFile: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.draftFile = path.join(this.root, 'draft.json');
  }

  private ensure(): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  readDraft(): TripConsoleDraft | null {
    try {
      return JSON.parse(fs.readFileSync(this.draftFile, 'utf8')) as TripConsoleDraft;
    } catch {
      return null;
    }
  }

  saveDraft(input: TripConsoleDraft): TripConsoleDraft {
    this.ensure();
    const draft = { ...deriveTripIdentity(input), updatedAt: new Date().toISOString() };
    const temp = `${this.draftFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.draftFile);
    return draft;
  }

  configPath(id: string): string {
    safeTripId(id);
    const dir = path.join(this.root, 'configs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, `${id}.trip.json`);
  }

  saveConfig(config: TripConfig): string {
    const file = this.configPath(config.id);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    return file;
  }
}

export class TripConsoleService {
  readonly root: string;
  readonly store: TripConsoleStore;
  readonly tripAdminScript: string;
  readonly nclScript: string;
  readonly archiveScript: string;
  readonly tsxCli: string;
  private readonly runner: TripCommandRunner;
  private readonly commandRunner: TripSetupRunner;
  private readonly restartHost?: () => Promise<unknown>;
  private readonly telegramBotLookup: (token: string) => Promise<TripTelegramBotIdentity>;
  private readonly onboarding = new Map<string, TripOnboardingSession>();

  constructor(
    root: string,
    dataRoot = path.join(root, 'data', 'trip-companion-console'),
    runner?: TripCommandRunner,
    options: TripConsoleServiceOptions = {},
  ) {
    this.root = path.resolve(root);
    this.store = new TripConsoleStore(dataRoot);
    this.tripAdminScript = path.join(this.root, 'scripts', 'trip-admin.ts');
    this.nclScript = path.join(this.root, 'src', 'cli', 'client.ts');
    this.archiveScript = path.join(this.root, '.claude', 'skills', 'archive-trip', 'scripts', 'archive-trip.ts');
    this.tsxCli = path.join(this.root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    this.runner = runner ?? ((script, args, timeoutMs) => this.runTs(script, args, timeoutMs));
    this.commandRunner = options.commandRunner ?? ((command, args, timeoutMs, env) => this.runCommand(command, args, timeoutMs, env));
    this.restartHost = options.restartHost;
    this.telegramBotLookup = options.telegramBotLookup ?? ((token) => this.lookupTelegramBot(token));
  }

  private async runTs(script: string, args: string[], timeoutMs = 180_000): Promise<string> {
    const result = await exec(process.execPath, [this.tsxCli, script, ...args], {
      cwd: this.root,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return `${result.stdout}${result.stderr}`.trim();
  }

  private async runCommand(
    command: string,
    args: string[],
    timeoutMs = 300_000,
    env?: NodeJS.ProcessEnv,
  ): Promise<string> {
    const result = await exec(command, args, {
      cwd: this.root,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return `${result.stdout}${result.stderr}`.trim();
  }

  bootstrap(): { draft: TripConsoleDraft } {
    return { draft: this.store.readDraft() ?? defaultTripDraft() };
  }

  saveDraft(input: TripConsoleDraft): { draft: TripConsoleDraft; validation: TripDraftValidation } {
    const draft = this.store.saveDraft(input);
    return { draft, validation: validateTripDraft(draft) };
  }

  async instantiate(input: TripConsoleDraft): Promise<{ ok: true; id: string; output: string; warnings: string[] }> {
    const draft = this.store.saveDraft(input);
    const parsed = validateTripDraft(draft);
    if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
    const config = buildTripConfig(draft);
    const configPath = this.store.saveConfig(config);
    try {
      const output = await this.runner(this.tripAdminScript, ['apply', configPath], 300_000);
      return { ok: true, id: config.id, output, warnings: parsed.warnings };
    } catch (error) {
      throw new Error(errorText(error));
    }
  }

  async cleanup(
    id: string,
    mode: TripCleanupMode,
    confirmation: string,
  ): Promise<{ ok: true; mode: TripCleanupMode; output: string }> {
    safeTripId(id);
    if (confirmation !== id) throw new Error(`Type the exact application ID “${id}” to confirm cleanup.`);
    try {
      if (mode === 'retain') {
        const pause = await this.runner(this.nclScript, ['groups', 'pause', '--id', id, '--json'], 120_000);
        const deleted = await this.runner(this.tripAdminScript, ['delete', id, '--yes'], 180_000);
        return { ok: true, mode, output: `${pause}\n${deleted}`.trim() };
      }
      const output = await this.runner(this.archiveScript, ['archive', '--id', id, '--yes', '--json'], 300_000);
      return { ok: true, mode, output };
    } catch (error) {
      throw new Error(errorText(error));
    }
  }

  private newOnboardingSession(channel: TripOnboardingChannel): TripOnboardingSession {
    const session: TripOnboardingSession = {
      id: `trip-${channel}-${crypto.randomUUID()}`,
      channel,
      status: 'preparing',
    };
    this.onboarding.set(session.id, session);
    return session;
  }

  private telegramToken(): string | undefined {
    try {
      const text = fs.readFileSync(path.join(this.root, '.env'), 'utf8');
      for (const line of text.split('\n')) {
        const match = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/);
        if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
      }
    } catch {
      // The browser can supply the token during first-time setup.
    }
    return undefined;
  }

  private telegramAdapterReady(): boolean {
    try {
      return fs.existsSync(path.join(this.root, 'src', 'channels', 'telegram.ts'))
        && fs.readFileSync(path.join(this.root, 'src', 'channels', 'index.ts'), 'utf8').includes("import './telegram.js';")
        && fs.readFileSync(path.join(this.root, 'setup', 'index.ts'), 'utf8').includes("'pair-telegram'");
    } catch {
      return false;
    }
  }

  private whatsappAdapterReady(): boolean {
    try {
      return fs.existsSync(path.join(this.root, 'src', 'channels', 'whatsapp.ts'))
        && fs.existsSync(path.join(this.root, 'setup', 'whatsapp-auth.ts'))
        && fs.readFileSync(path.join(this.root, 'src', 'channels', 'index.ts'), 'utf8').includes("import './whatsapp.js';");
    } catch {
      return false;
    }
  }

  private async lookupTelegramBot(token: string): Promise<TripTelegramBotIdentity> {
    const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json() as {
      ok?: boolean;
      description?: string;
      result?: { id?: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
    };
    if (!response.ok || !payload.ok || !payload.result?.id || payload.result.is_bot === false) {
      throw new Error(payload.description || 'Telegram rejected this bot token. Copy the token for the bot that will join this trip group.');
    }
    const result = payload.result;
    return {
      id: String(result.id),
      username: result.username ? `@${result.username}` : '',
      displayName: [result.first_name, result.last_name].filter(Boolean).join(' ') || result.username || 'Telegram bot',
    };
  }

  private statusInstructions(session: TripOnboardingSession): string[] {
    if (session.channel === 'telegram') {
      if (session.status === 'needs-token') {
        return [
          'Open Telegram and message @BotFather.',
          'Send /newbot, choose the bot name and username, then copy the token for the bot that will be included in this trip group into the field above.',
          'The bot name is not required for authentication; the browser will read the verified name and @username from Telegram.',
        ];
      }
      if (session.status === 'waiting' && session.code) {
        const botLabel = session.bot?.username
          ? `${session.bot.username}${session.bot.displayName ? ` (${session.bot.displayName})` : ''}`
          : session.bot?.displayName || 'the verified Telegram bot';
        return [
          `This pairing is for ${botLabel}, the bot that will be included in this trip's Telegram group.`,
          'In Telegram, create a new private group for this trip.',
          `Add ${botLabel} and the first person who should administer the trip; keep the group private while pairing.`,
          `Send exactly ${session.code} in that group${this.telegramToken() ? '' : ' (the bot must be running first)'}.`,
          'If Group Privacy is enabled in BotFather, send it as @botname followed by a space and the four digits.',
          'Leave this page open; it will detect the pairing and fill the trip wire and first member automatically.',
        ];
      }
      if (session.status === 'consumed') {
        const botLabel = session.bot?.username
          ? `${session.bot.username}${session.bot.displayName ? ` (${session.bot.displayName})` : ''}`
          : session.bot?.displayName || 'the verified Telegram bot';
        return [
          `Telegram pairing succeeded for ${botLabel}. The exact chat ID and first paired user are ready to add to the trip draft.`,
          'The browser will save the canonical Telegram identities; no per-user Telegram token is needed.',
        ];
      }
      if (session.status === 'needs-group') {
        return [
          'The code was sent from a private Telegram chat, not a group.',
          'Create a new Telegram group containing the bot and the first trip participant, then start a new pairing here.',
        ];
      }
      if (session.status === 'invalidated') {
        return ['That one-time code was rejected and cannot be reused. Start a new Telegram pairing and send the new code exactly once.'];
      }
      if (session.status === 'failed') return [session.error ?? 'Telegram setup failed. Check the message above and start again.'];
      return ['Preparing the Telegram adapter and pairing service…'];
    }

    if (session.status === 'preparing') return ['Preparing the WhatsApp adapter in the background. Keep this page open.'];
    if (session.status === 'waiting') {
      const instructions = [
        'On the phone whose WhatsApp number will represent this assistant, open WhatsApp → Settings → Linked Devices → Link a Device.',
        session.pairingCode
          ? `Choose “Link with phone number instead” and enter ${session.pairingCode}.`
          : 'Scan the QR code shown below with that phone.',
        'When the link succeeds, this page will restart NanoClaw and confirm that the WhatsApp adapter is ready.',
      ];
      return instructions;
    }
    if (session.status === 'authenticated') {
      if (session.hostRestart === 'pending') return ['WhatsApp credentials are saved. Restarting NanoClaw now; keep this page open.'];
      if (session.hostRestart === 'failed') return [session.error ?? 'WhatsApp is linked, but NanoClaw could not be restarted automatically.'];
      return [
        'WhatsApp is authenticated and the host has been restarted.',
        'Now create a brand-new WhatsApp group containing the linked assistant number and the first participant.',
        'Send one message in that group, then use “Refresh discovered chats” below to select the exact group.',
        'Add each participant from the discovered identities list so the trip’s known-sender policy can allow them.',
      ];
    }
    return [session.error ?? 'WhatsApp setup failed. Start the browser setup again.'];
  }

  private async publicStatus(session: TripOnboardingSession): Promise<TripOnboardingStatus> {
    const status: TripOnboardingStatus = {
      sessionId: session.id,
      channel: session.channel,
      status: session.status,
      ...(session.code ? { code: session.code } : {}),
      ...(session.pairingCode ? { pairingCode: session.pairingCode } : {}),
      ...(session.error ? { error: session.error } : {}),
      ...(session.consumed ? { consumed: session.consumed } : {}),
      ...(session.hostRestart ? { hostRestart: session.hostRestart } : {}),
      ...(session.bot ? { bot: session.bot } : {}),
      instructions: this.statusInstructions(session),
    };
    if (session.qr) status.qrDataUrl = await QRCode.toDataURL(session.qr, { width: 360, margin: 1 });
    return status;
  }

  async startTelegramOnboarding(input: TripConsoleDraft, token = ''): Promise<TripOnboardingStatus> {
    const session = this.newOnboardingSession('telegram');
    const configuredToken = this.telegramToken();
    const suppliedToken = token.trim();
    if (!suppliedToken && !configuredToken) {
      session.status = 'needs-token';
      return this.publicStatus(session);
    }
    const selectedToken = suppliedToken || configuredToken || '';
    if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(selectedToken)) {
      session.status = 'failed';
      session.error = 'The Telegram bot token format is not valid. Copy the complete token from @BotFather.';
      return this.publicStatus(session);
    }

    try {
      session.bot = await this.telegramBotLookup(selectedToken);
      const needsSetup = !this.telegramAdapterReady() || Boolean(suppliedToken);
      if (needsSetup) {
        const output = await this.commandRunner(
          'bash',
          [path.join(this.root, 'setup', 'add-telegram.sh')],
          300_000,
          { TELEGRAM_BOT_TOKEN: selectedToken },
        );
        if (/STATUS:\s+failed/i.test(output)) throw new Error('Telegram adapter setup failed. Review the setup status and try again.');
      }
      const draft = deriveTripIdentity(input);
      const pairing = await createPairing({ kind: 'new-agent', folder: draft.folder });
      session.code = pairing.code;
      session.status = 'waiting';
      return this.publicStatus(session);
    } catch (error) {
      session.status = 'failed';
      session.error = errorText(error);
      return this.publicStatus(session);
    }
  }

  private updateTelegramSession(session: TripOnboardingSession): void {
    if (!session.code) return;
    const pairing = getPairing(session.code);
    if (!pairing) {
      session.status = 'failed';
      session.error = 'The pairing record disappeared. Start a new pairing.';
      return;
    }
    if (pairing.status === 'invalidated') {
      session.status = 'invalidated';
      return;
    }
    if (pairing.status !== 'consumed' || !pairing.consumed) return;
    const consumed = pairing.consumed;
    session.consumed = {
      platformId: normalizeTripWirePlatformId('telegram', consumed.platformId),
      isGroup: consumed.isGroup,
      name: consumed.name,
      userId: consumed.adminUserId ? canonicalTripUser('telegram', consumed.adminUserId) : '',
    };
    session.status = consumed.isGroup ? 'consumed' : 'needs-group';
  }

  async startWhatsAppOnboarding(method: 'qr' | 'pairing-code' = 'qr', phone = ''): Promise<TripOnboardingStatus> {
    const session = this.newOnboardingSession('whatsapp');
    const authFile = path.join(this.root, 'store', 'auth', 'creds.json');
    const suppliedPhone = phone.replace(/\D/g, '');
    if (method === 'pairing-code' && !/^\d{7,15}$/.test(suppliedPhone)) {
      session.status = 'failed';
      session.error = 'Enter the WhatsApp phone number in international format, digits only, before starting phone pairing.';
      return this.publicStatus(session);
    }
    try {
      if (!this.whatsappAdapterReady()) {
        const output = await this.commandRunner('bash', [path.join(this.root, 'setup', 'add-whatsapp.sh')], 300_000);
        if (/STATUS:\s+failed/i.test(output)) throw new Error('WhatsApp adapter setup failed. Review the setup status and try again.');
      }
      if (fs.existsSync(authFile)) {
        this.markWhatsAppAuthenticated(session);
        return this.publicStatus(session);
      }

      const args = [
        this.tsxCli,
        path.join(this.root, 'setup', 'index.ts'),
        '--step',
        'whatsapp-auth',
        '--',
        '--method',
        method,
        ...(method === 'pairing-code' ? ['--phone', suppliedPhone] : []),
      ];
      const child = spawn(process.execPath, args, {
        cwd: this.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      });
      session.child = child;
      session.status = 'waiting';
      child.stdout.on('data', (chunk: Buffer | string) => this.consumeWhatsAppOutput(session, String(chunk)));
      child.stderr.on('data', () => {
        // Setup diagnostics stay server-side; QR/pairing state is the browser contract.
      });
      child.once('error', (error) => {
        session.status = 'failed';
        session.error = errorText(error);
      });
      child.once('close', (code) => {
        session.child = undefined;
        if (session.status !== 'authenticated' && code !== 0) {
          session.status = 'failed';
          session.error = session.error ?? `WhatsApp authentication exited with code ${code ?? 'unknown'}.`;
        }
      });
      return this.publicStatus(session);
    } catch (error) {
      session.status = 'failed';
      session.error = errorText(error);
      return this.publicStatus(session);
    }
  }

  private consumeWhatsAppOutput(session: TripOnboardingSession, chunk: string): void {
    session.outputBuffer = `${session.outputBuffer ?? ''}${chunk}`;
    while (true) {
      const start = session.outputBuffer.indexOf('=== NANOCLAW SETUP: ');
      if (start < 0) {
        session.outputBuffer = session.outputBuffer.slice(-1000);
        return;
      }
      const endMarker = '=== END ===';
      const end = session.outputBuffer.indexOf(endMarker, start);
      if (end < 0) {
        session.outputBuffer = session.outputBuffer.slice(start);
        return;
      }
      const block = session.outputBuffer.slice(start, end + endMarker.length);
      session.outputBuffer = session.outputBuffer.slice(end + endMarker.length);
      const header = block.match(/^=== NANOCLAW SETUP: ([A-Z_]+) ===/);
      if (!header) continue;
      const fields = Object.fromEntries(
        block.split(/\r?\n/).flatMap((line) => {
          const match = line.match(/^([A-Z_]+):\s*(.*)$/);
          return match ? [[match[1], match[2]]] : [];
        }),
      );
      if (header[1] === 'WHATSAPP_AUTH_QR' && fields.QR) {
        session.qr = fields.QR;
        session.status = 'waiting';
      } else if (header[1] === 'WHATSAPP_AUTH_PAIRING_CODE' && fields.CODE) {
        session.pairingCode = fields.CODE;
        session.status = 'waiting';
      } else if (header[1] === 'WHATSAPP_AUTH') {
        if (fields.STATUS === 'success' || fields.STATUS === 'skipped') this.markWhatsAppAuthenticated(session);
        if (fields.STATUS === 'failed') {
          session.status = 'failed';
          session.error = fields.ERROR || 'WhatsApp authentication failed.';
        }
      }
    }
  }

  private markWhatsAppAuthenticated(session: TripOnboardingSession): void {
    session.status = 'authenticated';
    session.qr = undefined;
    if (!this.restartHost) {
      session.hostRestart = 'failed';
      session.error = 'WhatsApp credentials were saved, but the host restart action is unavailable.';
      return;
    }
    session.hostRestart = 'pending';
    void this.restartHost()
      .then(() => {
        session.hostRestart = 'restarted';
        session.error = undefined;
      })
      .catch((error) => {
        session.hostRestart = 'failed';
        session.error = `WhatsApp is linked, but NanoClaw could not restart automatically: ${errorText(error)}`;
      });
  }

  async onboardingStatus(sessionId: string): Promise<TripOnboardingStatus> {
    const session = this.onboarding.get(sessionId);
    if (!session) throw new Error('unknown channel onboarding session');
    if (session.channel === 'telegram') this.updateTelegramSession(session);
    return this.publicStatus(session);
  }

  applyOnboarding(input: TripConsoleDraft, connection: TripOnboardingInput): { draft: TripConsoleDraft; validation: TripDraftValidation } {
    const draft = this.store.saveDraft(applyTripOnboarding(input, connection));
    return { draft, validation: validateTripDraft(draft) };
  }

  discoverChannel(channel: TripOnboardingChannel): TripDiscoveredChannel {
    try {
      return withCentral((db) => {
        const chats = db.prepare(
          `SELECT id, platform_id, COALESCE(name, platform_id) AS name, is_group, COALESCE(instance, '') AS instance
           FROM messaging_groups WHERE channel_type = ? ORDER BY created_at DESC LIMIT 100`,
        ).all(channel) as Array<{ id: number; platform_id: string; name: string; is_group: number; instance: string }>;
        const users = db.prepare(
          `SELECT id, COALESCE(display_name, id) AS display_name, COALESCE(kind, '') AS kind
           FROM users WHERE id LIKE ? ORDER BY display_name, id LIMIT 200`,
        ).all(`${channel}:%`) as Array<{ id: string; display_name: string; kind: string }>;
        return {
          channel,
          chats: chats.map((chat) => ({
            id: chat.id,
            platformId: chat.platform_id,
            name: chat.name,
            isGroup: Boolean(chat.is_group),
            instance: chat.instance,
          })),
          users: users.map((user) => ({ id: user.id, displayName: user.display_name, kind: user.kind })),
        };
      });
    } catch {
      return { channel, chats: [], users: [] };
    }
  }
}
