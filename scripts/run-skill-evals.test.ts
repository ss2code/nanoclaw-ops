import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = join(ROOT, 'container', 'skills', 'trip-companion-skills');

function evalScripts(): string[] {
  return readdirSync(SUITE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const evalDir = join(SUITE, entry.name, 'eval');
      if (!existsSync(evalDir)) return [];
      return readdirSync(evalDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(evalDir, name));
    });
}

describe('Trip Companion skill eval wiring', () => {
  it('batch script points at existing canonical nested skill evals', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'run-skill-evals.sh'), 'utf8');
    for (const rel of script.match(/container\/skills\/trip-companion-skills\/[^\s]+/g) ?? []) {
      expect(existsSync(join(ROOT, rel)), rel).toBe(true);
    }
    expect(script).not.toContain('container/skills/trip-core/eval');
  });

  it('batch script isolates live CLI eval sessions and fresh stateful sims', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'run-skill-evals.sh'), 'utf8');
    expect(script).toContain('RUN_ID=');
    for (const skill of ['trip-docs', 'trip-core', 'trip-finance', 'trip-planning']) {
      expect(script, skill).toContain(`--run "$RUN_ID-${skill}"`);
    }
    expect(script).toContain('trip-finance/eval/simulate.ts --run "$RUN_ID-trip-finance" --fresh');
    expect(script).toContain('trip-planning/eval/simulate.ts --run "$RUN_ID-trip-planning" --fresh');
  });

  it('eval scripts that declare ROOT resolve to the repository root', () => {
    for (const file of evalScripts()) {
      const source = readFileSync(file, 'utf8');
      const rootExpr = source.match(/const ROOT = resolve\(import\.meta\.dir, '([^']+)'\)/);
      if (!rootExpr) continue;
      expect(resolve(dirname(file), rootExpr[1]), file).toBe(ROOT);
    }
  });
});
