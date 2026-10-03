import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { _setStorePathForTest, getPairing, tryConsume } from '../src/channels/telegram-pairing.js';

import {
  TripConsoleService,
  applyTripOnboarding,
  buildTripConfig,
  defaultTripDraft,
  deriveTripIdentity,
  validateTripDraft,
} from './trips-console.js';

function validDraft() {
  const draft = defaultTripDraft();
  draft.name = 'Goa 2026';
  draft.members = [{ user: 'telegram:12345', displayName: 'Alice' }];
  draft.wires = [{
    channel: 'cli',
    platformId: 'goa-2026-dev',
    engageMode: 'pattern',
    engagePattern: '@trip',
    senderScope: 'known',
    ignoredMessagePolicy: 'accumulate',
    sessionMode: 'shared',
    name: 'Goa development chat',
  }];
  return draft;
}

describe('Trip Companion Ops Center console', () => {
  it('derives the same stable identity shape as the trip admin workflow', () => {
    const draft = defaultTripDraft();
    draft.name = 'Summer in Goa';
    expect(deriveTripIdentity(draft)).toMatchObject({
      id: 'ag-summer-in-goa',
      folder: 'summer-in-goa',
    });
  });

  it('validates drafts through the trip-admin config contract', () => {
    const draft = validDraft();
    expect(validateTripDraft(draft)).toEqual({ errors: [], warnings: [] });
    expect(buildTripConfig(draft)).toMatchObject({
      id: 'ag-goa-2026',
      folder: 'goa-2026',
      members: [{ user: 'telegram:12345' }],
      wires: [{ channel: 'cli', platformId: 'goa-2026-dev' }],
    });
  });

  it('uses typed confirmation and the existing scripts for instantiate and cleanup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-console-'));
    const calls: Array<{ script: string; args: string[] }> = [];
    const runner = async (script: string, args: string[]) => {
      calls.push({ script, args });
      return 'ok';
    };
    try {
      const service = new TripConsoleService(root, path.join(root, 'console-data'), runner);
      const created = await service.instantiate(validDraft());
      expect(created.id).toBe('ag-goa-2026');
      expect(calls[0].script).toContain('scripts/trip-admin.ts');
      expect(calls[0].args[0]).toBe('apply');
      await expect(service.cleanup('ag-goa-2026', 'retain', 'wrong-id')).rejects.toThrow(/exact application ID/);
      await service.cleanup('ag-goa-2026', 'retain', 'ag-goa-2026');
      expect(calls[1].args.slice(0, 3)).toEqual(['groups', 'pause', '--id']);
      expect(calls[2].args).toEqual(['delete', 'ag-goa-2026', '--yes']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts and observes the real Telegram pairing record without console input', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-telegram-pairing-'));
    const pairingStore = path.join(root, 'telegram-pairings.json');
    const calls: string[] = [];
    _setStorePathForTest(pairingStore);
    fs.writeFileSync(path.join(root, '.env'), 'TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJK\n');
    try {
      const service = new TripConsoleService(
        root,
        path.join(root, 'console-data'),
        async () => '=== NANOCLAW SETUP: ADD_TELEGRAM ===\nSTATUS: success\n=== END ===',
        {
          commandRunner: async (command, args) => {
            calls.push([command, ...args].join(' '));
            return 'STATUS: success';
          },
          telegramBotLookup: async () => ({
            id: '987654321',
            username: '@goa_trip_bot',
            displayName: 'Goa Trip Assistant',
          }),
        },
      );
      const started = await service.startTelegramOnboarding(validDraft(), '123456789:abcdefghijklmnopqrstuvwxyzABCDEFGHIJK');
      expect(started.status).toBe('waiting');
      expect(started.code).toMatch(/^\d{4}$/);
      expect(started.bot).toEqual({ id: '987654321', username: '@goa_trip_bot', displayName: 'Goa Trip Assistant' });
      expect(calls[0]).toContain('add-telegram.sh');
      expect(getPairing(started.code!)).toMatchObject({ intent: { kind: 'new-agent', folder: 'goa-2026' } });

      await tryConsume({
        text: started.code!,
        botUsername: 'goa_trip_bot',
        platformId: '-100987654321',
        isGroup: true,
        name: 'Goa 2026',
        adminUserId: '12345',
      });
      const completed = await service.onboardingStatus(started.sessionId);
      expect(completed.status).toBe('consumed');
      expect(completed.bot?.username).toBe('@goa_trip_bot');
      expect(completed.consumed).toMatchObject({
        platformId: 'telegram:-100987654321',
        userId: 'telegram:12345',
        isGroup: true,
      });
    } finally {
      _setStorePathForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the established read-only trip detail views beneath the live agent card', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'ops-center', 'server.ts'), 'utf8');
    expect(server).toContain('Domain and runner details');
    expect(server).toContain('Database inventory');
    expect(server).toContain('Recent operational messages');
  });

  it('puts external channel setup before the NanoClaw form', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'ops-center', 'server.ts'), 'utf8');
    expect(server).toContain('This browser orchestrates the NanoClaw-side setup');
    expect(server).toContain('BotFather');
    expect(server).toContain('there is no per-user Telegram token');
    expect(server).toContain('There is no WhatsApp bot token');
    expect(server).toContain('Start Telegram setup');
    expect(server).toContain('Refresh discovered chats');
    expect(server).toContain('Token for this trip’s Telegram bot');
    expect(server).toContain('The bot name is not required');
    expect(server).toContain('Telegram bot for this group');
    expect(server).not.toContain('pnpm exec tsx setup/index.ts --step pair-telegram');
    expect(server).not.toContain('pnpm exec tsx setup/index.ts --step whatsapp-auth');
  });

  it('merges a paired channel into the draft using canonical identities', () => {
    const draft = validDraft();
    const merged = applyTripOnboarding(draft, {
      channel: 'telegram',
      platformId: '-100987654321',
      userId: '12345',
      displayName: 'Alice',
      chatName: 'Goa 2026',
      bot: { id: '987654321', username: '@goa_trip_bot', displayName: 'Goa Trip Assistant' },
    });
    expect(merged.wires.at(-1)).toMatchObject({
      channel: 'telegram',
      platformId: 'telegram:-100987654321',
      engageMode: 'mention',
    });
    expect(merged.members).toContainEqual({ user: 'telegram:12345', displayName: 'Alice' });
    expect(merged.telegramBot).toEqual({ id: '987654321', username: '@goa_trip_bot', displayName: 'Goa Trip Assistant' });
  });

  it('does not duplicate an already connected channel or participant', () => {
    const draft = validDraft();
    draft.wires.push({
      channel: 'whatsapp',
      platformId: '120363000000000111@g.us',
      engageMode: 'mention',
      engagePattern: '',
      senderScope: 'known',
      ignoredMessagePolicy: 'accumulate',
      sessionMode: 'shared',
      name: 'Existing group',
    });
    draft.members.push({ user: 'whatsapp:15550000005@s.whatsapp.net', displayName: 'Bob' });
    const merged = applyTripOnboarding(draft, {
      channel: 'whatsapp',
      platformId: '120363000000000111@g.us',
      userId: '15550000005@s.whatsapp.net',
      displayName: 'Bob',
      chatName: 'Existing group',
    });
    expect(merged.wires.filter((wire) => wire.channel === 'whatsapp')).toHaveLength(1);
    expect(merged.members.filter((member) => member.user === 'whatsapp:15550000005@s.whatsapp.net')).toHaveLength(1);
  });
});
