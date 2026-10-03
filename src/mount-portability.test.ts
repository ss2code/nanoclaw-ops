import { describe, expect, it } from 'vitest';

import { contractHomePath, normalizeAdditionalMounts, normalizeMountAllowlist } from './mount-portability.js';

describe('contractHomePath', () => {
  it('contracts the home itself and descendants without matching sibling prefixes', () => {
    expect(contractHomePath('/srv/operator', '/srv/operator')).toBe('~');
    expect(contractHomePath('/srv/operator/work/files', '/srv/operator')).toBe('~/work/files');
    expect(contractHomePath('/srv/operator-archive/work', '/srv/operator')).toBe('/srv/operator-archive/work');
  });

  it('leaves relative, container, and non-home host paths unchanged', () => {
    expect(contractHomePath('~/work', '/srv/operator')).toBe('~/work');
    expect(contractHomePath('/srv/shared', '/srv/operator')).toBe('/srv/shared');
    expect(contractHomePath('/workspace/agent', '/srv/operator')).toBe('/workspace/agent');
  });
});

describe('portable mount normalization', () => {
  it('normalizes additional mount host paths without changing policy', () => {
    expect(
      normalizeAdditionalMounts(
        [{ hostPath: '/srv/operator/work', containerPath: 'work', readonly: false }],
        '/srv/operator',
      ),
    ).toEqual([{ hostPath: '~/work', containerPath: 'work', readonly: false }]);
  });

  it('normalizes allowlist roots and preserves blocked patterns', () => {
    expect(
      normalizeMountAllowlist(
        {
          allowedRoots: [{ path: '/srv/operator/work', allowReadWrite: true, description: 'projects' }],
          blockedPatterns: ['**/.ssh/**'],
        },
        '/srv/operator',
      ),
    ).toEqual({
      allowedRoots: [{ path: '~/work', allowReadWrite: true, description: 'projects' }],
      blockedPatterns: ['**/.ssh/**'],
    });
  });
});
