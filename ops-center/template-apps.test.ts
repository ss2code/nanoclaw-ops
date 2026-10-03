import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  discoverTemplateOpsCenterApps,
  serveTemplateAppAsset,
  templateAppFrame,
  templateAppNavigation,
} from './template-apps.js';

describe('template-provided Ops Center applications', () => {
  it('discovers Tutor Foundry from the template manifest', async () => {
    const apps = await discoverTemplateOpsCenterApps(process.cwd());
    const tutor = apps.find((app) => app.contribution.id === 'tutor-foundry');
    expect(tutor).toBeDefined();
    expect(templateAppNavigation(apps)).toContainEqual({ id: 'tutor-foundry', label: 'Tutor Foundry', icon: '⌁', path: '/tutor-foundry' });
    expect(templateAppFrame(tutor!)).toContain('src="/tutor-foundry/embed"');
    expect(serveTemplateAppAsset(tutor!, '/tutor-foundry/app.js')).toMatchObject({ contentType: 'text/javascript; charset=utf-8' });
    expect(serveTemplateAppAsset(tutor!, '/tutor-foundry/../index.html')).toBeUndefined();
  });

  it('rejects a template application that would shadow a core Ops Center route', async () => {
    const templatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-apps-'));
    try {
      fs.mkdirSync(path.join(templatesDir, 'bad', 'context'), { recursive: true });
      fs.mkdirSync(path.join(templatesDir, 'bad', 'ops-center', 'public'), { recursive: true });
      fs.writeFileSync(path.join(templatesDir, 'bad', 'context', 'instructions.md'), 'bad');
      fs.writeFileSync(path.join(templatesDir, 'bad', 'ops-center.json'), JSON.stringify({
        schema: 1, id: 'chat', label: 'Bad', icon: '!', entry: 'ops-center/index.ts', assets: 'ops-center/public', assetNames: ['app.js'],
      }));
      fs.writeFileSync(path.join(templatesDir, 'bad', 'ops-center', 'index.ts'), 'export function createTemplateOpsCenterApp() { return {}; }');
      fs.writeFileSync(path.join(templatesDir, 'bad', 'ops-center', 'public', 'app.js'), '');
      await expect(discoverTemplateOpsCenterApps(process.cwd(), templatesDir)).rejects.toThrow(/reserved/);
    } finally {
      fs.rmSync(templatesDir, { recursive: true, force: true });
    }
  });
});
