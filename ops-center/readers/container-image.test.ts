import { describe, expect, it } from 'vitest';

import { readContainerImageStatus, type DockerImageInspectResult } from './container-image.js';

describe('Ops Center container image provenance', () => {
  const found = (buildFingerprint: string): DockerImageInspectResult => ({
    status: 'found',
    image: {
      id: 'sha256:image-id',
      digest: 'repo@sha256:registry-digest',
      createdAt: '2026-08-21T08:00:00.000Z',
      sizeBytes: 123,
      buildFingerprint,
    },
  });

  it('marks the deployed image current when its build fingerprint matches the checkout', () => {
    const status = readContainerImageStatus('nanoclaw-agent:latest', {
      repoBuildFingerprint: 'repo-fp',
      inspect: () => found('repo-fp'),
    });
    expect(status.state).toBe('current');
    expect(status.deployedBuildFingerprint).toBe('repo-fp');
    expect(status.image?.digest).toContain('registry-digest');
  });

  it('reports a source/image delta and missing labels instead of hiding stale deployments', () => {
    const stale = readContainerImageStatus('nanoclaw-agent:latest', {
      repoBuildFingerprint: 'repo-fp',
      inspect: () => found('old-fp'),
    });
    expect(stale.state).toBe('stale');
    expect(stale.delta).toContain('repo-fp');

    const unlabeled = readContainerImageStatus('nanoclaw-agent:latest', {
      repoBuildFingerprint: 'repo-fp',
      inspect: () => found(''),
    });
    expect(unlabeled.state).toBe('stale');
    expect(unlabeled.reason).toMatch(/fingerprint|label/i);
  });

  it('preserves daemon-unavailable and image-missing states', () => {
    expect(
      readContainerImageStatus('missing:latest', {
        repoBuildFingerprint: 'repo-fp',
        inspect: () => ({ status: 'missing' }),
      }).state,
    ).toBe('missing');
    expect(
      readContainerImageStatus('missing:latest', {
        repoBuildFingerprint: 'repo-fp',
        inspect: () => ({ status: 'unavailable', error: 'docker down' }),
      }).state,
    ).toBe('unavailable');
  });
});
