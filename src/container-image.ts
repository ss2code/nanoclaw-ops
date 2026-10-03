import { createHash } from 'crypto';
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { getDefaultContainerImage } from './install-slug.js';

export const IMAGE_FINGERPRINT_LABEL = 'org.nanoclaw.build-fingerprint';

const execFileAsync = promisify(execFile);

const BUILD_INPUTS = [
  'Dockerfile',
  'cli-tools.json',
  'install-cli-tools.sh',
  'entrypoint.sh',
  'build.sh',
  'agent-runner/package.json',
  'agent-runner/bun.lock',
] as const;

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function cjkSetting(projectRoot: string): string {
  return (
    process.env.INSTALL_CJK_FONTS ||
    readEnvFile(['INSTALL_CJK_FONTS'], '.env', projectRoot).INSTALL_CJK_FONTS ||
    'false'
  );
}

/** Must stay byte-for-byte aligned with container/build.sh's fingerprint input. */
export function computeBuildFingerprint(projectRoot: string): string {
  const lines = [`INSTALL_CJK_FONTS=${cjkSetting(projectRoot)}`];
  for (const relative of BUILD_INPUTS) {
    const file = path.join(projectRoot, 'container', relative);
    lines.push(`${relative}:${sha256File(file)}`);
  }
  return createHash('sha256')
    .update(lines.join('\n') + '\n')
    .digest('hex');
}

/**
 * Fingerprint everything that can change the next container's behavior.
 * Runner/skill/template source is bind-mounted, so an image rebuild is not
 * needed for those edits; the fingerprint still recycles a warm container so
 * a long-lived process cannot continue executing an old module graph.
 */
export function computeRuntimeFingerprint(projectRoot: string, additionalRoots: string[] = []): string {
  const hash = createHash('sha256');
  hash.update(`build:${computeBuildFingerprint(projectRoot)}\n`);
  hash.update(`agent-runner:${hashTree(path.join(projectRoot, 'container', 'agent-runner', 'src'))}\n`);
  hash.update(`skills:${hashTree(path.join(projectRoot, 'container', 'skills'))}\n`);
  for (const root of [...additionalRoots].sort()) {
    hash.update(`source:${root}:${hashTree(root)}\n`);
  }
  return hash.digest('hex');
}

export function inspectImageFingerprint(image: string, runtime = 'docker'): string | null {
  try {
    const output = execFileSync(
      runtime,
      ['image', 'inspect', '--format', `{{index .Config.Labels "${IMAGE_FINGERPRINT_LABEL}"}}`, image],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      },
    ).trim();
    return output && output !== '<no value>' ? output : null;
  } catch {
    return null;
  }
}

export function imageFingerprintMatches(image: string, expected: string, runtime = 'docker'): boolean {
  return inspectImageFingerprint(image, runtime) === expected;
}

/** Rebuild the default image when its provenance label is absent or stale. */
export function ensureBaseImageFresh(projectRoot: string, image: string, runtime = 'docker'): string {
  const expected = computeBuildFingerprint(projectRoot);
  if (imageFingerprintMatches(image, expected, runtime)) return expected;
  if (image !== getDefaultContainerImage(projectRoot)) {
    throw new Error(
      `custom container image ${image} is stale or unlabeled; rebuild it with the current NanoClaw fingerprint before spawning`,
    );
  }
  if (process.env.NANOCLAW_AUTO_REBUILD_IMAGE === 'false') {
    throw new Error(
      `container image ${image} is stale or unlabeled; run ./container/build.sh or enable NANOCLAW_AUTO_REBUILD_IMAGE`,
    );
  }
  execFileSync('bash', [path.join(projectRoot, 'container', 'build.sh'), 'latest'], {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 900_000,
    env: { ...process.env, CONTAINER_RUNTIME: runtime },
  });
  if (!imageFingerprintMatches(image, expected, runtime)) {
    throw new Error(`container image ${image} did not acquire expected build fingerprint ${expected}`);
  }
  return expected;
}

/** Explicitly rebuild the shared default image for a host-requested restart. */
export async function rebuildBaseImage(projectRoot: string, image: string, runtime = 'docker'): Promise<string> {
  const expected = computeBuildFingerprint(projectRoot);
  if (image !== getDefaultContainerImage(projectRoot)) {
    throw new Error(`cannot rebuild shared image while CONTAINER_IMAGE is set to custom image ${image}`);
  }

  await execFileAsync('bash', [path.join(projectRoot, 'container', 'build.sh'), 'latest'], {
    cwd: projectRoot,
    timeout: 900_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CONTAINER_RUNTIME: runtime },
  });

  if (!imageFingerprintMatches(image, expected, runtime)) {
    throw new Error(`container image ${image} did not acquire expected build fingerprint ${expected}`);
  }
  return expected;
}

function hashTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) files.push(path.relative(root, full));
    }
  };
  if (fs.existsSync(root)) walk(root);
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}:${sha256File(path.join(root, file))}\n`);
  return hash.digest('hex');
}

export function writeRuntimeManifest(
  sessionDir: string,
  projectRoot: string,
  image: string,
  imageFingerprint: string,
  runtimeFingerprint = computeRuntimeFingerprint(projectRoot),
): void {
  const manifest = {
    schema: 2,
    generated_at: new Date().toISOString(),
    image,
    image_fingerprint: imageFingerprint,
    agent_runner_fingerprint: hashTree(path.join(projectRoot, 'container', 'agent-runner', 'src')),
    skills_fingerprint: hashTree(path.join(projectRoot, 'container', 'skills')),
    runtime_fingerprint: runtimeFingerprint,
  };
  const file = path.join(sessionDir, 'runtime-manifest.json');
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
