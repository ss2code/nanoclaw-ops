import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');

function readProjectFile(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('Node runtime contract', () => {
  it('uses the repository Node version in GitHub Actions', () => {
    const workflow = readProjectFile('.github/workflows/ci.yml');

    expect(workflow).toMatch(/node-version-file:\s*\.nvmrc/);
    expect(workflow).not.toMatch(/node-version:\s*20(?:\s|$)/);
  });

  it('declares the minimum Node version required by host dependencies', () => {
    const packageJson = JSON.parse(readProjectFile('package.json')) as {
      engines?: { node?: string };
    };

    expect(packageJson.engines?.node).toBe('>=22.19.0 <23');
  });

  it('keeps local and provisioning Node versions on major 22', () => {
    const nvmVersion = readProjectFile('.nvmrc').trim();
    const installer = readProjectFile('setup/install-node.sh');

    expect(nvmVersion).toBe('22');
    expect(installer).toContain('brew install node@22');
    expect(installer).toContain('https://deb.nodesource.com/setup_22.x');
  });
});
