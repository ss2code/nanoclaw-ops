import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcription-test-'));

vi.mock('../../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: tmpDataDir };
});

const transcribeAudio = vi.fn();
vi.mock('./gateway.js', () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudio(...args),
}));

const { transcribeInboundAudio, cleanupTranscribedAudio } = await import('./index.js');

function writeAudioFixture(name: string): string {
  const dir = path.join(tmpDataDir, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from('fake-opus-bytes'));
  return p;
}

function makeMessage(content: Record<string, unknown>): { content: unknown } {
  return { content: JSON.stringify(content) };
}

beforeEach(() => {
  transcribeAudio.mockReset();
});

afterEach(() => {
  fs.rmSync(path.join(tmpDataDir, 'attachments'), { recursive: true, force: true });
});

describe('transcribeInboundAudio', () => {
  it('appends the transcript to empty text and returns the file path', async () => {
    const filePath = writeAudioFixture('voice-1.ogg');
    transcribeAudio.mockResolvedValue({ text: 'pick up the laundry', seconds: 4, cost: 0.0001 });

    const msg = makeMessage({
      text: '',
      sender: '911234@s.whatsapp.net',
      attachments: [{ type: 'audio', name: 'voice-1.ogg', localPath: 'attachments/voice-1.ogg' }],
    });
    const paths = await transcribeInboundAudio(msg);

    expect(paths).toEqual([filePath]);
    const parsed = JSON.parse(msg.content as string);
    expect(parsed.text).toBe('[voice note transcript]: pick up the laundry');
    expect(parsed.sender).toBe('911234@s.whatsapp.net'); // other fields preserved
    // Attachment reference removed — the file gets deleted post-fan-out, so a
    // kept reference would be a dangling path agents waste a turn hunting for.
    expect(parsed.attachments).toBeUndefined();
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'ogg');
  });

  it('appends below an existing caption', async () => {
    writeAudioFixture('voice-2.ogg');
    transcribeAudio.mockResolvedValue({ text: 'hello', seconds: 1, cost: 0 });

    const msg = makeMessage({
      text: 'listen to this',
      attachments: [{ type: 'audio', name: 'voice-2.ogg', localPath: 'attachments/voice-2.ogg' }],
    });
    await transcribeInboundAudio(msg);

    expect(JSON.parse(msg.content as string).text).toBe('listen to this\n\n[voice note transcript]: hello');
  });

  it('marks failure visibly, keeps routing data intact, returns no cleanup paths', async () => {
    writeAudioFixture('voice-3.ogg');
    transcribeAudio.mockRejectedValue(new Error('gateway down'));

    const msg = makeMessage({
      text: '',
      attachments: [{ type: 'audio', name: 'voice-3.ogg', localPath: 'attachments/voice-3.ogg' }],
    });
    const paths = await transcribeInboundAudio(msg);

    expect(paths).toEqual([]);
    const parsed = JSON.parse(msg.content as string);
    expect(parsed.text).toBe('[voice note attached — transcription failed]');
    expect(parsed.attachments).toHaveLength(1); // failed: reference kept, file stays
  });

  it('ignores non-audio attachments and messages without attachments', async () => {
    const msg1 = makeMessage({
      text: 'hi',
      attachments: [{ type: 'image', name: 'a.jpg', localPath: 'attachments/a.jpg' }],
    });
    expect(await transcribeInboundAudio(msg1)).toEqual([]);
    expect(msg1.content).toBe(
      JSON.stringify({ text: 'hi', attachments: [{ type: 'image', name: 'a.jpg', localPath: 'attachments/a.jpg' }] }),
    );

    const msg2 = makeMessage({ text: 'hi' });
    expect(await transcribeInboundAudio(msg2)).toEqual([]);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('detects audio by extension when type is missing', async () => {
    writeAudioFixture('note.m4a');
    transcribeAudio.mockResolvedValue({ text: 'x', seconds: 1, cost: 0 });
    const msg = makeMessage({ text: '', attachments: [{ name: 'note.m4a', localPath: 'attachments/note.m4a' }] });
    await transcribeInboundAudio(msg);
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), 'm4a');
  });

  it('refuses localPath escaping the data dir', async () => {
    transcribeAudio.mockResolvedValue({ text: 'x', seconds: 1, cost: 0 });
    const msg = makeMessage({
      text: '',
      attachments: [{ type: 'audio', name: 'evil.ogg', localPath: '../../../etc/passwd.ogg' }],
    });
    expect(await transcribeInboundAudio(msg)).toEqual([]);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('skips unreadable files without failing the message', async () => {
    const msg = makeMessage({
      text: 'caption',
      attachments: [{ type: 'audio', name: 'gone.ogg', localPath: 'attachments/gone.ogg' }],
    });
    expect(await transcribeInboundAudio(msg)).toEqual([]);
    // no marker for a file that never existed locally — nothing was attempted
    expect(JSON.parse(msg.content as string).text).toBe('caption');
  });

  it('tolerates non-JSON content', async () => {
    const msg = { content: 'plain text' };
    expect(await transcribeInboundAudio(msg)).toEqual([]);
  });
});

describe('mixed attachments', () => {
  it('removes only the transcribed audio, keeping other attachments', async () => {
    writeAudioFixture('mix.ogg');
    transcribeAudio.mockResolvedValue({ text: 'x', seconds: 1, cost: 0 });
    const msg = makeMessage({
      text: '',
      attachments: [
        { type: 'audio', name: 'mix.ogg', localPath: 'attachments/mix.ogg' },
        { type: 'image', name: 'pic.jpg', localPath: 'attachments/pic.jpg' },
      ],
    });
    await transcribeInboundAudio(msg);
    const parsed = JSON.parse(msg.content as string);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('pic.jpg');
  });
});

describe('cleanupTranscribedAudio', () => {
  it('deletes listed files and survives missing ones', () => {
    const p = writeAudioFixture('done.ogg');
    cleanupTranscribedAudio([p, path.join(tmpDataDir, 'attachments', 'never-existed.ogg')]);
    expect(fs.existsSync(p)).toBe(false);
  });
});
