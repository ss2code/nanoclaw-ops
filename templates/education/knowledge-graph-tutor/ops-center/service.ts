import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import { createPairing, getPairing, type PairingIntent } from '../../../../src/channels/telegram-pairing.js';
import { buildTutorConfig, deriveIdentity, publicDraft, validateDraft, type TutorConsoleDraft } from './domain.js';
import { TutorConsoleStore } from './store.js';
import { readTutorApplicationStatus } from '../host/status.js';

const exec = promisify(execFile);

export interface ConsoleStatusItem {
  record: ReturnType<TutorConsoleStore['read']>;
  installed: boolean;
  lifecycle: { desiredState: string; status: string } | null;
  application: Record<string, unknown> | null;
  error: string | null;
}

export interface TutorConsoleApi {
  bootstrap(): Promise<Record<string, unknown>>;
  saveDraft(draft: TutorConsoleDraft): Promise<Record<string, unknown>>;
  startPairing(draft: TutorConsoleDraft, role: 'tutor' | 'student', slot?: string): Promise<Record<string, unknown>>;
  pairingStatus(code: string): Promise<Record<string, unknown>>;
  instantiate(draft: TutorConsoleDraft): Promise<Record<string, unknown>>;
  listStatus(): Promise<Record<string, unknown>>;
  classAction(id: string, action: string): Promise<Record<string, unknown>>;
  cleanup(id: string, purge: boolean, confirmation: string): Promise<Record<string, unknown>>;
}

export class TutorConsoleService implements TutorConsoleApi {
  readonly root: string;
  readonly store: TutorConsoleStore;
  readonly adminScript: string;
  readonly nclScript: string;
  readonly tsxCli: string;

  constructor(root: string, dataRoot = path.join(root, 'data', 'knowledge-graph-tutor-console'), templateRoot?: string) {
    this.root = path.resolve(root);
    this.store = new TutorConsoleStore(dataRoot);
    this.adminScript = path.join(templateRoot ?? path.join(this.root, 'templates', 'education', 'knowledge-graph-tutor'), 'host', 'admin.ts');
    this.nclScript = path.join(this.root, 'src', 'cli', 'client.ts');
    this.tsxCli = path.join(this.root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  }

  private async runTs(script: string, args: string[], timeout = 180_000): Promise<string> {
    const { stdout, stderr } = await exec(process.execPath, [this.tsxCli, script, ...args], {
      cwd: this.root,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return `${stdout}${stderr}`.trim();
  }

  async bootstrap(): Promise<Record<string, unknown>> {
    const records = this.store.list();
    return {
      drafts: records.map((record) => ({ ...record, draft: publicDraft(record.draft) })),
    };
  }

  async saveDraft(input: TutorConsoleDraft): Promise<Record<string, unknown>> {
    const draft = { ...deriveIdentity(input), updatedAt: new Date().toISOString() };
    const validation = validateDraft(draft);
    const record = this.store.saveDraft(draft);
    return { record, validation };
  }

  async startPairing(input: TutorConsoleDraft, role: 'tutor' | 'student', slot?: string): Promise<Record<string, unknown>> {
    const draft = deriveIdentity(input);
    if (!draft.classNumber.trim() || !draft.subject.trim()) {
      throw new Error('Enter the class number and subject before pairing.');
    }
    const intent: PairingIntent = role === 'tutor'
      ? { kind: 'new-agent', folder: draft.folder, slot: 'tutor' }
      : { kind: 'wire-to', folder: draft.folder, slot: slot || 'student' };
    const pairing = await createPairing(intent);
    return { code: pairing.code, status: pairing.status, role, createdAt: pairing.createdAt };
  }

  async pairingStatus(code: string): Promise<Record<string, unknown>> {
    if (!/^\d{4}$/.test(code)) throw new Error('invalid pairing code');
    const pairing = getPairing(code);
    if (!pairing) return { code, status: 'unknown' };
    return {
      code,
      status: pairing.status,
      attempts: pairing.attempts?.length ?? 0,
      consumed: pairing.consumed ? {
        platformId: pairing.consumed.platformId,
        isGroup: pairing.consumed.isGroup,
        name: pairing.consumed.name,
        telegramUserId: pairing.consumed.adminUserId ? `telegram:${pairing.consumed.adminUserId}` : '',
      } : null,
    };
  }

  async instantiate(input: TutorConsoleDraft): Promise<Record<string, unknown>> {
    const draft = { ...deriveIdentity(input), updatedAt: new Date().toISOString() };
    const validation = validateDraft(draft);
    if (validation.errors.length) throw new Error(validation.errors.join('\n'));
    this.store.saveDraft(draft);
    const config = buildTutorConfig(draft);
    const configPath = this.store.saveRuntimeConfig(config.id, config);
    try {
      const output = await this.runTs(this.adminScript, ['apply', configPath], 300_000);
      this.store.mark(config.id, 'instantiate', true, output, { applied: true });
      return { ok: true, id: config.id, output, status: await this.statusOne(config.id) };
    } catch (error) {
      const message = this.errorText(error);
      this.store.mark(config.id, 'instantiate', false, message);
      throw new Error(message);
    }
  }

  private errorText(error: unknown): string {
    const e = error as { stderr?: string; stdout?: string; message?: string };
    return String(e.stderr || e.stdout || e.message || error).slice(0, 4000);
  }

  private centralRuntime(id: string): { lifecycle: ConsoleStatusItem['lifecycle'] } {
    const file = path.join(this.root, 'data', 'v2.db');
    if (!fs.existsSync(file)) return { lifecycle: null };
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      const lifecycle = db.prepare('SELECT desired_state AS desiredState,lifecycle_status AS status FROM agent_group_lifecycle WHERE agent_group_id=?').get(id) as ConsoleStatusItem['lifecycle'];
      return { lifecycle: lifecycle ?? null };
    } finally {
      db.close();
    }
  }

  private async statusOne(id: string): Promise<ConsoleStatusItem> {
    const record = this.store.read(id);
    try {
      const application = readTutorApplicationStatus(this.root, id);
      const draft = record?.draft;
      const enrichedApplication: Record<string, unknown> = {
        ...application,
        tutor: draft ? {
          name: draft.tutor.name,
          paired: Boolean(draft.tutor.telegramUserId && draft.tutor.telegramGroupId),
          groupName: draft.tutor.telegramGroupName || null,
        } : null,
        roster: draft?.students.map((student, index) => ({
          name: student.name || `Student ${index + 1}`,
          rollNumber: student.rollNumber || null,
          paired: Boolean(student.telegramUserId && student.telegramGroupId),
        })) ?? [],
      };
      const runtime = this.centralRuntime(id);
      return { record, installed: true, ...runtime, application: enrichedApplication, error: null };
    } catch (error) {
      let runtime: ConsoleStatusItem['lifecycle'] = null;
      try { runtime = this.centralRuntime(id).lifecycle; } catch { /* preserve the actionable status error */ }
      return { record, installed: false, lifecycle: runtime, application: null, error: this.errorText(error) };
    }
  }

  async listStatus(): Promise<Record<string, unknown>> {
    const instances = await Promise.all(this.store.list().map((record) => this.statusOne(record.draft.id)));
    return { instances, checkedAt: new Date().toISOString() };
  }

  async classAction(id: string, action: string): Promise<Record<string, unknown>> {
    if (!/^[a-z][a-z0-9-]{0,49}$/.test(id)) throw new Error('invalid tutor application id');
    const command = action === 'shutdown' ? 'pause' : action;
    if (!['pause', 'resume', 'restart', 'stop'].includes(command)) throw new Error('unsupported class action');
    try {
      const output = await this.runTs(this.nclScript, ['groups', command, '--id', id]);
      this.store.mark(id, action, true, output);
      return { ok: true, output, status: await this.statusOne(id) };
    } catch (error) {
      const message = this.errorText(error);
      this.store.mark(id, action, false, message);
      throw new Error(message);
    }
  }

  async cleanup(id: string, purge: boolean, confirmation: string): Promise<Record<string, unknown>> {
    if (confirmation !== id) throw new Error(`Type the exact application ID “${id}” to confirm cleanup.`);
    const record = this.store.read(id);
    if (!record) throw new Error(`unknown tutor application: ${id}`);
    try {
      const args = ['delete', id, '--yes', ...(purge ? ['--purge'] : [])];
      const output = await this.runTs(this.adminScript, args, 300_000);
      this.store.mark(id, purge ? 'purge' : 'remove', true, output, { deleted: true, purged: purge });
      return { ok: true, output, purge };
    } catch (error) {
      const message = this.errorText(error);
      this.store.mark(id, purge ? 'purge' : 'remove', false, message);
      throw new Error(message);
    }
  }
}
