/**
 * nano-pvt-hub path resolution — the security boundary for the Docs Hub.
 *
 * The hub store is bind-mounted read-write into EVERY agent container and is
 * served over the tailnet, so `resolveHubPath` is the one thing standing
 * between a symlink an agent can create and a file the tailnet can read. These
 * tests pin both directions: the legitimate `nanoclaw-docs` symlink must
 * resolve, and every escape route must 404.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostAllowed, listHubDocsFiles, originAllowed, resolveHubPath } from './server.js';

let tmp: string;
let hubDir: string;
let docsDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hub-'));
  // Mirror the real layout: <root>/data/hub next to <root>/docs.
  hubDir = path.join(tmp, 'data', 'hub');
  docsDir = path.join(tmp, 'docs');
  fs.mkdirSync(path.join(hubDir, 'dashboards', 'shared', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(docsDir, 'local'), { recursive: true });

  fs.writeFileSync(path.join(hubDir, 'catalog.json'), '{"version":1,"artifacts":[]}');
  fs.writeFileSync(path.join(hubDir, 'dashboards', 'shared', 'demo', 'index.html'), '<h1>demo</h1>');
  fs.writeFileSync(path.join(docsDir, 'architecture.md'), '# architecture');
  fs.writeFileSync(path.join(docsDir, 'local', 'private-overlay.html'), '<h1>secret</h1>');
  fs.writeFileSync(path.join(docsDir, 'local', 'preview.png'), 'png');
  // The read-only surface: data/hub/nanoclaw-docs -> ../../docs
  fs.symlinkSync(path.join('..', '..', 'docs'), path.join(hubDir, 'nanoclaw-docs'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const resolve = (relative: string) => resolveHubPath(hubDir, relative, [docsDir]);

describe('resolveHubPath', () => {
  it('serves a published artifact inside the store', () => {
    expect(resolve('/dashboards/shared/demo/index.html')).toBe(
      fs.realpathSync(path.join(hubDir, 'dashboards', 'shared', 'demo', 'index.html')),
    );
  });

  it('serves index.html when a directory is requested', () => {
    expect(resolve('/dashboards/shared/demo/')).toBe(
      fs.realpathSync(path.join(hubDir, 'dashboards', 'shared', 'demo', 'index.html')),
    );
  });

  it('serves repo docs through the nanoclaw-docs symlink', () => {
    // The whole point of the allowlist: this realpath escapes hubDir, and must
    // still resolve because docsDir is an allowed root.
    expect(resolve('/nanoclaw-docs/architecture.md')).toBe(fs.realpathSync(path.join(docsDir, 'architecture.md')));
  });

  it('serves the local overlay as part of the NanoClaw Docs surface', () => {
    expect(resolve('/nanoclaw-docs/local/private-overlay.html')).toBe(
      fs.realpathSync(path.join(docsDir, 'local', 'private-overlay.html')),
    );
  });

  it('refuses a symlink an agent plants pointing outside the allowed roots', () => {
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'ssh-key');
    fs.symlinkSync(secret, path.join(hubDir, 'dashboards', 'shared', 'evil.txt'));
    expect(resolve('/dashboards/shared/evil.txt')).toBeNull();
  });

  it('refuses a symlinked directory that escapes the allowed roots', () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'index.html'), '<h1>nope</h1>');
    fs.symlinkSync(outside, path.join(hubDir, 'dashboards', 'escape'));
    expect(resolve('/dashboards/escape/index.html')).toBeNull();
    expect(resolve('/dashboards/escape/')).toBeNull();
  });

  it('refuses .. traversal out of the store', () => {
    fs.writeFileSync(path.join(tmp, 'data', 'v2.db'), 'sqlite');
    expect(resolve('/../v2.db')).toBeNull();
    expect(resolve('/../../docs/architecture.md')).toBeNull();
  });

  it('returns null for files that do not exist', () => {
    expect(resolve('/dashboards/shared/missing/index.html')).toBeNull();
  });
});

describe('listHubDocsFiles', () => {
  it('includes local docs in the normal NanoClaw Docs index', () => {
    expect(listHubDocsFiles(docsDir)).toEqual(['architecture.md', 'local/preview.png', 'local/private-overlay.html']);
  });
});

/**
 * Ops Center binds loopback, so the Host check is its anti-DNS-rebinding layer:
 * a hostile page that resolves its own domain to 127.0.0.1 must not be able to
 * drive this admin surface. `trustedHosts` widens it for a proxy we control
 * (Tailscale Serve) — these tests pin that it widens by exactly that much.
 */
const req = (headers: Record<string, string>) => ({ headers }) as never;
const cfg = { port: 10333, trustedHosts: ['ops.example.test'] };
const loopbackOnly = { port: 10333, trustedHosts: [] as string[] };

describe('hostAllowed', () => {
  it('accepts loopback regardless of configuration', () => {
    expect(hostAllowed(req({ host: '127.0.0.1:10333' }), loopbackOnly)).toBe(true);
    expect(hostAllowed(req({ host: 'localhost:10333' }), loopbackOnly)).toBe(true);
  });

  it('rejects any other host when nothing is trusted (default posture)', () => {
    expect(hostAllowed(req({ host: 'ops.example.test' }), loopbackOnly)).toBe(false);
    expect(hostAllowed(req({ host: 'evil.example.com' }), loopbackOnly)).toBe(false);
  });

  it('accepts a configured trusted host, with or without a port', () => {
    expect(hostAllowed(req({ host: 'ops.example.test' }), cfg)).toBe(true);
    expect(hostAllowed(req({ host: 'ops.example.test:443' }), cfg)).toBe(true);
    expect(hostAllowed(req({ host: 'OPS.EXAMPLE.TEST' }), cfg)).toBe(true);
  });

  it('still rejects rebinding attempts and near-miss names', () => {
    expect(hostAllowed(req({ host: 'evil.example.com' }), cfg)).toBe(false);
    // Suffix/prefix games must not pass — matching is exact, never a wildcard.
    expect(hostAllowed(req({ host: 'evil.ops.example.test' }), cfg)).toBe(false);
    expect(hostAllowed(req({ host: 'ops.example.test.evil.com' }), cfg)).toBe(false);
    expect(hostAllowed(req({}), cfg)).toBe(false);
  });
});

describe('originAllowed', () => {
  it('allows a same-origin request that sends no Origin header', () => {
    expect(originAllowed(req({}), loopbackOnly)).toBe(true);
  });

  it('allows loopback and trusted origins (https included)', () => {
    expect(originAllowed(req({ origin: 'http://127.0.0.1:10333' }), loopbackOnly)).toBe(true);
    expect(originAllowed(req({ origin: 'https://ops.example.test' }), cfg)).toBe(true);
  });

  it('blocks cross-site origins — the CSRF guard on mutating actions', () => {
    expect(originAllowed(req({ origin: 'https://evil.example.com' }), cfg)).toBe(false);
    expect(originAllowed(req({ origin: 'https://ops.example.test' }), loopbackOnly)).toBe(false);
    expect(originAllowed(req({ origin: 'not a url' }), cfg)).toBe(false);
  });
});
