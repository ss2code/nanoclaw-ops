/**
 * Ingest-time voice-note transcription.
 *
 * Called by the router after the messaging group is resolved and before
 * fan-out, when the group's voice_transcription flag is 'on'. Mutates the
 * event's content JSON in place: each audio attachment's transcript is
 * appended to the message text, so every wired agent (and the message
 * record itself — searchable history, accumulate-mode context) sees text
 * instead of an opaque audio file.
 *
 * Failure is always soft: a failed transcription appends a visible marker
 * and routing continues. Nothing here may throw across the module boundary.
 *
 * The host-side audio copy under data/attachments/ is deleted only for
 * successfully transcribed files, and only AFTER fan-out completes (the
 * router calls cleanupTranscribedAudio) — attachment staging into session
 * inboxes happens synchronously during fan-out.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { transcribeAudio } from './gateway.js';

const AUDIO_EXTENSIONS: Record<string, string> = {
  '.ogg': 'ogg',
  '.opus': 'ogg',
  '.mp3': 'mp3',
  '.m4a': 'm4a',
  '.aac': 'aac',
  '.wav': 'wav',
  '.webm': 'webm',
  '.flac': 'flac',
};

/** Voice notes are ~150 KB/min (Opus). Anything past this is not a voice
 *  note — skip rather than ship megabytes of base64 through the gateway. */
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

interface Attachment {
  type?: string;
  name?: string;
  localPath?: string;
}

/** An attachment is audio when the adapter says so or the extension does. */
function audioFormat(att: Attachment): string | null {
  const ext = path.extname(att.name ?? att.localPath ?? '').toLowerCase();
  if (AUDIO_EXTENSIONS[ext]) return AUDIO_EXTENSIONS[ext];
  if (att.type === 'audio' || att.type === 'voice') return 'ogg';
  return null;
}

/**
 * Transcribe every audio attachment on the event and fold the transcripts
 * into the content text. Returns host-side file paths that were successfully
 * transcribed (candidates for post-fan-out cleanup). Never throws.
 */
export async function transcribeInboundAudio(message: { content: unknown }): Promise<string[]> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(typeof message.content === 'string' ? message.content : '{}') as Record<string, unknown>;
  } catch {
    return [];
  }
  const attachments = parsed.attachments as Attachment[] | undefined;
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const transcribedPaths: string[] = [];
  const notes: string[] = [];
  // Successfully transcribed attachments are REMOVED from the message: the
  // host-side audio file gets deleted after fan-out, so leaving the reference
  // would hand agents a dangling path they'll waste a turn hunting for (and
  // then report as "attachment went missing"). The transcript replaces the
  // audio outright. Failed/skipped attachments keep their reference — the
  // file also stays on disk in those cases.
  const transcribed = new Set<Attachment>();

  for (const att of attachments) {
    const format = audioFormat(att);
    if (!format || !att.localPath) continue;

    // localPath is relative to DATA_DIR by adapter convention
    // (e.g. "attachments/audio-123.ogg"). Refuse anything that escapes.
    const filePath = path.resolve(DATA_DIR, att.localPath);
    if (!filePath.startsWith(path.resolve(DATA_DIR) + path.sep)) {
      log.warn('Audio attachment path escapes data dir, skipping transcription', { localPath: att.localPath });
      continue;
    }

    let audio: Buffer;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_AUDIO_BYTES) {
        log.info('Audio attachment too large for transcription, skipping', {
          name: att.name,
          size: stat.size,
        });
        continue;
      }
      audio = fs.readFileSync(filePath);
    } catch (err) {
      log.warn('Audio attachment unreadable, skipping transcription', { localPath: att.localPath, err });
      continue;
    }

    const started = Date.now();
    try {
      const result = await transcribeAudio(audio, format);
      notes.push(`[voice note transcript]: ${result.text}`);
      transcribedPaths.push(filePath);
      transcribed.add(att);
      log.info('Voice note transcribed at ingest', {
        name: att.name,
        seconds: result.seconds,
        cost: result.cost,
        ms: Date.now() - started,
      });
    } catch (err) {
      notes.push('[voice note attached — transcription failed]');
      log.warn('Voice note transcription failed, routing continues', {
        name: att.name,
        ms: Date.now() - started,
        err,
      });
    }
  }

  if (notes.length === 0) return transcribedPaths;

  const remaining = attachments.filter((a) => !transcribed.has(a));
  if (remaining.length > 0) parsed.attachments = remaining;
  else delete parsed.attachments;

  const text = typeof parsed.text === 'string' ? parsed.text : '';
  parsed.text = text ? `${text}\n\n${notes.join('\n')}` : notes.join('\n');
  message.content = JSON.stringify(parsed);
  return transcribedPaths;
}

/** Delete host-side audio copies after fan-out staged everything. Best-effort. */
export function cleanupTranscribedAudio(paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
      log.debug('Deleted transcribed audio from host attachments', { path: p });
    } catch (err) {
      log.warn('Failed to delete transcribed audio', { path: p, err });
    }
  }
}
