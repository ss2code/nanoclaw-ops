// Unit tests for the pure version/revision patch logic (docs.ts). These are the
// must-never-fail mechanics — per the validation runbook, mechanics that must be
// deterministic live in code and get unit-tested, not left to the prompt.
import { describe, expect, test } from 'bun:test';
import { bump, readVersion, scaffold, summarize } from '../scripts/docs';

const D1 = '2026-06-14';
const D2 = '2026-06-15';

describe('scaffold', () => {
  test('produces a v1 doc with all three markers', () => {
    const html = scaffold({ title: 'Scotland Research', date: D1 });
    expect(readVersion(html)).toBe(1);
    expect(html).toContain('<meta name="doc-version" content="1">');
    expect(html).toContain('class="doc-version" data-version="1"');
    expect(html).toContain('id="revisions"');
    const s = summarize(html);
    expect(s.title).toBe('Scotland Research');
    expect(s.version).toBe(1);
    expect(s.date).toBe(D1);
    expect(s.revisions).toHaveLength(1);
  });

  test('seeds a references section and PDF print rules without disturbing the version markers', () => {
    const html = scaffold({ title: 'Scotland Research', date: D1 });
    // PDF is the delivered artifact, so the canonical HTML must be print-ready
    // and carry a Reference section for verified URLs (see instructions.md).
    expect(html).toContain('id="references"');
    expect(html).toMatch(/@media\s+print/i);
    // the version contract is untouched by the additions
    expect(readVersion(html)).toBe(1);
    expect(html).toContain('<meta name="doc-version" content="1">');
    expect(html).toContain('id="revisions"');
    // references must not be mistaken for a revision entry
    expect(summarize(html).revisions).toHaveLength(1);
  });
});

describe('bump', () => {
  test('increments version, refreshes date, prepends a revision', () => {
    const v1 = scaffold({ title: 'T', date: D1 });
    const { html, version } = bump(v1, 'dropped Glasgow, added Skye', D2);
    expect(version).toBe(2);
    expect(readVersion(html)).toBe(2);
    const s = summarize(html);
    expect(s.version).toBe(2);
    expect(s.date).toBe(D2);
    expect(s.revisions[0]).toEqual({ version: 2, date: D2, summary: 'dropped Glasgow, added Skye' });
    expect(s.revisions).toHaveLength(2); // newest + the v1 seed
  });

  test('is monotonic across repeated bumps and keeps full history', () => {
    let html = scaffold({ title: 'T', date: D1 });
    html = bump(html, 'change A', D2).html;
    html = bump(html, 'change B', D2).html;
    html = bump(html, 'change C', D2).html;
    expect(readVersion(html)).toBe(4);
    const versions = summarize(html).revisions.map((r) => r.version);
    expect(versions).toEqual([4, 3, 2, 1]);
  });

  test('migrates a legacy doc with no markers to v1 in place', () => {
    const legacy = '<!doctype html><html><head><title>Old Doc</title></head><body><h1>Old Doc</h1><p>body</p></body></html>';
    expect(readVersion(legacy)).toBe(0);
    const { html, version } = bump(legacy, 'first tracked version', D2);
    expect(version).toBe(1);
    expect(html).toContain('<meta name="doc-version" content="1">');
    expect(html).toContain('id="revisions"');
    expect(html).toContain('Old Doc'); // original content preserved
    expect(summarize(html).revisions[0].summary).toBe('first tracked version');
  });

  test('escapes HTML-significant characters in the summary', () => {
    const v1 = scaffold({ title: 'T', date: D1 });
    const { html } = bump(v1, 'added <b>bold</b> & more', D2);
    expect(html).toContain('added &lt;b&gt;bold&lt;/b&gt; &amp; more');
    // and it round-trips back to the original text when read
    expect(summarize(html).revisions[0].summary).toBe('added <b>bold</b> & more');
  });

  test('normalizes legacy section markers from § to # in place', () => {
    const legacy = '<!doctype html><html><body><h1>Trip</h1><p>See §day-1 and §stays.</p></body></html>';
    const { html } = bump(legacy, 'normalized § tags', D2);
    expect(html).toContain('See #day-1 and #stays.');
    expect(html).not.toContain('§');
  });
});
