import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';

const launcher = path.resolve(process.cwd(), 'bin', 'ncl');

describe('bin/ncl launchd-safe launcher', () => {
  it('passes shell syntax and does not depend on pnpm in PATH', () => {
    const syntax = spawnSync('bash', ['-n', launcher], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);

    const source = fs.readFileSync(launcher, 'utf8');
    expect(source).toContain('scripts/resolve-node.sh');
    expect(source).toContain('node_modules/tsx/dist/cli.mjs');
    expect(source).toContain('exec "$NODE" "$TSX"');
    expect(source).not.toContain('exec pnpm exec tsx');
  });
});
