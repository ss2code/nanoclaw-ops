import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTemplate } from './parse.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-parse-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('parseTemplate', () => {
  it('parses mcpServers, instructions, context extras, and skills', () => {
    write('.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'mcp-fs', args: ['/data'] } } }));
    write('context/instructions.md', 'Be helpful.\n\n');
    write('context/playbook.md', '# Playbook');
    write('context/additional_context/faq.md', '# FAQ');
    write('skills/research/SKILL.md', 'do research');
    fs.writeFileSync(path.join(dir, 'context', 'notes.txt'), 'ignored'); // non-.md is ignored

    const tpl = parseTemplate(dir);

    expect(tpl.mcpServers).toEqual({ fs: { command: 'mcp-fs', args: ['/data'] } });
    expect(tpl.instructions).toBe('Be helpful.'); // trimEnd, instructions.md excluded from extras
    // Nested extras keep their context/-relative path as the name.
    expect(tpl.contextExtras.map((c) => c.name).sort()).toEqual(['additional_context/faq.md', 'playbook.md']);
    expect(tpl.skills.map((s) => s.name)).toEqual(['research']);
  });

  it('parses safe live runtime mounts', () => {
    write('runtime.json', JSON.stringify({ mounts: [{ source: 'app', target: '/workspace/agent/app' }] }));
    write('app/index.ts', 'export {}');
    write('context/instructions.md', 'Use the app.');
    const tpl = parseTemplate(dir);
    expect(tpl.runtimeMounts).toEqual([{ source: 'app', target: '/workspace/agent/app', readonly: true }]);
  });

  it('parses an optional Ops Center application contribution', () => {
    write(
      'ops-center.json',
      JSON.stringify({
        schema: 1,
        id: 'example-app',
        label: 'Example App',
        icon: '◇',
        entry: 'ops-center/index.ts',
        assets: 'ops-center/public',
        assetNames: ['app.js'],
      }),
    );
    write('ops-center/index.ts', 'export {}');
    write('ops-center/public/app.js', '');
    write('context/instructions.md', 'Use the app.');
    expect(parseTemplate(dir).opsCenter).toEqual({
      schema: 1,
      id: 'example-app',
      label: 'Example App',
      icon: '◇',
      entry: 'ops-center/index.ts',
      assets: 'ops-center/public',
      assetNames: ['app.js'],
    });
  });

  it('rejects runtime mounts outside the agent workspace', () => {
    write('context/instructions.md', 'No escape.');
    write('runtime.json', JSON.stringify({ mounts: [{ source: '.', target: '/app/src' }] }));
    expect(() => parseTemplate(dir)).toThrow(/must target \/workspace\/agent/);
  });

  it('defaults the optionals when only instructions.md is present', () => {
    write('context/instructions.md', 'Only instructions.');
    const tpl = parseTemplate(dir);
    expect(tpl.mcpServers).toEqual({});
    expect(tpl.contextExtras).toEqual([]);
    expect(tpl.runtimeMounts).toEqual([]);
    expect(tpl.skills).toEqual([]);
    expect(tpl.opsCenter).toBeNull();
  });

  it('throws when context/instructions.md is missing', () => {
    expect(() => parseTemplate(dir)).toThrow(/instructions\.md/);
  });

  it('throws when the folder does not exist', () => {
    expect(() => parseTemplate(path.join(dir, 'nope'))).toThrow(/not found/i);
  });

  it('parses a valid Agent Plugins 1.0.0 manifest and directory layout', () => {
    write(
      'plugin.json',
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'family-assistant',
        version: '1.0.0',
        description: 'A household assistant',
        extensions: { 'ai.nanoco.nanoclaw': { agentName: 'Family Assistant' } },
      }),
    );
    write(
      'mcp.json',
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { search: { type: 'stdio', command: 'search' } },
      }),
    );
    write('ai.nanoco.nanoclaw/context/instructions.md', 'Family persona.\n');
    write('ai.nanoco.nanoclaw/context/additional_context/faq.md', '# FAQ\n');
    write('ai.nanoco.nanoclaw/tasks/morning.md', '---\nschedule: "0 7 * * *"\n---\n\nSend the morning brief.\n');
    write(
      'skills/family-assistant/SKILL.md',
      '---\nname: family-assistant\ndescription: Household assistant\n---\n\nRoute family work.\n',
    );

    const parsed = parseTemplate(dir) as unknown as {
      name: string;
      version?: string;
      agentName?: string;
      instructions?: string;
      mcpServers: Record<string, unknown>;
      contextExtras: { name: string; content: string }[];
      skills: { name: string }[];
      tasks: { name: string; schedule: string; prompt: string }[];
      layout: string;
      report: string[];
    };

    expect(parsed.name).toBe('family-assistant');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.agentName).toBe('Family Assistant');
    expect(parsed.instructions).toBe('Family persona.');
    expect(parsed.mcpServers).toEqual({ search: { command: 'search', args: [], env: {} } });
    expect(parsed.contextExtras).toEqual([{ name: 'additional_context/faq.md', content: '# FAQ\n' }]);
    expect(parsed.skills).toEqual([{ name: 'family-assistant', srcDir: path.join(dir, 'skills/family-assistant') }]);
    expect(parsed.tasks).toEqual([
      {
        name: 'morning',
        schedule: '0 7 * * *',
        prompt: 'Send the morning brief.',
        source: 'ai.nanoco.nanoclaw/tasks/morning.md',
      },
    ]);
    expect(parsed.layout).toBe('agent-plugin');
    expect(parsed.report).toEqual([]);
  });

  it('parses the public Family Assistant shape without requiring an MCP file', () => {
    write(
      'plugin.json',
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'family-assistant',
        version: '1.0.0',
      }),
    );
    write('ai.nanoco.nanoclaw/context/instructions.md', '# Family Assistant\n');
    write('skills/welcome/SKILL.md', '---\nname: welcome\ndescription: Welcome a family\n---\n\nSay hello.\n');
    write(
      'skills/family-assistant/SKILL.md',
      '---\nname: family-assistant\ndescription: Run household workflows\n---\n\nRoute requests.\n',
    );
    write(
      'ai.nanoco.nanoclaw/tasks/weekly-week-ahead.md',
      '---\nschedule: "0 18 * * 0"\n---\n\nPrepare the week ahead.\n',
    );

    const parsed = parseTemplate(dir) as unknown as {
      name: string;
      instructions?: string;
      skills: { name: string }[];
      tasks: { name: string }[];
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.name).toBe('family-assistant');
    expect(parsed.instructions).toBe('# Family Assistant');
    expect(parsed.skills.map((skill) => skill.name)).toEqual(['family-assistant', 'welcome']);
    expect(parsed.tasks.map((task) => task.name)).toEqual(['weekly-week-ahead']);
    expect(parsed.mcpServers).toEqual({});
  });

  it.each([
    ['missing manifest', undefined, /plugin\.json not found/],
    ['malformed manifest JSON', '{not json', /plugin\.json is not valid JSON/],
    [
      'wrong manifest schema',
      JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/0.1.0/plugin.schema.json', name: 'broken' }),
      /plugin\.json \$schema must be/,
    ],
  ])('rejects %s while preserving the legacy-layout exception', (_case, manifest, expected) => {
    if (manifest !== undefined) write('plugin.json', manifest);
    expect(() => parseTemplate(dir)).toThrow(expected);
  });

  it('continues parsing a legacy template layout', () => {
    write('.mcp.json', JSON.stringify({ mcpServers: { legacy: { command: 'legacy-server' } } }));
    write('context/instructions.md', 'Legacy persona.\n');
    write('skills/legacy/SKILL.md', 'legacy skill body');

    const parsed = parseTemplate(dir) as unknown as {
      mcpServers: Record<string, unknown>;
      instructions?: string;
      layout: string;
    };
    expect(parsed.mcpServers).toEqual({ legacy: { command: 'legacy-server' } });
    expect(parsed.instructions).toBe('Legacy persona.');
    expect(parsed.layout).toBe('legacy');
  });

  it('keeps the existing education tutor template usable as a legacy template', () => {
    const tutorDir = path.resolve(process.cwd(), 'templates/education/knowledge-graph-tutor');
    const parsed = parseTemplate(tutorDir);
    expect(parsed.layout).toBe('legacy');
    expect(parsed.instructions).toMatch(/knowledge-graph tutor/i);
    expect(parsed.runtimeMounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: '/workspace/agent/tutor-app/app' })]),
    );
  });
});
