/**
 * Central DB backup: SQLite VACUUM INTO from a separate read connection —
 * consistent compacted snapshot while the host keeps writing. Gzipped,
 * dated, retention-pruned. Restore runbook: design doc §8.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { PATHS } from './config.js';

export interface BackupResult {
  ok: boolean;
  file?: string;
  sizeBytes?: number;
  error?: string;
  pruned: string[];
}

export function runBackup(
  sourceDb: string = PATHS.centralDb,
  backupsDir: string = PATHS.backupsDir,
  keep = 14,
  dateIso?: string,
): BackupResult {
  const result: BackupResult = { ok: false, pruned: [] };
  try {
    fs.mkdirSync(backupsDir, { recursive: true });
    const day = (dateIso ?? new Date().toISOString()).slice(0, 10);
    const tmp = path.join(backupsDir, `.v2-${day}.tmp.db`);
    const target = path.join(backupsDir, `v2-${day}.db.gz`);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
    try {
      db.prepare(`VACUUM INTO ?`).run(tmp);
    } finally {
      db.close();
    }
    fs.writeFileSync(target, zlib.gzipSync(fs.readFileSync(tmp)));
    fs.unlinkSync(tmp);
    result.ok = true;
    result.file = target;
    result.sizeBytes = fs.statSync(target).size;

    const backups = fs
      .readdirSync(backupsDir)
      .filter((f) => /^v2-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f))
      .sort();
    while (backups.length > keep) {
      const victim = backups.shift()!;
      fs.unlinkSync(path.join(backupsDir, victim));
      result.pruned.push(victim);
    }
  } catch (e) {
    result.error = (e as Error).message;
  }
  return result;
}

export function listBackups(backupsDir: string = PATHS.backupsDir): { file: string; sizeBytes: number; mtime: string }[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db.gz'))
    .sort()
    .reverse()
    .map((f) => {
      const st = fs.statSync(path.join(backupsDir, f));
      return { file: f, sizeBytes: st.size, mtime: st.mtime.toISOString() };
    });
}
