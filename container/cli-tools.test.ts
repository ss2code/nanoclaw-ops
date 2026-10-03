import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guards the cli-tools.json seam: the global CLIs the agent invokes at runtime
// are installed from the manifest (a skill adds one with a json-merge), not
// hand-edited into the Dockerfile. These go red on a bad merge that drops a
// baseline tool, or on dewiring the Dockerfile / switching the installer off
// the pnpm supply-chain path.
const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'cli-tools.json'), 'utf8')) as Array<{
  name: string;
  version: string;
  onlyBuilt?: boolean;
}>;
const agentRunnerPackage = JSON.parse(readFileSync(join(here, 'agent-runner', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const versionPins = JSON.parse(readFileSync(join(here, '..', 'versions.json'), 'utf8')) as Record<string, string>;
const dockerfile = readFileSync(join(here, 'Dockerfile'), 'utf8');
const installer = readFileSync(join(here, 'install-cli-tools.sh'), 'utf8');
const buildScript = readFileSync(join(here, 'build.sh'), 'utf8');

describe('cli-tools manifest', () => {
  it('is a non-empty array of { name, version }', () => {
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest.length).toBeGreaterThan(0);
    for (const tool of manifest) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.version).toBe('string');
      expect(tool.version.length).toBeGreaterThan(0);
    }
  });

  it('has unique tool names (json-merge is keyed on name)', () => {
    const names = manifest.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('pins every version to an exact semver (no latest, no ranges — supply-chain policy)', () => {
    for (const tool of manifest) {
      expect(tool.version, `${tool.name} must be an exact semver, not "${tool.version}"`).toMatch(
        /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
      );
    }
  });

  it('keeps the baseline CLIs the agent depends on', () => {
    const names = manifest.map((t) => t.name);
    for (const required of ['vercel', 'agent-browser', '@anthropic-ai/claude-code']) {
      expect(names).toContain(required);
    }
  });

  it('does not install the retired remote web-lookup bridge', () => {
    expect(manifest.find((tool) => tool.name === 'mcp-remote')).toBeUndefined();
  });

  it('keeps the OpenCode CLI, SDK, and sanctioned pin in lockstep', () => {
    const cli = manifest.find((tool) => tool.name === 'opencode-ai');
    expect(cli?.version).toBe('1.18.25');
    expect(agentRunnerPackage.dependencies?.['@opencode-ai/sdk']).toBe(cli?.version);
    expect(versionPins['opencode-ai']).toBe(cli?.version);
  });

  it('is wired into the Dockerfile build (COPY manifest + run installer)', () => {
    expect(dockerfile).toMatch(/COPY cli-tools\.json install-cli-tools\.sh/);
    expect(dockerfile).toMatch(/install-cli-tools\.sh \/tmp\/cli-tools\.json/);
  });

  it('installs via pnpm and writes only-built opt-ins (preserves the supply-chain path)', () => {
    expect(installer).toMatch(/pnpm install -g/);
    expect(installer).toMatch(/only-built-dependencies\[\]=/);
  });

  it('installs each pinned CLI separately to bound global-install memory', () => {
    expect(installer).toMatch(/for spec in \$\(node -e/);
    expect(installer).toContain('pnpm install -g "$spec"');
  });

  it('keeps the build-script fingerprint encoding aligned with the host', () => {
    expect(buildScript).toContain('printf \'%b\' "$fingerprint_lines"');
  });
});
