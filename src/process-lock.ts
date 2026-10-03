import fs from 'fs';
import path from 'path';

export interface ProcessLock {
  path: string;
  pid: number;
  release(): void;
}

export interface ProcessLockOptions {
  pid?: number;
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

export class ProcessAlreadyRunningError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly ownerPid: number | null,
  ) {
    const owner = ownerPid === null ? 'an unknown process' : `process ${ownerPid}`;
    super(`NanoClaw is already running (${owner}; lock ${lockPath})`);
    this.name = 'ProcessAlreadyRunningError';
  }
}

interface LockContents {
  pid: number;
  startedAt: string;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user. It is still
    // an owner for lock purposes; only ESRCH means the PID is stale.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(lockPath: string): { raw: string; contents: LockContents | null } {
  const raw = fs.readFileSync(lockPath, 'utf8');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as LockContents).pid === 'number' &&
      typeof (parsed as LockContents).startedAt === 'string'
    ) {
      return { raw, contents: parsed as LockContents };
    }
  } catch {
    // A partially-written or manually-created lock has no trustworthy owner.
  }
  return { raw, contents: null };
}

/** Acquire an exclusive host-process lock, recovering only demonstrably stale locks. */
export function acquireProcessLock(lockPath: string, options: ProcessLockOptions = {}): ProcessLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date().toISOString());
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      const contents: LockContents = { pid, startedAt: now() };
      fs.writeFileSync(fd, JSON.stringify(contents) + '\n');
      fs.closeSync(fd);

      let released = false;
      return {
        path: lockPath,
        pid,
        release(): void {
          if (released) return;
          released = true;
          try {
            const current = readLock(lockPath);
            if (current.raw !== JSON.stringify(contents) + '\n') return;
            fs.unlinkSync(lockPath);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') throw err;
          }
        },
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;

      let existing: { raw: string; contents: LockContents | null };
      try {
        existing = readLock(lockPath);
      } catch (readErr) {
        const readCode = (readErr as NodeJS.ErrnoException).code;
        if (readCode === 'ENOENT') continue;
        throw readErr;
      }

      const ownerPid = existing.contents?.pid ?? null;
      if (ownerPid !== null && isProcessAlive(ownerPid)) {
        throw new ProcessAlreadyRunningError(lockPath, ownerPid);
      }

      // Unknown/corrupt locks are not safe to delete automatically. A stale
      // lock is recoverable only when it identifies a dead owner.
      if (ownerPid === null) {
        throw new ProcessAlreadyRunningError(lockPath, null);
      }

      // Remove only the exact lock we inspected. The short read/unlink window
      // is retried by a competing acquirer if another process wins the race.
      if (readLock(lockPath).raw === existing.raw) fs.unlinkSync(lockPath);
    }
  }

  throw new ProcessAlreadyRunningError(lockPath, null);
}
