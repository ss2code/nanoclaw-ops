import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import os from 'os';
import { computeRuntimeFingerprint } from './container-image.js';

describe('agent container image', () => {
  it('includes attachment inspection, PDF extraction, and OCR tools', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('file');
    expect(dockerfile).toContain('poppler-utils');
    expect(dockerfile).toContain('tesseract-ocr');
  });

  it('bakes the finance skill Python market-data runtime into the shared image', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('python3-venv');
    expect(dockerfile).toContain('pandas==2.3.3');
    expect(dockerfile).toContain('yfinance==0.2.66');
    expect(dockerfile).toContain('/opt/finance-python/bin:$PATH');
  });

  it('labels builds with a source fingerprint and pulls the current base image', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');
    const buildScript = fs.readFileSync(path.join(process.cwd(), 'container', 'build.sh'), 'utf8');

    expect(dockerfile).toContain('NANOCLAW_BUILD_FINGERPRINT');
    expect(dockerfile).toContain('org.nanoclaw.build-fingerprint');
    expect(buildScript).toContain('--pull');
    expect(buildScript).toContain('NANOCLAW_BUILD_FINGERPRINT');
  });

  it('supports an explicit asynchronous rebuild of the shared default image', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'container-image.ts'), 'utf8');

    expect(source).toContain('export async function rebuildBaseImage');
    expect(source).toContain("container', 'build.sh");
    expect(source).toContain('await execFileAsync(');
    expect(source).toContain('timeout: 900_000');
  });

  it('changes the runtime fingerprint when a live source tree changes', () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-fingerprint-'));
    try {
      fs.writeFileSync(path.join(source, 'module.ts'), 'export const version = 1;\n');
      const first = computeRuntimeFingerprint(process.cwd(), [source]);
      fs.writeFileSync(path.join(source, 'module.ts'), 'export const version = 2;\n');
      expect(computeRuntimeFingerprint(process.cwd(), [source])).not.toBe(first);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
    }
  });
});
