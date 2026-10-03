import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { parseTutorConfig } from '../templates/education/knowledge-graph-tutor/host/admin.js';
import {
  modelContractMatches,
  parseLiveEvalArgs,
  shouldPauseForReview,
} from './knowledge-graph-tutor-live-eval.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const evaluator = () => fs.readFileSync(path.join(ROOT, '.claude/skills/new-knowledge-graph-tutor/scripts/evaluate.ts'), 'utf8');

describe('knowledge-graph tutor iterative evaluation wiring', () => {
  test('defines twelve journeys across all eight agreed personas', () => {
    const source = evaluator();
    for (const persona of [
      'systematic_novice', 'persistent_misconception', 'advanced', 'hint_dependent',
      'returning', 'uneven', 'visual_accessibility', 'safety_red_team',
    ]) expect(source).toContain(persona);
    expect(source.match(/id: '(?:math|science)-[^']+'/g)).toHaveLength(12);
  });

  test('persists immutable receipts, a queryable ledger, and blocker failures', () => {
    const source = evaluator();
    expect(source).toContain("flag: 'wx'");
    expect(source).toContain('CREATE TABLE IF NOT EXISTS iterations');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS journeys');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS turns');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS failures');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS trace_events');
    expect(source).toContain("new-knowledge-graph-tutor/scripts/evaluate.ts");
    expect(source).toContain("new-knowledge-graph-tutor/references/evaluation.md");
    expect(source).toContain("app/ingestion.ts");
    expect(source).toContain("app/operations.ts");
    expect(source).toContain("app/retrieval.ts");
    expect(source).toContain("app/visuals.ts");
    expect(source).toContain("setup/initialize.ts");
    expect(source).toContain("branching-mathematics-base-doc.md");
    expect(source).toContain("causal-science-base-doc.md");
    expect(source).toContain('process.exitCode = 1');
  });

  test('keeps simulated time behind the tutor harness guard', () => {
    const util = fs.readFileSync(path.join(ROOT, 'templates/education/knowledge-graph-tutor/app/util.ts'), 'utf8');
    expect(util).toContain("process.env.TUTOR_HARNESS === '1' && process.env.TUTOR_NOW");
  });

  test('validates the disposable eight-persona live configuration', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config-examples/knowledge-graph-tutor.eight-persona.synthetic.json'), 'utf8'));
    const parsed = parseTutorConfig(config);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.students).toHaveLength(8);
    expect(parsed.config?.model).toBe('claude-haiku-4-5-20251001');
    expect(new Set(parsed.config?.students.map((student) => student.channel.platformId)).size).toBe(8);
  });

  test('serial live lane attests the model and emits resumable human checkpoints', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/knowledge-graph-tutor-live-eval.ts'), 'utf8');
    expect(source).toContain('pauseUntilQuiet(config.id)');
    expect(source).toContain("groupAction(config.id, 'run')");
    expect(source).toContain('containersStopped > 2');
    expect(source).toContain('no intermediate learning traces persisted');
    expect(source).toContain('expected exact assessment keys');
    expect(source).toContain('blank attempt evidence row(s) persisted');
    expect(source).toContain('turns.length !== 60');
    expect(source).toContain('model preflight mismatch');
    expect(source).toContain('model attestation failed');
    expect(source).toContain("status: 'attention_required'");
    expect(source).toContain('refusing mixed-model resume');
    expect(source).toContain("flag: 'wx'");
  });

  test('defaults tuning runs to quality checkpoints and validates controls', () => {
    expect(parseLiveEvalArgs(['fixture.json', 'run-1'])).toEqual({
      configPath: 'fixture.json',
      runId: 'run-1',
      resume: false,
      checkpoint: 'on-quality',
      qualityThreshold: 1.7,
    });
    expect(parseLiveEvalArgs(['fixture.json', 'run-1', '--checkpoint', 'each-persona', '--resume'])).toMatchObject({
      resume: true,
      checkpoint: 'each-persona',
    });
    expect(() => parseLiveEvalArgs(['fixture.json', '--checkpoint', 'sometimes'])).toThrow(/checkpoint/);
    expect(shouldPauseForReview('each-persona', 2, 1.7, true)).toBe(true);
    expect(shouldPauseForReview('on-quality', 1.69, 1.7, true)).toBe(true);
    expect(shouldPauseForReview('on-quality', 1.7, 1.7, true)).toBe(false);
    expect(shouldPauseForReview('each-persona', 1, 1.7, false)).toBe(false);
  });

  test('requires an exact API-reported main model for attestation', () => {
    expect(modelContractMatches('claude-haiku-4-5-20251001', {
      main_calls: 4,
      main_models: { 'claude-haiku-4-5-20251001': 4 },
      subagent_calls: 0,
      subagent_models: {},
    })).toBe(true);
    expect(modelContractMatches('claude-haiku-4-5-20251001', {
      main_calls: 4,
      main_models: { 'claude-sonnet-5': 4 },
      subagent_calls: 0,
      subagent_models: {},
    })).toBe(false);
    expect(modelContractMatches('claude-haiku-4-5-20251001', {
      main_calls: 0,
      main_models: {},
      subagent_calls: 0,
      subagent_models: {},
    })).toBe(false);
  });
});
