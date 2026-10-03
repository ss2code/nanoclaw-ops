import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LINT = path.resolve(__dirname, 'pii-lint.sh');

/**
 * Offending fixtures are assembled at runtime so this source file never
 * contains a string the lint itself would flag.
 */
const j = (...parts: string[]) => parts.join('');

function runOnContent(content: string): { code: number; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pii-lint-'));
  const file = path.join(dir, 'sample.txt');
  writeFileSync(file, content);
  try {
    const out = execFileSync('bash', [LINT, '--files', file], {
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('pii-lint generic patterns', () => {
  it('flags Indian mobile numbers', () => {
    const r = runOnContent(j('contact me at 91', '98123', '45678 ok'));
    expect(r.code).toBe(1);
  });

  it('flags real-shaped WhatsApp phone JIDs', () => {
    const r = runOnContent(j('9198', '7654', '3210', '@s.whatsapp.net'));
    expect(r.code).toBe(1);
  });

  it('allows the fake WhatsApp ranges', () => {
    const r = runOnContent(
      '15550000005@s.whatsapp.net and 915550000005@s.whatsapp.net',
    );
    expect(r.code).toBe(0);
  });

  it('flags real-shaped group JIDs but allows the fake range', () => {
    expect(runOnContent(j('1203634', '11223344556', '@g.us')).code).toBe(1);
    expect(runOnContent('120363000000000111@g.us').code).toBe(0);
  });

  it('flags LIDs but allows the fake range', () => {
    expect(runOnContent(j('2287972', '53177430', '@lid')).code).toBe(1);
    expect(runOnContent('111000000000002@lid').code).toBe(0);
  });

  it('flags personal-provider emails', () => {
    const r = runOnContent(j('someone', '@gmail', '.com'));
    expect(r.code).toBe(1);
  });

  it('flags absolute home paths', () => {
    const r = runOnContent(j('/Users/', 'somebody', '/Dev/project'));
    expect(r.code).toBe(1);
  });

  it('flags credential shapes', () => {
    expect(runOnContent(j('sk-ant-', 'a'.repeat(24))).code).toBe(1);
    expect(runOnContent(j('ghp_', 'A1'.repeat(12))).code).toBe(1);
    expect(runOnContent(j('AKIA', 'ABCDEFGHIJKLMNOP')).code).toBe(1);
  });

  it('honors the pii-lint-allow escape hatch', () => {
    const r = runOnContent(
      j('/Users/', 'somebody', '/x', ' ', 'pii-lint', '-allow: doc example'),
    );
    expect(r.code).toBe(0);
  });

  it('does not flag standard container/placeholder home paths', () => {
    expect(runOnContent('mount at /home/node/.codex readonly').code).toBe(0);
    expect(runOnContent(j('/Users/', 'you', '/nanoclaw-workspace')).code).toBe(0);
  });

  it('passes clean content', () => {
    const r = runOnContent('nothing sensitive here\njust code\n');
    expect(r.code).toBe(0);
  });

  it('passes a staged binary file plus clean text (--staged)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pii-staged-'));
    const run = (cmd: string, args: string[]) =>
      execFileSync(cmd, args, { cwd: dir, encoding: 'utf8' });
    run('git', ['init', '-q']);
    run('git', ['config', 'user.email', 'test@example.org']);
    run('git', ['config', 'user.name', 'Test']);
    writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 255, 254, 0, 10]));
    writeFileSync(path.join(dir, 'clean.txt'), 'nothing here\n');
    run('git', ['add', 'blob.bin', 'clean.txt']);
    // Run the real script but point its git at the temp repo by copying it in.
    const lintCopy = path.join(dir, 'scripts', 'pii-lint.sh');
    run('mkdir', ['-p', path.join(dir, 'scripts')]);
    writeFileSync(lintCopy, require('node:fs').readFileSync(LINT, 'utf8'));
    const out = execFileSync('bash', [lintCopy, '--staged'], { cwd: dir, encoding: 'utf8' });
    expect(out).toBe('');
  });

  it('still fails --staged when a staged text file has PII', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pii-staged2-'));
    const run = (cmd: string, args: string[]) =>
      execFileSync(cmd, args, { cwd: dir, encoding: 'utf8' });
    run('git', ['init', '-q']);
    writeFileSync(path.join(dir, 'bad.txt'), j('call 91', '98123', '45678 now\n'));
    run('git', ['add', 'bad.txt']);
    const lintCopy = path.join(dir, 'scripts', 'pii-lint.sh');
    run('mkdir', ['-p', path.join(dir, 'scripts')]);
    writeFileSync(lintCopy, require('node:fs').readFileSync(LINT, 'utf8'));
    let code = 0;
    try {
      execFileSync('bash', [lintCopy, '--staged'], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
  });

  it('scans commit message files via --message', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pii-msg-'));
    const msg = path.join(dir, 'COMMIT_EDITMSG');
    writeFileSync(msg, j('fix session for 91', '98765', '43210', '\n\nbody\n'));
    let code = 0;
    try {
      execFileSync('bash', [LINT, '--message', msg], { encoding: 'utf8' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
  });
});
