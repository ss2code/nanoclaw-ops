// docs.ts — pure version + revision-history patching for a single canonical trip
// document (HTML). No DB, no fs: every function takes and returns strings, so the
// logic is deterministic and unit-testable (bun:test). The CLI (trip-docs.ts) owns
// file IO; this module owns the markers contract:
//
//   <meta name="doc-version" content="N">                          (in <head>, machine-readable)
//   <p class="doc-version" data-version="N">vN · updated DATE</p>   (visible header line)
//   <section id="revisions" class="revision-history"> … <ul>
//       <li data-version="N">vN · DATE — summary</li> … </ul></section>
//
// bump() increments N, refreshes the date, prepends a revision <li>, and INSERTS
// any missing markers — so a legacy doc (no markers) becomes versioned on its first
// bump, in place, without ever creating a second file. That single-file invariant
// is the deterministic side-effect the eval asserts.

export interface Revision {
  version: number;
  date: string;
  summary: string;
}
export interface DocState {
  version: number;
  date: string | null;
  title: string | null;
  revisions: Revision[];
}
export interface BumpResult {
  html: string;
  version: number;
  date: string;
  summary: string;
}
export type DocType = 'free' | 'research' | 'master' | 'recap';

const META_RE = /<meta\s+name=(["'])doc-version\1\s+content=(["'])(\d+)\2\s*\/?>/i;
const VLINE_RE = /<p\s+class=(["'])doc-version\1[^>]*>[\s\S]*?<\/p>/i;
const REV_UL_OPEN_RE = /(<section\b[^>]*\bid=(["'])revisions\2[\s\S]*?<ul\b[^>]*>)/i;
const TITLE_RE = /<title>([\s\S]*?)<\/title>/i;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Reverse of esc(): decode &lt;/&gt; before &amp; so escaped text round-trips cleanly.
function unesc(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Current tracked version, or 0 if the doc has no version marker yet. */
export function readVersion(html: string): number {
  const m = html.match(META_RE);
  return m ? parseInt(m[3], 10) : 0;
}

/** Keep the chat-facing section vocabulary consistent when upgrading a legacy doc. */
export function normalizeSectionMarkers(html: string): string {
  return html.replace(/§/g, '#');
}

function setMeta(html: string, version: number): string {
  const tag = `<meta name="doc-version" content="${version}">`;
  if (META_RE.test(html)) return html.replace(META_RE, tag);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
  return `${tag}\n${html}`;
}

function setVline(html: string, version: number, date: string): string {
  const line = `<p class="doc-version" data-version="${version}">v${version} · updated ${esc(date)}</p>`;
  if (VLINE_RE.test(html)) return html.replace(VLINE_RE, line);
  if (/<\/h1>/i.test(html)) return html.replace(/<\/h1>/i, `</h1>\n${line}`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1\n${line}`);
  return `${line}\n${html}`;
}

function prependRevision(html: string, rev: Revision): string {
  const li = `<li data-version="${rev.version}">v${rev.version} · ${esc(rev.date)} — ${esc(rev.summary)}</li>`;
  if (REV_UL_OPEN_RE.test(html)) return html.replace(REV_UL_OPEN_RE, `$1\n      ${li}`);
  const section = `<section id="revisions" class="revision-history">\n  <h2>Revision history</h2>\n  <ul>\n      ${li}\n  </ul>\n</section>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${section}\n</body>`);
  return `${html}\n${section}`;
}

/**
 * Increment the version, refresh the date, prepend a revision entry, and insert
 * any missing markers — all on the SAME html string (caller writes it back to the
 * same file). Never produces a second document.
 */
export function bump(html: string, summary: string, date: string): BumpResult {
  const next = readVersion(html) + 1;
  const normalizedSummary = normalizeSectionMarkers(summary);
  let out = normalizeSectionMarkers(html);
  out = setMeta(out, next);
  out = setVline(out, next, date);
  out = prependRevision(out, { version: next, date, summary: normalizedSummary });
  return { html: out, version: next, date, summary: normalizedSummary };
}

function baseStyle(): string {
  return `
    body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:28px 18px;color:#22262f;background:#fbfaf8}
    h1{margin:.2em 0;letter-spacing:-.01em}
    .doc-version{color:#6b7280;font-size:13px;margin:.2em 0 1.6em}
    .revision-history{margin-top:44px;border-top:1px solid #e8e3da;padding-top:14px;color:#6b7280;font-size:13px}
    .revision-history h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#9aa0aa}
    .revision-history ul{padding-left:18px;margin:.4em 0}
    .references{margin-top:36px;border-top:1px solid #e8e3da;padding-top:14px;font-size:14px}
    .references h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#9aa0aa}
    .references ul{padding-left:18px;margin:.4em 0}
    .references a{color:#2563eb;word-break:break-word}
    @page{margin:16mm 14mm}
    @media print{
      body{max-width:none;margin:0;padding:0;background:#fff;color:#000;font-size:12pt}
      h1,h2{break-after:avoid;page-break-after:avoid}
      section,figure,table,pre,blockquote{break-inside:avoid;page-break-inside:avoid}
      a{color:#000;text-decoration:underline}
    }
  `;
}

function masterStyle(): string {
  // Design tokens + component styles for the master document. The prose blocks
  // migrated from research docs reuse the same class vocabulary (badge-*, callout-*,
  // price, walk-dist, a.ext, compare-*), so authored and generated content read as
  // one document. Print CSS linearizes the tabs and hides interactive-only chrome.
  return `
    :root{--paper:#f3f4ef;--card:#fff;--ink:#22302a;--muted:#68766e;--line:#e3e6df;
      --brand-1:#12382b;--brand-2:#1f6a4c;--accent:#177a58;--accent-soft:#e7f3ed;
      --chip-ink:#3d5a4d;--gold:#b07f24;--transit:#6d4fc4;--city:#2c6fb0;--explore:#2b8a57}
    *{box-sizing:border-box}
    body{font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:0;color:var(--ink);background:var(--paper)}
    main{max-width:880px;margin:0 auto;padding:18px 16px 64px}
    a{color:#1d6fae;text-decoration:none;font-weight:500}a:hover{text-decoration:underline}
    a.ext::after{content:" ↗";font-size:.72em;opacity:.65}
    .master-header{background:linear-gradient(135deg,var(--brand-1),var(--brand-2));color:#fff;padding:26px 20px 20px}
    .master-header .inner{max-width:880px;margin:0 auto}
    .master-header h1{margin:0;font-size:1.55rem;letter-spacing:-.015em}
    .doc-version{color:#cfe3d8;font-size:12.5px;margin:.35em 0 .7em}
    .meta-chips{display:flex;flex-wrap:wrap;gap:7px;margin:2px 0 10px}
    .meta-chips .chip{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);color:#fff;border-radius:999px;padding:2px 11px;font-size:12px;font-weight:600}
    .stage-badge{display:inline-block;border-radius:999px;padding:2px 11px;font-size:12px;font-weight:700;background:#f6e6bf;color:#5c4508;text-transform:uppercase;letter-spacing:.05em}
    #how-to{margin-top:10px;font-size:13px;color:#e4efe9}
    #how-to summary{cursor:pointer;font-weight:600;opacity:.9}
    #how-to p{margin:.5em 0 0;opacity:.92}
    #how-to code{background:rgba(255,255,255,.15);border-radius:4px;padding:0 5px}
    nav.doc-nav{position:sticky;top:0;z-index:30;background:var(--card);border-bottom:1px solid var(--line);box-shadow:0 1px 4px rgba(20,40,30,.08);padding:8px 16px;display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
    nav.doc-nav a{font-size:12px;font-weight:700;color:var(--chip-ink);background:var(--accent-soft);border-radius:999px;padding:3px 10px}
    nav.doc-nav a:hover{background:#d3e9de;text-decoration:none}
    nav.doc-nav a.ops-link{background:#efe9fb;color:#4c3a8a}
    .tabs{display:flex;gap:0;margin:16px 0 4px;border:1px solid var(--line);border-radius:10px;overflow:hidden;width:max-content;background:var(--card)}
    .tabs button{border:0;background:transparent;padding:8px 18px;font-weight:700;font-size:13.5px;cursor:pointer;color:var(--muted)}
    .tabs button.active{background:var(--brand-2);color:#fff}
    .tab[hidden]{display:none}
    .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0;box-shadow:0 1px 3px rgba(20,40,30,.05)}
    .panel>h2{margin:0 0 12px;font-size:1.08rem;color:#173a2c;display:flex;align-items:baseline;gap:8px}
    .panel h3{font-size:.95rem;color:var(--accent);margin:18px 0 8px;border-bottom:1px solid var(--accent-soft);padding-bottom:4px}
    .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
    .summary-card{border:1px solid var(--line);border-radius:9px;padding:11px 13px;background:#fbfcfa;font-size:13px}
    .summary-card>a{display:block;margin-bottom:3px;color:var(--accent);font-size:13.5px}
    .stay-line,.route-line,.point-line{font-size:13px;margin:8px 0;padding:8px 10px;border-radius:7px;background:#f6f8f4}
    .route-line{background:#eef5f8}.point-line{background:#f7f3ea}
    .tag{margin-left:auto;font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8b978f;background:#f1f3ee;border-radius:6px;padding:2px 7px;text-decoration:none;flex-shrink:0;white-space:nowrap}
    .tag:hover{color:var(--accent);background:var(--accent-soft);text-decoration:none}
    h3 .tag,td .tag,li .tag{margin-left:6px}
    .muted{color:var(--muted)}.small{font-size:13px}
    .hint{color:var(--muted);font-size:13px;background:#f6f7f3;border:1px dashed var(--line);border-radius:8px;padding:8px 12px;margin:6px 0}
    table{border-collapse:collapse;width:100%;font-size:13.5px;margin:10px 0}
    th{background:#f2f5f0;color:#324139;text-align:left;padding:7px 10px;font-weight:600;border-bottom:2px solid var(--line)}
    td{text-align:left;padding:7px 10px;border-bottom:1px solid #eef1ea;vertical-align:top}
    tr:last-child td{border-bottom:none}
    .price{font-weight:600;color:#1f6a4c;white-space:nowrap}
    .walk-dist{font-size:.85em;color:var(--muted)}
    .badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;white-space:nowrap}
    .badge-green,.status-committed{background:#d2eedd;color:#175434}
    .badge-yellow,.status-shortlisted{background:#faedc4;color:#6d5209}
    .badge-gray,.status-candidate{background:#e7eae4;color:#55635b}
    .badge-red,.status-overdue{background:#f8dcd7;color:#8a2a1b}
    .badge-blue{background:#d4e6f5;color:#1c4c74}.badge-purple{background:#e7ddf8;color:#4c3a8a}
    .callout{border-radius:8px;padding:11px 14px;font-size:13.5px;margin:12px 0}
    .callout-blue{background:#eaf3fa;border-left:3px solid #2c6fb0}
    .callout-green{background:#ebf6ef;border-left:3px solid #2b8a57}
    .callout-yellow{background:#fdf7e3;border-left:3px solid #c9a13b}
    .callout-red{background:#fbeeec;border-left:3px solid #c4543f}
    .callout-purple{background:#f2edfb;border-left:3px solid #6d4fc4}
    .compare-box{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
    .compare-card{flex:1;min-width:230px;border-radius:10px;padding:14px 16px}
    .compare-card.blue{background:#eaf3fa}.compare-card.purple{background:#f2edfb}.compare-card.green{background:#ebf6ef}
    .compare-card h4{margin:0 0 8px;font-size:.92rem}.compare-card ul{margin:0;padding-left:18px;font-size:13px}
    .strip-wrap{overflow-x:auto;padding:4px 0}
    .route-strip{min-width:560px;width:100%;height:auto}
    .ribbon{display:flex;gap:6px;overflow-x:auto;padding:4px 0}
    .ribbon a{flex:1;min-width:86px;border-radius:9px;padding:8px 9px 7px;font-size:11.5px;line-height:1.35;color:var(--ink);border:1px solid var(--line);border-top:4px solid var(--rb,#9aa79f);background:#fbfcfa}
    .ribbon a:hover{text-decoration:none;background:var(--accent-soft)}
    .ribbon .rb-day{font-weight:800;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
    .ribbon .rb-place{font-weight:700;display:block}
    .ribbon .rb-theme{color:var(--muted);display:block}
    .ribbon .rb-deadline{color:#8a2a1b;font-weight:700}
    .day-card{border:1px solid var(--line);border-left:4px solid var(--explore);border-radius:10px;padding:14px 16px;margin:12px 0;background:#fdfdfc}
    .day-card.transit{border-left-color:var(--transit)}.day-card.city{border-left-color:var(--city)}
    .day-card .day-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);display:flex;align-items:baseline}
    .day-card h3{border:0;margin:2px 0 8px;padding:0;font-size:1rem;color:var(--ink)}
    ul.slots{list-style:none;margin:0;padding:0}
    ul.slots li{padding:5px 0;border-bottom:1px dashed #edf0e9;font-size:13.5px;display:flex;flex-wrap:wrap;gap:7px;align-items:baseline}
    ul.slots li:last-child{border-bottom:none}
    .slot-chip{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--chip-ink);background:var(--accent-soft);border-radius:5px;padding:1px 7px;min-width:66px;text-align:center}
    .travel-chip{font-size:11.5px;font-weight:600;color:#553c9a;background:#f2edfb;border-radius:5px;padding:1px 7px}
    .meal-line,.event-line{margin:8px 0 0;font-size:13px;color:#415048}
    .budget-chips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px}
    .budget-chips .chip{background:#f2f5f0;border:1px solid var(--line);border-radius:8px;padding:5px 12px;font-size:13px}
    .budget-chips .chip b{color:#1f6a4c}
    .bar{height:12px;background:#e8ebe4;border-radius:999px;overflow:hidden;margin:8px 0 4px}
    .bar>span{display:block;height:100%;background:linear-gradient(90deg,#2b8a57,#177a58)}
    .pulse{display:flex;gap:8px;flex-wrap:wrap}
    #geo-map-canvas{height:340px;border-radius:10px;border:1px solid var(--line)}
    .reload{display:none;position:sticky;top:0;background:#fdf3cf;border-bottom:1px solid #ecd98a;color:#5c4508;padding:9px 16px;z-index:40;font-size:13.5px;font-weight:600;cursor:pointer;text-align:center}
    .revision-history{margin-top:44px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:13px}
    .revision-history h2,.references h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#93a099;margin:0 0 6px}
    .revision-history ul,.references ul{padding-left:18px;margin:.4em 0}
    .references{margin-top:36px;border-top:1px solid var(--line);padding-top:14px;font-size:13.5px}
    .references a{word-break:break-word}
    @page{margin:14mm 12mm}
    @media print{
      body{background:#fff;font-size:11pt}
      main{max-width:none;padding:0}
      .master-header{background:#12382b!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;border-radius:0}
      nav.doc-nav,.tabs,.reload,#how-to,.geo-map{display:none}
      .tab[hidden]{display:block}
      .tab[hidden]::before{content:"Operations";display:block;font-size:1.25rem;font-weight:800;margin:22px 0 6px;border-top:2px solid #12382b;padding-top:12px}
      .panel,.day-card{box-shadow:none;break-inside:avoid;page-break-inside:avoid}
      h1,h2,h3{break-after:avoid;page-break-after:avoid}
      .tag{color:#777;background:none;border:1px solid #ccc}
      a{color:#000}
    }
  `;
}

/** A minimal, marker-compliant document at v1 for a brand-new topic. */
export function scaffold(opts: { title: string; date: string; summary?: string; type?: DocType }): string {
  const summary = opts.summary ?? 'Created';
  if (opts.type === 'master') return masterScaffold(opts.title, opts.date, summary);
  if (opts.type === 'recap') return recapScaffold(opts.title, opts.date, summary);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)}</title>
  <meta name="doc-version" content="1">
  <style>${baseStyle()}</style>
</head>
<body>
  <h1>${esc(opts.title)}</h1>
  <p class="doc-version" data-version="1">v1 · updated ${esc(opts.date)}</p>

  <!-- content goes here -->

  <section id="references" class="references">
    <h2>References</h2>
    <ul>
      <!-- Verified source URLs only — links you actually opened/confirmed.
           e.g. <li><a href="https://…">Source — the fact or booking it backs</a></li> -->
    </ul>
  </section>

  <section id="revisions" class="revision-history">
    <h2>Revision history</h2>
    <ul>
      <li data-version="1">v1 · ${esc(opts.date)} — ${esc(summary)}</li>
    </ul>
  </section>
</body>
</html>
`;
}

function recapScaffold(title: string, date: string, summary: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><meta name="doc-version" content="1"><meta name="doc-type" content="recap"><style>${baseStyle()}img{max-width:100%;max-height:220px;object-fit:cover;margin:4px;border-radius:6px}.photos{display:flex;flex-wrap:wrap}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{border:1px solid #e8e3da;padding:8px 12px;border-radius:8px}</style></head>
<body data-doc-type="recap"><h1>${esc(title)}</h1><p class="doc-version" data-version="1">v1 · updated ${esc(date)}</p>
<section><!-- gen:route sha256=empty --><!-- /gen:route --></section>
<section><h2>Intro</h2><!-- prose:intro --></section>
<section><!-- gen:stats sha256=empty --><!-- /gen:stats --></section>
<section><h2>Highlights</h2><!-- prose:highlights --></section>
<section><!-- gen:days sha256=empty --><!-- /gen:days --></section>
<section><h2>Superlatives</h2><!-- gen:superlatives sha256=empty --><!-- /gen:superlatives --></section>
<section><h2>Outtakes</h2><!-- prose:outtakes --></section>
<section id="references" class="references"><h2>References</h2><ul></ul></section>
<section id="revisions" class="revision-history"><h2>Revision history</h2><ul><li data-version="1">v1 · ${esc(date)} — ${esc(summary)}</li></ul></section></body></html>`;
}

function masterScaffold(title: string, date: string, summary: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="doc-version" content="1">
  <meta name="doc-type" content="master">
  <style>${masterStyle()}</style>
</head>
<body data-doc-type="master">
  <div class="reload" id="reload-banner"></div>
  <header class="master-header"><div class="inner">
    <h1>${esc(title)}</h1>
    <p class="doc-version" data-version="1">v1 · updated ${esc(date)}</p>
    <!-- gen:header sha256=empty -->
    <!-- /gen:header -->
    <details id="how-to">
      <summary>💬 Drive this doc from chat <a class="tag" href="#how-to">#how-to</a></summary>
      <p>This document is controlled from the group chat — nobody edits it directly. Refer to any section by its # tag and ask for changes or raise questions, e.g. <code>move the castle in #day-4 to the morning</code> or <code>question about #stays-portree</code>. To share the document: say <code>send the PDF</code>. To update the hosted web page: say <code>update the page</code> — that is a separate deploy step (compose → publish) and is NOT the same as making an edit.</p>
    </details>
  </div></header>
  <!-- gen:nav sha256=empty -->
  <!-- /gen:nav -->
  <main>
  <nav class="tabs" aria-label="Document tabs">
    <button type="button" data-tab="trip" class="active">Trip</button>
    <button type="button" data-tab="ops">Operations</button>
  </nav>
  <section id="tab-trip" class="tab">
    <!-- gen:summary sha256=empty -->
    <!-- /gen:summary -->
    <!-- gen:hero sha256=empty -->
    <!-- /gen:hero -->
    <section id="overview" class="panel">
      <h2>🧭 Overview <a class="tag" href="#overview">#overview</a></h2>
      <!-- prose:intro -->
    </section>
    <section id="route-options" class="panel">
      <h2>⚖️ Route options <a class="tag" href="#route-options">#route-options</a></h2>
      <!-- prose:options -->
    </section>
    <!-- gen:plan sha256=empty -->
    <!-- /gen:plan -->
    <section id="sights-overview" class="panel">
      <h2>🏰 Research &amp; sights <a class="tag" href="#sights-overview">#sights-overview</a></h2>
      <!-- prose:sights -->
    </section>
    <section id="food" class="panel">
      <h2>🥗 Food <a class="tag" href="#food">#food</a></h2>
      <!-- prose:food -->
    </section>
    <section id="weather" class="panel">
      <h2>🌦️ Weather window <a class="tag" href="#weather">#weather</a></h2>
      <!-- prose:weather -->
    </section>
    <section id="packing" class="panel">
      <h2>🎒 Packing &amp; accessibility <a class="tag" href="#packing">#packing</a></h2>
      <!-- prose:packing -->
    </section>
  </section>
  <section id="tab-ops" class="tab" hidden>
    <!-- gen:ops sha256=empty -->
    <!-- /gen:ops -->
  </section>
  <section id="references" class="references">
    <h2>References</h2>
    <!-- prose:references -->
    <ul><!-- Verified source URLs only. --></ul>
  </section>
  <section id="revisions" class="revision-history">
    <h2>Revision history</h2>
    <ul><li data-version="1">v1 · ${esc(date)} — ${esc(summary)}</li></ul>
  </section>
  </main>
  <script>
  (()=>{const buttons=[...document.querySelectorAll('[data-tab]')];const show=id=>{for(const b of buttons)b.classList.toggle('active',b.dataset.tab===id);for(const el of document.querySelectorAll('.tab'))el.hidden=el.id!=='tab-'+id;};for(const b of buttons)b.addEventListener('click',()=>show(b.dataset.tab));const opsHash=h=>h&&document.querySelector('#tab-ops '+h.replace(/[^#\\w-]/g,''))!=null;const jump=()=>{if(opsHash(location.hash)){show('ops');const el=document.querySelector(location.hash);el&&el.scrollIntoView();}};window.addEventListener('hashchange',jump);jump();fetch('version.json').then(r=>r.ok?r.json():null).then(v=>{const cur=document.querySelector('meta[name="doc-version"]')?.content;if(v&&cur&&String(v.version)!==cur){const el=document.getElementById('reload-banner');el.style.display='block';el.textContent='Updated to v'+v.version+(v.summary?': '+v.summary:'')+' — tap to reload';el.onclick=()=>location.reload();}}).catch(()=>{});})();
  </script>
</body>
</html>
`;
}

/**
 * Re-apply a document's version + revision history onto a freshly scaffolded
 * shell — the template-upgrade path (compose --rebuild). Pure string-in/string-out
 * so it is unit-testable like bump().
 */
export function restoreHistory(html: string, state: DocState): string {
  if (state.version < 1) return html;
  let out = setMeta(html, state.version);
  out = setVline(out, state.version, state.date ?? '');
  const items = state.revisions
    .sort((a, b) => b.version - a.version)
    .map((r) => `<li data-version="${r.version}">v${r.version} · ${esc(r.date)} — ${esc(r.summary)}</li>`)
    .join('\n      ');
  if (items) {
    out = out.replace(
      /(<section\b[^>]*\bid=(["'])revisions\2[\s\S]*?<ul\b[^>]*>)[\s\S]*?(<\/ul>)/i,
      `$1\n      ${items}\n  $3`,
    );
  }
  return out;
}

/** Read back version, date, title, and revision entries (newest first by document order). */
export function summarize(html: string): DocState {
  const version = readVersion(html);
  const vline = html.match(VLINE_RE)?.[0] ?? '';
  const date = vline.match(/updated\s+([^<]+?)\s*<\/p>/i)?.[1]?.trim() ?? null;
  const title = html.match(TITLE_RE)?.[1]?.trim() ?? null;
  const revisions: Revision[] = [];
  const liRe = /<li\s+data-version=(["'])(\d+)\1[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html))) {
    const text = m[3].replace(/<[^>]+>/g, '').trim();
    const dm = text.match(/·\s*([^—]+?)\s*—\s*([\s\S]*)$/);
    revisions.push({
      version: parseInt(m[2], 10),
      date: dm?.[1]?.trim() ?? '',
      summary: unesc((dm?.[2] ?? text).trim()),
    });
  }
  return { version, date, title, revisions };
}
