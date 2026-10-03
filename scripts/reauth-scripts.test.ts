import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach } from 'vitest';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const scripts = [
  'scripts/reauth-codex.sh',
  'scripts/reauth-claude.sh',
  'scripts/reauth-xai.sh',
  'scripts/reauth-openrouter.sh',
];
let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe('headless provider re-auth scripts', () => {
  it('are executable shell scripts with detailed help that works without provider commands', () => {
    for (const relative of scripts) {
      const file = path.join(root, relative);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.accessSync(file, fs.constants.X_OK)).toBeUndefined();
      execFileSync('bash', [file, '-h'], { cwd: root, encoding: 'utf8' });
      const help = execFileSync('bash', [file, '--help'], { cwd: root, encoding: 'utf8' });
      expect(help).toContain('You do NOT need desktop access');
      if (!relative.endsWith('reauth-xai.sh')) expect(help).toContain('--secret-id <ID>');
      expect(help).toContain('data/provider-auth-status.json');
    }
  });

  it('keeps provider-specific safety and in-place vault update anchors', () => {
    const codex = fs.readFileSync(path.join(root, 'scripts/reauth-codex.sh'), 'utf8');
    const claude = fs.readFileSync(path.join(root, 'scripts/reauth-claude.sh'), 'utf8');
    const xai = fs.readFileSync(path.join(root, 'scripts/reauth-xai.sh'), 'utf8');
    const openrouter = fs.readFileSync(path.join(root, 'scripts/reauth-openrouter.sh'), 'utf8');
    const common = fs.readFileSync(path.join(root, 'scripts/reauth-common.sh'), 'utf8');

    expect(codex).toContain('CODEX_HOME="$LOGIN_HOME" codex login --device-auth');
    expect(codex).toContain('do not copy your personal ~/.codex/auth.json');
    expect(claude).toContain("script -q -c 'claude setup-token'");
    expect(claude).toContain('captured-token.ts');
    expect(xai).toContain('At the Pi prompt, enter /login xai');
    expect(xai).toContain('--volume "$PI_DIR:/home/node/.pi/agent"');
    expect(xai).toContain('--entrypoint pi "$IMAGE"');
    expect(xai).toContain('.pi-shared');
    expect(xai).not.toContain('opencode-xdg');
    expect(xai).not.toContain('OpenCode');
    expect(xai).toContain('--group-id <ID>');
    expect(xai).toContain('data/v2-sessions');
    expect(xai).toContain('export NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT"');
    expect(xai).toContain('reauth_require_node');
    expect(xai).toContain('GROUP_ID="$(reauth_node -');
    expect(xai).not.toContain('GROUP_ID="$(node -');
    expect(xai).not.toContain('onecli secrets');
    expect(openrouter).toContain('onecli run curl');
    expect(openrouter).toContain('reauth_upsert_value_secret');
    expect(openrouter).toContain('openrouter.ai');
    expect(common).toContain('onecli secrets update');
    expect(common).toContain('onecli secrets create');
    expect(common).toContain('provider-auth-status.json');
    expect(common).toContain('run-node22.sh');
    expect(common).toContain('reauth_node -e');
    expect(common).not.toContain('set -x');
  });

  it('writes only non-secret provider status and preserves the other provider', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-status-'));
    const common = path.join(root, 'scripts/reauth-common.sh');
    const command = [
      'source "$1"',
      'reauth_record_status "$2" codex "ChatGPT device-code login" "2026-08-21T00:00:00.000Z" "" provider-managed "managed"',
      'reauth_record_status "$2" claude "Claude setup-token subscription login" "2026-08-21T00:00:00.000Z" "2027-08-21T00:00:00.000Z" estimated "estimate"',
    ].join('; ');
    execFileSync('bash', ['-c', command, 'bash', common, tempRoot], { cwd: root });

    const status = JSON.parse(fs.readFileSync(path.join(tempRoot, 'data/provider-auth-status.json'), 'utf8'));
    expect(status.providers.codex.expiryMode).toBe('provider-managed');
    expect(status.providers.claude.expiresAt).toBe('2027-08-21T00:00:00.000Z');
    expect(status.providers.claude).not.toHaveProperty('token');
  });
});
