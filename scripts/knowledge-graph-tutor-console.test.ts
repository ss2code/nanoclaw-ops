import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  buildTutorConfig,
  defaultDraft,
  deriveIdentity,
  newStudentDraft,
  slugify,
  validateDraft,
} from '../templates/education/knowledge-graph-tutor/ops-center/domain.js';
import { actionAuthorized, allowedHost, allowedOrigin } from '../templates/education/knowledge-graph-tutor/ops-center/server.js';
import { TutorConsoleStore } from '../templates/education/knowledge-graph-tutor/ops-center/store.js';
import {
  dispatchTutorFoundryRequest,
  renderTutorFoundryEmbed,
  tutorFoundryFrameBody,
} from '../templates/education/knowledge-graph-tutor/ops-center/ops-center.js';
import { TutorConsoleService } from '../templates/education/knowledge-graph-tutor/ops-center/service.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function validDraft() {
  const draft = defaultDraft();
  draft.classNumber = 'Class 6';
  draft.section = 'A';
  draft.subject = 'Mathematics';
  draft.tutor = {
    name: 'Meera', phone: '+91 91555 00001', telegramUserId: 'telegram:101',
    telegramGroupId: 'telegram:-1001001', telegramGroupName: 'Tutor control',
  };
  draft.students = [{
    ...newStudentDraft(), name: 'Asha', rollNumber: '17', phone: '+91 91555 00002',
    telegramUserId: '202', telegramGroupId: '-1002002', telegramGroupName: 'Asha private',
  }];
  return draft;
}

describe('knowledge-graph tutor console domain', () => {
  test('derives portable ids without hiding editable overrides', () => {
    const draft = validDraft();
    const derived = deriveIdentity(draft);
    expect(slugify('Class 6 – Mathematics')).toBe('class-6-mathematics');
    expect(derived.id).toBe('ag-class-6-a-mathematics');
    expect(derived.folder).toBe('class-6-a-mathematics');
    expect(derived.displayName).toBe('Class 6 – A Mathematics Tutor');
  });

  test('normalizes paired Telegram ids and preserves operator parameters outside runtime config', () => {
    const config = buildTutorConfig(validDraft());
    expect(config.tutor.user).toBe('telegram:101');
    expect(config.tutor.channel.platformId).toBe('telegram:-1001001');
    expect(config.students[0].user).toBe('telegram:202');
    expect(config.students[0].channel.platformId).toBe('telegram:-1002002');
    expect(config).not.toHaveProperty('phone');
    expect(config.students[0]).not.toHaveProperty('rollNumber');
  });

  test('rejects reused accounts and group routes before any lifecycle mutation', () => {
    const sameUser = validDraft();
    sameUser.students[0].telegramUserId = sameUser.tutor.telegramUserId;
    expect(validateDraft(sameUser).errors.join(' ')).toContain('different Telegram accounts');

    const sameGroup = validDraft();
    sameGroup.students[0].telegramGroupId = sameGroup.tutor.telegramGroupId;
    expect(validateDraft(sameGroup).errors.join(' ')).toContain('different Telegram group');
  });

  test('requires pairing but keeps phone numbers optional operator metadata', () => {
    const draft = validDraft();
    draft.tutor.phone = '';
    draft.students[0].phone = '';
    draft.students[0].telegramGroupId = '';
    const result = validateDraft(draft);
    expect(result.errors).toContain('Student 1 Telegram group has not been paired.');
    expect(result.errors.some((error) => /phone/i.test(error))).toBe(false);
  });

  test('requires class identity before issuing a pairing code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-console-pairing-'));
    cleanup.push(dir);
    const service = new TutorConsoleService(process.cwd(), dir);
    await expect(service.startPairing(defaultDraft(), 'tutor')).rejects.toThrow(/class number and subject/i);
  });
});

describe('knowledge-graph tutor console storage and HTTP boundary', () => {
  test('stores operator metadata privately and runtime config separately', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-console-store-'));
    cleanup.push(dir);
    const store = new TutorConsoleStore(dir);
    const draft = deriveIdentity(validDraft());
    store.saveDraft(draft);
    store.saveRuntimeConfig(draft.id, buildTutorConfig(draft));

    const recordFile = path.join(dir, 'instances', `${draft.id}.json`);
    const configFile = path.join(dir, 'configs', `${draft.id}.json`);
    expect(fs.statSync(recordFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(recordFile, 'utf8')).toContain('+91 91555 00001');
    expect(fs.readFileSync(configFile, 'utf8')).not.toContain('+91 91555 00001');
  });

  test('ships configuration, status, and workflow help while rejecting non-local or tokenless mutations', () => {
    const page = fs.readFileSync(path.resolve('templates/education/knowledge-graph-tutor/ops-center/public/index.html'), 'utf8');
    expect(page).toContain('Configuration');
    expect(page).toContain('Status');
    expect(page).toContain('Help');
    expect(page).toContain('Pair the tutor group');
    expect(page).toContain('Pair rooms before launch');
    expect(page).toContain('Containers start on the first message');
    expect(page).not.toContain('One calm place to launch');
    expect(page).not.toContain('Checking NanoClaw');
    expect(page).not.toContain('Checking Telegram');
    const app = fs.readFileSync(path.resolve('templates/education/knowledge-graph-tutor/ops-center/public/app.js'), 'utf8');
    expect(app).toContain('application-info');
    expect(app).toContain('Status unavailable');
    expect(app).toContain('Private room paired');
    expect(app).toContain('await saveDraft(false)');
    expect(app).toContain("slot: studentKey || 'tutor'");

    expect(allowedHost({ headers: { host: '127.0.0.1:10335' } })).toBe(true);
    expect(allowedHost({ headers: { host: 'evil.example' } })).toBe(false);
    expect(allowedOrigin({ headers: { origin: 'http://localhost:10335' } })).toBe(true);
    expect(allowedOrigin({ headers: { origin: 'https://evil.example' } })).toBe(false);
    expect(actionAuthorized({ headers: { origin: 'http://127.0.0.1:10335' } }, 'secret')).toBe(false);
    expect(actionAuthorized({ headers: { origin: 'http://127.0.0.1:10335', 'x-tutor-action-token': 'secret' } }, 'secret')).toBe(true);
  });

  test('launcher pins the tutor lifecycle to the Node 22 ABI contract', () => {
    const launcher = fs.readFileSync(path.resolve('templates/education/knowledge-graph-tutor/ops-center/launch.sh'), 'utf8');
    expect(launcher).toContain('^v22\\.');
    expect(launcher).toContain('v22*/bin/node');
  });

  test('renders the same three-tab application inside the Ops Center shell', () => {
    const assets = path.resolve('templates/education/knowledge-graph-tutor/ops-center/public');
    const page = renderTutorFoundryEmbed(assets, 'ops-secret');
    const frame = tutorFoundryFrameBody();

    expect(page).toContain('Configuration');
    expect(page).toContain('Status');
    expect(page).toContain('Help');
    expect(page).toContain('content="/api/tutor-foundry"');
    expect(page).toContain('content="x-ops-action-token"');
    expect(page).toContain('<body class="embedded">');
    expect(page).not.toContain('__ACTION_TOKEN__');
    expect(frame).toContain('src="/tutor-foundry/embed"');
    expect(frame).toContain('title="Tutor Foundry"');
  });

  test('uses an Ops Center dark palette with accessible embedded contrast', () => {
    const styles = fs.readFileSync(path.resolve('templates/education/knowledge-graph-tutor/ops-center/public/styles.css'), 'utf8');
    const block = styles.match(/body\.embedded\s*\{([^}]+)\}/)?.[1] ?? '';
    const colors = Object.fromEntries(
      [...block.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]),
    );
    const luminance = (hex: string) => {
      const values = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
    };
    const contrast = (a: string, b: string) => {
      const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (lighter + 0.05) / (darker + 0.05);
    };

    expect(block).toContain('color-scheme: dark');
    expect(contrast(colors['--ink'], colors['--paper'])).toBeGreaterThanOrEqual(7);
    expect(contrast(colors['--muted'], colors['--card'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors['--green'], colors['--card'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors['--ops-on-action'], colors['--green'])).toBeGreaterThanOrEqual(4.5);
    expect(styles).toContain('body.embedded input');
    expect(styles).toContain('body.embedded .button.primary');
  });

  test('dispatches namespaced Ops Center routes through the canonical console API', async () => {
    const calls: string[] = [];
    const api = {
      bootstrap: async () => ({ page: 'bootstrap' }),
      saveDraft: async () => ({ ok: true }),
      startPairing: async (_draft: never, role: 'tutor' | 'student') => ({ role }),
      pairingStatus: async (code: string) => ({ code }),
      instantiate: async () => ({ ok: true }),
      listStatus: async () => ({ page: 'status' }),
      classAction: async (id: string, action: string) => { calls.push(`${id}:${action}`); return { ok: true }; },
      cleanup: async (id: string, purge: boolean) => { calls.push(`${id}:${purge}`); return { ok: true }; },
    };

    await expect(dispatchTutorFoundryRequest(api, 'GET', '/api/tutor-foundry/bootstrap')).resolves.toEqual({ page: 'bootstrap' });
    await expect(dispatchTutorFoundryRequest(api, 'GET', '/api/tutor-foundry/pairings/1234')).resolves.toEqual({ code: '1234' });
    await expect(dispatchTutorFoundryRequest(api, 'POST', '/api/tutor-foundry/pairings', { role: 'student', draft: {} })).resolves.toEqual({ role: 'student' });
    await dispatchTutorFoundryRequest(api, 'POST', '/api/tutor-foundry/instances/ag-class-6/action', { action: 'pause' });
    await dispatchTutorFoundryRequest(api, 'POST', '/api/tutor-foundry/instances/ag-class-6/cleanup', { purge: true, confirmation: 'ag-class-6' });
    expect(calls).toEqual(['ag-class-6:pause', 'ag-class-6:true']);
    await expect(dispatchTutorFoundryRequest(api, 'POST', '/api/tutor-foundry/instances/../../action', {})).resolves.toBeUndefined();
  });
});
