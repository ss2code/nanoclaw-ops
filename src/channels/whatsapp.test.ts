/**
 * Regression coverage for #2560 — group @-mentions of the bot must set
 * `InboundMessage.isMention`. Before the fix, the inbound construction
 * site hard-coded `isMention: !isGroup ? true : undefined`, which dropped
 * every group mention on the floor and prevented the router from waking
 * the agent on a mention-only trigger.
 *
 * The detection logic lives in the exported pure helper `isBotMentionedInGroup`;
 * the inbound site calls it with `normalized`, `botPhoneJid`, `botLidUser`.
 * `isMention` is then computed as:
 *
 *   isMention: !isGroup ? true : botMentionedInGroup ? true : undefined
 *
 * Both the helper and the call-site ternary are covered below so a future
 * refactor that breaks either part fails this suite.
 */
import { describe, it, expect } from 'vitest';

import {
  appendMediaFailureNote,
  computeIsMention,
  groupEncryptionParticipantId,
  isBotMentionedInGroup,
  mimeTypeForDocumentExtension,
  parseWhatsAppMentions,
} from './whatsapp.js';

const BOT_PHONE_JID = '15550009999@s.whatsapp.net';
const BOT_LID_USER = '987654321';

describe('isBotMentionedInGroup (#2560)', () => {
  it('detects the bot phone JID in extendedTextMessage.contextInfo.mentionedJid', () => {
    const normalized = {
      extendedTextMessage: {
        text: 'hey @15550009999 take a look',
        contextInfo: { mentionedJid: [BOT_PHONE_JID] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(true);
  });

  it('returns false when the bot is not in mentionedJid', () => {
    const normalized = {
      extendedTextMessage: {
        text: 'hey @15551112222 take a look',
        contextInfo: { mentionedJid: ['15551112222@s.whatsapp.net'] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(false);
  });

  it('detects an LID-only mention when no phone JID is in the list', () => {
    // Modern WhatsApp clients increasingly emit the LID even when the
    // human typed a phone-number mention; the phone JID may not appear.
    const normalized = {
      extendedTextMessage: {
        contextInfo: { mentionedJid: [`${BOT_LID_USER}@lid`] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(true);
  });

  it('detects a mention in an image caption', () => {
    const normalized = {
      imageMessage: {
        caption: 'check this @15550009999',
        contextInfo: { mentionedJid: [BOT_PHONE_JID] },
      },
    };
    expect(isBotMentionedInGroup(normalized, BOT_PHONE_JID, BOT_LID_USER)).toBe(true);
  });

  it('returns false on an empty / missing mentionedJid array', () => {
    expect(isBotMentionedInGroup({}, BOT_PHONE_JID, BOT_LID_USER)).toBe(false);
    expect(
      isBotMentionedInGroup(
        { extendedTextMessage: { contextInfo: { mentionedJid: [] } } },
        BOT_PHONE_JID,
        BOT_LID_USER,
      ),
    ).toBe(false);
  });

  it('returns false when neither bot identifier is known', () => {
    const normalized = {
      extendedTextMessage: {
        contextInfo: { mentionedJid: [BOT_PHONE_JID, `${BOT_LID_USER}@lid`] },
      },
    };
    expect(isBotMentionedInGroup(normalized, undefined, undefined)).toBe(false);
  });
});

describe('InboundMessage.isMention semantics (#2560)', () => {
  it('is undefined for a group message with no bot mention', () => {
    expect(computeIsMention(true, false)).toBeUndefined();
  });

  it('is true for a group message where the bot is mentioned', () => {
    expect(computeIsMention(true, true)).toBe(true);
  });

  it('is true for a DM regardless of mention state', () => {
    // DMs are unconditionally mentions — the helper isn't consulted there.
    expect(computeIsMention(false, false)).toBe(true);
    expect(computeIsMention(false, true)).toBe(true);
  });
});

describe('groupEncryptionParticipantId', () => {
  it('preserves the native LID in an LID-addressed group', () => {
    expect(
      groupEncryptionParticipantId({
        id: '111000000000002@lid',
        phoneNumber: '915550000003@s.whatsapp.net',
      }),
    ).toBe('111000000000002@lid');
  });

  it('preserves the native phone JID in a PN-addressed group', () => {
    expect(
      groupEncryptionParticipantId({
        id: '915550000003@s.whatsapp.net',
        lid: '111000000000002@lid',
      }),
    ).toBe('915550000003@s.whatsapp.net');
  });
});

describe('mimeTypeForDocumentExtension', () => {
  it('sets real MIME types for documents Android should open directly', () => {
    expect(mimeTypeForDocumentExtension('.pdf')).toBe('application/pdf');
    expect(mimeTypeForDocumentExtension('.html')).toBe('text/html');
    expect(mimeTypeForDocumentExtension('.PDF')).toBe('application/pdf');
  });

  it('keeps unknown document extensions as generic binary', () => {
    expect(mimeTypeForDocumentExtension('.unknown')).toBe('application/octet-stream');
  });
});

describe('parseWhatsAppMentions', () => {
  it('returns empty mentions for plain text', () => {
    const { text, mentions } = parseWhatsAppMentions('hello there');
    expect(text).toBe('hello there');
    expect(mentions).toEqual([]);
  });

  it('extracts a single @<digits> mention into a JID', () => {
    const { text, mentions } = parseWhatsAppMentions('hey @15550000005 you around?');
    expect(text).toBe('hey @15550000005 you around?');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net']);
  });

  it('strips a leading + so the literal text matches the JID digits', () => {
    const { text, mentions } = parseWhatsAppMentions('ping @+15550000005 please');
    expect(text).toBe('ping @15550000005 please');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net']);
  });

  it('matches a mention at the start of the string', () => {
    const { text, mentions } = parseWhatsAppMentions('@15550000005 hi');
    expect(text).toBe('@15550000005 hi');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net']);
  });

  it('extracts multiple distinct mentions', () => {
    const { text, mentions } = parseWhatsAppMentions('cc @15550000005 and @15550000006');
    expect(text).toBe('cc @15550000005 and @15550000006');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net', '15550000006@s.whatsapp.net']);
  });

  it('deduplicates repeated mentions of the same number', () => {
    const { mentions } = parseWhatsAppMentions('@15550000005 ping @15550000005 again');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net']);
  });

  it('does not tag email-like patterns', () => {
    const { text, mentions } = parseWhatsAppMentions('write to test@1234567890.com');
    expect(text).toBe('write to test@1234567890.com');
    expect(mentions).toEqual([]);
  });

  it('does not tag sequences shorter than 5 digits', () => {
    const { text, mentions } = parseWhatsAppMentions('see issue @123 for details');
    expect(text).toBe('see issue @123 for details');
    expect(mentions).toEqual([]);
  });

  it('handles punctuation directly after the digits', () => {
    const { text, mentions } = parseWhatsAppMentions('thanks @15550000005!');
    expect(text).toBe('thanks @15550000005!');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net']);
  });

  it('handles parenthesized mentions', () => {
    const { text, mentions } = parseWhatsAppMentions('(@15550000005) wrote this');
    expect(text).toBe('(@15550000005) wrote this');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net']);
  });

  it('resolves known LID digits to a phone-number mention', () => {
    const { text, mentions } = parseWhatsAppMentions('Hi @111000000000004', (digits) =>
      digits === '111000000000004' ? '15550000005@s.whatsapp.net' : undefined,
    );
    expect(text).toBe('Hi @15550000005');
    expect(mentions).toEqual(['15550000005@s.whatsapp.net']);
  });
});

describe('appendMediaFailureNote', () => {
  it('returns content unchanged when nothing failed', () => {
    expect(appendMediaFailureNote('hello', [])).toBe('hello');
  });

  it('appends the note on its own line when a captioned message has a failed download', () => {
    expect(appendMediaFailureNote('check this out', ['image'])).toBe('check this out\n[image could not be downloaded]');
  });

  it('uses the note as the content when an uncaptioned media message fails (would otherwise be dropped)', () => {
    // Regression guard: an uncaptioned image whose download fails must still
    // produce a non-empty message, or the empty-message guard skips it and the
    // agent never learns media was sent.
    expect(appendMediaFailureNote('', ['image'])).toBe('[image could not be downloaded]');
  });

  it('lists each failed media type when several fail together', () => {
    expect(appendMediaFailureNote('', ['image', 'document'])).toBe(
      '[image could not be downloaded] [document could not be downloaded]',
    );
  });
});
