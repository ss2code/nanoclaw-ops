#!/usr/bin/env bun
// trip-docs — single-canonical-file versioning for the trip's shared documents.
// The agent keeps ONE HTML file per document in /workspace/agent and routes every
// meaningful change through `bump`, so the version line + revision history stay
// consistent and NO second "(updated)" copy is ever created. WHEN to actually
// re-send a file to the chat (the delivery discipline) lives in instructions.md /
// SKILL.md — this CLI owns the file mechanics only.
//
// Usage: bun trip-docs.ts [--dir <docs-dir>] <verb> [options]
// See docs/local/apps/trip-companion/skill-validation-runbook.html (private overlay).

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bump, readVersion, scaffold, summarize, type DocType } from './docs';
import { renderToPdf } from './render';
import { composeMaster, composeRecap } from './compose';

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
const str = (f: Args['flags'], k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
function need(f: Args['flags'], k: string): string {
  const v = str(f, k);
  if (v === undefined) throw new Error(`--${k} is required`);
  return v;
}

const HELP = `trip-docs — one canonical HTML file per document, version-stamped in place

Global: --dir <docs-dir>  (default /workspace/agent)   --date YYYY-MM-DD   --json

  new <slug> --title "<Title>" [--summary <s>] [--type free|research|master|recap]
        scaffold <slug>.html at v1 with version + revision-history markers.
        master creates the standardized trip master template; recap creates the post-trip keepsake shell.
  compose <slug> --db <trip.db> [--hosted] [--rebuild]
        compose a master or recap document from trip.db + blocks/<slug>/*.html. Generated
        regions are hash-guarded; hand-edits inside them are refused.
        --hosted adds the interactive Leaflet map (for the deployed page).
        --rebuild regenerates the shell from the current template (keeps version
        history + prose blocks) — use after a template upgrade or if the shell
        was damaged by hand edits.
  bump <slug> --summary "<one-line what changed>"
        v N→N+1, refresh the date, prepend a revision entry — EDITS THE SAME FILE.
        Use for every meaningful change. Never hand-edit the version or make a copy.
  show <slug>
        print current version, date, and recent revisions (read-back proof)
  render <slug>
        render the canonical HTML to <slug>.pdf — the artifact you DELIVER to the
        chat. The HTML stays the version-stamped master; never send the .html.
        Always \`render\` after a \`bump\`, just before you attach the file.
  list
        every document in the dir with its current version

A <slug> may be given with or without the .html suffix.`;

function slugToFile(slug: string): string {
  return slug.endsWith('.html') ? slug : `${slug}.html`;
}

function renderConfirm(file: string, version: number, date: string, revs: { version: number; date: string; summary: string }[]): string {
  const recent = revs
    .sort((a, b) => b.version - a.version)
    .slice(0, 3)
    .map((r) => `     v${r.version} · ${r.date} — ${r.summary}`)
    .join('\n');
  return [
    `📄 DOC UPDATED ${file}  →  v${version} · ${date}`,
    `   one canonical file, edited in place — no new copy created`,
    `   recent:`,
    recent,
  ].join('\n');
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [verb, ...rest] = positional;
  const dir = str(flags, 'dir') ?? '/workspace/agent';
  const date = str(flags, 'date') ?? new Date().toISOString().slice(0, 10);
  const json = flags.json === true;

  if (!verb || verb === 'help') {
    console.log(HELP);
    return;
  }

  switch (verb) {
    case 'new': {
      if (!rest[0]) throw new Error('usage: new <slug> --title "<Title>"');
      const file = slugToFile(rest[0]);
      const path = join(dir, file);
      if (existsSync(path)) throw new Error(`${file} already exists — use \`bump\` to update it, not \`new\``);
      const type = (str(flags, 'type') ?? 'free') as DocType;
      if (!['free', 'research', 'master', 'recap'].includes(type)) throw new Error('--type must be free, research, master, or recap');
      const html = scaffold({ title: need(flags, 'title'), date, summary: str(flags, 'summary'), type });
      writeFileSync(path, html);
      if (type === 'master') {
        const slug = rest[0].replace(/\.html$/, '');
        mkdirSync(join(dir, 'blocks', slug), { recursive: true });
        await Bun.write(join(dir, 'blocks', slug, 'intro.html'), '<p class="muted">One-paragraph framing of where planning stands. Authored prose — edit freely.</p>');
        await Bun.write(join(dir, 'blocks', slug, 'options.html'), '<p class="muted">Route options under discussion (compare-box cards work well here). Remove once the route is locked.</p>');
        await Bun.write(join(dir, 'blocks', slug, 'sights.html'), '<p class="muted">Add sight research here.</p>');
        await Bun.write(join(dir, 'blocks', slug, 'food.html'), '<p class="muted">Add vegetarian food notes here.</p>');
        await Bun.write(join(dir, 'blocks', slug, 'weather.html'), '<p class="muted">Add weather notes here.</p>');
        await Bun.write(join(dir, 'blocks', slug, 'packing.html'), '<p class="muted">Add packing and accessibility notes here.</p>');
      }
      if (type === 'recap') {
        const slug = rest[0].replace(/\.html$/, ''); mkdirSync(join(dir, 'blocks', slug), { recursive: true });
        await Bun.write(join(dir, 'blocks', slug, 'intro.html'), '<p class="muted">A warm opening note for the trip.</p>');
        await Bun.write(join(dir, 'blocks', slug, 'highlights.html'), '<p class="muted">The moments everyone will retell.</p>');
        await Bun.write(join(dir, 'blocks', slug, 'outtakes.html'), '<p class="muted">The glorious mishaps and running jokes.</p>');
      }
      console.log(json ? JSON.stringify({ file, version: 1, type }) : `📄 DOC CREATED ${file}  →  v1 · ${date} · ${type}`);
      break;
    }
    case 'compose': {
      if (!rest[0]) throw new Error('usage: compose <slug> --db <trip.db>');
      const slug = rest[0].replace(/\.html$/, ''); const existing = join(dir, slugToFile(slug)); const isRecap = existsSync(existing) && /<meta name="doc-type" content="recap">/i.test(readFileSync(existing, 'utf8'));
      const res = (isRecap ? composeRecap : composeMaster)({ slug, dbPath: need(flags, 'db'), dir, date, hosted: flags.hosted === true, rebuild: flags.rebuild === true });
      console.log(
        json
          ? JSON.stringify(res)
          : [`📄 DOC COMPOSED ${res.file}  →  v${res.version}`, ...res.warnings.map((w) => `   ⚠ ${w}`)].join('\n'),
      );
      break;
    }
    case 'bump': {
      if (!rest[0]) throw new Error('usage: bump <slug> --summary "<what changed>"');
      const file = slugToFile(rest[0]);
      const path = join(dir, file);
      if (!existsSync(path)) throw new Error(`${file} not found in ${dir} — create it with \`new\` first`);
      const summary = need(flags, 'summary');
      const res = bump(readFileSync(path, 'utf8'), summary, date);
      writeFileSync(path, res.html);
      // Read-back proof: re-open the file and confirm the version landed.
      const after = summarize(readFileSync(path, 'utf8'));
      if (after.version !== res.version) throw new Error('write did not persist the new version');
      console.log(json ? JSON.stringify({ file, version: after.version, date }) : renderConfirm(file, after.version, date, after.revisions));
      break;
    }
    case 'show': {
      if (!rest[0]) throw new Error('usage: show <slug>');
      const file = slugToFile(rest[0]);
      const path = join(dir, file);
      if (!existsSync(path)) throw new Error(`${file} not found in ${dir}`);
      const s = summarize(readFileSync(path, 'utf8'));
      if (json) { console.log(JSON.stringify(s)); break; }
      console.log(`${s.title ?? file} — v${s.version} · updated ${s.date ?? '?'}`);
      for (const r of s.revisions.sort((a, b) => b.version - a.version).slice(0, 5)) console.log(`  v${r.version} · ${r.date} — ${r.summary}`);
      break;
    }
    case 'render': {
      if (!rest[0]) throw new Error('usage: render <slug>');
      const file = slugToFile(rest[0]);
      const htmlPath = join(dir, file);
      if (!existsSync(htmlPath)) throw new Error(`${file} not found in ${dir} — create it with \`new\` first`);
      const version = readVersion(readFileSync(htmlPath, 'utf8'));
      const { pdfPath } = await renderToPdf(htmlPath);
      const pdfFile = pdfPath.slice(dir.endsWith('/') ? dir.length : dir.length + 1);
      console.log(
        json
          ? JSON.stringify({ html: file, pdf: pdfFile, path: pdfPath, version })
          : [
              `📄 PDF RENDERED ${pdfFile}  →  from ${file} · v${version}`,
              `   deliver this PDF to the chat — the .html is the master, keep it in the workspace`,
            ].join('\n'),
      );
      break;
    }
    case 'list': {
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')) : [];
      const rows = files.map((f) => ({ file: f, version: readVersion(readFileSync(join(dir, f), 'utf8')) }));
      if (json) { console.log(JSON.stringify(rows)); break; }
      console.log(rows.map((r) => `v${r.version}  ${r.file}`).join('\n') || '(no documents)');
      break;
    }
    default:
      throw new Error(`unknown command "${verb}" — run \`trip-docs help\``);
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
