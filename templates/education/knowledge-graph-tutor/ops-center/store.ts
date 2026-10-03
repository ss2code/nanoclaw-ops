import fs from 'node:fs';
import path from 'node:path';

import { type TutorConsoleDraft } from './domain.js';

export interface ConsoleInstanceRecord {
  schema: 1;
  draft: TutorConsoleDraft;
  createdAt: string;
  appliedAt: string | null;
  deletedAt: string | null;
  purged: boolean;
  lastOperation: { at: string; kind: string; ok: boolean; message: string } | null;
}

function safeId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(value)) throw new Error('invalid tutor application id');
  return value;
}

export class TutorConsoleStore {
  readonly root: string;
  readonly recordsDir: string;
  readonly configsDir: string;

  constructor(root: string) {
    this.root = root;
    this.recordsDir = path.join(root, 'instances');
    this.configsDir = path.join(root, 'configs');
  }

  private ensure(): void {
    fs.mkdirSync(this.recordsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.configsDir, { recursive: true, mode: 0o700 });
  }

  private recordPath(id: string): string {
    return path.join(this.recordsDir, `${safeId(id)}.json`);
  }

  configPath(id: string): string {
    this.ensure();
    return path.join(this.configsDir, `${safeId(id)}.json`);
  }

  private writeJson(file: string, value: unknown): void {
    this.ensure();
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  read(id: string): ConsoleInstanceRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.recordPath(id), 'utf8')) as ConsoleInstanceRecord;
    } catch {
      return null;
    }
  }

  list(): ConsoleInstanceRecord[] {
    this.ensure();
    return fs
      .readdirSync(this.recordsDir)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(this.recordsDir, file), 'utf8')) as ConsoleInstanceRecord];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt));
  }

  saveDraft(draft: TutorConsoleDraft): ConsoleInstanceRecord {
    const existing = this.read(draft.id);
    const record: ConsoleInstanceRecord = {
      schema: 1,
      draft,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      appliedAt: existing?.appliedAt ?? null,
      deletedAt: existing?.deletedAt ?? null,
      purged: existing?.purged ?? false,
      lastOperation: existing?.lastOperation ?? null,
    };
    this.writeJson(this.recordPath(draft.id), record);
    return record;
  }

  saveRuntimeConfig(id: string, config: unknown): string {
    const file = this.configPath(id);
    this.writeJson(file, config);
    return file;
  }

  mark(id: string, kind: string, ok: boolean, message: string, flags: { applied?: boolean; deleted?: boolean; purged?: boolean } = {}): ConsoleInstanceRecord {
    const record = this.read(id);
    if (!record) throw new Error(`unknown console instance: ${id}`);
    const at = new Date().toISOString();
    record.lastOperation = { at, kind, ok, message: message.slice(0, 2000) };
    if (flags.applied && ok) {
      record.appliedAt = at;
      record.deletedAt = null;
      record.purged = false;
    }
    if (flags.deleted && ok) {
      record.deletedAt = at;
      record.purged = flags.purged === true;
    }
    this.writeJson(this.recordPath(id), record);
    return record;
  }
}
