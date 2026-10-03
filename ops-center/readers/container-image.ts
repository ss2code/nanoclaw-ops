/**
 * Compare the image a group would run with the reproducible build inputs in
 * this checkout. The Docker label is written by container/build.sh and is the
 * same SHA-256 fingerprint used by the host before a container spawn.
 */
import { execFileSync } from 'child_process';

import { computeBuildFingerprint } from '../../src/container-image.js';
import { ROOT } from '../config.js';

export interface DockerImageInfo {
  id: string | null;
  digest: string | null;
  createdAt: string | null;
  sizeBytes: number | null;
  buildFingerprint: string;
}

export type DockerImageInspectResult =
  | { status: 'found'; image: DockerImageInfo }
  | { status: 'missing' }
  | { status: 'unavailable'; error?: string };

export type ContainerImageState = 'current' | 'stale' | 'missing' | 'unavailable';

export interface ContainerImageStatus {
  imageTag: string;
  state: ContainerImageState;
  reason: string;
  delta: string | null;
  repoBuildFingerprint: string | null;
  deployedBuildFingerprint: string | null;
  image: DockerImageInfo | null;
}

interface DockerImageInspectJson {
  Id?: unknown;
  RepoDigests?: unknown;
  Created?: unknown;
  Size?: unknown;
  Config?: { Labels?: unknown };
}

/** Inspect one image without invoking a shell or exposing unbounded output. */
export function inspectDockerImage(imageTag: string): DockerImageInspectResult {
  try {
    const output = execFileSync('docker', ['image', 'inspect', '--format', '{{json .}}', imageTag], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    if (!output.trim()) return { status: 'missing' };
    const raw = JSON.parse(output) as DockerImageInspectJson;
    const labels = raw.Config?.Labels;
    const buildFingerprint =
      labels &&
      typeof labels === 'object' &&
      !Array.isArray(labels) &&
      typeof (labels as Record<string, unknown>)['org.nanoclaw.build-fingerprint'] === 'string'
        ? String((labels as Record<string, unknown>)['org.nanoclaw.build-fingerprint'])
        : '';
    const repoDigests = Array.isArray(raw.RepoDigests)
      ? raw.RepoDigests.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      status: 'found',
      image: {
        id: typeof raw.Id === 'string' ? raw.Id : null,
        digest: repoDigests[0] ?? null,
        createdAt: typeof raw.Created === 'string' ? raw.Created : null,
        sizeBytes: typeof raw.Size === 'number' && Number.isFinite(raw.Size) ? raw.Size : null,
        buildFingerprint,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Missing image and an unavailable daemon have different operator actions.
    // Docker's CLI error text is stable enough for this read-only distinction;
    // unknown failures stay in the safer unavailable bucket.
    if (/no such image|not found|pull access denied/i.test(message)) return { status: 'missing' };
    return { status: 'unavailable', error: message.slice(0, 240) };
  }
}

export interface ContainerImageStatusOptions {
  /** Injected in tests; production uses docker image inspect. */
  inspect?: (imageTag: string) => DockerImageInspectResult;
  /** Injected in tests; production hashes the current checkout. */
  repoBuildFingerprint?: string | null;
}

/** Compare a deployed image label with the current repository build fingerprint. */
export function readContainerImageStatus(
  imageTag: string,
  options: ContainerImageStatusOptions = {},
): ContainerImageStatus {
  const inspect = (options.inspect ?? inspectDockerImage)(imageTag);
  let repoBuildFingerprint = options.repoBuildFingerprint;
  if (repoBuildFingerprint === undefined) {
    try {
      repoBuildFingerprint = computeBuildFingerprint(ROOT);
    } catch {
      repoBuildFingerprint = null;
    }
  }

  if (inspect.status === 'missing') {
    return {
      imageTag,
      state: 'missing',
      reason: 'Image tag is not present in Docker.',
      delta: null,
      repoBuildFingerprint: repoBuildFingerprint ?? null,
      deployedBuildFingerprint: null,
      image: null,
    };
  }
  if (inspect.status === 'unavailable') {
    return {
      imageTag,
      state: 'unavailable',
      reason: inspect.error ? `Docker inspection unavailable: ${inspect.error}` : 'Docker inspection unavailable.',
      delta: null,
      repoBuildFingerprint: repoBuildFingerprint ?? null,
      deployedBuildFingerprint: null,
      image: null,
    };
  }

  const deployedBuildFingerprint = inspect.image.buildFingerprint || null;
  const delta = repoBuildFingerprint
    ? `repo ${repoBuildFingerprint.slice(0, 16)}… · deployed ${deployedBuildFingerprint?.slice(0, 16) ?? 'no label'}${deployedBuildFingerprint && deployedBuildFingerprint !== repoBuildFingerprint ? ' · differs' : ''}`
    : null;
  if (!repoBuildFingerprint) {
    return {
      imageTag,
      state: 'unavailable',
      reason: 'Could not compute the repository build fingerprint.',
      delta,
      repoBuildFingerprint: null,
      deployedBuildFingerprint,
      image: inspect.image,
    };
  }
  if (deployedBuildFingerprint === repoBuildFingerprint) {
    return {
      imageTag,
      state: 'current',
      reason: 'Deployed image matches the current repository build inputs.',
      delta,
      repoBuildFingerprint,
      deployedBuildFingerprint,
      image: inspect.image,
    };
  }
  return {
    imageTag,
    state: 'stale',
    reason: deployedBuildFingerprint
      ? 'Repository build inputs changed since this image was built.'
      : 'Image has no NanoClaw build fingerprint label; rebuild it to establish provenance.',
    delta,
    repoBuildFingerprint,
    deployedBuildFingerprint,
    image: inspect.image,
  };
}
