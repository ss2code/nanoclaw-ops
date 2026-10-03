import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readGroupTemplate, type TemplateResolver } from './templates.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Ops Center template reader', () => {
  it('summarizes the live template composition without treating source text as instructions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-template-reader-'));
    roots.push(root);
    const group = path.join(root, 'group');
    const template = path.join(root, 'template');
    fs.mkdirSync(path.join(group), { recursive: true });
    fs.mkdirSync(path.join(template, 'context', 'additional'), { recursive: true });
    fs.mkdirSync(path.join(template, 'skills', 'planner'), { recursive: true });
    fs.writeFileSync(
      path.join(group, '.nanoclaw-template.json'),
      JSON.stringify({ schema: 1, ref: 'education/demo', mode: 'live' }),
    );
    fs.writeFileSync(path.join(template, 'context', 'instructions.md'), 'Use the attached context.\nSecond line.\n');
    fs.writeFileSync(path.join(template, 'context', 'additional', 'faq.md'), '# FAQ\n');
    fs.writeFileSync(path.join(template, 'skills', 'planner', 'SKILL.md'), '---\nname: Planner\n---\n');
    fs.writeFileSync(path.join(template, '.mcp.json'), JSON.stringify({ mcpServers: { calendar: {}, search: {} } }));
    fs.writeFileSync(
      path.join(template, 'runtime.json'),
      JSON.stringify({ mounts: [{ source: 'context', target: '/workspace/agent/context' }] }),
    );

    const resolve: TemplateResolver = () => template;
    const info = readGroupTemplate(group, resolve);

    expect(info.status).toBe('ready');
    expect(info.ref).toBe('education/demo');
    expect(info.instructions?.lines).toBe(2);
    expect(info.contextExtras).toEqual([{ name: 'additional/faq.md', bytes: 6 }]);
    expect(info.skills.map((skill) => skill.name)).toEqual(['planner']);
    expect(info.mcpServers).toEqual(['calendar', 'search']);
    expect(info.runtimeMounts).toEqual([{ source: 'context', target: '/workspace/agent/context', readonly: true }]);
  });

  it('summarizes schema-2 live Agent Plugin references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-template-reader-'));
    roots.push(root);
    const group = path.join(root, 'group');
    const template = path.join(root, 'template');
    fs.mkdirSync(path.join(group), { recursive: true });
    fs.mkdirSync(path.join(template, 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
    fs.writeFileSync(
      path.join(group, '.nanoclaw-template.json'),
      JSON.stringify({
        schema: 2,
        ref: 'private/jeeves-family-assistant',
        mode: 'live',
        provenance: { name: 'jeeves-family-assistant', version: '1.0.0', layout: 'agent-plugin' },
        attachedAt: '2026-08-21T08:49:57.027Z',
        managed: { files: {}, trees: {}, mcpServers: {}, tasks: {} },
      }),
    );
    fs.writeFileSync(
      path.join(template, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'jeeves-family-assistant',
        version: '1.0.0',
      }),
    );
    fs.writeFileSync(path.join(template, 'ai.nanoco.nanoclaw', 'context', 'instructions.md'), 'Jeeves persona.\n');

    const info = readGroupTemplate(group, () => template);

    expect(info.status).toBe('ready');
    expect(info.ref).toBe('private/jeeves-family-assistant');
    expect(info.instructions?.lines).toBe(1);
    expect(info.instructions?.bytes).toBe(Buffer.byteLength('Jeeves persona.'));
  });

  it('distinguishes an ordinary group from a broken template reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-template-reader-'));
    roots.push(root);
    const group = path.join(root, 'group');
    fs.mkdirSync(group, { recursive: true });

    expect(readGroupTemplate(group, () => null).status).toBe('none');
    fs.writeFileSync(path.join(group, '.nanoclaw-template.json'), '{bad');
    const broken = readGroupTemplate(group, () => null);
    expect(broken.status).toBe('error');
    expect(broken.error).toMatch(/invalid|JSON/i);
  });
});
