import path from 'path';

import type { AdditionalMount, MountAllowlist } from './modules/mount-security/index.js';

/** Contract an absolute path beneath the current home to a host-portable ~/ path. */
export function contractHomePath(hostPath: string, homeDir: string): string {
  if (!path.isAbsolute(hostPath) || !path.isAbsolute(homeDir)) return hostPath;
  const normalizedPath = path.resolve(hostPath);
  const normalizedHome = path.resolve(homeDir);
  if (normalizedPath === normalizedHome) return '~';
  const relative = path.relative(normalizedHome, normalizedPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return hostPath;
  }
  return `~/${relative.split(path.sep).join('/')}`;
}

export function normalizeAdditionalMounts(mounts: AdditionalMount[], homeDir: string): AdditionalMount[] {
  return mounts.map((mount) => ({ ...mount, hostPath: contractHomePath(mount.hostPath, homeDir) }));
}

export function normalizeMountAllowlist(allowlist: MountAllowlist, homeDir: string): MountAllowlist {
  return {
    ...allowlist,
    allowedRoots: allowlist.allowedRoots.map((root) => ({
      ...root,
      path: contractHomePath(root.path, homeDir),
    })),
    blockedPatterns: [...allowlist.blockedPatterns],
  };
}
