import { describe, expect, it } from 'vitest';
import { normalizeTripWirePlatformId, parseTripConfig } from './trip-admin.js';

const valid = {
  name: 'Goa 2026',
  model: 'sonnet',
  members: [{ user: 'telegram:5550001111', displayName: 'Alice' }],
  wires: [{ channel: 'cli', platformId: 'goa-sim' }],
};

describe('parseTripConfig', () => {
  it('normalizes Chat SDK IDs while preserving native WhatsApp JIDs', () => {
    expect(normalizeTripWirePlatformId('telegram', '-100123')).toBe('telegram:-100123');
    expect(normalizeTripWirePlatformId('telegram', 'telegram:-100123')).toBe('telegram:-100123');
    expect(normalizeTripWirePlatformId('whatsapp', '120363000000000111@g.us')).toBe('120363000000000111@g.us');
    expect(normalizeTripWirePlatformId('whatsapp', '15550000005@s.whatsapp.net')).toBe('15550000005@s.whatsapp.net');
  });

  it('accepts a minimal valid config and derives id/folder from the name', () => {
    const { config, errors } = parseTripConfig(valid);
    expect(errors).toEqual([]);
    expect(config).not.toBeNull();
    expect(config!.id).toBe('ag-goa-2026');
    expect(config!.folder).toBe('goa-2026');
  });

  it('defaults to context-aware mention: CLI pattern/@trip, real channels mention + accumulate, max 30', () => {
    const { config } = parseTripConfig({
      ...valid,
      wires: [
        { channel: 'cli', platformId: 'x' },
        { channel: 'telegram', platformId: '-100123' },
      ],
    });
    // CLI can't set isMention, so it stays pattern (@trip) — the dev/test transport.
    expect(config!.wires[0]).toMatchObject({ engageMode: 'pattern', engagePattern: '@trip', senderScope: 'known' });
    // design §4: real channels wake only on @mention; un-mentioned chatter is
    // accumulated (banked, wake=0), not dropped.
    expect(config!.wires[1]).toMatchObject({ engageMode: 'mention', ignoredMessagePolicy: 'accumulate' });
    expect(config!.maxMessagesPerPrompt).toBe(30);
  });

  it('rejects ids that violate the OneCLI identifier rule (must start with a letter)', () => {
    const { config, errors } = parseTripConfig({ ...valid, id: '63e88f9b-bad' });
    expect(config).toBeNull();
    expect(errors.join()).toMatch(/start with a letter/);
  });

  it('rejects empty members and empty wires with actionable messages', () => {
    const { errors } = parseTripConfig({ name: 'X', members: [], wires: [] });
    expect(errors.join()).toMatch(/nobody can talk/);
    expect(errors.join()).toMatch(/never receive a message/);
  });

  it('rejects malformed user ids', () => {
    const { errors } = parseTripConfig({ ...valid, members: [{ user: 'alice' }] });
    expect(errors.join()).toMatch(/<channel>:<handle>/);
  });

  it('rejects invalid engage regex', () => {
    const { errors } = parseTripConfig({
      ...valid,
      wires: [{ channel: 'cli', platformId: 'x', engageMode: 'pattern', engagePattern: '([' }],
    });
    expect(errors.join()).toMatch(/not a valid regex/);
  });

  it('warns (not errors) on mention modes for CLI wires, which can never engage', () => {
    const { config, warnings } = parseTripConfig({
      ...valid,
      wires: [{ channel: 'cli', platformId: 'x', engageMode: 'mention-sticky' }],
    });
    expect(config).not.toBeNull();
    expect(warnings.join()).toMatch(/never sets isMention/);
  });

  it('dedupes duplicate members and wires with warnings', () => {
    const { config, warnings } = parseTripConfig({
      ...valid,
      members: [{ user: 'cli:a' }, { user: 'cli:a' }],
      wires: [
        { channel: 'cli', platformId: 'x' },
        { channel: 'cli', platformId: 'x' },
      ],
    });
    expect(config!.members).toHaveLength(1);
    expect(config!.wires).toHaveLength(1);
    expect(warnings.join()).toMatch(/duplicate/);
  });
});
