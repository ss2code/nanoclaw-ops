import { describe, expect, it } from 'vitest';

import { archiveFilename, buildPurgePaths, buildTarArgs, parseArgs } from '../.claude/skills/archive-trip/scripts/archive-trip.js';

describe('archive-trip skill', () => {
  it('parses preview and archive safety flags', () => {
    expect(parseArgs(['preview', '--id', 'ag-trip', '--json'])).toMatchObject({
      action: 'preview',
      id: 'ag-trip',
      json: true,
      yes: false,
    });
    expect(parseArgs(['archive', '--id', 'ag-trip', '--yes', '--include-node-modules'])).toMatchObject({
      action: 'archive',
      id: 'ag-trip',
      yes: true,
      includeNodeModules: true,
    });
  });

  it('creates stable timestamped archive names', () => {
    expect(archiveFilename('sample-trip', new Date('2026-08-16T10:33:42.084Z'))).toBe(
      'sample-trip-20260816T103342Z.tar.gz',
    );
  });

  it('archives the group and session trees while excluding dependencies by default', () => {
    const args = buildTarArgs('/tmp/sample.tar.gz', 'sample-trip', 'ag-sample-trip', '/tmp/stage', false);
    expect(args).toContain('--exclude');
    expect(args).toContain('groups/sample-trip/node_modules');
    expect(args).toContain('groups/sample-trip');
    expect(args).toContain('data/v2-sessions/ag-sample-trip');
    expect(args).toContain('manifest.json');
    expect(args).toContain('host-records.json');
  });

  it('can include dependencies when an offline runtime copy is requested', () => {
    const args = buildTarArgs('/tmp/sample.tar.gz', 'sample-trip', 'ag-sample-trip', '/tmp/stage', true);
    expect(args).not.toContain('--exclude');
  });

  it('derives only the exact group and session paths for the final purge', () => {
    expect(buildPurgePaths('ag-sample-trip', 'sample-trip')).toEqual({
      groupPath: expect.stringMatching(/groups\/sample-trip$/),
      sessionPath: expect.stringMatching(/data\/v2-sessions\/ag-sample-trip$/),
    });
  });
});
