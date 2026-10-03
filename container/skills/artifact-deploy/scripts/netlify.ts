import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { Database } from 'bun:sqlite';

export interface BundleOptions {
  input: string;
  outDir: string;
  slug: string;
  version: number | string;
  summary?: string;
  passphrase?: string | null;
  updatedAt: string;
}

export interface BundleFile {
  path: string;
  sha1: string;
  bytes: number;
}

export interface BundleResult {
  outDir: string;
  files: BundleFile[];
  version: string;
  protected: boolean;
}

export interface CryptoEnvelope {
  v: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  data: string;
}

export interface EncryptedCheck {
  url: string;
  status: number;
  envelopePresent: boolean;
  plaintextLeaked: boolean;
}

// OWASP 2023 guidance for PBKDF2-HMAC-SHA256. High enough to make offline
// brute-force of a generated passphrase costly; still sub-second in the browser.
const PBKDF2_ITERATIONS = 600_000;

function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out.sort();
}

export function generatePassphrase(seed = randomBytes(8).toString('hex')): string {
  const words = ['heather', 'castle', 'river', 'summit', 'harbor', 'maple', 'lantern', 'ticket', 'cloud', 'route', 'garden', 'station'];
  const n = parseInt(sha256(seed).slice(0, 8), 16);
  return `${words[n % words.length]}-${words[Math.floor(n / words.length) % words.length]}-${String(n % 100).padStart(2, '0')}`;
}

// Encrypt an HTML document with a passphrase: PBKDF2-SHA256 → AES-256-GCM.
// The GCM auth tag is appended to the ciphertext because the browser's WebCrypto
// AES-GCM decrypt expects tag-appended input; a wrong passphrase fails the tag
// check, which is how the decryptor detects an incorrect password.
export function encryptHtml(html: string, passphrase: string, iterations = PBKDF2_ITERATIONS): CryptoEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(html, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: salt.toString('base64') },
    cipher: { name: 'AES-GCM', iv: iv.toString('base64') },
    data: Buffer.concat([ciphertext, tag]).toString('base64'),
  };
}

// A self-contained page that prompts for the passphrase and decrypts the embedded
// document entirely in the browser via WebCrypto. Only ciphertext ever ships.
export function renderDecryptorPage(envelope: CryptoEnvelope, opts: { title?: string } = {}): string {
  const title = opts.title ?? 'Protected document';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f5f5f4; color: #1c1917; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #f5f5f4; } }
  form { width: min(90vw, 340px); padding: 28px; border-radius: 14px; background: color-mix(in srgb, Canvas 92%, transparent); box-shadow: 0 10px 40px rgba(0,0,0,.15); text-align: center; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p { margin: 0 0 18px; opacity: .7; font-size: 13px; }
  input { width: 100%; box-sizing: border-box; padding: 11px 12px; font-size: 15px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 9px; background: Canvas; color: CanvasText; }
  button { margin-top: 12px; width: 100%; padding: 11px; font-size: 15px; font-weight: 600; border: 0; border-radius: 9px; background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: progress; }
  .err { color: #dc2626; font-size: 13px; min-height: 18px; margin-top: 10px; }
</style>
</head>
<body>
<form id="artifact-crypt" data-artifact-encrypted="1" autocomplete="off">
  <h1>${title}</h1>
  <p>Enter the passphrase to view this document.</p>
  <input id="pw" type="password" placeholder="Passphrase" autofocus autocomplete="current-password" aria-label="Passphrase">
  <button id="go" type="submit">Unlock</button>
  <div class="err" id="err" role="alert"></div>
</form>
<script>
const ENV = ${JSON.stringify(envelope)};
const b64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
async function decrypt(pass) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(ENV.kdf.salt), iterations: ENV.kdf.iterations, hash: ENV.kdf.hash },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(ENV.cipher.iv) }, key, b64(ENV.data));
  return new TextDecoder().decode(pt);
}
const form = document.getElementById('artifact-crypt');
const pw = document.getElementById('pw');
const go = document.getElementById('go');
const err = document.getElementById('err');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  go.disabled = true; go.textContent = 'Unlocking…';
  try {
    const html = await decrypt(pw.value);
    document.open(); document.write(html); document.close();
  } catch {
    err.textContent = 'Incorrect passphrase.';
    go.disabled = false; go.textContent = 'Unlock';
    pw.select();
  }
});
</script>
</body>
</html>
`;
}

export function createNetlifyBundle(opts: BundleOptions): BundleResult {
  mkdirSync(opts.outDir, { recursive: true });
  const rawHtml = readFileSync(opts.input, 'utf8');
  const isProtected = Boolean(opts.passphrase);
  const indexHtml = isProtected
    ? renderDecryptorPage(encryptHtml(rawHtml, opts.passphrase as string), { title: 'Protected document' })
    : rawHtml;
  writeFileSync(join(opts.outDir, 'index.html'), indexHtml);
  // Never ship the human summary next to an encrypted doc — it would leak content.
  writeFileSync(join(opts.outDir, 'version.json'), JSON.stringify({ slug: opts.slug, version: String(opts.version), summary: isProtected ? '' : (opts.summary ?? ''), updated_at: opts.updatedAt }, null, 2));
  const files = walk(opts.outDir).map((path) => {
    const buf = readFileSync(path);
    return { path: relative(opts.outDir, path).replace(/\\/g, '/'), sha1: sha1(buf), bytes: buf.length };
  });
  return { outDir: opts.outDir, files, version: String(opts.version), protected: isProtected };
}

export function manifest(files: BundleFile[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[`/${f.path}`] = f.sha1;
  return out;
}

// A distinctive slice of the source, used to assert the plaintext never ships in
// the deployed (encrypted) page. Any non-trivial raw-HTML substring works: the
// encrypted page carries only base64 ciphertext, so a match means a real leak.
export function contentSample(html: string, len = 80): string {
  const trimmed = html.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= len) return trimmed;
  const start = Math.floor(trimmed.length / 3);
  return trimmed.slice(start, start + len);
}

export async function verifyEncryptedUrl(
  url: string,
  plaintextSample?: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<EncryptedCheck> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 2000;
  let lastStatus = 0;
  // Retry only on transient non-2xx (a fresh deploy may still be processing).
  // A 2xx page that lacks the envelope or exposes plaintext is a structural
  // failure — fail immediately rather than mask it behind retries.
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    const body = await res.text();
    lastStatus = res.status;
    if (res.status < 200 || res.status >= 300) {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    const envelopePresent = body.includes('artifact-crypt') && /"AES-GCM"/.test(body);
    if (!envelopePresent) {
      throw new Error('encrypted deploy verification failed: decryptor/envelope not found in deployed page');
    }
    const plaintextLeaked = Boolean(plaintextSample) && body.includes(plaintextSample as string);
    if (plaintextLeaked) {
      throw new Error('encrypted deploy verification failed: plaintext content is present in the deployed page');
    }
    return { url, status: res.status, envelopePresent, plaintextLeaked };
  }
  throw new Error(`encrypted deploy verification failed: HTTP ${lastStatus} after ${attempts} attempts, expected 2xx`);
}

export class NetlifyApi {
  constructor(private token = process.env.NETLIFY_AUTH_TOKEN ?? '', private baseUrl = 'https://api.netlify.com/api/v1') {}

  private headers(extra?: HeadersInit): HeadersInit {
    return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : { ...extra };
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: this.headers({ 'content-type': 'application/json', ...(init.headers ?? {}) }) });
    if (!res.ok) throw new Error(`Netlify API ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async createSite(name: string): Promise<{ id: string; name: string; ssl_url?: string; url?: string }> {
    return this.json('/sites', { method: 'POST', body: JSON.stringify({ name }) });
  }

  async createDeploy(siteId: string, files: Record<string, string>, title: string, opts: { production?: boolean } = {}): Promise<any> {
    const production = opts.production === true;
    return this.json(`/sites/${encodeURIComponent(siteId)}/deploys?production=${production ? 'true' : 'false'}&title=${encodeURIComponent(title)}`, {
      method: 'POST',
      body: JSON.stringify({ files, draft: !production }),
    });
  }

  async listDeploys(siteId: string): Promise<any[]> {
    return this.json(`/sites/${encodeURIComponent(siteId)}/deploys`, { method: 'GET' });
  }

  async getDeploy(siteId: string, deployId: string): Promise<any> {
    return this.json(`/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`, { method: 'GET' });
  }

  async uploadDeployFile(deployId: string, path: string, content: Buffer): Promise<void> {
    const res = await fetch(`${this.baseUrl}/deploys/${encodeURIComponent(deployId)}/files/${path.replace(/^\//, '')}`, {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/octet-stream' }),
      body: content,
    });
    if (!res.ok) throw new Error(`Netlify file upload ${res.status}: ${await res.text()}`);
  }

  async restore(siteId: string, deployId: string): Promise<any> {
    return this.json(`/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}/restore`, { method: 'POST', body: '{}' });
  }

  async publishDeploy(siteId: string, deployId: string): Promise<any> {
    return this.restore(siteId, deployId);
  }

  async deleteSite(siteId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sites/${encodeURIComponent(siteId)}`, { method: 'DELETE', headers: this.headers() });
    if (!res.ok && res.status !== 204) throw new Error(`Netlify delete ${res.status}: ${await res.text()}`);
  }
}

export function ensureDeployState(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  // Fail fast (a few seconds) rather than block forever if another writer — e.g. a
  // running container holding this DB over a bind mount — currently owns the lock.
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS deploy_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export function setDeployState(db: Database, key: string, value: unknown, at: string): void {
  db.query(`INSERT INTO deploy_state (key, value, updated_at) VALUES ($k, $v, $at)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run({
    $k: key,
    $v: JSON.stringify(value),
    $at: at,
  });
}

export function getDeployState(db: Database): Record<string, unknown> {
  const rows = db.query('SELECT key, value FROM deploy_state ORDER BY key').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

export function defaultOutDir(dir: string, slug: string): string {
  return join(dir, '.deploy', slug || basename(dir));
}

export function readDocVersion(input: string): string {
  const html = readFileSync(input, 'utf8');
  return html.match(/<meta\s+name=(["'])doc-version\1\s+content=(["'])([^"']+)\2/i)?.[3] ?? 'unknown';
}

export function readSummary(input: string): string {
  const html = readFileSync(input, 'utf8');
  return html.match(/<li\s+data-version=["'][^"']+["'][^>]*>[\s\S]*?—\s*([^<]+)<\/li>/i)?.[1]?.trim() ?? '';
}

export function requiredFileContent(bundleDir: string, path: string): Buffer {
  return readFileSync(join(bundleDir, path.replace(/^\//, '')));
}

export function parentDir(path: string): string {
  return dirname(path);
}
