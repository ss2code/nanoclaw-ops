/** Read the provenance manifest written beside each host-backed session. */
import fs from 'fs';
import path from 'path';

export interface RuntimeManifest {
  schema: 1 | 2;
  generated_at: string;
  image: string;
  image_fingerprint: string;
  agent_runner_fingerprint: string;
  skills_fingerprint: string;
  runtime_fingerprint?: string;
}

export function readRuntimeManifest(sessionDir: string): RuntimeManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(sessionDir, 'runtime-manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      (value.schema !== 1 && value.schema !== 2) ||
      typeof value.generated_at !== 'string' ||
      typeof value.image !== 'string' ||
      typeof value.image_fingerprint !== 'string' ||
      typeof value.agent_runner_fingerprint !== 'string' ||
      typeof value.skills_fingerprint !== 'string' ||
      (value.schema === 2 && typeof value.runtime_fingerprint !== 'string')
    )
      return null;
    return value as unknown as RuntimeManifest;
  } catch {
    return null;
  }
}
