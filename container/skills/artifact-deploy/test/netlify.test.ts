import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  contentSample,
  createNetlifyBundle,
  encryptHtml,
  generatePassphrase,
  manifest,
  NetlifyApi,
  verifyEncryptedUrl,
} from '../scripts/netlify';

let dir = '';
const originalFetch = globalThis.fetch;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
  globalThis.fetch = originalFetch;
});

// Mirror the browser decryptor's WebCrypto steps, to prove the Node-side
// encryptHtml output is decryptable by the exact logic shipped in the page.
async function webDecrypt(env: ReturnType<typeof encryptHtml>, pass: string): Promise<string> {
  const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(env.kdf.salt), iterations: env.kdf.iterations, hash: env.kdf.hash },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.cipher.iv) }, key, b64(env.data));
  return new TextDecoder().decode(pt);
}

describe('netlify bundle', () => {
  test('unprotected bundle ships the raw HTML and version.json', () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-deploy-'));
    const html = join(dir, 'doc.html');
    writeFileSync(html, '<!doctype html><meta name="doc-version" content="7"><h1>PLAINTEXT-DOC</h1>');
    const out = join(dir, 'out');
    const bundle = createNetlifyBundle({ input: html, outDir: out, slug: 'doc', version: 7, summary: 'changed route', updatedAt: '2026-07-08T00:00:00Z' });
    expect(bundle.protected).toBe(false);
    expect(bundle.files.map((f) => f.path).sort()).toEqual(['index.html', 'version.json']);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('PLAINTEXT-DOC');
    const files = manifest(bundle.files);
    expect(Object.prototype.hasOwnProperty.call(files, '/index.html')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(files, '/version.json')).toBe(true);
  });

  test('protected bundle encrypts: no plaintext, no summary leak, decryptor present', () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-deploy-'));
    const html = join(dir, 'doc.html');
    writeFileSync(html, '<!doctype html><meta name="doc-version" content="7"><h1>SECRET-CONTENT</h1><li data-version="7">v7 — LEAKY-SUMMARY</li>');
    const out = join(dir, 'out');
    const bundle = createNetlifyBundle({ input: html, outDir: out, slug: 'doc', version: 7, summary: 'LEAKY-SUMMARY', passphrase: 'heather-castle-42', updatedAt: '2026-07-08T00:00:00Z' });
    expect(bundle.protected).toBe(true);
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    expect(page).not.toContain('SECRET-CONTENT');
    expect(page).toContain('artifact-crypt');
    expect(page).toContain('AES-GCM');
    expect(readFileSync(join(out, 'version.json'), 'utf8')).not.toContain('LEAKY-SUMMARY');
  });

  test('generates memorable deterministic passphrases from a seed', () => {
    expect(generatePassphrase('trip')).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(generatePassphrase('trip')).toBe(generatePassphrase('trip'));
  });

  test('encryptHtml round-trips through the browser WebCrypto decrypt logic', async () => {
    const doc = '<!doctype html><h1>Trip itinerary — 12 Aug</h1><p>flight AI-131</p>';
    const env = encryptHtml(doc, 'river-summit-07', 50_000);
    expect(env.kdf.iterations).toBe(50_000);
    await expect(webDecrypt(env, 'river-summit-07')).resolves.toBe(doc);
  });

  test('encryptHtml with the wrong passphrase fails the GCM auth tag', async () => {
    const env = encryptHtml('<h1>Secret</h1>', 'correct-horse-01', 50_000);
    await expect(webDecrypt(env, 'wrong-passphrase-99')).rejects.toBeDefined();
  });

  test('creates draft deploys by default and production only when requested', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ id: `deploy-${calls.length}`, required: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const api = new NetlifyApi('token', 'https://api.example.test/api/v1');
    await api.createDeploy('site-1', { '/index.html': 'abc' }, 'Trip v1');
    await api.createDeploy('site-1', { '/index.html': 'abc' }, 'Trip v1', { production: true });

    expect(calls[0]).toEqual({
      url: 'https://api.example.test/api/v1/sites/site-1/deploys?production=false&title=Trip%20v1',
      body: { files: { '/index.html': 'abc' }, draft: true },
    });
    expect(calls[1]).toEqual({
      url: 'https://api.example.test/api/v1/sites/site-1/deploys?production=true&title=Trip%20v1',
      body: { files: { '/index.html': 'abc' }, draft: false },
    });
  });

  test('publishes a selected deploy through the restore endpoint', async () => {
    const calls: Array<{ url: string; method?: string; body?: any }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ id: 'deploy-1', ssl_url: 'https://example.netlify.app' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const api = new NetlifyApi('token', 'https://api.example.test/api/v1');
    await api.publishDeploy('site-1', 'deploy-1');

    expect(calls).toEqual([
      {
        url: 'https://api.example.test/api/v1/sites/site-1/deploys/deploy-1/restore',
        method: 'POST',
        body: {},
      },
    ]);
  });

  test('verifyEncryptedUrl passes when the decryptor ships and no plaintext leaks', async () => {
    const page = '<form id="artifact-crypt"></form><script>const ENV={cipher:{name:"AES-GCM"}}</script>';
    globalThis.fetch = (async () => new Response(page, { status: 200 })) as typeof fetch;
    await expect(verifyEncryptedUrl('https://deploy.example.test', 'NEVER-SHIPS')).resolves.toMatchObject({
      status: 200,
      envelopePresent: true,
      plaintextLeaked: false,
    });
  });

  test('verifyEncryptedUrl rejects when the plaintext content is present', async () => {
    const leaky = '<form id="artifact-crypt"></form><script>{cipher:{name:"AES-GCM"}}</script> SECRET-CONTENT-HERE';
    globalThis.fetch = (async () => new Response(leaky, { status: 200 })) as typeof fetch;
    await expect(verifyEncryptedUrl('https://deploy.example.test', 'SECRET-CONTENT-HERE')).rejects.toThrow('plaintext content is present');
  });

  test('verifyEncryptedUrl rejects when the decryptor envelope is missing', async () => {
    globalThis.fetch = (async () => new Response('<h1>just a plain page</h1>', { status: 200 })) as typeof fetch;
    await expect(verifyEncryptedUrl('https://deploy.example.test')).rejects.toThrow('envelope not found');
  });

  test('verifyEncryptedUrl retries a still-processing deploy, then succeeds', async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      if (n < 3) return new Response('processing', { status: 503 });
      return new Response('<form id="artifact-crypt"></form><script>{cipher:{name:"AES-GCM"}}</script>', { status: 200 });
    }) as typeof fetch;
    await expect(verifyEncryptedUrl('https://deploy.example.test', undefined, { attempts: 5, delayMs: 1 })).resolves.toMatchObject({ status: 200, envelopePresent: true });
    expect(n).toBe(3);
  });

  test('contentSample returns a distinctive slice of the source', () => {
    const sample = contentSample('<!doctype html><h1>' + 'x'.repeat(200) + '</h1>');
    expect(sample.length).toBe(80);
  });

  test('set-password refuses to set a password implicitly (deploy safety)', () => {
    const script = join(import.meta.dir, '..', 'scripts', 'artifact-deploy.ts');
    const bare = Bun.spawnSync(['bun', script, 'netlify', 'set-password', '--json']);
    expect(bare.exitCode).not.toBe(0);
    expect(bare.stderr.toString()).toContain('requires --set');
    const gen = Bun.spawnSync(['bun', script, 'netlify', 'set-password', '--generate', '--json']);
    expect(gen.exitCode).toBe(0);
    expect(JSON.parse(gen.stdout.toString()).password).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  });

  // Netlify bills 15 credits per production deployment against a hard 300/month Free
  // cap. The three commands that publish to production must never spend those credits
  // implicitly — an agent has to be told the cost and confirm it first.
  test('production publishes refuse to spend credits without --confirm-credits', () => {
    const script = join(import.meta.dir, '..', 'scripts', 'artifact-deploy.ts');
    dir = mkdtempSync(join(tmpdir(), 'artifact-deploy-'));
    const gated = [
      ['netlify', 'deploy', '--dir', dir, '--input', join(dir, 'missing.html'), '--slug', 's', '--site-id', 'x', '--production'],
      ['netlify', 'publish', '--site-id', 'x', '--deploy', 'd'],
      ['netlify', 'rollback', '--site-id', 'x', '--deploy', 'd'],
    ];
    for (const argv of gated) {
      const res = Bun.spawnSync(['bun', script, ...argv]);
      expect(res.exitCode).not.toBe(0);
      const err = res.stderr.toString();
      expect(err).toContain('15 Netlify credits');
      expect(err).toContain('--confirm-credits');
    }
  });

  test('--confirm-credits opens the gate; draft deploys are never gated', () => {
    const script = join(import.meta.dir, '..', 'scripts', 'artifact-deploy.ts');
    dir = mkdtempSync(join(tmpdir(), 'artifact-deploy-'));
    // A missing input file makes each run die at bundle time — after the credit gate,
    // before any network call. So "failed on ENOENT" proves the gate let it through.
    const base = ['netlify', 'deploy', '--dir', dir, '--input', join(dir, 'missing.html'), '--slug', 's', '--site-id', 'x'];

    const confirmed = Bun.spawnSync(['bun', script, ...base, '--production', '--confirm-credits']);
    expect(confirmed.stderr.toString()).toContain('ENOENT');
    expect(confirmed.stderr.toString()).not.toContain('--confirm-credits');

    // Draft deploys are free and unlimited: they must never demand confirmation.
    const draft = Bun.spawnSync(['bun', script, ...base]);
    expect(draft.stderr.toString()).toContain('ENOENT');
    expect(draft.stderr.toString()).not.toContain('--confirm-credits');
  });
});
