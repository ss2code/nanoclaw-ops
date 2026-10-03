import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { PlaceStore } from './db';
import type { PlaceMediaView, PlaceView, RenderResult } from './types';
import { assertInside, escapeHtml, safeJsonForScript } from './util';

const IMAGE_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export interface RenderOptions {
  regionId: string;
  profile?: 'private' | 'share';
  outputDir?: string;
  maxEmbeddedImageBytes?: number;
}

interface RenderPayload {
  schemaVersion: 1;
  revision: number;
  generatedAt: string;
  profile: 'private' | 'share';
  region: ReturnType<PlaceStore['getRegion']>;
  places: PlaceView[];
  categories: Array<{ id: string; count: number }>;
  summary: {
    places: number;
    wantToGo: number;
    visited: number;
    revisit: number;
    rated: number;
  };
}

function mediaUrl(storeDir: string, item: PlaceMediaView, maxBytes: number): string | undefined {
  if (item.url) return item.url;
  if (!item.localPath) return undefined;
  try {
    const absolute = assertInside(storeDir, item.localPath);
    const mime = IMAGE_TYPES[extname(absolute).toLowerCase()];
    if (!mime || statSync(absolute).size > maxBytes) return undefined;
    return `data:${mime};base64,${readFileSync(absolute).toString('base64')}`;
  } catch {
    return undefined;
  }
}

function hydrateMedia(storeDir: string, places: PlaceView[], maxBytes: number): PlaceView[] {
  return places.map((place) => ({
    ...place,
    media: place.media.map((item) => {
      const url = mediaUrl(storeDir, item, maxBytes);
      return url ? { ...item, url } : item;
    }),
  }));
}

function buildPayload(store: PlaceStore, options: RenderOptions): RenderPayload {
  const profile = options.profile ?? 'private';
  const region = store.getRegion(options.regionId);
  const places = hydrateMedia(
    store.dir,
    store.listPlaces({ regionId: region.id, profile }),
    options.maxEmbeddedImageBytes ?? 1_500_000,
  );
  const categoryCounts = new Map<string, number>();
  for (const place of places) {
    for (const category of place.categories) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  return {
    schemaVersion: 1,
    revision: store.revision(),
    generatedAt: new Date().toISOString(),
    profile,
    region,
    places,
    categories: [...categoryCounts].map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id)),
    summary: {
      places: places.length,
      wantToGo: places.reduce((sum, place) => sum + place.summary.wantToGo, 0),
      visited: places.reduce((sum, place) => sum + place.summary.visited, 0),
      revisit: places.reduce((sum, place) => sum + place.summary.revisit, 0),
      rated: places.filter((place) => place.summary.ratingCount > 0).length,
    },
  };
}

function imageMediaFor(place: PlaceView): PlaceMediaView | undefined {
  return place.media.find((item) => Boolean(item.url) && item.kind !== 'source-card');
}

function placeInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

function iconPathFor(category: string | undefined): string {
  if (category === 'food-drink') return '<path d="M8 4v7m-3-7v7c0 2 1 3 3 3v7m5-17v8c0 2 1 3 3 3h1V4m-1 0v17"/><path d="M5 8h6"/>';
  if (category === 'hikes-walks-cycling') return '<path d="m3 20 6-9 4 5 3-4 5 8H3Z"/><path d="m14 7 2-3 2 3-2 3-2-3Z"/>';
  if (category === 'culture-history') return '<path d="m4 9 8-5 8 5M5 10h14M7 10v7m5-7v7m5-7v7M4 20h16"/>';
  if (category === 'nature-scenery') return '<path d="m3 20 6-8 3 4 4-7 5 11H3Z"/><path d="M17 5h.01"/>';
  return '<circle cx="12" cy="12" r="8"/><path d="m12 7 1.6 3.4L17 12l-3.4 1.6L12 17l-1.6-3.4L7 12l3.4-1.6L12 7Z"/>';
}

function fallbackVisualMarkup(place: PlaceView, className: string): string {
  const category = place.categories[0];
  return `<div class="${className}" aria-label="Illustrated mark for ${escapeHtml(place.name)}">
    <svg class="fallback-icon" viewBox="0 0 24 24" aria-hidden="true">${iconPathFor(category)}</svg>
    <span class="fallback-initials">${escapeHtml(placeInitials(place.name))}</span>
  </div>`;
}

function recentPlacesMarkup(payload: RenderPayload): string {
  const places = [...payload.places]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const tiles = places.map((place) => {
    const image = imageMediaFor(place);
    const visual = image?.url
      ? `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt || place.name)}" loading="lazy" referrerpolicy="no-referrer">`
      : fallbackVisualMarkup(place, 'recent-fallback');
    return `<a class="recent-tile" href="#${escapeHtml(place.anchor)}" aria-label="Open ${escapeHtml(place.name)}">
      <div class="recent-visual">${visual}</div>
      <div class="recent-overlay"><span>${escapeHtml(placeInitials(place.name))}</span><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.neighborhood || place.locality || 'Saved place')}</small></div>
    </a>`;
  }).join('');
  const note = places.length ? `${places.length} most recently added` : 'No places added yet';
  return `<div class="recent-panel" aria-label="Latest additions in ${escapeHtml(payload.region.name)}">
    <div class="map-label"><span>Latest additions</span><span>${escapeHtml(payload.region.name)}</span></div>
    <div class="recent-grid">${tiles || '<div class="recent-empty">Add a place to start your latest additions.</div>'}</div>
    <div class="map-caption"><span>${escapeHtml(note)}</span><span>Click a tile to open its record</span></div>
  </div>`;
}

function dashboardHtml(payload: RenderPayload): string {
  const title = `Places — ${payload.region.name}`;
  const summary = `${payload.summary.places} saved places in ${payload.region.name}; searchable by category, visit state, interest, and rating.`;
  const data = safeJsonForScript(payload);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="document-title" content="${escapeHtml(title)}">
  <meta name="document-summary" content="${escapeHtml(summary)}">
  <meta name="document-version" content="${payload.revision}">
  <meta name="document-profile" content="${payload.profile}">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--paper:#f7f2e9;--card:#fffdf8;--ink:#1c2430;--muted:#68716e;--line:#d9d0c0;--green:#2d5b46;--green-soft:#e3ece0;--red:#b54a32;--gold:#c98a1b;--gold-soft:#f7ecd4;--shadow:0 12px 28px rgba(40,37,28,.08)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 Georgia,"Times New Roman",serif}
    button,input,select{font:inherit}button{cursor:pointer}.shell{width:min(1180px,calc(100% - 32px));margin:auto}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,430px);gap:46px;align-items:center;padding:42px 0 28px}.hero-copy{padding:8px 0}.kicker,.map-label,.metric span,.map-caption,.count,.footer,.where,.signals,.detail-label,.card-kicker,.category-tab,.field,.details summary{font-family:ui-sans-serif,-apple-system,"Helvetica Neue",Arial,sans-serif}.kicker{color:var(--red);font-size:.68rem;letter-spacing:.18em;text-transform:uppercase}.hero h1{font:400 clamp(3.2rem,7.4vw,6.9rem)/.9 Georgia,"Times New Roman",serif;letter-spacing:-.07em;margin:.18em 0 .24em}.hero p{max-width:34rem;color:#3c4b49;font-size:1.16rem;line-height:1.45;margin:0}.hero-actions{display:flex;align-items:center;gap:14px;margin-top:24px;font:600 .78rem ui-sans-serif,-apple-system,sans-serif}.hero-actions a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--red);padding-bottom:3px}.hero-actions span{color:var(--muted);font-weight:400}
    .recent-panel{position:relative;max-width:430px;justify-self:end;width:100%;padding:15px 15px 11px;background:#e7e0d1;border:1px solid #cfc3af;border-radius:18px;box-shadow:var(--shadow);transform:rotate(.35deg)}.map-label{display:flex;justify-content:space-between;color:var(--green);font-size:.66rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;padding:0 3px 8px}.recent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;height:225px}.recent-tile{position:relative;min-width:0;overflow:hidden;border:1px solid rgba(45,91,70,.35);border-radius:10px;background:#b9cbb8;color:#fffdf8;text-decoration:none;box-shadow:0 2px 5px rgba(30,38,29,.08);transition:transform .15s ease,box-shadow .15s ease}.recent-tile:hover{transform:translateY(-2px);box-shadow:0 7px 14px rgba(30,38,29,.16)}.recent-visual,.recent-visual img,.recent-fallback{position:absolute;inset:0;width:100%;height:100%}.recent-visual img{object-fit:cover}.recent-fallback{display:grid;place-items:center;background:linear-gradient(145deg,#b9cbb8,#718d76)}.recent-overlay{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;padding:9px;background:linear-gradient(180deg,rgba(22,35,28,.04) 20%,rgba(19,28,25,.78) 100%)}.recent-overlay span{align-self:flex-start;border:1px solid rgba(255,253,248,.7);border-radius:999px;padding:2px 6px;font:700 .56rem ui-sans-serif,Arial,sans-serif;letter-spacing:.07em}.recent-overlay strong{font:700 .78rem/1.05 Georgia,serif;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent-overlay small{font:500 .6rem ui-sans-serif,Arial,sans-serif;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent-empty{grid-column:1/-1;display:grid;place-items:center;border:1px dashed #b9b0a1;border-radius:10px;color:var(--muted);font:.78rem ui-sans-serif,Arial,sans-serif;text-align:center;padding:20px}.map-caption{display:flex;justify-content:space-between;gap:8px;color:#647067;font-size:.63rem;padding:9px 2px 0}.map-caption span:last-child{text-align:right}
    .metrics{display:flex;flex-wrap:wrap;margin:0 0 24px;border-block:1px solid var(--ink)}.metric{flex:1 1 130px;padding:11px 16px;border-left:1px solid var(--line)}.metric:first-child{border-left:0}.metric b{display:block;font:700 1.7rem/1.05 Georgia,serif}.metric span{display:block;color:var(--muted);font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;margin-top:4px}
    .toolbar{position:sticky;top:0;z-index:5;background:rgba(247,242,233,.96);backdrop-filter:blur(12px);padding:11px 0;border-bottom:1px solid var(--line)}.filters{display:grid;grid-template-columns:minmax(0,1fr) minmax(200px,270px) 160px 160px;gap:12px;align-items:center}.category-tabs{display:flex;gap:8px;overflow:auto;grid-column:1/-1;padding:1px 0 3px;scrollbar-width:none}.category-tabs::-webkit-scrollbar{display:none}.category-tab{flex:none;border:1px solid #c9c0b1;border-radius:999px;padding:7px 15px;background:transparent;color:var(--ink);font-size:.76rem}.category-tab:hover,.category-tab.active{background:var(--green);border-color:var(--green);color:#fffdf8}.field{font-size:.78rem;border:1px solid #b9b0a1;background:var(--card);color:var(--ink);padding:9px 13px;border-radius:999px;width:100%;outline:none}.field:focus-visible{outline:2px solid var(--red);outline-offset:2px}.search{font-family:ui-sans-serif,-apple-system,"Helvetica Neue",Arial,sans-serif}
    .results-head{display:flex;justify-content:space-between;align-items:baseline;margin:27px 0 13px}.results-head h2{font:400 2rem/1 Georgia,serif;margin:0}.count{color:var(--muted);font-size:.73rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;padding-bottom:58px}.place{border:1px solid var(--line);background:var(--card);border-radius:14px;overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column;scroll-margin-top:120px}.place:target{outline:3px solid rgba(181,74,50,.28);outline-offset:4px}.visual{height:158px;position:relative;display:grid;place-items:center;border-bottom:4px solid transparent;background:#b9cbb8;overflow:hidden}.visual.visual-fallback{height:112px}.visual img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.visual:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 46%,rgba(19,25,30,.22));pointer-events:none}.fallback-mark{position:relative;z-index:1;display:flex;align-items:center;gap:9px;color:rgba(255,253,248,.96)}.fallback-icon{display:grid;place-items:center;width:34px;height:34px}.fallback-icon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.7}.fallback-initials{font:700 1.35rem ui-sans-serif,Arial,sans-serif;letter-spacing:.08em}.visual-stamp{position:absolute;z-index:2;left:12px;top:11px;border:1px solid rgba(255,253,248,.75);border-radius:999px;padding:3px 8px;color:#fffdf8;background:rgba(28,36,48,.35);font:700 .62rem ui-sans-serif,Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em}
    .content{padding:16px 16px 14px;display:flex;flex-direction:column;gap:8px;flex:1}.topline{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.place h3{font:400 1.45rem/1.05 Georgia,serif;margin:0}.rating{flex:none;font:700 .72rem ui-sans-serif,Arial,sans-serif;color:var(--gold);background:var(--gold-soft);padding:4px 8px;border-radius:999px;white-space:nowrap}.where{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:.74rem;min-height:1em}.vdot{width:7px;height:7px;border-radius:50%;flex:none}.vdot.verified{background:#4c9a6a}.vdot.provisional{background:var(--gold)}.vdot.unverified{background:transparent;border:1px solid var(--muted)}.vlabel{font-size:.66rem;color:var(--muted);text-transform:capitalize}.chips{display:flex;flex-wrap:wrap;gap:5px}.chip{display:inline-flex;align-items:center;gap:5px;font:600 .65rem ui-sans-serif,Arial,sans-serif;padding:4px 8px;border-radius:999px;white-space:nowrap}.chip.cat{background:hsl(var(--h) 52% 93%);color:hsl(var(--h) 46% 30%)}.chip.tag{background:#f0eadf;color:#736d5b}.chip.tag::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.6}.signals{display:flex;flex-wrap:wrap;gap:10px;color:var(--muted);font-size:.72rem}
    .details{border-top:1px solid var(--line);padding-top:9px;margin-top:5px}.details summary{display:flex;justify-content:space-between;gap:10px;align-items:center;cursor:pointer;color:var(--green);font-size:.74rem;font-weight:800;list-style:none}.details summary::-webkit-details-marker{display:none}.details summary:after{content:"+";font-size:1rem;font-weight:400}.details[open] summary:after{content:"–"}.summary-count{color:var(--muted);font-size:.65rem;font-weight:500;text-align:right}.detail-body{padding-top:13px}.detail-section{padding-top:11px;margin-top:11px;border-top:1px solid var(--line)}.detail-section:first-child{padding-top:0;margin-top:0;border-top:0}.detail-section h4{font:700 .66rem ui-sans-serif,Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 7px}.record-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.record-field{padding:8px 9px;background:var(--paper);border-radius:8px}.record-field b{display:block;font:700 .66rem ui-sans-serif,Arial,sans-serif;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.record-field span{display:block;margin-top:2px;font-size:.78rem;overflow-wrap:anywhere}.timeline{list-style:none;margin:0;padding:0}.timeline li{padding:9px 10px;background:var(--paper);border-radius:8px;margin-bottom:6px;font-size:.8rem}.timeline .meta{font:700 .72rem ui-sans-serif,Arial,sans-serif}.timeline .cmt{margin:4px 0;white-space:pre-wrap}.timeline small{display:block;color:var(--muted);font:500 .66rem ui-sans-serif,Arial,sans-serif}.detail-list{display:flex;flex-wrap:wrap;gap:5px}.detail-list .chip{font-size:.66rem}.aliases{color:#465550;font-size:.8rem;margin:0}.links{display:flex;flex-wrap:wrap;gap:8px;font:600 .72rem ui-sans-serif,Arial,sans-serif}.links a{color:var(--ink);text-decoration:underline;text-underline-offset:2px}.empty{grid-column:1/-1;text-align:center;padding:68px 20px;border:1px dashed #b9b0a1;border-radius:14px;background:rgba(255,253,248,.45)}.empty b{display:block;font:400 1.8rem Georgia,serif;margin-bottom:6px}.empty span{color:var(--muted);font:400 .85rem ui-sans-serif,Arial,sans-serif}.footer{color:var(--muted);padding:0 0 38px;font-size:.73rem}.hidden{display:none!important}
    @media(max-width:900px){.hero{grid-template-columns:minmax(0,1fr) minmax(280px,360px);gap:28px}.recent-grid{height:205px}.filters{grid-template-columns:minmax(0,1fr) minmax(180px,230px) 145px}.sort{grid-column:3}.search{grid-column:1}.visit{grid-column:2}}
    @media(max-width:700px){.hero{grid-template-columns:1fr;padding-top:30px}.recent-panel{justify-self:stretch;max-width:none;transform:none}.recent-grid{height:240px}.filters{grid-template-columns:1fr 1fr}.category-tabs{grid-column:1/-1}.search{grid-column:1/-1}.visit,.sort{grid-column:auto}}
    @media(max-width:440px){.shell{width:min(100% - 22px,1180px)}.hero h1{font-size:3.7rem}.hero p{font-size:1rem}.metric{padding:10px 11px}.metric b{font-size:1.35rem}.metric span{font-size:.58rem}.grid{grid-template-columns:1fr}.visual{height:174px}.record-grid{grid-template-columns:1fr}.summary-count{max-width:8rem}}
  </style>
</head>
<body>
  <header class="shell hero">
    <div class="hero-copy">
      <div class="kicker">Field notes · ${escapeHtml(payload.profile)} view</div>
      <h1>${escapeHtml(payload.region.name)}</h1>
      <p>A shared memory of places worth trying, returning to, or passing on. Every card keeps its notes, sources, and the group’s evolving experience attached to the place.</p>
      <div class="hero-actions"><a href="#places">Browse saved places</a><span>Click a latest addition to jump to its card</span></div>
    </div>
    ${recentPlacesMarkup(payload)}
  </header>
  <section class="shell metrics" aria-label="Tracker summary">
    <div class="metric"><b id="heroCount">${payload.summary.places}</b><span>saved places</span></div>
    <div class="metric"><b>${payload.summary.wantToGo}</b><span>want to go</span></div>
    <div class="metric"><b>${payload.summary.visited}</b><span>visited</span></div>
    <div class="metric"><b>${payload.summary.revisit}</b><span>revisit</span></div>
    <div class="metric"><b>${payload.summary.rated}</b><span>rated</span></div>
  </section>
  <div class="toolbar"><div class="shell filters">
    <div class="category-tabs" id="category-tabs" aria-label="Categories"></div>
    <input class="field search" id="search" type="search" placeholder="Search places, neighborhoods, tags…" aria-label="Search places">
    <select class="field visit" id="visit" aria-label="Visit state"><option value="">Any visit state</option><option value="visited">Visited</option><option value="revisit">Revisit</option><option value="not-visited">Not visited</option></select>
    <select class="field sort" id="sort" aria-label="Sort"><option value="recent">Recently updated</option><option value="name">Name</option><option value="rating">Highest rated</option><option value="wanted">Most wanted</option></select>
  </div></div>
  <main class="shell" id="places"><div class="results-head"><h2>Saved places</h2><div class="count" id="count"></div></div><div class="grid" id="grid"></div></main>
  <footer class="shell footer">Revision ${payload.revision} · Updated <span id="generated"></span> · Source links open in a new tab.</footer>
  <script type="application/json" id="places-data">${data}</script>
  <script>
  (() => {
    const CATEGORY_ORDER = ['food-drink','nature-scenery','hikes-walks-cycling','culture-history','arts-entertainment','nightlife','shopping-markets','sports-adventure','wellness','family-children','day-trips-drives','staycations'];
    const CATEGORY_LABELS = {'food-drink':'Food & drink','nature-scenery':'Nature & scenery','hikes-walks-cycling':'Hikes, walks & cycling','culture-history':'Culture & history','arts-entertainment':'Arts & entertainment','nightlife':'Nightlife','shopping-markets':'Shopping & markets','sports-adventure':'Sports & adventure','wellness':'Wellness','family-children':'Family & children','day-trips-drives':'Day trips & drives','staycations':'Staycations'};
    const data = JSON.parse(document.getElementById('places-data').textContent);
    const grid = document.getElementById('grid'), count = document.getElementById('count');
    const categoryTabs = document.getElementById('category-tabs');
    const search = document.getElementById('search'), visit = document.getElementById('visit'), sort = document.getElementById('sort');
    let selectedCategory = '';
    const label = value => value.replaceAll('-', ' ').replace(/\\b\\w/g, c => c.toUpperCase());
    const labelFor = id => CATEGORY_LABELS[id] || label(id);
    const hueFor = id => { const i = CATEGORY_ORDER.indexOf(id); return i < 0 ? 222 : Math.round((i * 360) / CATEGORY_ORDER.length); };
    const ICON_PATHS = {'food-drink':'<path d="M8 4v7m-3-7v7c0 2 1 3 3 3v7m5-17v8c0 2 1 3 3 3h1V4m-1 0v17"/><path d="M5 8h6"/>','hikes-walks-cycling':'<path d="m3 20 6-9 4 5 3-4 5 8H3Z"/><path d="m14 7 2-3 2 3-2 3-2-3Z"/>','culture-history':'<path d="m4 9 8-5 8 5M5 10h14M7 10v7m5-7v7m5-7v7M4 20h16"/>','nature-scenery':'<path d="m3 20 6-8 3 4 4-7 5 11H3Z"/><path d="M17 5h.01"/>','default':'<circle cx="12" cy="12" r="8"/><path d="m12 7 1.6 3.4L17 12l-3.4 1.6L12 17l-1.6-3.4L7 12l3.4-1.6L12 7Z"/>'};
    const imageFor = place => place.media.find(m=>m.url && m.kind!=='source-card');
    const initials = value => value.split(/\\s+/).filter(Boolean).slice(0,2).map(word=>word.charAt(0).toUpperCase()).join('');
    const el = (tag, cls, text) => { const node=document.createElement(tag); if(cls) node.className=cls; if(text!=null) node.textContent=text; return node; };
    const fallbackMark = (place, cat) => { const mark=el('div','fallback-mark'), icon=el('span','fallback-icon'); icon.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+(ICON_PATHS[cat]||ICON_PATHS.default)+'</svg>'; mark.append(icon,el('span','fallback-initials',initials(place.name))); return mark; };
    const allTab=el('button','category-tab active','All places'); allTab.type='button'; allTab.dataset.category=''; categoryTabs.append(allTab);
    data.categories.forEach(item => { const tab=el('button','category-tab',labelFor(item.id)+' · '+item.count); tab.type='button'; tab.dataset.category=item.id; categoryTabs.append(tab); });
    categoryTabs.addEventListener('click', event => { const tab=event.target.closest('button[data-category]'); if(!tab) return; selectedCategory=tab.dataset.category||''; categoryTabs.querySelectorAll('button').forEach(node=>node.classList.toggle('active',node===tab)); render(); });
    document.getElementById('generated').textContent = new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(data.generatedAt));
    function placeCard(place) {
      const card=el('article','place'); card.id=place.anchor;
      const cat=place.categories[0], hue=hueFor(cat);
      const visual=el('div','visual'); visual.style.borderBottomColor='hsl('+hue+' 40% 30%)';
      const image=imageFor(place);
      if(image){const img=el('img');img.src=image.url;img.alt=image.alt||place.name;img.loading='lazy';img.referrerPolicy='no-referrer';visual.append(img)}
      else{visual.classList.add('visual-fallback');visual.style.background=cat?('hsl('+hue+' 40% 34%)'):'#3a3d46';visual.append(fallbackMark(place,cat))}
      const stamp=el('span','visual-stamp',labelFor(cat||'saved')); visual.append(stamp);
      const content=el('div','content'), top=el('div','topline'), h3=el('h3','',place.name);
      top.append(h3);
      if(place.summary.ratingCount) top.append(el('span','rating','★ '+place.summary.ratingAverage));
      content.append(top);
      const where=el('div','where');
      where.append(el('span','vdot '+place.verificationState));
      if(place.verificationState!=='verified') where.append(el('span','vlabel',place.verificationState));
      where.append(document.createTextNode([place.neighborhood,place.locality,place.address].filter(Boolean).join(' · ')||'Location details pending'));
      content.append(where);
      const chips=el('div','chips');
      place.categories.forEach(v=>{const c=el('span','chip cat',labelFor(v));c.style.setProperty('--h',hueFor(v));chips.append(c)});
      place.tags.slice(0,5).forEach(v=>chips.append(el('span','chip tag',label(v))));
      content.append(chips);
      const signals=el('div','signals');
      if(place.summary.wantToGo) signals.append(el('span','',place.summary.wantToGo+' want to go'));
      if(place.summary.visited) signals.append(el('span','',place.summary.visited+' visited'));
      if(place.summary.revisit) signals.append(el('span','',place.summary.revisit+' revisit'));
      content.append(signals);
      const details=el('details','details'), summary=el('summary'); summary.append(el('span','summary-label','View full place record'),el('span','summary-count',place.activities.length+' notes · '+(place.sources.length+place.evidence.length)+' sources')); details.append(summary);
      const detailBody=el('div','detail-body');
      const record=el('div','detail-section'), recordHeading=el('h4','', 'Record'); record.append(recordHeading);
      const recordGrid=el('div','record-grid');
      const recordField=(name,value)=>{const field=el('div','record-field');field.append(el('b','',name),el('span','',value));return field};
      recordGrid.append(recordField('Verification',label(place.verificationState)+' · '+Math.round(place.confidence*100)+'% confidence'),recordField('Status',label(place.status)));
      if(place.coordinates) recordGrid.append(recordField('Coordinates',place.coordinates.lat.toFixed(5)+', '+place.coordinates.lng.toFixed(5)));
      record.append(recordGrid); detailBody.append(record);
      if(place.aliases.length){const aliases=el('div','detail-section'), heading=el('h4','', 'Also known as'); aliases.append(heading,el('p','aliases',place.aliases.join(' · '))); detailBody.append(aliases)}
      const tags=el('div','detail-section'), tagsHeading=el('h4','', 'All tags'), tagList=el('div','detail-list'); place.tags.forEach(v=>tagList.append(el('span','chip tag','#'+v))); tags.append(tagsHeading,tagList); detailBody.append(tags);
      if(place.memberStates.length){const states=el('div','detail-section'), statesHeading=el('h4','', 'Group status'), stateGrid=el('div','record-grid'); place.memberStates.forEach(state=>stateGrid.append(recordField(state.displayAlias,[label(state.interest||''),label(state.visitState),state.rating?'★ '+state.rating:'',state.lastComment||''].filter(Boolean).join(' · ')))); states.append(statesHeading,stateGrid); detailBody.append(states)}
      const activitySection=el('div','detail-section'), activityHeading=el('h4','', 'Notes and history'), timeline=el('ul','timeline');
      place.activities.forEach(a=>{const li=el('li'), main=[a.displayAlias,a.type,label(a.interest||''),label(a.visitState||''),a.rating?'★ '+a.rating:''].filter(Boolean).join(' · ');li.append(el('div','meta',main));if(a.comment)li.append(el('div','cmt',a.comment));li.append(el('small','',new Intl.DateTimeFormat(undefined,{dateStyle:'medium'}).format(new Date(a.occurredAt))));timeline.append(li)});
      if(!place.activities.length) timeline.append(el('li','', 'No group notes yet.')); activitySection.append(activityHeading,timeline); detailBody.append(activitySection);
      const linksSection=el('div','detail-section'), linksHeading=el('h4','', 'Sources and links'), links=el('div','links');
      place.sources.forEach((s,i)=>{const a=el('a','',s.platform+' source '+(i+1)+(s.title?' · '+s.title:''));a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';links.append(a)});
      place.evidence.forEach((item,i)=>{if(item.url){const a=el('a','','verification '+(i+1));a.href=item.url;a.target='_blank';a.rel='noopener noreferrer';links.append(a)}else links.append(el('span','',item.reference))});
      if(place.coordinates){const a=el('a','','Open map');a.href='https://www.openstreetmap.org/?mlat='+encodeURIComponent(place.coordinates.lat)+'&mlon='+encodeURIComponent(place.coordinates.lng)+'#map=16/'+encodeURIComponent(place.coordinates.lat)+'/'+encodeURIComponent(place.coordinates.lng);a.target='_blank';a.rel='noopener noreferrer';links.append(a)}
      linksSection.append(linksHeading,links); detailBody.append(linksSection); details.append(detailBody); content.append(details); card.append(visual,content); return card;
    }
    function render(){
      const q=search.value.trim().toLowerCase(), state=visit.value;
      let places=data.places.filter(p=>{
        const text=JSON.stringify([p.name,p.aliases,p.address,p.locality,p.neighborhood,p.categories,p.tags,p.memberStates,p.sources,p.evidence,p.activities]).toLowerCase();
        return (!q||q.split(/\\s+/).every(term=>text.includes(term)))&&(!selectedCategory||p.categories.includes(selectedCategory))&&(!state||p.memberStates.some(s=>s.visitState===state));
      });
      places.sort((a,b)=>sort.value==='name'?a.name.localeCompare(b.name):sort.value==='rating'?(b.summary.ratingAverage||0)-(a.summary.ratingAverage||0):sort.value==='wanted'?b.summary.wantToGo-a.summary.wantToGo:b.updatedAt.localeCompare(a.updatedAt));
      grid.replaceChildren();
      if(!places.length){const empty=el('div','empty');empty.append(el('b','',data.places.length?'No matching places':'Your city list starts here'),el('span','',data.places.length?'Try a broader search or clear a filter.':'Share a place with the save keyword and it will appear on this regional board.'));grid.append(empty)}
      else places.forEach(p=>grid.append(placeCard(p)));
      count.textContent=places.length+' of '+data.places.length;
    }
    [search,visit,sort].forEach(node=>node.addEventListener(node===search?'input':'change',render)); render();
  })();
  </script>
</body>
</html>`;
}

export function renderRegion(store: PlaceStore, options: RenderOptions): RenderResult {
  const payload = buildPayload(store, options);
  const outputDir = resolve(options.outputDir ?? join(store.dir, 'place-artifacts'));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const suffix = payload.profile === 'share' ? '-share' : '';
  const htmlPath = resolve(outputDir, `${payload.region.id}${suffix}.html`);
  const jsonPath = resolve(outputDir, `${payload.region.id}${suffix}.json`);
  if (dirname(htmlPath) !== outputDir || basename(htmlPath).includes('..')) throw new Error('unsafe output path');
  writeFileSync(htmlPath, dashboardHtml(payload), { mode: 0o600 });
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return {
    regionId: payload.region.id,
    revision: payload.revision,
    profile: payload.profile,
    htmlPath,
    jsonPath,
    places: payload.places.length,
  };
}
