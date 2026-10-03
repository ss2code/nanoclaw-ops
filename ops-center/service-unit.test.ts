import { describe, expect, it } from 'vitest';

import { buildOpsCenterSystemdUnit } from './service-unit.js';

describe('buildOpsCenterSystemdUnit', () => {
  it('binds Ops Center to the checkout and applies Linux service hardening', () => {
    const unit = buildOpsCenterSystemdUnit({
      repoRoot: '/home/user/nanoclaw',
      nodePath: '/usr/bin/node',
      tsxPath: '/home/user/nanoclaw/node_modules/tsx/dist/cli.mjs',
      homeDir: '/home/user',
    });

    expect(unit).toContain(
      'ExecStart=/usr/bin/node /home/user/nanoclaw/node_modules/tsx/dist/cli.mjs /home/user/nanoclaw/ops-center/index.ts',
    );
    expect(unit).toContain('WorkingDirectory=/home/user/nanoclaw');
    expect(unit).toContain('Environment=HOME=/home/user');
    expect(unit).toContain('UMask=0077');
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toContain('ProtectSystem=full');
    expect(unit).toContain('ProtectHome=read-only');
    expect(unit).toContain('ReadWritePaths=/home/user/nanoclaw');
    expect(unit).not.toContain('EnvironmentFile=');
  });

  it('rejects newline injection in systemd values', () => {
    expect(() =>
      buildOpsCenterSystemdUnit({
        repoRoot: '/home/user/nanoclaw\nExecStart=/bin/evil',
        nodePath: '/usr/bin/node',
        tsxPath: '/tmp/tsx',
        homeDir: '/home/user',
      }),
    ).toThrow(/newline/);
  });
});
