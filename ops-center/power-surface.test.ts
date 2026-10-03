import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('Ops Center power surface', () => {
  it('exposes separate recoverable stop and hard-off actions with a terminal recovery command', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'ops-center', 'server.ts'), 'utf8');
    expect(server).toContain("'/api/host/stop'");
    expect(server).toContain("'/api/host/hard-off'");
    expect(server).toContain('Stop runtime');
    expect(server).toContain('Hard off everything');
    expect(server).toContain('./bin/nanoclaw-power start');
  });

  it('ships an executable recovery wrapper outside the dashboard process', () => {
    const wrapper = path.join(process.cwd(), 'bin', 'nanoclaw-power');
    expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
    const source = fs.readFileSync(wrapper, 'utf8');
    expect(source).toContain('ops-center/power-cli.ts');
    expect(source).toContain('resolve-node.sh');
    expect(source).toContain('node_modules/tsx/dist/cli.mjs');
  });
});
