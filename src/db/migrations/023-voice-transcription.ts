/**
 * Per-messaging-group voice-note transcription toggle.
 *
 *   voice_transcription  'on' | 'off'  (default 'on')
 *
 * When 'on', the router transcribes inbound audio attachments at ingest
 * (host-side, via the OneCLI gateway → OpenRouter) and embeds the transcript
 * in the message text before fan-out. 'off' is the privacy switch: audio
 * passes through untouched and never leaves the machine.
 *
 * Default is 'on' because the owner's stated model is "transcribe everywhere,
 * flip off per chat when I want privacy" — the off switch (ncl / Ops Center)
 * is the mechanism, not the default.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  name: 'voice-transcription',
  up: (db: Database.Database) => {
    // Idempotent guard, same pattern as migration 012: fresh installs get the
    // column from schema.ts, so ALTER only when it's actually missing.
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'voice_transcription')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN voice_transcription TEXT NOT NULL DEFAULT 'on'`);
    }
  },
};
