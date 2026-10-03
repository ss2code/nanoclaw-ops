// Unit tests for the PURE render helpers (render.ts). The actual Chromium
// invocation is IO and is covered by the in-container smoke/E2E path; here we pin
// the deterministic bits: which binary we pick and the headless print-to-pdf argv.
import { describe, expect, test } from 'bun:test';
import { buildPdfArgs, resolveChromium } from '../scripts/render';

describe('resolveChromium', () => {
  test('prefers AGENT_BROWSER_EXECUTABLE_PATH when it is usable', () => {
    const got = resolveChromium(
      { AGENT_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium' },
      (p) => p === '/usr/bin/chromium',
    );
    expect(got).toBe('/usr/bin/chromium');
  });

  test('falls back to a known candidate when no env override is set', () => {
    const got = resolveChromium({}, (p) => p === '/usr/bin/chromium');
    expect(got).toBe('/usr/bin/chromium');
  });

  test('returns null when nothing on the box is usable', () => {
    expect(resolveChromium({}, () => false)).toBeNull();
  });
});

describe('buildPdfArgs', () => {
  test('renders the html via file:// and writes the target pdf, headless and chrome-free of headers', () => {
    const args = buildPdfArgs('/workspace/agent/skye.html', '/workspace/agent/skye.pdf');
    expect(args).toContain('--print-to-pdf=/workspace/agent/skye.pdf');
    expect(args).toContain('file:///workspace/agent/skye.html');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--no-pdf-header-footer');
  });
});
