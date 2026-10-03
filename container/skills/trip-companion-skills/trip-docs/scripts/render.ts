// render.ts — turn the canonical trip document (HTML) into the PDF that actually
// gets delivered to the chat. The HTML remains the single, version-stamped master
// (docs.ts owns that); this module only produces a derived <slug>.pdf snapshot from
// it. Page geometry/margins come from the document's own @page / @media print CSS
// (seeded by scaffold()), so rendering stays deterministic and faithful.
//
// The pure helpers (resolveChromium, buildPdfArgs) are unit-tested; the actual
// headless Chromium run (renderToPdf) is IO and is exercised by the smoke/E2E path.

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// Order matters: container env overrides first (the agent image sets these to the
// baked-in /usr/bin/chromium), then well-known Linux names, then macOS Chrome/Chromium
// for host-side smoke tests. No Playwright download is ever triggered.
const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/**
 * Resolve a usable Chromium/Chrome binary. Prefers the container's env overrides,
 * then a list of common install paths. `isUsable` is injectable so the resolution
 * order can be unit-tested without touching the real filesystem. Returns null when
 * nothing is available (caller should fall back to the agent-browser skill).
 */
export function resolveChromium(
  env: Record<string, string | undefined>,
  isUsable: (p: string) => boolean = (p) => existsSync(p),
): string | null {
  const fromEnv = [env.AGENT_BROWSER_EXECUTABLE_PATH, env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  for (const c of [...fromEnv, ...CANDIDATES]) {
    if (isUsable(c)) return c;
  }
  return null;
}

/**
 * Build the headless print-to-pdf argv (everything after the binary). Loads the
 * HTML over file:// and writes the target PDF. `--no-pdf-header-footer` drops
 * Chrome's default date/URL chrome; margins/format come from the document's CSS.
 */
export function buildPdfArgs(htmlAbsPath: string, pdfAbsPath: string): string[] {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfAbsPath}`,
    `file://${htmlAbsPath}`,
  ];
}

/**
 * Render <htmlPath> to a PDF and return its absolute path. Throws with an
 * actionable message if the source is missing, no Chromium is available, the
 * render exits non-zero, or no output file lands. The caller (trip-docs.ts)
 * surfaces that as a CLI error so the agent never claims a PDF it didn't produce.
 */
export async function renderToPdf(
  htmlPath: string,
  pdfPath?: string,
  env: Record<string, string | undefined> = process.env,
  opts: { timeoutMs?: number } = {},
): Promise<{ pdfPath: string; chromium: string }> {
  const htmlAbs = isAbsolute(htmlPath) ? htmlPath : resolve(htmlPath);
  if (!existsSync(htmlAbs)) throw new Error(`source HTML not found: ${htmlAbs}`);
  const pdfAbs = pdfPath ? (isAbsolute(pdfPath) ? pdfPath : resolve(pdfPath)) : htmlAbs.replace(/\.html?$/i, '.pdf');
  if (pdfAbs === htmlAbs) throw new Error(`refusing to overwrite the HTML master: ${htmlAbs}`);

  const chromium = resolveChromium(env);
  if (!chromium) {
    throw new Error(
      'no Chromium/Chrome binary found — set AGENT_BROWSER_EXECUTABLE_PATH, or render via the agent-browser skill instead',
    );
  }

  // Isolated profile so we never collide with a Chrome the user already has open.
  const profile = mkdtempSync(join(tmpdir(), 'trip-docs-chrome-'));
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const proc = Bun.spawn([chromium, `--user-data-dir=${profile}`, ...buildPdfArgs(htmlAbs, pdfAbs)], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  try {
    // Headless Chrome writes the PDF and then often LINGERS instead of exiting, so
    // we don't block on the process — we poll until the file is present and its
    // size has settled, then reap the process ourselves. Fast and hang-proof.
    const start = Date.now();
    let lastSize = -1;
    let done = false;
    while (Date.now() - start < timeoutMs) {
      if (proc.exitCode !== null) break; // exited on its own
      if (existsSync(pdfAbs)) {
        const size = statSync(pdfAbs).size;
        if (size > 0 && size === lastSize) { done = true; break; } // stable across two polls
        lastSize = size;
      }
      await Bun.sleep(250);
    }
    proc.kill();
    await proc.exited.catch(() => {});
    if (!done && (!existsSync(pdfAbs) || statSync(pdfAbs).size === 0)) {
      const err = await new Response(proc.stderr).text().catch(() => '');
      throw new Error(`render produced no output at ${pdfAbs} (chromium=${chromium})${err ? ` — ${err.trim().slice(0, 300)}` : ''}`);
    }
    return { pdfPath: pdfAbs, chromium };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
