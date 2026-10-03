import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('runtime Node resolver', () => {
  function resolverEnv(home: string, fallback?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: path.join(home, 'empty-path'),
    };

    if (fallback) env.NANOCLAW_NODE_FALLBACKS = fallback;
    return env;
  }

  it('finds a supported durable Node install when node is absent from PATH', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-node-resolver-'));
    const node = path.join(home, '.local', 'opt', 'node-v22.22.3-darwin-arm64', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n[ "$1" = "--version" ] && echo v22.22.3\n', { mode: 0o755 });

    const resolved = execFileSync('/bin/bash', [path.join(process.cwd(), 'scripts', 'resolve-node.sh')], {
      encoding: 'utf8',
      env: resolverEnv(home),
    }).trim();

    expect(resolved).toBe(node);
  });

  it('finds a supported nvm Node install when launchd omits nvm from PATH', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-node-resolver-nvm-'));
    const node = path.join(home, '.nvm', 'versions', 'node', 'v22.22.3', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n[ "$1" = "--version" ] && echo v22.22.3\n', { mode: 0o755 });

    const resolved = execFileSync('/bin/bash', [path.join(process.cwd(), 'scripts', 'resolve-node.sh')], {
      encoding: 'utf8',
      env: resolverEnv(home),
    }).trim();

    expect(resolved).toBe(node);
  });

  it('rejects Node versions below the repository runtime floor', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-node-resolver-old-'));
    const node = path.join(home, '.local', 'opt', 'node-v20.19.0-darwin-arm64', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n[ "$1" = "--version" ] && echo v20.19.0\n', { mode: 0o755 });

    expect(() =>
      execFileSync('/bin/bash', [path.join(process.cwd(), 'scripts', 'resolve-node.sh')], {
        encoding: 'utf8',
        env: resolverEnv(home, node),
      }),
    ).toThrow();
  });

  it('rejects a newer Node ABI outside the repository Node 22 contract', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-node-resolver-new-'));
    const node = path.join(home, '.local', 'opt', 'node-v24.19.0-darwin-arm64', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n[ "$1" = "--version" ] && echo v24.19.0\n', { mode: 0o755 });

    expect(() =>
      execFileSync('/bin/bash', [path.join(process.cwd(), 'scripts', 'resolve-node.sh')], {
        encoding: 'utf8',
        env: resolverEnv(home, node),
      }),
    ).toThrow();
  });

  it('reports the launchd PATH and checked candidates on resolution failure', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-node-resolver-diagnostics-'));
    const missing = path.join(home, 'missing-node');

    try {
      execFileSync('/bin/bash', [path.join(process.cwd(), 'scripts', 'resolve-node.sh')], {
        encoding: 'utf8',
        env: resolverEnv(home, missing),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('resolver unexpectedly succeeded');
    } catch (error) {
      const stderr = String((error as { stderr?: string | Buffer }).stderr ?? error);
      expect(stderr).toContain('launchd PATH:');
      expect(stderr).toContain('checked Node candidates:');
      expect(stderr).toContain(`${missing}=missing`);
    }
  });

  it('routes the host test command through the supported Node resolver', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: { test?: string } };
    expect(packageJson.scripts?.test).toContain('scripts/run-node22.sh');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-node-launcher-'));
    const node = path.join(home, 'supported-node');
    fs.writeFileSync(node, '#!/bin/sh\n[ "$1" = "--version" ] && echo v22.22.3\n', { mode: 0o755 });

    const wrapper = path.join(process.cwd(), 'scripts', 'run-node22.sh');
    const version = execFileSync('/bin/bash', [wrapper, '--version'], {
      encoding: 'utf8',
      env: resolverEnv(home, node),
    }).trim();

    expect(version).toBe('v22.22.3');
  });
});
