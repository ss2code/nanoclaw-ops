import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('tutor deployment helper', () => {
  it('uses the Node-22-safe resolver and keeps tutor runtime source-backed', () => {
    const wrapper = fs.readFileSync(path.join(process.cwd(), 'bin', 'tutor-deploy'), 'utf8');
    const source = fs.readFileSync(
      path.join(process.cwd(), 'templates', 'education', 'knowledge-graph-tutor', 'host', 'deploy.ts'),
      'utf8',
    );
    expect(wrapper).toContain('scripts/resolve-node.sh');
    expect(wrapper).toContain('node_modules/tsx/dist/cli.mjs');
    expect(wrapper).toContain('SCRIPT="${BASH_SOURCE[0]}"');
    expect(wrapper).not.toContain('SCRIPT="\\${BASH_SOURCE[0]}"');
    expect(source).toContain("command === 'apply'");
    expect(source).toContain("'groups', 'restart'");
    expect(source).toContain("from './admin.js'");
    expect(source).not.toContain("from './knowledge-graph-tutor-admin.js'");
    expect(source).not.toContain('copyTemplate(config)');
    expect(source).toContain('source-backed runtime changes are picked up on the next wake');
  });
});
