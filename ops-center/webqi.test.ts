import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  WEBQI_ACTIVITY_PATH,
  WEBQI_CONVERSATION_PATH,
  WEBQI_HELP_PATH,
  WEBQI_LENSES,
  WEBQI_PATH,
  buildWebQiCommand,
  chatSubnav,
  webQiBody,
  webQiHelpBody,
} from './webqi.js';

describe('WebQI command seam', () => {
  it('supports every consult lens for a new consultation', () => {
    for (const lens of WEBQI_LENSES) {
      const command = buildWebQiCommand({
        action: 'new',
        protocol: 'quick',
        lens: lens.value,
        targets: ['atlas'],
        question: 'Which assumption should we test next?',
      });
      expect(command).toContain(`/consult quick --to atlas --lens ${lens.value}`);
    }
  });

  it('builds anchored continuation and local reprocessing commands', () => {
    expect(
      buildWebQiCommand({
        action: 'continue',
        rootId: 'C007',
        ref: 'C007:A1',
        protocol: 'verify',
        lens: 'critique',
        targets: ['atlas'],
        tiers: { atlas: 'high' },
        question: 'Challenge the strongest claim.',
      }),
    ).toBe(
      '/consult continue C007:A1 --protocol verify --to atlas --tier atlas=high --lens critique Challenge the strongest claim.',
    );
    expect(buildWebQiCommand({ action: 'reprocess', rootId: 'C007', ref: 'C007:A1', lens: 'steelman' })).toBe(
      '/consult lens C007:A1 steelman',
    );
    expect(buildWebQiCommand({ action: 'delete', rootId: 'C007' })).toBe('/consult delete C007');
    expect(
      buildWebQiCommand({
        action: 'reopen-continue',
        rootId: 'C007',
        ref: 'C007:Q0',
        protocol: 'explore',
        lens: 'extend',
        question: 'Continue the research.',
      }),
    ).toBe('/consult continue C007:Q0 --protocol explore --to auto --lens extend Continue the research.');
  });

  it('keeps the protocol target ceiling and rejects invalid lenses', () => {
    expect(() =>
      buildWebQiCommand({ action: 'new', protocol: 'quick', targets: ['a', 'b', 'c'], question: 'Too many?' }),
    ).toThrow('at most 2');
    expect(() => buildWebQiCommand({ action: 'new', lens: 'invented', question: 'No.' })).toThrow('unknown lens');
  });
});

describe('WebQI UI seam', () => {
  it('presents a conversation with advanced controls behind disclosure', () => {
    expect(chatSubnav(WEBQI_PATH)).toContain('Consult');
    const body = webQiBody();
    for (const lens of WEBQI_LENSES) expect(body).toContain(lens.value);
    for (const label of [
      'Get second opinion',
      'Ask a follow-up',
      'Original model answers',
      'Explain the disagreement',
      'Explore separately',
      'Details and full history',
      'Undo move to trash',
    ])
      expect(body).toContain(label);
    expect(body).toContain('<details id="wi-options">');
    expect(body).toContain('<details id="wi-advanced">');
    expect(body).toMatch(/session:\s*state.session.id/);
    expect(body).toContain(WEBQI_ACTIVITY_PATH);
    expect(body).toContain(WEBQI_CONVERSATION_PATH);
    expect(body).toContain(WEBQI_HELP_PATH);
  });

  it('emits syntactically valid browser JavaScript', () => {
    const body = webQiBody();
    const script = body.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('provides the complete WhatsApp command reference', () => {
    const body = webQiHelpBody();
    for (const command of [
      '/consult help all',
      '/consult deep',
      '/consult verify',
      '/consult decide',
      '/consult explore',
      '/consult debate',
      '/consult redteam',
      '/consult forecast',
      '/consult distill',
      '/consult critique',
      '/consult counsel',
      '/consult steelman',
      '/consult extend',
      '/consult contrast',
      '/consult referee',
      '/consult quick',
      '/consult ask',
      '/consult continue',
      '/consult branch',
      '/consult lens',
      '/consult judge',
      '/consult challenge',
      '/consult revise',
      '/consult show',
      '/consult sources',
      '/consult raw',
      '/consult roster',
      '/consult profile show',
      '/consult recent',
      '/consult roots',
      '/consult use',
      '/consult close',
      '/consult reopen',
      '/consult delete',
      '/consult restore',
    ]) {
      expect(body).toContain(command);
    }
    for (const command of ['/consult more', '/consult topics', '/consult done']) expect(body).toContain(command);
    const copy = JSON.parse(fs.readFileSync('container/skills/consult/references/help.json', 'utf8'));
    expect(body).toContain(copy.start.split('\n')[0]);
    expect(body).toContain('Messages without /consult stay normal chat');
    expect(body).toContain('Numbers stay tied to the list you saw');
  });

  it('keeps the graph snapshot pointer backed by a read-only server route', () => {
    const server = fs.readFileSync(path.join(process.cwd(), 'ops-center', 'server.ts'), 'utf8');
    expect(server).toContain('WEBQI_GRAPH_FILE_PATH');
    expect(server).toContain('WEBQI_CONVERSATION_PATH');
    expect(server).toContain('WEBQI_HELP_PATH');
    expect(server).toContain('webQiHelpBody()');
    expect(server).toContain('webQiConversation(');
    expect(server).toContain('webQiGraphFile(');
    expect(server).toContain('application/json; charset=utf-8');
    expect(server).toContain("content-disposition': 'inline'");
  });
});
