/**
 * Server-rendered HTML. Dark theme matching the project's design docs.
 * Live updates: a small vanilla JS client subscribes to /events (SSE) and
 * patches elements by id — no framework, no build step (design §1).
 */
import type { GroupLive } from './collector.js';
import { isSupportedCodexModelId } from '../src/codex-models.js';
import type { SeriesPoint, UsageBucket, UsageBucketBreakdown } from './opsdb.js';
import { unionDurationMs, type ActivitySpan } from './readers/lifecycle.js';
import { matchPreset, type GroupConfigSnapshot, type MemberInfo, type WiringInfo } from './readers/central.js';
import { catalogByIntelligence, findCatalogModel, type ModelCatalog } from './readers/model-catalog.js';
import { isCore, type ResolvedSkills, type SkillInfo } from './readers/skills.js';
import type { GroupRuntimeHooks, ImageBuildManifest } from './readers/container-build.js';
import type { ContainerImageStatus } from './readers/container-image.js';
import type { GroupTemplateInfo } from './readers/templates.js';
import type { RuntimeManifest } from './readers/runtime-manifest.js';
import type { RecoveryStatus } from './machine-recovery.js';
import {
  providerAuthDaysRemaining,
  providerAuthState,
  type ProviderAuthRecord,
  type ProviderAuthStatus,
} from './readers/provider-auth.js';

/** Single-line clamp for free-text fields (skill descriptions). */
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export const fmtBytes = (n: number | null | undefined): string => {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

export const fmtAge = (ms: number | null | undefined): string => {
  if (ms == null) return '–';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
};

export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

/** Compact numeral for hero metric slots — no trailing `.0` (e.g. 186k, 1.2M). */
export const fmtCompact = (n: number): string =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(Math.round(n));

/**
 * Parse a stored timestamp into a Date. All stored timestamps are UTC — ISO strings
 * carry a `Z`, while SQLite `datetime('now')` values are zone-less (e.g. "2026-06-13
 * 00:34:48"). A zone-less string must be read as UTC (matching `toUtcMs` in the session
 * reader), otherwise `new Date()` would treat it as local and shift it by the offset.
 */
const parseStamp = (ts: string): Date | null => {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts);
  const d = new Date(hasZone ? ts : ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Render a stored UTC timestamp in the host's local timezone, e.g. "Jun 13, 07:33:51".
 * The rest of the dashboard (charts, routing decisions) is local-time, so tables must
 * match — a raw `ts.slice(...)` shows UTC and looks stale.
 */
export const fmtTs = (ts: string | null | undefined): string => {
  if (!ts) return '–';
  const d = parseStamp(ts);
  return d
    ? d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : String(ts);
};

/** Date-only local rendering of a stored UTC timestamp, e.g. "Jun 13, 2026". */
export const fmtDate = (ts: string | null | undefined): string => {
  if (!ts) return '–';
  const d = parseStamp(ts);
  return d ? d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : String(ts);
};

export const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CSS = `
/* ═══ TOWER design system — docs/local/ops-design-systems.html (private overlay) (SYSTEM 01) ═══
   Control-room dark: slate surfaces (3 elevation steps), Instrument Sans for
   words + IBM Plex Mono for machine data, and a strict color contract —
   blue = interactive only · green/amber/red = health only (red errors ONLY)
   · violet family = triggers · stable lane color per agent group.
   Legacy var names (--teal etc.) are aliased onto contract colors so existing
   server.ts markup keeps rendering correctly. */
:root{
  --bg:#0c0f13;--panel:#13171d;--raise:#1a2028;--edge:rgba(255,255,255,.065);--edge2:rgba(255,255,255,.12);
  --ink:#eef2f6;--sub:#9fadbb;--dim:#5c6a78;
  --act:#4cc3ff;--ok:#3fce7c;--warn:#ffb020;--err:#ff5d5d;
  --t-chat:#2dd4bf;--t-sched:#ffb020;--t-a2a:#a78bfa;--t-deleg:#8f7ff7;--t-sys:#758291;--t-compact:#f472b6;--t-wake:#3fce7c;
  --mono:"IBM Plex Mono",ui-monospace,Menlo,monospace;
  --sans:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  /* legacy aliases — semantic mapping per the color contract */
  --teal:var(--act);--green:var(--ok);--amber:var(--warn);--red:var(--err);--rose:#ff8a8a;--violet:var(--t-a2a);
  --line:var(--edge);--panel2:var(--raise);--muted:var(--sub)}
*{box-sizing:border-box}
html{scrollbar-color:#2a323d var(--bg)}
body{margin:0;background:var(--bg);color:var(--sub);font:13.5px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--act);text-decoration:none} a:hover{text-decoration:underline}
b{color:var(--ink);font-weight:600}
code{font:500 11.5px var(--mono)}
.sp{flex:1}

/* ── app shell ── */
.shell{display:grid;grid-template-columns:var(--sidew,216px) minmax(0,1fr);min-height:100vh}
html.navmin .shell{grid-template-columns:58px minmax(0,1fr)}
html.navmin .brand .nm,html.navmin .side nav .lbl,html.navmin .side nav .badge,html.navmin .brand .sp{display:none}
/* Collapsed: stack the logo and the expand button in a centered column so the
   button sits under the logo instead of overlapping the first nav item. */
html.navmin .brand{padding:0 0 12px;flex-direction:column;gap:8px}
html.navmin .side nav a{justify-content:center;padding:9px 0}
html.navmin .navbtn{position:static}
html.navmin .resizer{display:none}
.navbtn{width:22px;height:22px;border-radius:6px;border:1px solid var(--edge2);background:var(--raise);color:var(--dim);
font-size:11px;cursor:pointer;padding:0;display:grid;place-items:center;flex:none}
.navbtn:hover{color:var(--act);border-color:var(--act)}
html.navmin .navbtn:after{content:"»"} html.navmin .navbtn{font-size:0} html.navmin .navbtn:after{font-size:11px}
.resizer{position:absolute;right:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:6}
.resizer:hover{background:linear-gradient(90deg,transparent 40%,rgba(76,195,255,.4) 50%,transparent 60%)}
.side{position:sticky}
.side nav .ic{width:16px;text-align:center;font-size:12px;opacity:.7;flex:none}
.side nav a.active .ic{opacity:1;color:var(--act)}
.badge{margin-left:auto;font:600 10px var(--mono);padding:1px 7px;border-radius:99px}
.badge.err{background:rgba(255,93,93,.16);color:var(--err)}
.badge.warn{background:rgba(255,176,32,.14);color:var(--warn)}
.tvit{display:inline-flex;align-items:center;gap:5px;font:500 11px var(--mono);color:var(--dim);white-space:nowrap}
.tvit b{color:var(--sub);font-weight:600;font-size:11px}
.tvit .dot{margin-right:0}
.tvit.chgrp{gap:10px;border-left:1px solid var(--edge);padding-left:12px}
.tvit.chgrp span{display:inline-flex;align-items:center;gap:4px}
.fmore{grid-column:1/-1;display:flex;gap:8px 22px;align-items:center;flex-wrap:wrap;padding:0 0 2px 42px}
.fmore .kv{margin:0}
.fmore .chart{margin:0}
[data-rowhref]{cursor:pointer}
.qcard[data-rowhref]:hover{border-color:var(--act)}
.side{background:#0a0d11;border-right:1px solid var(--edge);display:flex;flex-direction:column;
padding:16px 0 14px;position:sticky;top:0;height:100vh;overflow-y:auto;overflow-x:hidden}
.brand{padding:0 18px 14px;display:flex;align-items:center;gap:10px}
.brand .logo{width:27px;height:27px;border-radius:7px;background:linear-gradient(135deg,var(--act),#2b6ff2);
display:grid;place-items:center;font:700 13px var(--mono);color:#04121f;flex:none}
.brand .nm{font-weight:700;font-size:14px;color:var(--ink);letter-spacing:-.01em;line-height:1.15}
.brand .nm small{display:block;font:500 9px var(--mono);letter-spacing:.22em;color:var(--dim);text-transform:uppercase;margin-top:1px}
.side nav{display:flex;flex-direction:column;gap:1px;padding:4px 10px;margin:0}
.side nav a{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:8px;color:var(--sub);
font-size:13px;font-weight:500;position:relative;text-decoration:none}
.side nav a:hover{color:var(--ink);background:rgba(255,255,255,.03);text-decoration:none}
.side nav a.active{color:var(--ink);background:var(--raise)}
.side nav a.active:before{content:"";position:absolute;left:-10px;top:7px;bottom:7px;width:3px;border-radius:3px;background:var(--act)}
.vitals{margin:auto 10px 0;padding:11px 12px 9px;background:var(--panel);border:1px solid var(--edge);border-radius:10px}
.vitals .vh{font:600 9px var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin-bottom:7px}
.vitals .vr{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--sub);padding:2px 0;min-width:0}
.vitals .vr b{margin-left:auto;font:600 10.5px var(--mono);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
.vitals .chdots{display:flex;gap:9px;padding:6px 0 1px;flex-wrap:wrap}
.vitals .chdots span{display:flex;align-items:center;gap:4px;font:500 10px var(--mono);color:var(--sub)}
.vitals .chdots .dot{margin-right:0}

/* main column + topbar */
.main{min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:10px;padding:12px 24px;border-bottom:1px solid var(--edge);
background:rgba(19,23,29,.55);position:sticky;top:0;z-index:4;backdrop-filter:blur(8px)}
.topbar .pgtitle{font-size:16px;font-weight:700;color:var(--ink);letter-spacing:-.01em;margin:0}
.content{padding:20px 24px 60px;max-width:1200px;width:100%}
.content>h1:first-child{display:none} /* topbar carries the page title */
h1{font-size:16px;margin:4px 0 14px;color:var(--ink);font-weight:700;letter-spacing:-.01em}
h2{font-size:11px;margin:24px 0 8px;color:var(--sub);text-transform:uppercase;letter-spacing:.16em;font-weight:600;font-family:var(--mono);
border-left:3px solid var(--act);padding-left:9px;line-height:1.4}
h2 a{font-family:var(--sans);text-transform:none;letter-spacing:0}

/* ── status LEDs ── */
.dot{width:8px;height:8px;border-radius:99px;display:inline-block;margin-right:6px;vertical-align:middle;background:#3a4552}
.dot.ok{background:var(--ok);box-shadow:0 0 6px rgba(63,206,124,.55)}
.dot.bad{background:var(--err);box-shadow:0 0 6px rgba(255,93,93,.55)}
.dot.warn{background:var(--warn);box-shadow:0 0 6px rgba(255,176,32,.5)}
.strip{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;border:1px solid var(--edge);border-radius:12px;
padding:10px 16px;background:var(--panel);margin-bottom:14px;font-size:12.5px}

/* ── surfaces ── */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.cards.kpi{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.masonry{columns:340px 3;column-gap:12px;margin-top:14px}
.masonry>*{break-inside:avoid;margin:0 0 12px}
.stack{display:flex;flex-direction:column;gap:12px;margin-top:14px}
.card{border:1px solid var(--edge);border-radius:12px;background:var(--panel);padding:14px 16px}
.card h3{margin:0 0 4px;font-size:13.5px;color:var(--ink);font-weight:600} .card h3 a{color:var(--ink)}
.kv{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--dim);margin:6px 0;font-variant-numeric:tabular-nums}
.kv b{color:var(--ink);font-weight:600}
.big{font-size:24px;font-weight:700;letter-spacing:-.02em;color:var(--ink)}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:8px 0}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--edge);vertical-align:top}
th{color:var(--dim);font:600 10px var(--mono);text-transform:uppercase;letter-spacing:.14em}
table tr:nth-child(even) td{background:rgba(255,255,255,.012)}
table tr:hover td{background:rgba(255,255,255,.03)}
td a:not(.chip):not(.btnlink),p.small a,.small a,.card h3 a{display:inline-block;padding:4px 6px;margin:-4px -6px;border-radius:6px}
td a:not(.chip):not(.btnlink):hover,p.small a:hover,.small a:hover,.card h3 a:hover{background:rgba(76,195,255,.1);text-decoration:none;color:var(--act)}
.scrollbox{max-height:360px;overflow-y:auto;border:1px solid var(--edge);border-radius:10px;margin:8px 0}
.scrollbox table{margin:0} .scrollbox th{position:sticky;top:0;background:var(--panel);z-index:1}
button,select{background:var(--raise);color:var(--ink);border:1px solid var(--edge2);border-radius:7px;padding:5px 12px;
font:500 12px var(--sans);cursor:pointer} button:hover{border-color:var(--act);color:var(--act)}
select:focus,button:focus{outline:none;border-color:var(--act)}
button.danger{border-color:rgba(255,93,93,.4);color:#ff8a8a} button.danger:hover{border-color:var(--err);color:var(--err)}
a.btnlink{display:inline-flex;align-items:center;text-decoration:none;color:var(--ink);background:var(--raise);
border:1px solid var(--edge2);border-radius:7px;padding:5px 12px;font-size:12px} a.btnlink:hover{border-color:var(--act);color:var(--act);text-decoration:none}
.muted{color:var(--dim)} .small{font-size:11.5px}
.backlink{display:inline-flex;align-items:center;gap:5px;font:500 12px var(--mono);color:var(--dim);text-decoration:none;margin:0 0 12px}
.backlink:hover{color:var(--act);text-decoration:none}
.log{background:#090b0e;border:1px solid var(--edge);border-radius:10px;padding:10px 14px;font:11px/1.5 var(--mono);
white-space:pre-wrap;word-break:break-all;max-height:560px;overflow-y:auto;color:var(--sub)}
.trace-ev{margin:0 0 12px} .trace-ev .log{margin-top:4px}
.trace-hd{font:500 11px var(--mono);color:var(--dim)} .trace-hd b{color:var(--act)}
.toast{position:fixed;bottom:18px;right:18px;background:var(--raise);border:1px solid var(--act);border-radius:10px;
padding:10px 16px;font-size:13px;max-width:420px;display:none;z-index:99;color:var(--ink);box-shadow:0 12px 40px rgba(0,0,0,.5)}
.chart{margin:6px 0}
.ribbon .ribbon-base{fill:var(--raise)}
.ribbon .rb-on{fill:var(--act)}
.ribbon .rb-live{fill:var(--act);filter:brightness(1.4)}
.ribbon .rb-approx{fill:var(--act);opacity:.4}
.ribbon .rb-tick{stroke:var(--warn);stroke-width:1.5}
.ribbon .rb-m-haiku{stroke:var(--t-a2a)}
.ribbon .rb-m-opus{stroke:var(--t-compact)}
.range a{margin-right:8px;font-size:12px} .range a.active{font-weight:700;text-decoration:underline}
input[type=text]{background:var(--bg);color:var(--ink);border:1px solid var(--edge2);border-radius:8px;padding:6px 10px;font:400 12.5px var(--sans)}
input[type=text]:focus{outline:none;border-color:var(--act);box-shadow:0 0 0 3px rgba(76,195,255,.12)}
input::placeholder{color:var(--dim)}
.ctx{height:6px;border-radius:3px;background:var(--raise);overflow:hidden;width:120px;display:inline-block;vertical-align:middle}
.ctx i{display:block;height:100%;background:var(--act)}
.pill{font:500 10px var(--mono);padding:2px 8px;border-radius:5px;border:1px solid var(--edge2);color:var(--sub);letter-spacing:.04em}
.uchart{position:relative;overflow:visible}
.uchart .cross,.uchart .dot-t,.uchart .dot-m{opacity:0;transition:opacity .08s}
.uchart .hit{fill:transparent;cursor:crosshair}
.uchart .utip{position:absolute;left:0;top:0;pointer-events:none;display:none;background:var(--raise);border:1px solid var(--act);
border-radius:8px;padding:6px 9px;font-size:11.5px;line-height:1.5;white-space:nowrap;z-index:8;box-shadow:0 6px 20px rgba(0,0,0,.4);color:var(--sub)}
.uchart .utip b{color:var(--ink)} .uchart .utip .t{color:var(--warn)} .uchart .utip .m{color:var(--t-a2a)}
.uchart .utip .q5{color:var(--act)} .uchart .utip .q7{color:var(--rose)}
.uchart .utip .bd{margin-top:5px;padding-top:5px;border-top:1px solid var(--edge);color:var(--dim)}
.uchart .utip .bd b{font-weight:600}
.legend{display:flex;gap:14px;font-size:11.5px;color:var(--dim);margin:2px 0 4px;flex-wrap:wrap}
.legend i{display:inline-block;width:18px;height:0;border-top:2.5px solid;vertical-align:middle;margin-right:5px;border-radius:2px}
.flow-list{display:flex;flex-direction:column;gap:8px}
.flow-card{padding:9px 12px}
.flow-head{display:flex;gap:7px 12px;align-items:center;flex-wrap:wrap}
.flow-head h3{min-width:100px;margin:0}
.flow-path{display:grid;grid-template-columns:1.05fr 1.25fr .9fr .95fr;gap:7px;margin-top:7px}
.flow-node{position:relative;border-left:2px solid var(--edge2);padding:3px 7px 3px 10px;min-width:0;color:var(--dim)}
.flow-node:before{content:"";position:absolute;left:-5px;top:8px;width:8px;height:8px;border-radius:50%;background:var(--raise);border:2px solid var(--panel)}
.flow-node.done:before{background:var(--ok)} .flow-node.current:before{background:var(--warn)}
.flow-node.failed:before{background:var(--err)}
.flow-node span{display:block;font:600 9px var(--mono);text-transform:uppercase;letter-spacing:.1em}
.flow-node b{display:block;color:var(--ink);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flow-node small{display:block;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.trace{margin-top:5px}
.flow{position:relative;padding-left:20px}
.flow:before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:2px;background:var(--raise)}
.flow-step{position:relative;display:grid;grid-template-columns:105px minmax(120px,1fr);gap:10px;padding:3px 0;color:var(--dim)}
.flow-step:before{content:"";position:absolute;left:-18px;top:9px;width:8px;height:8px;border-radius:50%;background:var(--raise);border:2px solid var(--panel)}
.flow-step.done:before{background:var(--ok)} .flow-step.current:before{background:var(--warn)}
.flow-step.failed:before{background:var(--err)} .flow-step b{color:var(--ink)}
.empty{padding:22px;text-align:center}
.subnav{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 14px}
.subnav a{padding:6px 12px;border:1px solid var(--edge);border-radius:8px;color:var(--sub);background:var(--panel);font-size:12.5px}
.subnav a.active{color:var(--act);border-color:rgba(76,195,255,.4);background:var(--raise)}
.subnav a:hover{text-decoration:none;color:var(--ink)}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0 14px}
.filters label{color:var(--dim);font-size:12px;display:inline-flex;align-items:center;gap:5px}
.filters input{flex:1 1 120px;min-width:110px;background:var(--bg);color:var(--ink);border:1px solid var(--edge2);
border-radius:8px;padding:6px 10px;font:400 12.5px var(--sans)}
.filters input::placeholder{color:var(--dim);opacity:.8}
.filters input[type=checkbox]{flex:0 0 auto;min-width:0;width:15px;height:15px;accent-color:var(--act)}
.filters input:focus,.filters select:focus{outline:none;border-color:var(--act);box-shadow:0 0 0 3px rgba(76,195,255,.12)}
.filters .acts{display:inline-flex;gap:8px;align-items:center;white-space:nowrap}
/* Runs controls: filters + facets in one quiet panel */
.runs-controls{border:1px solid var(--edge);border-radius:12px;background:var(--panel);padding:12px 14px;margin:10px 0 14px}
.runs-controls .filters{margin:0 0 11px;padding-bottom:11px;border-bottom:1px solid var(--edge)}
.facet-grid{display:flex;flex-direction:column;gap:7px}
.facet-row{display:grid;grid-template-columns:52px 1fr;gap:10px;align-items:start}
.facet-row .flabel{text-align:right;font:600 9.5px var(--mono);letter-spacing:.12em;text-transform:uppercase;padding-top:6px;white-space:nowrap}
.fl-lane{color:var(--act)}.fl-skill{color:var(--t-compact)}.fl-tool{color:var(--warn)}.fl-model{color:var(--ok)}
.fl-trigger{color:var(--t-a2a)}
/* Turn drill-down */
.turns{display:flex;flex-direction:column;gap:4px;margin-top:8px}
details.turn{border:1px solid var(--edge);border-radius:10px;background:rgba(255,255,255,.012);overflow:hidden}
details.turn>summary{display:grid;grid-template-columns:76px 106px minmax(160px,1fr) auto;gap:11px;align-items:center;
padding:8px 12px;cursor:pointer;list-style:none;font-size:12px}
details.turn>summary::-webkit-details-marker{display:none}
details.turn>summary:hover{background:rgba(255,255,255,.02)}
details.turn[open]>summary{border-bottom:1px dashed var(--edge2);background:rgba(255,255,255,.02)}
.turn .t-time{color:var(--dim);font:500 10.5px var(--mono);white-space:nowrap}
.trig{display:inline-flex;align-items:center;gap:6px;font:600 9.5px var(--mono);text-transform:uppercase;letter-spacing:.07em;
padding:2.5px 9px;border-radius:999px;color:var(--t-sys);background:rgba(117,130,145,.12);white-space:nowrap;justify-self:start;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.trig:before{content:"";width:5px;height:5px;border-radius:99px;background:currentColor;flex:none}
.trig-chat{color:var(--t-chat);background:rgba(45,212,191,.1)}
.trig-schedule{color:var(--t-sched);background:rgba(255,176,32,.1)}
.trig-a2a{color:var(--t-a2a);background:rgba(167,139,250,.12)}
.trig-delegated{color:var(--t-deleg);background:rgba(143,127,247,.12)}
.trig-compact-resume{color:var(--t-compact);background:rgba(244,114,182,.1)}
.trig-task-note{color:var(--t-wake);background:rgba(63,206,124,.1)}
.trig-wake{color:var(--t-wake);background:rgba(63,206,124,.1)}
.trig-system{color:var(--t-sys);background:rgba(117,130,145,.14)}
.turn .t-intent{color:var(--ink);font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.turn .t-meta{color:var(--dim);font:500 10.5px var(--mono);white-space:nowrap;display:inline-flex;gap:9px}
.turn .t-meta .err,.err{color:var(--err);font-weight:700}
.turn-body{padding:9px 12px;font-size:12px}
.steps{width:100%}
.steps td{vertical-align:top}
.steps .dur{white-space:nowrap;color:var(--dim);font:500 10.5px var(--mono);text-align:right}
.steps .errcell{color:var(--err);font-weight:700}
.steps tr:nth-child(even) td{background:rgba(255,255,255,.012)}
.steps tr.mrow td{background:rgba(76,195,255,.04)}
.steps tr.mrow td:first-child{border-left:2px solid var(--act)}
.steps tr.error-row td{color:var(--err)}
.steps tr.error-row td:first-child{border-left:2px solid var(--err)}
.memline{margin-top:8px;padding:7px 9px;border-left:3px solid var(--t-a2a);background:rgba(167,139,250,.06);color:var(--ink);font-size:12px;border-radius:0 7px 7px 0}
.profile{margin-top:7px}.profile summary{cursor:pointer;color:var(--dim);font-size:12px}
.good{border-left:3px solid var(--ok)}
.resp{margin:8px 0 2px;padding:7px 11px;border-left:3px solid var(--t-chat);color:var(--ink);background:rgba(45,212,191,.05);border-radius:0 8px 8px 0;font-size:12.5px}
.resp .to{color:var(--t-chat);font:600 9.5px var(--mono);text-transform:uppercase;letter-spacing:.1em;margin-right:7px}
.art{display:inline-flex;gap:6px;align-items:baseline;border:1px dashed var(--edge2);border-radius:7px;padding:3px 9px;font-size:11px;color:var(--dim);max-width:100%}
.art b{color:var(--warn);font:600 11px var(--mono)}
.art .why{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{display:inline-flex;align-items:center;font-size:11.5px;padding:2.5px 10px;border-radius:999px;
border:1px solid var(--edge2);color:var(--sub);background:var(--bg);white-space:nowrap;line-height:1.5;
transition:border-color .12s ease,color .12s ease,background .12s ease}
.chip:hover{border-color:var(--act);color:var(--ink);text-decoration:none}
.chip.on{color:var(--act);background:rgba(76,195,255,.13);border-color:rgba(76,195,255,.55);font-weight:600}
.chip code{color:inherit;background:none;padding:0;font:500 11px var(--mono)}
.chip .c{margin-left:6px;color:var(--dim);font:600 10px var(--mono)}
.chip:hover .c{color:var(--act)}
.chip.on .c{color:var(--act);opacity:.75}
.chips{display:inline-flex;flex-wrap:wrap;gap:5px;vertical-align:middle}
.docs-group{margin:7px 0 0;border:1px solid var(--edge);border-radius:10px;background:rgba(255,255,255,.012);overflow:hidden}
.docs-group>summary{display:flex;align-items:center;gap:8px;padding:8px 11px;cursor:pointer;color:var(--sub);font-size:12px}
.docs-group>summary .small{margin-left:auto}
.docs-group>summary:hover{background:rgba(255,255,255,.025);color:var(--ink)}
.docs-group>summary:focus-visible{outline:2px solid var(--act);outline-offset:-2px}
.docs-group[open]>summary{border-bottom:1px dashed var(--edge2);background:rgba(255,255,255,.018)}
.docs-chips{display:flex;list-style:none;margin:0;padding:8px 11px}
.docs-chips li{display:inline-flex}
.statstrip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 16px}
.statstrip .stat{padding:12px 16px;border:1px solid var(--edge);border-radius:12px;background:var(--panel)}
.statstrip .lbl{display:block;font:600 9.5px var(--mono);text-transform:uppercase;letter-spacing:.16em;color:var(--dim)}
.statstrip .num{display:block;font-size:24px;font-weight:700;letter-spacing:-.02em;line-height:1.15;margin:3px 0 2px;color:var(--ink)}
.statstrip .stat:first-child .num{color:var(--act)}
.statstrip .stat:last-child .num{color:var(--warn)}
.statstrip .sub{display:block;font-size:11px;color:var(--dim)}
@media(max-width:760px){.statstrip{grid-template-columns:repeat(2,1fr)}}
.trip-setup-card{margin:0 0 18px;padding:18px 20px;border-color:rgba(76,195,255,.2);background:linear-gradient(145deg,rgba(76,195,255,.055),var(--panel) 42%)}
.trip-setup-card>form{margin-top:15px}.trip-form-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(140px,1fr) minmax(140px,1fr);gap:12px;margin-top:12px}
.trip-setup-guide{margin-top:15px;border:1px solid rgba(76,195,255,.25);border-radius:9px;background:rgba(76,195,255,.045);padding:11px 13px}.trip-setup-guide>summary,.trip-channel-guides details>summary{cursor:pointer;color:var(--ink);font-weight:600;font-size:12px}.trip-setup-guide>summary{letter-spacing:.01em}.trip-setup-guide>p{margin:10px 0;color:var(--sub);line-height:1.55}.trip-channel-guides{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}.trip-channel-guides details{border:1px solid var(--edge);border-radius:8px;padding:9px 11px;background:rgba(0,0,0,.1)}.trip-channel-guides ol{margin:9px 0 0;padding-left:20px;color:var(--sub);line-height:1.55}.trip-channel-guides li{margin:5px 0}.trip-channel-guides code,.trip-setup-guide code{white-space:normal;overflow-wrap:anywhere}.trip-howto-note{margin:10px 0 0;padding:8px 9px;border-left:3px solid var(--act);background:rgba(76,195,255,.06);color:var(--sub);line-height:1.5}.trip-channel-apply{margin-top:10px;padding-top:10px;border-top:1px solid var(--edge);color:var(--sub);line-height:1.5}
.trip-channel-onboarding{margin-top:15px;padding:13px;border:1px solid rgba(63,206,124,.28);border-radius:9px;background:rgba(63,206,124,.045)}.trip-channel-onboarding .flow-head{margin:0}.trip-onboarding-controls{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(220px,1.5fr) auto;gap:10px;align-items:end;margin-top:11px}.trip-onboarding-controls label{display:flex;flex-direction:column;gap:5px;color:var(--dim);font-size:11px}.trip-onboarding-controls [hidden]{display:none!important}.trip-onboarding-controls input,.trip-onboarding-controls select{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--edge2);border-radius:8px;padding:7px 9px;font:400 12px var(--sans)}.trip-onboarding-controls input:focus,.trip-onboarding-controls select:focus{outline:none;border-color:var(--act);box-shadow:0 0 0 3px rgba(76,195,255,.12)}.trip-bot-context{margin-top:10px;padding:8px 10px;border-left:3px solid var(--act);background:rgba(76,195,255,.06);color:var(--sub);font-size:11px;line-height:1.5}.trip-bot-context b{color:var(--ink)}.trip-onboarding-status{margin-top:12px;padding:11px 12px;border:1px solid var(--edge);border-radius:8px;background:rgba(0,0,0,.13);color:var(--sub);line-height:1.5}.trip-onboarding-status h4{margin:0 0 8px;color:var(--ink);font-size:13px}.trip-onboarding-status ol{margin:7px 0 0;padding-left:20px}.trip-onboarding-status li{margin:4px 0}.trip-onboarding-code{display:inline-block;margin:4px 0 8px;padding:8px 12px;border:1px solid var(--act);border-radius:8px;color:var(--ink);font:700 25px var(--mono);letter-spacing:.18em;background:rgba(76,195,255,.1)}.trip-onboarding-qr{display:block;width:220px;height:220px;margin:10px 0;background:white;border-radius:8px}.trip-discovered-results{margin-top:10px;padding:11px 12px;border:1px solid var(--edge);border-radius:8px;background:rgba(0,0,0,.13)}.trip-discovered-results h4{margin:0 0 8px;color:var(--ink);font-size:12px}.trip-discovered-results .trip-discovered-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--edge);font-size:11px}.trip-discovered-results .trip-discovered-row:first-of-type{border-top:0}.trip-discovered-results .trip-discovered-row span{min-width:0;flex:1;overflow-wrap:anywhere}.trip-discovered-results code{color:var(--dim)}
.trip-form-grid label,.trip-config-row label{display:flex;flex-direction:column;gap:5px;min-width:0;color:var(--dim);font-size:11px}.trip-form-grid input,.trip-form-grid select,.trip-config-row input,.trip-config-row select,.trip-confirm-label input{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--edge2);border-radius:8px;padding:7px 9px;font:400 12px var(--sans)}
.trip-form-grid input:focus,.trip-form-grid select:focus,.trip-config-row input:focus,.trip-config-row select:focus,.trip-confirm-label input:focus{outline:none;border-color:var(--act);box-shadow:0 0 0 3px rgba(76,195,255,.12)}
.trip-advanced{margin-top:12px;border-top:1px solid var(--edge);padding-top:10px}.trip-advanced summary{cursor:pointer;color:var(--dim);font-size:11px}.trip-advanced[open] summary{color:var(--act)}
.trip-form-section{margin-top:18px;padding-top:14px;border-top:1px solid var(--edge)}.trip-form-section h3{margin:0;color:var(--ink);font-size:13px}.trip-form-section .flow-head{justify-content:space-between}.trip-form-section>p{margin:5px 0 10px}
.trip-config-row{display:grid;grid-template-columns:30px minmax(180px,1fr) minmax(130px,1fr) auto;gap:9px;align-items:end;margin:8px 0;padding:10px;border:1px solid var(--edge);border-radius:9px;background:rgba(255,255,255,.018)}.trip-wire-row{grid-template-columns:28px minmax(110px,.7fr) minmax(150px,1.2fr) minmax(130px,.8fr) minmax(130px,1fr) auto}.trip-row-number{font:600 10px var(--mono);color:var(--dim);padding:8px 0}.trip-remove{align-self:end;color:var(--dim);padding:6px 8px}.trip-remove:hover{color:var(--err);border-color:rgba(255,93,93,.4)}
.trip-form-actions,.trip-agent-actions,.trip-dialog-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.trip-form-actions{margin-top:16px}.trip-form-actions button[type=submit]{background:var(--act);border-color:var(--act);color:#06131d;font-weight:700}.trip-form-actions button[type=submit]:hover{color:#06131d;filter:brightness(1.08)}
.trip-status-section{margin-top:20px}.trip-status-section>.flow-head{align-items:flex-end;margin-bottom:10px}.trip-status-section h2{margin-bottom:4px}.trip-agent-card{margin-bottom:12px;padding:16px 18px}.trip-agent-card .flow-head{margin-bottom:13px}.trip-agent-metrics{display:grid;grid-template-columns:repeat(6,minmax(100px,1fr));gap:1px;border:1px solid var(--edge);border-radius:9px;overflow:hidden;background:var(--edge)}.trip-agent-metrics>div{min-width:0;padding:11px 12px;background:var(--panel)}.trip-agent-metrics span,.trip-agent-metrics small{display:block;color:var(--dim);font-size:10px}.trip-agent-metrics b{display:block;margin:2px 0;font:600 15px var(--mono);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.trip-agent-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.trip-agent-detail-grid>div{padding:10px 12px;border:1px solid var(--edge);border-radius:9px;background:rgba(255,255,255,.015)}.trip-agent-detail-grid h3{margin:0 0 5px;color:var(--ink);font-size:12px}.trip-agent-detail-grid p{margin:3px 0}.trip-attention{margin-top:11px;padding:8px 10px;border-left:3px solid var(--warn);border-radius:0 7px 7px 0;background:rgba(255,176,32,.07);color:var(--sub);font-size:11.5px}.trip-attention b{color:var(--warn);margin-right:5px}.trip-agent-actions{margin-top:13px;padding-top:12px;border-top:1px solid var(--edge)}.trip-agent-actions .danger{margin-left:auto}
.trip-detail-summary{display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0;color:var(--dim);font-size:11px}.trip-detail-summary b{color:var(--ink)}
dialog{max-width:520px;width:calc(100% - 28px);border:1px solid var(--edge2);border-radius:12px;background:var(--panel);color:var(--sub);padding:20px;box-shadow:0 20px 80px rgba(0,0,0,.6)}dialog::backdrop{background:rgba(0,0,0,.72)}.trip-dialog-close{float:right;border:0;background:transparent;font-size:20px;padding:0;color:var(--dim)}.trip-dialog-close:hover{color:var(--ink)}#trip-cleanup-title{margin-top:12px}.trip-confirm-label{display:flex;flex-direction:column;gap:6px;margin-top:15px;color:var(--dim);font-size:11px}.trip-cleanup-options{display:grid;gap:8px;margin-top:15px}.trip-cleanup-options label{display:flex;gap:9px;align-items:flex-start;padding:10px;border:1px solid var(--edge);border-radius:8px;cursor:pointer}.trip-cleanup-options label:has(input:checked){border-color:rgba(76,195,255,.45);background:rgba(76,195,255,.06)}.trip-cleanup-options input{margin-top:3px;accent-color:var(--act)}.trip-cleanup-options b,.trip-cleanup-options small{display:block}.trip-cleanup-options small{margin-top:3px;color:var(--dim);font-size:11px}.trip-dialog-actions{justify-content:flex-end;margin-top:18px}
@media(max-width:900px){.trip-agent-metrics{grid-template-columns:repeat(3,minmax(100px,1fr))}.trip-wire-row{grid-template-columns:28px repeat(2,minmax(120px,1fr))}.trip-wire-row label:nth-of-type(3),.trip-wire-row label:nth-of-type(4){grid-column:span 1}.trip-wire-row .trip-remove{grid-column:2/-1;justify-self:start}}
@media(max-width:680px){.trip-form-grid,.trip-agent-detail-grid,.trip-channel-guides{grid-template-columns:1fr}.trip-onboarding-controls{grid-template-columns:1fr}.trip-config-row,.trip-wire-row{grid-template-columns:24px 1fr}.trip-config-row label,.trip-wire-row label{grid-column:2}.trip-config-row .trip-remove{grid-column:2;justify-self:start}.trip-agent-metrics{grid-template-columns:repeat(2,minmax(100px,1fr))}.trip-agent-actions .danger{margin-left:0}.trip-status-section>.flow-head{align-items:flex-start;flex-direction:column}}
.state{font:600 10.5px var(--mono);padding:2px 8px;border-radius:5px;border:1px solid var(--edge2);color:var(--ink);white-space:nowrap;background:var(--raise)}
.state.failed,.state.error,.state.fatal{color:var(--err);border-color:rgba(255,93,93,.4);background:rgba(255,93,93,.08)}
.state.processing,.state.warn,.state.due{color:var(--warn);border-color:rgba(255,176,32,.35);background:rgba(255,176,32,.07)}
.state.queued,.state.awaiting_delivery{color:var(--t-a2a);border-color:rgba(167,139,250,.35);background:rgba(167,139,250,.08)}
.state.scheduled,.state.info{color:var(--sub);border-color:var(--edge2);background:var(--raise)}
.attention{border-left:3px solid var(--warn)}
.attention.critical{border-left-color:var(--err)}
.diag-message{font-weight:600;color:var(--ink)}.diag-fields{color:var(--dim);font:400 11px var(--mono)}
details.raw{margin-top:18px} details.raw summary{cursor:pointer;color:var(--act)}
details.fold{padding:0;overflow:hidden}
details.fold>summary{list-style:none;cursor:pointer;padding:13px 16px;display:flex;align-items:center;gap:9px;user-select:none}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::before{content:"▸";color:var(--dim);font-size:12px;transition:transform .15s ease;flex:0 0 auto}
details.fold[open]>summary::before{transform:rotate(90deg);color:var(--act)}
details.fold>summary h3{margin:0}
details.fold>summary:hover h3{color:var(--act)}
details.fold[open]>summary{border-bottom:1px solid var(--edge)}
details.fold>.fold-body{padding:12px 16px 14px}
details.morechips{display:inline}
details.morechips>summary{display:inline;cursor:pointer;list-style:none}
details.morechips>summary::-webkit-details-marker{display:none}
details.morechips>summary::marker{content:""}
details.morechips>summary:hover,details.morechips[open]>summary{color:var(--act)}

/* ── Overview: attention queue + fleet table ── */
.queue{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin:0 0 16px}
.qcard{background:var(--panel);border:1px solid var(--edge);border-left:3px solid var(--err);border-radius:10px;
padding:12px 15px;display:flex;gap:12px;align-items:flex-start}
.qcard.warn{border-left-color:var(--warn)}
.qcard.allclear{border-left-color:var(--ok)}
.qcard .qi{font-size:14px;line-height:1.4;flex:none}
.qcard.err .qi{color:var(--err)} .qcard.warn .qi{color:var(--warn)} .qcard.allclear .qi{color:var(--ok)}
.qcard .qt b{display:block;font-size:13px;font-weight:600;margin-bottom:1px}
.qcard .qt span{font-size:12px;color:var(--dim)}
.qcard .qm{margin-left:auto;flex:none}

/* ── scheduled actions (Overview global strip) ── */
.sched{margin:0 0 14px}
.sched h3{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.sched h3 .hint{font:400 11px var(--mono);color:var(--dim);letter-spacing:0}
.sched-row{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.sched-empty{color:var(--dim);font-size:12px;margin-top:6px}
.sched-chip{position:relative;display:inline-flex;align-items:center;gap:8px;max-width:290px;
  padding:5px 11px 5px 9px;border:1px solid var(--edge2);border-radius:8px;background:var(--raise);cursor:default}
.sched-chip .ic{color:var(--act);font-size:11px;flex:none}
.sched-chip .sn{flex:none;width:16px;height:16px;border-radius:50%;background:var(--act);color:#04121f;
  font:700 10px var(--mono);display:grid;place-items:center}
.sched-chip .lbl{color:var(--ink);font-size:12px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sched-chip .when{color:var(--dim);font:500 10.5px var(--mono);flex:none;white-space:nowrap}
.sched-chip.fired{border-color:rgba(76,195,255,.32)}
.sched-chip.due{border-color:rgba(255,176,32,.4);background:rgba(255,176,32,.07)}
.sched-chip.due .ic,.sched-chip.due .when{color:var(--warn)}
.sched-chip.paused{opacity:.62}.sched-chip.paused .ic{color:var(--dim)}
.sched-chip:hover,.sched-chip:focus-within{border-color:var(--act);outline:none}
.sched h3 .fired-hint{color:var(--act);font-weight:600}
/* hover/focus popover — "what it is" */
.sched-pop{position:absolute;left:0;top:calc(100% + 6px);z-index:20;display:none;width:328px;max-width:80vw;
  background:var(--raise);border:1px solid var(--act);border-radius:10px;padding:10px 12px;cursor:auto;
  white-space:normal;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.sched-chip:hover .sched-pop,.sched-chip:focus-within .sched-pop{display:block}
.sched-pop b{display:block;color:var(--ink);font-size:12.5px;line-height:1.35;margin-bottom:4px}
.sched-pop .meta{display:block;font:500 10px var(--mono);color:var(--act);margin-bottom:7px}
.sched-pop .body{display:block;color:var(--sub);font-size:11.5px;line-height:1.5;max-height:118px;overflow-y:auto}
.sched-pop .lastfire{display:block;margin-top:8px;color:var(--act);font:500 10.5px var(--mono);line-height:1.4}
.sched-pop .next{display:block;margin-top:8px;padding-top:7px;border-top:1px solid var(--edge);font:500 10.5px var(--mono);color:var(--dim)}

.fleet{background:var(--panel);border:1px solid var(--edge);border-radius:12px;overflow:hidden;margin:0 0 16px}
.frow{display:grid;grid-template-columns:minmax(190px,1.3fr) minmax(150px,1fr) minmax(140px,1fr) minmax(120px,.9fr) minmax(120px,.9fr) 84px;
gap:12px;align-items:center;padding:10px 16px 10px 14px;border-bottom:1px solid var(--edge);position:relative}
.frow:last-child{border-bottom:none}
.frow:hover{background:rgba(255,255,255,.015)}
.frow:before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--lane,transparent)}
.frow.hd:before{display:none}
.frow.hd{padding:8px 16px 8px 14px}
.frow.hd span{font:600 9.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.fid{display:flex;align-items:center;gap:10px;min-width:0}
.fid .av{width:29px;height:29px;border-radius:8px;flex:none;display:grid;place-items:center;font:700 12px var(--mono);color:#0b0f14;background:var(--lane,#3a4552)}
.fid .nm{font-weight:600;font-size:13px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.fid .nm a{color:var(--ink)}
.fid .ch{font:500 10px var(--mono);color:var(--dim);display:block;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fstate{font-size:11.5px;color:var(--sub);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fspark svg{display:block;width:100%}
.fnum{font:500 11px var(--mono);color:var(--sub);text-align:right;white-space:nowrap}
.fnum .cost{color:var(--warn);font-weight:600}
.facts{display:flex;gap:6px;justify-content:flex-end}
.iconb{width:28px;height:28px;border-radius:7px;border:1px solid var(--edge2);background:var(--raise);color:var(--sub);
display:grid;place-items:center;font-size:12px;cursor:pointer;padding:0}
.iconb:hover{color:var(--act);border-color:var(--act)}

/* ── group drawer ── */
.scrim{position:fixed;inset:0;background:rgba(5,7,10,.6);backdrop-filter:blur(2px);z-index:8;display:none}
.scrim.on{display:block}
.drawer{position:fixed;top:0;right:0;bottom:0;width:600px;max-width:94vw;background:var(--panel);border-left:1px solid var(--edge2);
z-index:9;display:flex;flex-direction:column;box-shadow:-40px 0 80px -30px rgba(0,0,0,.8);
transform:translateX(102%);transition:transform .18s ease}
.drawer.open{transform:none}
.dw-hd{display:flex;align-items:center;gap:11px;padding:14px 18px;border-bottom:1px solid var(--edge);position:relative;flex:none}
.dw-hd:before{content:"";position:absolute;left:0;top:0;right:0;height:3px;background:var(--lane,var(--act))}
.dw-hd .av{width:32px;height:32px;border-radius:9px;background:var(--lane,#3a4552);color:#0b0f14;display:grid;place-items:center;font:700 13px var(--mono);flex:none}
.dw-hd .nm{font-weight:700;font-size:15px;color:var(--ink)}
.dw-hd .st{font-size:11.5px;color:var(--dim);display:block;margin-top:1px}
.dw-body{padding:16px 18px 90px;display:flex;flex-direction:column;gap:18px;overflow-y:auto;flex:1}
.dw-sec>h4{font:600 9.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:0 0 8px;display:flex;align-items:baseline;gap:10px}
.dw-sec>h4 .hint{font:500 10px var(--mono);letter-spacing:0;text-transform:none;margin-left:auto}
.ctable{width:100%;border-collapse:collapse;background:var(--bg);border:1px solid var(--edge);border-radius:10px;overflow:hidden;margin:0}
.ctable th{font:600 9px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--dim);padding:7px 11px;border-bottom:1px solid var(--edge)}
.ctable td{padding:7px 11px;border-bottom:1px solid var(--edge);font-size:12px;color:var(--sub);vertical-align:middle}
.ctable tr:last-child td{border-bottom:none}
.ctable .chn{color:var(--ink);font-weight:500}
.ctable .chn small{display:block;font:500 9.5px var(--mono);color:var(--dim);font-weight:400}
.ctable select{width:100%;max-width:230px}
select.dirty,input.dirty{border-color:var(--warn);box-shadow:0 0 0 3px rgba(255,176,32,.12)}
.sw2{width:34px;height:19px;border-radius:99px;background:var(--raise);border:1px solid var(--edge2);position:relative;display:inline-block;cursor:pointer;vertical-align:middle;flex:none}
.sw2 i{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:99px;background:var(--dim);transition:.15s}
.sw2.on{background:rgba(63,206,124,.2);border-color:rgba(63,206,124,.5)}
.sw2.on i{left:16px;background:var(--ok)}
.savebar{position:sticky;bottom:0;margin:0 -18px -90px;display:none;align-items:center;gap:12px;padding:12px 18px;
background:rgba(26,32,40,.97);border-top:1px solid var(--edge2);z-index:2}
.savebar .msg{font-size:12px;color:var(--warn);font-weight:600}
.savebar .msg:before{content:"";display:inline-block;width:7px;height:7px;border-radius:99px;background:var(--warn);margin-right:8px}
button.pri{background:var(--act);border-color:var(--act);color:#04121f;font-weight:600}
button.pri:hover{color:#04121f;filter:brightness(1.1)}

/* ── compact fleet ──
   Dense, zero-expansion group cards. Every card uses the same row grammar so
   the operator can scan vertically while keeping the page short. */
.compact-fleet{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:10px;align-items:stretch;margin:0 0 16px}
/* Fleet card — status-first hero. Palette scoped to the card (softened "Muted"
   accents/text) so the rest of the Ops Center is untouched. Two zones: a top
   "activity" block (status, vitals, hero metrics, ribbon, senders) and a
   recessed bottom "configuration" block (model/tiers/channels/rules/skills as
   chips). The name bar is the ONLY link to the group page. */
.fc-card{--lane:#758291;--ink:#dce4ed;--sub:#94a3b2;--dim:#66727f;--act:#7fb8dc;--ok:#6fce9d;--warn:#e6bd7e;--fc-zone:#0f1319;--fc-raise:rgba(255,255,255,.024);
  container:fc / inline-size;
  position:relative;display:flex;flex-direction:column;min-width:0;border:1px solid var(--edge);border-radius:12px;background:var(--panel);overflow:hidden}
.fc-card:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--lane);opacity:.82;z-index:2}
.fc-card:hover{border-color:var(--edge2)}
/* header: status lozenge · name (the single link) · quiet action icons */
.fc-head{display:flex;align-items:center;gap:11px;padding:13px 12px 12px 15px}
.fc-lz{display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:8px;background:var(--fc-raise);border:1px solid var(--edge);flex:none}
.fc-lz .dot{margin:0;width:6px;height:6px}
.fc-lz b{color:var(--sub);font:700 9.5px var(--mono);letter-spacing:.13em;text-transform:uppercase}
.fc-open{display:flex;align-items:center;gap:6px;min-width:0;flex:1;text-decoration:none;cursor:pointer;border-radius:8px;margin:-3px -4px;padding:3px 4px}
.fc-open:hover{background:rgba(255,255,255,.03)}.fc-open:hover .fc-name{color:var(--act)}.fc-open:hover .fc-arr{opacity:1;color:var(--act)}
.fc-id{min-width:0;flex:1}
.fc-name{display:block;color:var(--ink);font-size:15px;font-weight:650;letter-spacing:-.01em;white-space:normal;overflow-wrap:anywhere;line-height:1.2}
.fc-route{display:block;margin-top:2px;color:var(--dim);font:500 9.5px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fc-arr{flex:none;color:var(--dim);font-size:10px;opacity:.45;transition:.12s}
.fc-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.fc-actions button{width:26px;height:26px;padding:0;font-size:12px;display:grid;place-items:center;border:1px solid var(--edge);background:transparent;color:var(--dim);border-radius:7px;cursor:pointer;font-family:var(--sans)}
.fc-actions button.lc-run,.fc-actions button.lc-stop,.fc-actions button.lc-pause{width:auto;padding:0 7px;font-size:10px}
.fc-actions button.lc-stop{color:var(--warn)} .fc-actions button.lc-pause{color:var(--rose)} .fc-actions button.lc-run{color:var(--ok)} .fc-actions button.lc-fresh{color:var(--rose)}
.fc-actions .lc-icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.fc-actions button:hover{color:var(--act);border-color:var(--act)}
@media(max-width:900px){
  .fc-head{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start}
  .fc-actions{grid-column:1/-1;justify-content:flex-start;padding-top:1px}
}
@container fc (max-width:700px){
  .fc-head{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start}
  .fc-actions{grid-column:1/-1;justify-content:flex-start;padding-top:1px}
}
/* ── top zone: activity ── */
.fc-top{padding:0 15px 13px}
.fc-vitals{display:flex;align-items:center;gap:7px;padding:2px 1px 12px;flex-wrap:wrap;white-space:nowrap}
.fc-vitals .m{color:var(--sub);font:500 10.5px var(--mono)}.fc-vitals .m i{font-style:normal;color:var(--ink);font-weight:600}
.fc-vitals .sep{color:var(--dim)}
.fc-vitals .hb{margin-left:auto;color:var(--dim);font:500 10px var(--mono)}
.fc-hero{display:grid;grid-template-columns:repeat(4,1fr);padding:13px 2px;background:var(--fc-raise);border:1px solid var(--edge);border-radius:10px}
.fc-hc{padding:0 13px;min-width:0}
.fc-hc+.fc-hc{border-left:1px solid var(--edge)}
.fc-hc .k{display:block;color:var(--dim);font:600 8.5px var(--mono);letter-spacing:.12em;text-transform:uppercase;margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fc-hc .v{display:block;color:var(--ink);font:600 18px/1 var(--sans);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fc-hc .v .s{color:var(--dim);font-weight:400;margin:0 1px}
.fc-hc.p95 .v .u{font-size:12px;color:var(--sub);font-weight:500;margin-left:1px}
.fc-hc .sub{display:block;margin-top:5px;color:var(--sub);font:500 10px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fc-ribbon{padding:14px 1px 0}
.rb-cap{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.rb-cap .lbl{color:var(--dim);font:600 8.5px var(--mono);letter-spacing:.09em;text-transform:uppercase}
.rb-cap .rb-stat{flex:1;min-width:0;margin-left:auto;color:var(--sub);font:500 9px var(--mono);text-align:right;overflow-wrap:anywhere}
.fc-ribbon svg{display:block;width:100%;margin:0}
.fc-senders{display:flex;align-items:center;gap:9px;padding:13px 1px 0;min-width:0}
.fc-senders .k{flex:none;color:var(--dim);font:600 8.5px var(--mono);letter-spacing:.1em;text-transform:uppercase}
.fc-senders .who{min-width:0;color:var(--sub);font:500 11px var(--sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fc-senders .who b{color:var(--ink);font-weight:600}.fc-senders .who .ch{color:var(--dim);font:500 9px var(--mono);text-transform:uppercase}.fc-senders .who .more{color:var(--dim)}
.fc-senders .unk{flex:none;color:var(--warn);font:500 10px var(--mono)}
.fc-senders .cnt{flex:none;margin-left:auto;color:var(--sub);font:500 10px var(--mono)}.fc-senders .cnt b{color:var(--ink)}
.fc-senders .none{color:var(--dim);font:500 11px var(--sans)}
/* ── bottom zone: configuration (recessed) ── */
.fc-cfg{margin-top:auto;background:var(--fc-zone);border-top:1px solid var(--edge);padding:12px 15px 4px}
.fc-zlab{display:block;color:var(--dim);font:600 8px var(--mono);letter-spacing:.14em;text-transform:uppercase;margin-bottom:10px}
.fc-chips{display:flex;flex-wrap:wrap;gap:7px}
.fc-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;border:1px solid var(--edge);background:var(--panel);color:var(--sub);font:500 11px var(--sans);white-space:nowrap}
.fc-chip b{color:var(--ink);font-weight:600}
.fc-chip .mk{color:var(--dim);font:600 8.5px var(--mono);text-transform:uppercase;letter-spacing:.04em}
.fc-foot{display:flex;align-items:center;padding:11px 15px 13px;background:var(--fc-zone);color:var(--dim);font:500 10px var(--mono);min-width:0}
.fc-foot .latest{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── run cards (Runs tab) ── */
.run-hd{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 0 9px;margin:0 0 9px;border-bottom:1px solid var(--edge);position:relative}
.card.runcard{padding:13px 16px 13px 18px;position:relative;overflow:hidden;margin-bottom:12px}
.card.runcard:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--lane,transparent)}
.run-hd .av{width:25px;height:25px;border-radius:7px;background:var(--lane,#3a4552);color:#0b0f14;display:grid;place-items:center;font:700 10.5px var(--mono);flex:none}
.run-hd .nm{font-weight:700;font-size:14px;color:var(--ink)}
.run-hd .nm:hover{color:var(--act);text-decoration:none}
.run-hd .when{font:500 10.5px var(--mono);color:var(--dim)}
.run-hd .agg{margin-left:auto;font:500 10.5px var(--mono);color:var(--dim);display:inline-flex;gap:10px;flex-wrap:wrap}
.run-hd .agg b{color:var(--ink)} .run-hd .agg .cost{color:var(--warn);font-weight:600}

@media(max-width:1000px){
  .shell{grid-template-columns:1fr}
  .side{position:static;height:auto;flex-direction:row;align-items:center;flex-wrap:wrap;padding:10px 12px;gap:8px}
  .side nav{flex-direction:row;flex-wrap:wrap;padding:0}
  .side nav a.active:before{display:none}
  .vitals{display:none}
  .frow{grid-template-columns:1fr 1fr;row-gap:6px}
  .drawer{width:100vw;max-width:100vw}
  .flow-path{grid-template-columns:1fr 1fr}.flow-node b,.flow-node small{white-space:normal}
}
@media(max-width:620px){
  .compact-fleet{grid-template-columns:1fr}
}

/* ── chat ── */
.chatwrap{display:flex;flex-direction:column;gap:10px;max-width:880px}
.cx{background:var(--panel);border:1px solid var(--edge);border-radius:10px;padding:14px;overflow-y:auto;
  height:56vh;min-height:220px;display:flex;flex-direction:column;gap:10px}
.cmsg{display:flex;flex-direction:column;max-width:78%}
.cmsg.user{align-self:flex-end;align-items:flex-end}
.cmsg.agent{align-self:flex-start;align-items:flex-start}
.cmsg .bub{padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;color:var(--ink);
  font-size:13px;line-height:1.5}
.cmsg.user .bub{background:rgba(76,195,255,.13);border:1px solid rgba(76,195,255,.28);border-bottom-right-radius:4px}
.cmsg.agent .bub{background:var(--raise);border:1px solid var(--edge2);border-bottom-left-radius:4px}
.cmeta{font-size:10.5px;color:var(--dim);margin-top:3px}
.crow{display:flex;gap:8px;align-items:flex-end}
.crow textarea{flex:1;background:var(--panel);border:1px solid var(--edge2);border-radius:10px;color:var(--ink);
  font:13px/1.45 var(--sans);padding:10px 12px;resize:vertical;min-height:44px;max-height:180px}
.crow textarea:focus{outline:none;border-color:var(--act)}
.crow button{background:var(--act);border:none;color:#08222f;font-weight:600;border-radius:10px;
  padding:11px 20px;cursor:pointer;font-family:var(--sans);font-size:13px}
.crow button:hover{filter:brightness(1.1)}
.crow button:disabled{opacity:.5;cursor:default}
.cpill{font:500 11px var(--mono);padding:3px 10px;border-radius:99px;border:1px solid var(--edge2);color:var(--dim)}
.cpill.working{color:var(--warn);border-color:var(--warn);animation:cpulse 1.6s ease-in-out infinite}
.cpill.queued{color:var(--sub);border-color:var(--edge2)}
@keyframes cpulse{0%,100%{opacity:1}50%{opacity:.45}}
.csteps{max-width:880px}

/* ── optional WebQI consultation workspace ── */
.navhint{font-size:10px;color:var(--dim);margin-left:3px}
.webqi-intro{display:flex;align-items:flex-start;gap:14px;justify-content:space-between;margin-bottom:14px}
.webqi-intro h2,.webqi-head h2{margin:0 0 5px;font-size:17px;font-weight:650}
.webqi-grid{display:grid;grid-template-columns:minmax(220px,285px) minmax(0,1fr);gap:12px;align-items:start}
.webqi-sidebar,.webqi-card{min-width:0}
.webqi-sidebar{position:sticky;top:14px;display:flex;flex-direction:column;gap:7px}
.webqi-sidebar select,.webqi-composer select,.webqi-composer input,.webqi-composer textarea{width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--edge2);border-radius:7px;color:var(--ink);font:12px var(--sans);padding:7px 9px}
.webqi-sidebar select:focus,.webqi-composer select:focus,.webqi-composer input:focus,.webqi-composer textarea:focus{outline:none;border-color:var(--act)}
.webqi-meta{padding:5px 0 9px;line-height:1.45}
.webqi-section-head{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--edge);padding-top:11px;margin-top:3px}
.webqi-section-head h3{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--sub)}
.linkbtn{border:0;background:none;color:var(--act);cursor:pointer;padding:2px 0;font:600 11px var(--sans)}
.linkbtn:disabled{color:var(--dim);cursor:default}
.webqi-cleanup{display:flex;flex-direction:column;gap:5px;padding:1px 0 3px}.webqi-cleanup-actions{display:flex;align-items:center;justify-content:space-between;gap:7px}.webqi-cleanup-actions .btn{padding:5px 7px;font-size:10px}
.webqi-roots{display:flex;flex-direction:column;gap:5px;max-height:52vh;overflow:auto}
.webqi-root-row{display:grid;grid-template-columns:18px minmax(0,1fr);gap:4px;align-items:stretch}.webqi-root-check{margin:0 0 0 3px;align-self:center;accent-color:var(--act)}
.webqi-root{display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;border:1px solid var(--edge);border-radius:8px;background:rgba(255,255,255,.015);color:var(--ink);padding:8px 9px;cursor:pointer;font:12px var(--sans)}
.webqi-root-row .webqi-root{min-width:0;width:100%}
.webqi-root:hover,.webqi-root:focus,.webqi-root.selected{border-color:var(--act);background:var(--raise);outline:none}.webqi-root.selected{box-shadow:0 0 0 1px rgba(76,195,255,.18)}
.webqi-root b,.webqi-root small{display:block}.webqi-root small{color:var(--dim);font:10px var(--mono);margin-top:3px}
.webqi-main{display:flex;flex-direction:column;gap:12px;min-width:0}
.webqi-head{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;margin-bottom:12px}
.webqi-head .chips{justify-content:flex-end}
.eyebrow{color:var(--act);font:600 10px var(--mono);letter-spacing:.12em;text-transform:uppercase;margin-bottom:5px}
.webqi-graph{display:flex;flex-direction:column;gap:8px;max-height:63vh;overflow:auto;padding-right:2px}
.webqi-node{border:1px solid var(--edge);border-left:3px solid var(--edge2);border-radius:8px;background:rgba(255,255,255,.012);padding:10px 11px;cursor:pointer;transition:border-color .12s ease,background .12s ease}
.webqi-node:hover{border-color:var(--act)}.webqi-node.selected{background:rgba(76,195,255,.07);border-color:rgba(76,195,255,.55);box-shadow:0 0 0 1px rgba(76,195,255,.1)}
.webqi-question{border-left-color:var(--act)}.webqi-answer{border-left-color:var(--ok)}.webqi-synthesis{border-left-color:var(--teal)}.webqi-critique{border-left-color:var(--warn)}.webqi-judgment{border-left-color:var(--t-a2a)}
.webqi-node-head,.webqi-node-foot{display:flex;align-items:center;gap:7px;min-width:0}.webqi-node-head b{font:600 11px var(--mono);color:var(--sub)}
.webqi-node h4{margin:8px 0 5px;font-size:12px}.webqi-node p{margin:0;color:var(--sub);font-size:12px;line-height:1.45;white-space:normal}.webqi-node-foot{margin-top:8px;justify-content:space-between;gap:10px}.webqi-node-foot>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.webqi-composer form{display:flex;flex-direction:column;gap:12px}.webqi-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.webqi-form-grid label,.webqi-composer>label,.webqi-composer form>label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--sub)}
.webqi-field-title{font-size:11px;color:var(--sub);margin-bottom:6px}.webqi-targets{display:flex;flex-direction:column;gap:6px}.webqi-target{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 8px;border:1px solid var(--edge);border-radius:7px;background:rgba(255,255,255,.012)}
.webqi-target label{display:flex;align-items:center;gap:8px;min-width:0}.webqi-target label span{min-width:0}.webqi-target b,.webqi-target small{display:block}.webqi-target small{color:var(--dim);font:10px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.webqi-target input{width:auto}.webqi-target select{width:auto;min-width:155px;padding:5px 7px}
.webqi-livebar{display:flex;align-items:center;gap:9px;margin:-2px 0 12px;padding:8px 10px;border:1px solid var(--edge);border-radius:8px;background:rgba(76,195,255,.035)}
.webqi-activity-card{min-height:120px}.webqi-activity{display:flex;flex-direction:column;gap:7px;max-height:360px;overflow:auto}.wi-activity-row{padding:8px 10px;border:1px solid var(--edge);border-radius:8px;background:rgba(255,255,255,.012);color:var(--sub);font-size:12px;line-height:1.45;white-space:pre-wrap}.wi-activity-row.user{border-left:3px solid var(--act)}.wi-activity-row.agent{border-left:3px solid var(--ok)}.wi-activity-role{margin-bottom:3px;color:var(--dim);font:10px var(--mono);text-transform:uppercase;letter-spacing:.08em}
.webqi-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.webqi-actions .btn.primary{background:var(--act);color:#08222f;border-color:var(--act)}
.webqi-help-layout{display:grid;grid-template-columns:minmax(190px,245px) minmax(0,1fr);gap:12px;align-items:start}.webqi-help-nav{position:sticky;top:14px;display:flex;flex-direction:column;gap:7px}.webqi-help-nav h3{margin:0 0 5px;font-size:13px}.webqi-help-nav>a{display:flex;gap:8px;align-items:baseline;padding:6px 7px;border-radius:7px;color:var(--sub);font-size:12px}.webqi-help-nav>a:hover{background:rgba(76,195,255,.1);color:var(--ink);text-decoration:none}.webqi-help-nav>a span{color:var(--dim);font:10px var(--mono)}.webqi-help-note{border-top:1px solid var(--edge);margin-top:6px;padding-top:10px;line-height:1.45}.webqi-help-main{display:flex;flex-direction:column;gap:12px;min-width:0}.webqi-help-section{scroll-margin-top:14px}.webqi-help-section h2{margin:0 0 11px;font-size:17px}.webqi-help-section pre{margin:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--sub);font:12px/1.55 var(--mono)}
@media(max-width:820px){.webqi-grid{grid-template-columns:1fr}.webqi-sidebar{position:static}.webqi-roots{max-height:260px}.webqi-graph{max-height:none}}
@media(max-width:820px){.webqi-help-layout{grid-template-columns:1fr}.webqi-help-nav{position:static}}
@media(max-width:560px){.webqi-form-grid{grid-template-columns:1fr}.webqi-target{align-items:flex-start;flex-direction:column}.webqi-target select{width:100%}.webqi-intro{flex-direction:column}.webqi-intro .webqi-actions{width:100%}}
`;

const CLIENT_JS = `
const $=id=>document.getElementById(id);
function toast(msg,ok=true){const t=$('toast');t.textContent=msg;t.style.borderColor=ok?'var(--teal)':'var(--red)';
t.style.display='block';clearTimeout(window.__tt);window.__tt=setTimeout(()=>t.style.display='none',6000)}
async function act(url,body,confirmMsg,typed){
  if(confirmMsg&&!confirm(confirmMsg))return;
  if(typed&&prompt('Type "'+typed+'" to confirm')!==typed){toast('Cancelled',false);return}
  toast('Working…');
  try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-ops-action-token':window.__opsToken},body:JSON.stringify(body||{})});
  const j=await r.json();toast(j.message||(j.ok?'Done':'Failed'),j.ok)}catch(e){toast('Request failed: '+e,false)}
}
function dot(el,ok){if(el)el.className='dot '+(ok?'ok':'bad')}
function set(id,v){const el=$(id);if(el&&v!=null)el.textContent=v}
function setOnecliLink(){
  const link=$('onecli-link');if(!link)return;
  try{
    const page=new URL(window.location.href);
    const target=new URL('http://127.0.0.1:10254/overview');
    target.protocol=page.protocol;target.hostname=page.hostname;target.port='10254';
    link.href=target.href;
  }catch(e){}
}
setOnecliLink();
function applySnapshot(s){
  dot($('d-host'),s.host.running);set('t-host',s.host.running?('up · pid '+s.host.pid):(s.host.loaded?'loaded, not running':'stopped'));
  for(const[ch,live]of Object.entries(s.channels)){dot($('d-ch-'+ch),live&&s.host.running)}
  dot($('d-docker'),s.docker.daemonUp);set('t-docker',s.docker.daemonUp?(s.docker.containers+' container(s)'):'daemon down');
  dot($('d-onecli'),s.onecliUp);
  set('t-delivery',s.lastDelivery?new Date(s.lastDelivery).toLocaleTimeString():'–');
  set('t-disk',(s.diskTotalBytes/1048576).toFixed(0)+' MB');
  let unans=0;
  for(const g of s.groups){
    unans+=g.unanswered;
    set('g-'+g.id+'-in',g.todayIn);set('g-'+g.id+'-out',g.todayOut);
    set('g-'+g.id+'-queue',g.queueDepth);set('g-'+g.id+'-inflight',g.inflight);
    set('g-'+g.id+'-sessions',g.sessions);
    const state=g.lifecycleStatus||((g.containersUp>0)?'running':'idle');
    const cd=$('g-'+g.id+'-dot');if(cd)cd.className='dot '+(state==='running'?'ok':state==='error'?'bad':state==='paused'?'warn':'');
    const cs=$('g-'+g.id+'-cstat');if(cs)cs.textContent=cs.classList.contains('fc-cstat')?state:(state==='running'?('container up'+(g.minHeartbeatAgeMs!=null&&g.minHeartbeatAgeMs<120000?(' · hb '+Math.round(g.minHeartbeatAgeMs/1000)+'s'):'')+(g.currentTool?(' · '+g.currentTool):'')):state);
    set('g-'+g.id+'-heartbeat',g.minHeartbeatAgeMs==null?'–':(g.minHeartbeatAgeMs<60000?Math.round(g.minHeartbeatAgeMs/1000)+'s':Math.round(g.minHeartbeatAgeMs/60000)+'m'));
    set('g-'+g.id+'-model',(g.model||'–').split('/').pop().replace(/^claude-/,'').replace(/-\\d{8}$/,''));
  }
  const attention=s.openIncidents+unans+s.queues.approvals;
  const ad=$('d-attention');if(ad)ad.className='dot '+(s.openIncidents>0||unans>0?'bad':s.queues.approvals>0?'warn':'ok');
  set('t-attention',attention===0?'clear':attention+' attention');
  const logEl=$('livelog');
  if(logEl&&s.recentLog&&s.recentLog.length){for(const l of s.recentLog){logEl.textContent+=l.replace(/\\\\x1b\\[[0-9;]*m/g,'')+'\\n'}
    logEl.scrollTop=logEl.scrollHeight;
    const lines=logEl.textContent.split('\\n');if(lines.length>800)logEl.textContent=lines.slice(-600).join('\\n')}
}
const es=new EventSource('/events');
es.onmessage=e=>{try{applySnapshot(JSON.parse(e.data))}catch(err){}};
es.onerror=()=>{dot($('d-host'),false);set('t-host','ops-center unreachable?')};
// Hover wiring for interactive usage charts (geometry precomputed server-side).
function fmtT(n){return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(Math.round(n))}
function wireCharts(){
  document.querySelectorAll('.uchart').forEach(el=>{
    if(el.__wired)return;el.__wired=1;
    let pts;try{pts=JSON.parse(el.dataset.pts)}catch(e){return}
    if(!pts||!pts.length)return;
    const kind=el.dataset.kind||'usage';
    const svg=el.querySelector('svg'),cross=el.querySelector('.cross'),
      dtk=el.querySelector('.dot-t'),dmsg=el.querySelector('.dot-m'),tip=el.querySelector('.utip'),hit=el.querySelector('.hit');
    if(!svg||!hit)return;
    const show=on=>{for(const n of [cross,dtk,dmsg])if(n)n.style.opacity=on?'1':'0';tip.style.display=on?'block':'none'};
    hit.addEventListener('mousemove',ev=>{
      const b=svg.getBoundingClientRect();
      const sx=svg.width.baseVal.value, sy=svg.height.baseVal.value;
      const x=(ev.clientX-b.left)*(sx/b.width);
      let best=0,bd=1e9;for(let i=0;i<pts.length;i++){const d=Math.abs(pts[i].x-x);if(d<bd){bd=d;best=i}}
      const p=pts[best];
      if(cross){cross.setAttribute('x1',p.x);cross.setAttribute('x2',p.x)}
      if(dtk){dtk.setAttribute('cx',p.x);dtk.setAttribute('cy',p.yt)}
      if(dmsg){dmsg.setAttribute('cx',p.x);dmsg.setAttribute('cy',p.ym)}
      let html;
      if(kind==='quota'){
        html='<b>'+p.l+'</b><br><span class="q5">5h '+(p.v5==null?'–':p.v5+'%')+'</span> · <span class="q7">7d '+(p.v7==null?'–':p.v7+'%')+'</span>';
      }else{
        html='<b>'+p.l+'</b><br><span class="m">msgs '+p.mi+' in · '+p.mo+' out</span><br><span class="t">tokens '+fmtT(p.to)+' out · '+fmtT(p.ti)+' in</span>';
        if(p.g&&p.g.length){html+='<div class="bd">';for(const gg of p.g){html+='<b>'+gg.n+'</b> · '+fmtT(gg.to)+'↑ tok · '+gg.ms+' msgs<br>'}html+='</div>'}
      }
      tip.innerHTML=html;
      // Measure then place: above the point by default, flipped below when it would clip the top; clamped horizontally.
      tip.style.display='block';
      const px=p.x*(b.width/sx), py=p.yt*(b.height/sy);
      const tw=tip.offsetWidth, th=tip.offsetHeight;
      let L=px-tw/2; L=Math.max(0,Math.min(b.width-tw,L));
      let T=py-th-12; if(T<0)T=py+18;
      tip.style.left=L+'px';tip.style.top=T+'px';
      show(true);
    });
    hit.addEventListener('mouseleave',()=>show(false));
  });
}
wireCharts();
// Lazy detail loader: <details data-lazy="URL"> fetches its body HTML the first
// time it is opened, so the page no longer embeds every file preview / DB dump.
function wireLazyDetails(){
  document.querySelectorAll('details[data-lazy]').forEach(d=>{
    if(d.__wired)return;d.__wired=1;
    d.addEventListener('toggle',async()=>{
      if(!d.open||d.__loaded)return;d.__loaded=1;
      const body=d.querySelector('.lazy-body');if(!body)return;
      try{const r=await fetch(d.dataset.lazy);if(!r.ok)throw new Error(r.status);body.innerHTML=await r.text();}
      catch(e){body.innerHTML='<span class="muted small">Failed to load ('+e+').</span>';d.__loaded=0;}
    });
  });
}
wireLazyDetails();
// ── Tower shell: group drawers ──
function openDrawer(id){const d=$('drawer-'+id);if(!d)return;closeDrawers();d.classList.add('open');const s=$('scrim');if(s)s.classList.add('on')}
function closeDrawers(){document.querySelectorAll('.drawer.open').forEach(d=>d.classList.remove('open'));const s=$('scrim');if(s)s.classList.remove('on')}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawers()});
// Dirty-state save bar: settings selects mark themselves dirty; one Save & apply
// fires each dirty control's own endpoint sequentially (no per-row Apply buttons).
function markDirty(el,gid){el.dataset.dirty='1';el.classList.add('dirty');const bar=$('save-'+gid);if(!bar)return;
  const n=document.querySelectorAll('#drawer-'+gid+' [data-dirty="1"]').length;
  bar.style.display=n?'flex':'none';const m=$('savemsg-'+gid);if(m)m.textContent=n+' unsaved change'+(n>1?'s':'')}
async function drawerSave(gid,confirmMsg){
  const d=$('drawer-'+gid);if(!d)return;
  if(confirmMsg&&!confirm(confirmMsg))return;
  for(const el of d.querySelectorAll('[data-dirty="1"]')){
    let body={};try{body=JSON.parse(el.dataset.body||'{}')}catch(e){}
    body[el.dataset.key||'value']=el.value;
    await act(el.dataset.url,body);
    el.dataset.dirty='';el.classList.remove('dirty');
  }
  const bar=$('save-'+gid);if(bar)bar.style.display='none';
}
// Voice switch: state lives in the class, so repeated toggles without a reload
// always send the right next value. Applies instantly (toast confirms).
function voiceToggle(el,url,mgid){
  const next=el.classList.contains('on')?'off':'on';
  const msg=next==='off'
    ?'Turn voice-note transcription OFF for this chat? Audio will pass through untouched and never leave the machine.'
    :'Turn voice-note transcription ON for this chat? Inbound voice notes will be transcribed via OpenRouter (cloud).';
  if(!confirm(msg))return;
  el.classList.toggle('on');
  act(url,{messagingGroupId:mgid,value:next});
}
// Whole-row click targets: any [data-rowhref] element navigates (or opens a
// drawer via the drawer: prefix) unless the click landed on a real control.
document.addEventListener('click',e=>{
  const r=e.target.closest('[data-rowhref]');if(!r)return;
  if(e.target.closest('a,button,select,input,summary,label'))return;
  const d=r.dataset.rowhref;
  if(d.startsWith('drawer:'))openDrawer(d.slice(7));else location.href=d;
});
// Sidebar collapse + drag-resize (persisted).
const __nb=$('navbtn');
if(__nb)__nb.onclick=()=>{const on=!document.documentElement.classList.contains('navmin');
  document.documentElement.classList.toggle('navmin',on);
  try{localStorage.setItem('ops-navmin',on?'1':'0')}catch(e){}};
const __rz=$('resizer');
if(__rz)__rz.addEventListener('mousedown',e=>{e.preventDefault();
  const move=ev=>{const w=Math.min(340,Math.max(150,ev.clientX));
    document.documentElement.style.setProperty('--sidew',w+'px');
    try{localStorage.setItem('ops-sidew',String(w))}catch(err){}};
  const up=()=>{document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up)};
  document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);
});
`;

export function layout(
  title: string,
  active: string,
  body: string,
  channels: string[],
  actionToken: string,
  templateApps: { path: string; label: string; icon: string }[] = [],
): string {
  const tabs: [string, string, string][] = [
    ['/', 'Overview', '◉'],
    ['/runs', 'Runs', '▶'],
    ['/logs', 'Logs', '≋'],
    ['/chat', 'Chat', '❝'],
    ['/apps', 'Apps', '▦'],
    ...templateApps.map(({ path, label, icon }) => [path, label, icon] as [string, string, string]),
    ['/trips', 'Trip Companion', '✈'],
    ['/knowledge', 'Knowledge', '◆'],
    ['/reflect', 'Reflect', '↻'],
    ['/system', 'System', '⚙'],
    ['/hub/', 'Docs', '✎'],
  ];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · NanoClaw Ops</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<script>(function(){try{var w=localStorage.getItem('ops-sidew');if(w)document.documentElement.style.setProperty('--sidew',w+'px');if(localStorage.getItem('ops-navmin')==='1')document.documentElement.classList.add('navmin')}catch(e){}})()</script>
<style>${CSS}</style></head><body><div class="shell">
<aside class="side">
  <div class="brand"><span class="logo">◮</span><span class="nm">NanoClaw<small>Ops Tower</small></span><span class="sp"></span><button class="navbtn" id="navbtn" title="Collapse / expand the sidebar">«</button></div>
  <nav>${tabs
    .map(
      ([href, label, ic]) =>
        `<a href="${href}" class="${active === href ? 'active' : ''}" title="${esc(label)}"><span class="ic">${esc(ic)}</span><span class="lbl">${esc(label)}</span></a>`,
    )
    .join('')}</nav>
  <div class="resizer" id="resizer" title="Drag to resize"></div>
</aside>
<div class="main">
  <div class="topbar"><h1 class="pgtitle">${esc(title)}</h1><span class="sp"></span>
    <span class="tvit"><span class="dot" id="d-host"></span>host <b id="t-host">…</b></span>
    <span class="tvit"><span class="dot" id="d-docker"></span><b id="t-docker">docker</b></span>
    <span class="tvit"><span class="dot" id="d-onecli"></span><a id="onecli-link" href="http://127.0.0.1:10254/overview" target="_blank" rel="noopener" title="Open the OneCLI gateway dashboard">OneCLI ↗</a></span>
    <span class="tvit" title="last outbound delivery — this is not the current time">✉ <b id="t-delivery">–</b></span>
    <span class="tvit" title="ops data on disk">◔ <b id="t-disk">–</b></span>
    <a class="tvit" id="attention-status" href="/system" title="Open System for incidents, host events, and runtime health"><span class="dot" id="d-attention"></span><b id="t-attention">…</b></a>
    <span class="tvit chgrp">${channels.map((c) => `<span title="${esc(c)}"><span class="dot" id="d-ch-${esc(c)}"></span>${esc(c)}</span>`).join('')}</span>
  </div>
  <div class="content">
${body}
  </div>
</div>
</div>
<div class="scrim" id="scrim" onclick="closeDrawers()"></div>
<div class="toast" id="toast"></div>
<script>window.__opsToken=${JSON.stringify(actionToken)};</script><script>${CLIENT_JS}</script>
</body></html>`;
}

/** Stable identity color for an agent group (Tower lane colors). Deterministic
 *  by group id so a group keeps its hue across restarts; the palette avoids
 *  red (reserved for errors) and the pure accent blue (reserved for interactive). */
export function laneColor(id: string): string {
  // fnv-1a + avalanche, mapped onto a 300° hue band. A fixed small palette
  // collided on real group ids; 300 hue buckets make same-color lanes
  // vanishingly rare while staying deterministic. The ±30° wedge around
  // pure red is skipped — red is reserved for errors by the color contract.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  const hue = 30 + (h % 300);
  return `hsl(${hue} 62% 68%)`;
}

/** Inline SVG line chart. */
export function svgChart(
  points: SeriesPoint[],
  opts: { w?: number; h?: number; color?: string; label?: string } = {},
): string {
  const w = opts.w ?? 320;
  const h = opts.h ?? 56;
  const color = opts.color ?? '#a78bfa';
  if (!points.length)
    return `<svg class="chart" width="${w}" height="${h}"><text x="4" y="${h / 2}" fill="#7b8794" font-size="11">no data${opts.label ? ` · ${esc(opts.label)}` : ''}</text></svg>`;
  const max = Math.max(...points.map((p) => p.value), 1);
  const xs = (i: number) => (points.length === 1 ? w / 2 : (i / (points.length - 1)) * (w - 8) + 4);
  const ys = (v: number) => h - 6 - (v / max) * (h - 14);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(' ');
  return `<svg class="chart" width="${w}" height="${h}" role="img">
<path d="${path}" fill="none" stroke="${color}" stroke-width="1.6"/>
<text x="4" y="11" fill="#7b8794" font-size="10">${esc(opts.label ?? '')} · max ${fmtTokens(max)}</text></svg>`;
}

/** "active X% · N spawns · N compactions · longest …" — the ribbon's caption, rendered as HTML by the caller. */
export function ribbonStat(spans: ActivitySpan[], nowMs: number, compactionsToday = 0): string {
  const fromMs = nowMs - 86_400_000;
  const rawPct = (unionDurationMs(spans, fromMs, nowMs) / 86_400_000) * 100;
  const pct = rawPct < 1 ? rawPct.toFixed(1) : Math.round(rawPct);
  const spawns = spans.filter((s) => s.startMs >= fromMs).length;
  const longest = spans.length ? Math.max(...spans.map((s) => s.endMs - s.startMs)) : 0;
  return `active ${pct}% · ${spawns} spawns${compactionsToday ? ` · ${compactionsToday} compactions` : ''}${longest ? ` · longest ${fmtAge(longest)}` : ''}`;
}

/**
 * 24h container idle/active strip — responsive geometry only (thin baseline, thicker
 * active-time segments, subagent tick marks). The caption is rendered as HTML by the
 * caller via ribbonStat(); the viewBox lets the bars stretch to the card width. Native
 * <title> tooltips; no client JS.
 */
export function activityRibbon(
  spans: ActivitySpan[],
  ticks: { tsMs: number; model: string }[],
  opts: { w?: number; nowMs: number; ariaLabel?: string },
): string {
  const w = opts.w ?? 330;
  const h = 22;
  const fromMs = opts.nowMs - 86_400_000;
  const x = (ms: number) => 4 + ((Math.min(Math.max(ms, fromMs), opts.nowMs) - fromMs) / 86_400_000) * (w - 8);
  const tFmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const segs = spans
    .map((s) => {
      const x1 = x(s.startMs);
      const x2 = Math.max(x(s.endMs), x1 + 1.5); // sliver minimum so short wakes stay visible
      const cls = s.live ? 'rb-live' : s.approx ? 'rb-approx' : 'rb-on';
      const tip =
        `${tFmt(s.startMs)} → ${s.live ? 'now' : tFmt(s.endMs)} · ${fmtAge(s.endMs - s.startMs)}` +
        (s.code != null ? ` · exit ${s.code}` : '') +
        (s.approx ? ' · approx end' : '') +
        (s.sessionId ? ` · ${s.sessionId}` : '');
      return `<rect class="${cls}" x="${x1.toFixed(1)}" y="6" width="${(x2 - x1).toFixed(1)}" height="9" rx="2"><title>${esc(tip)}</title></rect>`;
    })
    .join('');

  const tickMarks = ticks
    .filter((t) => t.tsMs >= fromMs)
    .map(
      (t) =>
        `<line class="rb-tick rb-m-${esc(t.model)}" x1="${x(t.tsMs).toFixed(1)}" y1="2" x2="${x(t.tsMs).toFixed(1)}" y2="19"><title>${esc(`subagent: ${t.model} @ ${tFmt(t.tsMs)}`)}</title></line>`,
    )
    .join('');

  return `<svg class="chart ribbon" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" role="img" aria-label="${esc(opts.ariaLabel ?? 'container activity, 24h')}">
<rect class="ribbon-base" x="4" y="10" width="${w - 8}" height="3" rx="1.5"/>
${segs}${tickMarks}</svg>`;
}

/** ~6 x-axis time labels under the baseline, derived from sample/bucket timestamps. */
function timeTickSvg(timestamps: string[], xAt: (i: number) => number, textY: number): string {
  const n = timestamps.length;
  if (n < 2) return '';
  const count = Math.min(6, n);
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const i = Math.round((k / (count - 1)) * (n - 1));
    const d = new Date(timestamps[i]);
    if (Number.isNaN(d.getTime())) continue;
    const label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const anchor = k === 0 ? 'start' : k === count - 1 ? 'end' : 'middle';
    out.push(
      `<text x="${xAt(i).toFixed(1)}" y="${textY.toFixed(1)}" fill="#7b8794" font-size="9" text-anchor="${anchor}">${esc(label)}</text>`,
    );
  }
  return out.join('');
}

/**
 * Continuous interactive activity chart: messages and tokens on independent scales
 * (so both stay legible despite very different magnitudes), with a hover crosshair
 * that reads exact values. Geometry is precomputed here and embedded as JSON; the
 * client `wireCharts()` only does nearest-point lookup + positioning.
 */
export interface UsageMarker {
  atMs: number;
  n: number;
  label?: string;
}

export function usageChart(
  buckets: (UsageBucket | UsageBucketBreakdown)[],
  opts: { w?: number; h?: number; label?: string; groups?: Record<string, string>; markers?: UsageMarker[] } = {},
): string {
  const w = opts.w ?? 1040;
  const h = opts.h ?? 150;
  const padX = 8;
  // Numbered fire-markers ride in a thin band above the plot, so widen the top
  // pad only when they're present (keeps the marker-less charts unchanged).
  const padTop = opts.markers?.length ? 22 : 14;
  const padBottom = 18;
  const plotW = w - 2 * padX;
  const plotH = h - padTop - padBottom;
  const n = buckets.length;
  if (!n) return `<div class="card"><h3>${esc(opts.label ?? 'Activity')}</h3><p class="muted small">no data</p></div>`;

  const msgTotal = (b: UsageBucket) => b.msgsIn + b.msgsOut;
  const maxMsg = Math.max(...buckets.map(msgTotal), 1);
  const maxTok = Math.max(...buckets.map((b) => b.tokensOut), 1);
  const xs = (i: number) => padX + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yTok = (v: number) => padTop + plotH - (v / maxTok) * plotH;
  const yMsg = (v: number) => padTop + plotH - (v / maxMsg) * plotH;

  const tokLine = buckets.map((b, i) => `${xs(i).toFixed(1)},${yTok(b.tokensOut).toFixed(1)}`).join(' ');
  const msgLine = buckets.map((b, i) => `${xs(i).toFixed(1)},${yMsg(msgTotal(b)).toFixed(1)}`).join(' ');

  // Per-point geometry + values for the client tooltip. `l` is a short local-time label.
  // `g` (optional) is the per-app-group breakdown for that bucket, biggest spiker first.
  type Pt = {
    x: number;
    yt: number;
    ym: number;
    mi: number;
    mo: number;
    ti: number;
    to: number;
    l: string;
    g?: { n: string; to: number; ms: number }[];
  };
  const pts: Pt[] = buckets.map((b, i) => {
    const pt: Pt = {
      x: +xs(i).toFixed(1),
      yt: +yTok(b.tokensOut).toFixed(1),
      ym: +yMsg(msgTotal(b)).toFixed(1),
      mi: b.msgsIn,
      mo: b.msgsOut,
      ti: Math.round(b.tokensIn),
      to: Math.round(b.tokensOut),
      l: new Date(b.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    };
    if (opts.groups && 'byGroup' in b) {
      const g = Object.entries(b.byGroup)
        .map(([id, s]) => ({
          n: opts.groups![id] ?? id,
          to: Math.round(s.tokensOut),
          ms: Math.round(s.msgsIn + s.msgsOut),
        }))
        .filter((x) => x.to > 0 || x.ms > 0)
        .sort((a, b2) => b2.to - a.to);
      if (g.length) pt.g = g;
    }
    return pt;
  });
  const data = esc(JSON.stringify(pts));
  const baseY = (padTop + plotH).toFixed(1);

  // Fire-markers: numbered pins in the top band at each scheduled-action firing,
  // dropping a faint guide to the baseline at the true time. Pins are nudged
  // apart left-to-right when firings cluster; a connector keeps a nudged pin
  // tied to its true-time guide. pointer-events:none so the hover tooltip that
  // tracks the whole plot underneath still works.
  let markLayer = '';
  const marks = opts.markers ?? [];
  if (marks.length) {
    const t0 = Date.parse(buckets[0].t);
    const tN = Date.parse(buckets[n - 1].t);
    const span = Math.max(1, tN - t0);
    const xForMs = (ms: number) => padX + Math.max(0, Math.min(1, (ms - t0) / span)) * plotW;
    const R = 7;
    const minGap = 2 * R + 2;
    let lastPin = -Infinity;
    const els = [...marks]
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const tx = xForMs(m.atMs);
        let px = Math.max(tx, lastPin + minGap);
        px = Math.min(px, w - padX - R);
        lastPin = px;
        const pinY = 9;
        const guide = `<line x1="${tx.toFixed(1)}" y1="${padTop}" x2="${tx.toFixed(
          1,
        )}" y2="${baseY}" stroke="var(--act)" stroke-width="1" stroke-dasharray="2 3" opacity=".3"/>`;
        const conn =
          Math.abs(px - tx) > 0.6
            ? `<line x1="${tx.toFixed(1)}" y1="${padTop}" x2="${px.toFixed(1)}" y2="${(pinY + R).toFixed(
                1,
              )}" stroke="var(--act)" stroke-width="1" opacity=".3"/>`
            : '';
        const title = m.label ? `<title>${esc(m.label)}</title>` : '';
        return `${guide}${conn}<circle cx="${px.toFixed(1)}" cy="${pinY}" r="${R}" fill="var(--act)"/>${title}<text x="${px.toFixed(
          1,
        )}" y="${pinY}" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="700" fill="#04121f">${m.n}</text>`;
      })
      .join('');
    markLayer = `<g class="fire-markers" pointer-events="none">${els}</g>`;
  }

  return `<div class="card"><h3>${esc(opts.label ?? 'Activity')}</h3>
<div class="legend"><span><i style="border-color:var(--amber)"></i>tokens out <span class="muted">(peak ${fmtTokens(maxTok)})</span></span>
<span><i style="border-color:var(--violet)"></i>messages in+out <span class="muted">(peak ${maxMsg})</span></span>
<span class="muted">independent scales · hover to read values</span></div>
<div class="uchart" data-pts="${data}">
<svg width="${w}" height="${h}" role="img">
<line x1="${padX}" y1="${baseY}" x2="${w - padX}" y2="${baseY}" stroke="var(--line)" stroke-width="1"/>
${timeTickSvg(
  buckets.map((b) => b.t),
  xs,
  padTop + plotH + 12,
)}
<polyline points="${tokLine}" fill="none" stroke="var(--amber)" stroke-width="1.6"/>
<polyline points="${msgLine}" fill="none" stroke="var(--violet)" stroke-width="1.4"/>
<line class="cross" x1="0" y1="${padTop}" x2="0" y2="${baseY}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
<circle class="dot-t" r="3.2" fill="var(--amber)"/>
<circle class="dot-m" r="3.2" fill="var(--violet)"/>
<rect class="hit" x="0" y="0" width="${w}" height="${h}"/>
${markLayer}
</svg>
<div class="utip"></div>
</div></div>`;
}

/**
 * Subscription-quota trend: 5h and 7d window utilization. The y-scale adapts to
 * the data (0–25 / 0–50 / 0–100%) so low utilization isn't squashed into the
 * bottom of a fixed 0–100 band — the axis labels carry the "how close to the
 * cap" reading instead. Hover crosshair (shared wireCharts machinery, kind
 * 'quota'), x-axis time ticks, and end-of-line value labels tie the numbers to
 * the lines. Both series share sample timestamps; the 5h series is the hover
 * spine. `current` (optional) drives the header readout + reset times.
 */
export function quotaChart(
  fiveHour: SeriesPoint[],
  sevenDay: SeriesPoint[],
  opts: {
    w?: number;
    h?: number;
    label?: string;
    current?: {
      fiveHourPct: number;
      sevenDayPct: number;
      fiveHourResetsAt: string | null;
      sevenDayResetsAt: string | null;
      ageMs: number;
    } | null;
    /** Wall-clock ms of the render. Used to stitch `current` onto the line's trailing edge. */
    nowMs?: number;
  } = {},
): string {
  const w = opts.w ?? 1040;
  const h = opts.h ?? 170;
  const padX = 8;
  const padTop = 14;
  const padBottom = 18;
  const plotW = w - 2 * padX;
  const plotH = h - padTop - padBottom;
  const cur = opts.current;

  // Stitch the live current reading onto the trailing edge so the line endpoint and
  // its value label agree with the header readout. The collector only persists fresh
  // snapshots, so a stale gap (no interactive session / failed refresh) leaves the
  // last sample frozen at an old value while `cur` has already moved on — without
  // this, the line ends at a stale value that contradicts the legend.
  if (cur && opts.nowMs !== undefined) {
    const tIso = new Date(opts.nowMs - cur.ageMs).toISOString();
    if (!fiveHour.length || fiveHour[fiveHour.length - 1].t < tIso)
      fiveHour = [...fiveHour, { t: tIso, value: cur.fiveHourPct }];
    if (!sevenDay.length || sevenDay[sevenDay.length - 1].t < tIso)
      sevenDay = [...sevenDay, { t: tIso, value: cur.sevenDayPct }];
  }

  const dataMax = Math.max(
    1,
    ...fiveHour.map((p) => p.value),
    ...sevenDay.map((p) => p.value),
    cur?.fiveHourPct ?? 0,
    cur?.sevenDayPct ?? 0,
  );
  const yMax = dataMax <= 25 ? 25 : dataMax <= 50 ? 50 : 100;
  const y = (pct: number) => padTop + plotH - (Math.max(0, Math.min(yMax, pct)) / yMax) * plotH;
  const xAt = (pts: SeriesPoint[]) => (i: number) =>
    padX + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const line = (pts: SeriesPoint[]) =>
    pts.map((p, i) => `${xAt(pts)(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  const gridStep = yMax / 5;
  const grid = Array.from({ length: 6 }, (_, k) => k * gridStep)
    .map((g) => {
      const gy = y(g).toFixed(1);
      return `<line x1="${padX}" y1="${gy}" x2="${w - padX}" y2="${gy}" stroke="var(--line)" stroke-width="1"/><text x="${w - padX}" y="${(+gy - 2).toFixed(1)}" fill="#7b8794" font-size="9" text-anchor="end">${g}%</text>`;
    })
    .join('');

  // Hover spine: 5h series (falls back to 7d if 5h is empty). Same sample ticks
  // write both metrics, so index-zip is the normal case; timestamps guard drift.
  const spine = fiveHour.length ? fiveHour : sevenDay;
  const other = fiveHour.length ? sevenDay : [];
  const sx = xAt(spine);
  const pts = spine.map((p, i) => {
    const o = other[i]?.t === p.t ? other[i] : other.find((q) => q.t === p.t);
    const v5 = fiveHour.length ? p.value : null;
    const v7 = fiveHour.length ? (o?.value ?? null) : p.value;
    return {
      x: +sx(i).toFixed(1),
      yt: +y(v5 ?? p.value).toFixed(1),
      ym: +y(v7 ?? p.value).toFixed(1),
      v5: v5 === null ? null : +v5.toFixed(1),
      v7: v7 === null ? null : +v7.toFixed(1),
      l: new Date(p.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    };
  });

  // End-of-line value labels, nudged apart when the lines converge.
  const endLabels = (() => {
    const ends: { v: number; yy: number; color: string }[] = [];
    if (fiveHour.length)
      ends.push({
        v: fiveHour[fiveHour.length - 1].value,
        yy: y(fiveHour[fiveHour.length - 1].value),
        color: 'var(--teal)',
      });
    if (sevenDay.length)
      ends.push({
        v: sevenDay[sevenDay.length - 1].value,
        yy: y(sevenDay[sevenDay.length - 1].value),
        color: 'var(--rose)',
      });
    if (ends.length === 2 && Math.abs(ends[0].yy - ends[1].yy) < 12) {
      const [a, b] = ends[0].yy <= ends[1].yy ? [ends[0], ends[1]] : [ends[1], ends[0]];
      const mid = (a.yy + b.yy) / 2;
      a.yy = mid - 6;
      b.yy = mid + 6;
    }
    return ends
      .map(
        (e) =>
          `<text x="${(w - padX - 24).toFixed(1)}" y="${(e.yy + 3).toFixed(1)}" fill="${e.color}" font-size="10" font-weight="700" text-anchor="end">${e.v.toFixed(0)}%</text>`,
      )
      .join('');
  })();

  const readout = cur
    ? `<span><i style="border-color:var(--teal)"></i>5h <b>${cur.fiveHourPct.toFixed(0)}%</b>${cur.fiveHourResetsAt ? ` <span class="muted">↻ ${esc(fmtResetLocal(cur.fiveHourResetsAt))}</span>` : ''}</span>
<span><i style="border-color:var(--rose)"></i>7d <b>${cur.sevenDayPct.toFixed(0)}%</b>${cur.sevenDayResetsAt ? ` <span class="muted">↻ ${esc(fmtResetLocal(cur.sevenDayResetsAt))}</span>` : ''}</span>
<span class="muted small">snapshot ${fmtAge(cur.ageMs)} old · scale 0–${yMax}% · hover to read values</span>`
    : `<span><i style="border-color:var(--teal)"></i>5h window</span><span><i style="border-color:var(--rose)"></i>7d window</span>
<span class="muted small">waiting for the first quota snapshot</span>`;

  const baseY = (padTop + plotH).toFixed(1);
  const body = spine.length
    ? `<div class="uchart" data-kind="quota" data-pts="${esc(JSON.stringify(pts))}">
<svg width="${w}" height="${h}" role="img">${grid}
${timeTickSvg(
  spine.map((p) => p.t),
  sx,
  padTop + plotH + 12,
)}
<polyline points="${line(fiveHour)}" fill="none" stroke="var(--teal)" stroke-width="1.6"/>
<polyline points="${line(sevenDay)}" fill="none" stroke="var(--rose)" stroke-width="1.6"/>
${endLabels}
<line class="cross" x1="0" y1="${padTop}" x2="0" y2="${baseY}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
<circle class="dot-t" r="3.2" fill="var(--teal)"/>
<circle class="dot-m" r="3.2" fill="var(--rose)"/>
<rect class="hit" x="0" y="0" width="${w}" height="${h}"/>
</svg>
<div class="utip"></div>
</div>`
    : `<p class="muted small">no quota samples yet — they'll appear within a minute of the collector's first refresh</p>`;

  return `<div class="card"><h3>${esc(opts.label ?? 'Subscription quota — 5h / 7d utilization')}</h3>
<div class="legend">${readout}</div>
${body}</div>`;
}

/** Reset timestamp → compact local time/date, e.g. "3:40 PM" (same day) or "Jun 14". */
function fmtResetLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Per-card skills summary (Part 1). `enabledIds` is already intersected with
 *  the catalog, so its length is the true enabled count; `total` is the catalog size. */
export interface GroupSkillsSummary {
  mode: 'all' | 'list';
  enabledIds: string[];
  total: number;
}

export interface GroupCardExtras {
  routingName: string;
  skills: GroupSkillsSummary;
  /** Compact template provenance for the overview fleet card. */
  template?: {
    status: GroupTemplateInfo['status'];
    ref: string | null;
    skillCount: number;
    opsCenterLabel: string | null;
  };
  tokensToday: { model: string; out: number; in: number }[];
  costTodayUsd: number;
  /** Distinct senders in the last 24h: total, how many are off the allowlist, and the top few. */
  senders: { unique: number; unknown: number; top: { name: string; channel: string }[] };
  /** SLO latency proxy (p95 of per-minute maxima) over `sloWindowDays`; the card's live p95. */
  latencyP95ProxyMs: number | null;
  sloWindowDays: number;
  p95Ms: number | null;
  spans: ActivitySpan[];
  subagentTicks: { tsMs: number; model: string }[];
  compactionsToday: number;
  /** All-time curated-memory recalls; null when the group has no memory.db. */
  recalls: number | null;
  /** Fraction of recalls that returned ≥1 hit (0–1); null when there are no recalls. */
  recallHitRate: number | null;
  nowMs: number;
  mix: ModelMixEntry[];
  wirings: WiringInfo[];
  maxMessagesPerPrompt: number | null;
}

// Internal transports where engagement mode is meaningless — there's no
// @mention concept on the CLI/agent channels (those carry test sims and
// agent-to-agent traffic). Only human chat channels get an engagement control.
export const NON_CHAT_CHANNELS = new Set(['cli', 'agent']);

/**
 * Voice-note transcription switches for the group detail page. Same semantics
 * as the drawer column: 'on' transcribes inbound audio at ingest (OneCLI →
 * OpenRouter); 'off' is the per-chat privacy switch. Applies live.
 */
export function voiceTranscriptionControls(g: GroupLive, wirings: WiringInfo[]): string {
  const chat = wirings.filter((w) => !NON_CHAT_CHANNELS.has(w.channel_type ?? ''));
  if (!chat.length) return '';
  const id = esc(g.id);
  const rows = chat
    .map((w) => {
      const on = w.voice_transcription !== 'off';
      const label = esc(w.name?.trim() || `${w.channel_type ?? 'chat'} · ${prettyHandle(w.platform_id ?? '')}`);
      return `<tr><td class="chn">${label}</td><td style="width:54px;text-align:center"><span class="sw2${on ? ' on' : ''}" onclick="voiceToggle(this,'/api/group/${id}/voice-transcription','${esc(w.messaging_group_id)}')"><i></i></span></td></tr>`;
    })
    .join('');
  return `<div style="margin-top:10px"><div class="muted small" style="margin-bottom:6px">Voice notes — transcribe at ingest (off = privacy: audio never leaves the machine)</div>
<table class="ctable"><tr><th>chat</th><th>voice</th></tr>${rows}</table></div>`;
}

/** Strip the `<channel>:` prefix and platform JID noise so a member id reads as
 *  the bare handle/number the operator recognises (e.g. `915550000003`). */
export function prettyHandle(userId: string): string {
  const i = userId.indexOf(':');
  const h = i >= 0 ? userId.slice(i + 1) : userId;
  return h
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@lid$/, '')
    .replace(/@g\.us$/, '');
}

/**
 * Allowlist card for the group detail page. The allowlist (agent_group_members)
 * is the set of senders that wake the agent — everyone else on a connected
 * channel is ignored. Members are grouped by the channel they belong to; only
 * human chat channels are shown (cli/agent transports have no allowlist
 * semantics). Every connected chat channel appears even with zero members, so an
 * empty allowlist (every sender ignored) is visible rather than silently absent.
 * Channel-agnostic: WhatsApp, Telegram, and any future chat channel render the
 * same way off the `<channel>:<handle>` id prefix.
 */
export function allowlistCard(members: MemberInfo[], connectedChannels: string[]): string {
  const byChannel = new Map<string, MemberInfo[]>();
  for (const m of members) {
    if (NON_CHAT_CHANNELS.has(m.channel)) continue;
    const arr = byChannel.get(m.channel) ?? [];
    arr.push(m);
    byChannel.set(m.channel, arr);
  }
  for (const ch of connectedChannels) {
    if (!NON_CHAT_CHANNELS.has(ch) && !byChannel.has(ch)) byChannel.set(ch, []);
  }
  if (byChannel.size === 0)
    return `<div class="card"><h3>Allowlist</h3><p class="muted small">No chat channel connected — nothing to allowlist.</p></div>`;
  const sections = [...byChannel.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ch, ms]) => {
      const rows = ms.length
        ? ms
            .map(
              (m) =>
                `<tr><td>${esc(m.display_name || prettyHandle(m.user_id))}</td><td class="small muted">${esc(prettyHandle(m.user_id))}</td></tr>`,
            )
            .join('')
        : `<tr><td colspan=2 class="muted small">No one on the allowlist — every ${esc(ch)} sender is treated as unknown and ignored.</td></tr>`;
      return `<div class="kv" style="margin-top:6px"><span>${esc(ch)} <b>${ms.length}</b> on allowlist</span></div>
<table>${rows}</table>`;
    })
    .join('');
  return `<div class="card"><h3>Allowlist</h3>
<p class="muted small">Only these senders wake the agent. Everyone else on the channel is ignored — the Senders table flags them as "not on allowlist".</p>
${sections}</div>`;
}

/** Connected messaging groups for the detail page. Names identify chats for
 * humans; the platform address remains visible as the stable machine key. */
export function channelsCard(wirings: WiringInfo[]): string {
  const rows = wirings
    .map((w) => {
      const channel = w.channel_type ?? 'unknown';
      const friendly = w.name?.trim() || `${channel} · ${prettyHandle(w.platform_id ?? '')}`;
      const address = w.platform_id ? prettyHandle(w.platform_id) : '–';
      const instance = w.instance && w.instance !== channel ? w.instance : 'default';
      const mode = matchPreset(w) ?? w.engage_mode;
      return `<tr><td><b>${esc(friendly)}</b><small class="muted">${esc(channel)} · ${esc(instance)}</small></td>
<td class="small muted" title="${esc(w.platform_id ?? '')}">${esc(address)}</td>
<td><span class="state info">${esc(mode)}</span><div class="muted small">${esc(w.engage_mode)} · ${esc(w.ignored_message_policy)}</div></td></tr>`;
    })
    .join('');
  return `<div class="card"><h3>Channels <span class="muted small">${wirings.length}</span></h3>
<p class="muted small">Every messaging group wired to this agent. Names are operator labels; the platform address remains available on hover for exact matching.</p>
<div class="scrollbox"><table class="ctable"><tr><th>chat</th><th>platform address</th><th>engagement</th></tr>
${rows || '<tr><td colspan=3 class="muted">No channels connected.</td></tr>'}</table></div></div>`;
}

/**
 * Interactive skills panel for the group detail page (replaces the old "Sessions
 * & context" card). Lists the full shared catalog with a checkbox per skill;
 * enabled rows sort first. The "Apply & restart" button gathers the checked set
 * and POSTs to /api/group/:id/skills (server validates + collapses a full set to
 * dynamic "all", then restarts so symlinks re-materialize). `core` skills get an
 * informational badge but are freely toggleable. `footerHtml` carries the live
 * container-status line so the detail page keeps its SSE-updated indicator.
 */
export function skillsCard(
  groupId: string,
  groupName: string,
  available: SkillInfo[],
  resolved: ResolvedSkills,
  footerHtml = '',
): string {
  if (!available.length)
    return `<div class="card"><h3>Skills</h3><p class="muted small">No shared skills found under container/skills/.</p>${footerHtml}</div>`;
  const gid = esc(groupId);
  const total = available.length;
  const rows = available
    .map((s) => ({ s, on: resolved.mode === 'all' || resolved.enabledIds.has(s.id) }))
    .sort((a, b) => (a.on === b.on ? a.s.id.localeCompare(b.s.id) : a.on ? -1 : 1));
  const enabledCount = rows.filter((r) => r.on).length;
  const note =
    resolved.mode === 'all'
      ? `This group runs <b>all ${total}</b> skills — any newly-added skill is included automatically.`
      : `Explicit selection: <b>${enabledCount}</b> of ${total} enabled. New skills are <b>not</b> auto-added to this group.`;
  const body = rows
    .map(({ s, on }) => {
      const desc = s.description ? esc(truncate(s.description, 130)) : '<span class="muted">—</span>';
      const badge = isCore(s.id)
        ? ` <span class="pill" title="Infrastructural skill — disabling it degrades how the agent handles credential/auth errors.">core</span>`
        : '';
      const sub = s.name !== s.id ? `<div class="muted small">${esc(s.id)}</div>` : '';
      const cb = `<input type="checkbox" class="skl" value="${esc(s.id)}"${on ? ' checked' : ''}>`;
      return `<tr><td><label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer">${cb}<span><b${on ? '' : ' class="muted"'}>${esc(s.name)}</b>${badge}${sub}</span></label></td><td class="small muted">${desc}</td></tr>`;
    })
    .join('');
  // groupName lands inside a single-quoted JS string in the onclick; esc() guards
  // the double-quoted attribute and the apostrophe-strip guards the JS string.
  const confirm = `Apply skill changes to ${esc(groupName).replace(/'/g, '')} and restart? Skills re-materialize on the next container spawn; in-flight work is interrupted.`;
  return `<div class="card"><h3>Skills <span class="muted small">${enabledCount}/${total}</span></h3>
<p class="muted small">Skills come from the shared <b>container/skills/</b> set; toggle which are active for <b>this group</b>, then apply.</p>
<p class="muted small">${note}</p>
<div id="skills-${gid}" class="scrollbox">
<table><tr><th>skill</th><th>what it does</th></tr>${body}</table>
</div>
<div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:8px">
  <button onclick="act('/api/group/${gid}/skills',{skills:[...document.querySelectorAll('#skills-${gid} input.skl:checked')].map(c=>c.value)},'${confirm}')">Apply &amp; restart</button>
  <span class="muted small">Unchecking any skill switches the group from dynamic <b>all</b> to a fixed list; re-checking everything restores <b>all</b>.</span>
</div>${footerHtml}</div>`;
}

/**
 * Explain the source-backed template attached to a group. This sits beside the
 * selectable shared-skills card so operators can tell template skills apart
 * from the global catalog and see what will be mounted at the next wake.
 */
export function templateCard(
  info: GroupTemplateInfo,
  opts: { currentRuntimeFingerprint?: string | null; latestRuntime?: RuntimeManifest | null } = {},
): string {
  if (info.status === 'none') {
    return `<div class="card"><h3>Template</h3><p class="muted small">No local template is attached. This group uses its own instructions and the shared skill selection.</p></div>`;
  }
  if (info.status === 'error') {
    return `<div class="card"><h3>Template <span class="state warn">unavailable</span></h3><p class="muted small">${esc(info.error ?? 'The template reference could not be resolved.')}</p><p class="muted small">Reference: <code>${esc(info.ref ?? '–')}</code></p></div>`;
  }

  const latest = opts.latestRuntime;
  const currentFp = opts.currentRuntimeFingerprint ?? null;
  const sourceState =
    latest?.runtime_fingerprint && currentFp
      ? latest.runtime_fingerprint === currentFp
        ? `<span class="dot ok"></span><b>current</b> · source matches the latest runtime stamp`
        : `<span class="dot warn"></span><b>source changed</b> · the next wake will refresh this group`
      : latest
        ? `<span class="dot"></span><b>not comparable</b> · older runtime stamp has no full fingerprint`
        : `<span class="dot"></span><b>not deployed yet</b> · no runtime stamp found for this group`;
  const pill = (value: string): string => `<span class="pill">${esc(value)}</span>`;
  const templateSkills = info.skills.length
    ? info.skills.map((skill) => pill(skill.name)).join(' ')
    : '<span class="muted">none</span>';
  const mcp = info.mcpServers.length ? info.mcpServers.map(pill).join(' ') : '<span class="muted">none</span>';
  const mounts = info.runtimeMounts.length
    ? info.runtimeMounts
        .map((mount) => pill(`${mount.source} → ${mount.target}${mount.readonly ? '' : ' · rw'}`))
        .join(' ')
    : '<span class="muted">none</span>';
  const extraFiles = info.contextExtras.length
    ? info.contextExtras.map((file) => pill(`${file.name} · ${fmtBytes(file.bytes)}`)).join(' ')
    : '<span class="muted">none</span>';
  const ops = info.opsCenter ? `${info.opsCenter.icon} ${info.opsCenter.label} · ${info.opsCenter.id}` : 'none';
  return `<div class="card"><h3>Template <span class="state info">live source</span></h3>
<p class="muted small">This group is stamped from a local template, but the source remains live and is mounted read-only at container start. Edits are picked up on the next wake/restart.</p>
<div class="kv"><span>ref <b><code>${esc(info.ref ?? '–')}</code></b></span><span>source <code>${esc(info.rootLabel ?? '–')}</code></span><span>README <b>${info.readme ? 'yes' : 'no'}</b></span></div>
<div class="kv"><span>instructions <b>${info.instructions ? `${info.instructions.lines} lines · ${fmtBytes(info.instructions.bytes)}` : '–'}</b></span><span>template skills <b>${info.skills.length}</b></span><span>context files <b>${info.contextExtras.length}</b></span><span>MCP servers <b>${info.mcpServers.length}</b></span></div>
<p class="small" style="margin:8px 0 0">${sourceState}</p>
<details style="margin-top:10px"><summary class="muted small">Template composition</summary>
<table><tr><th>surface</th><th>declared content</th></tr><tr><td>skills</td><td>${templateSkills}</td></tr><tr><td>MCP</td><td>${mcp}</td></tr><tr><td>context extras</td><td>${extraFiles}</td></tr><tr><td>runtime mounts</td><td>${mounts}</td></tr><tr><td>Ops Center app</td><td>${esc(ops)}</td></tr></table></details></div>`;
}

/** Format a USD-per-1M-token cost compactly ($/M). */
function fmtCost(v: number): string {
  if (!v) return '$0';
  if (v < 1) return `$${v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** Parse a group's model_tiers column. */
export function parseTiers(
  raw: string | null | undefined,
): { high: string; medium: string; low: string; default: string } | null {
  try {
    const t = raw ? (JSON.parse(raw) as { high: string; medium: string; low: string; default: string }) : null;
    if (t && t.high && t.medium && t.low && ['high', 'medium', 'low'].includes(t.default)) return t;
  } catch {
    /* ignore */
  }
  return null;
}

/** `<option>` list of catalog models sorted by Intelligence Index, one preselected. */
function catalogOptions(catalog: ModelCatalog, selectedId: string | null): string {
  return catalogByIntelligence(catalog)
    .map((m) => {
      const ii = m.intelligenceIndex != null ? `II ${m.intelligenceIndex.toFixed(1)}` : 'II —';
      const label = `${m.name} · ${ii} · ${fmtCost(m.promptCost)}/${fmtCost(m.completionCost)} per M`;
      return `<option value="${esc(m.id)}"${m.id === selectedId ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

/**
 * "Models" card (OpenCode groups): the group's default model plus an
 * EDITABLE high/medium/low tier picker (each a catalog dropdown sorted by
 * Intelligence Index), a default-tier selector, and Save. Below, the full
 * OpenRouter groups also get the host-cached catalog as a read-only
 * cost/intelligence reference; native providers use their own model lists.
 */
/**
 * Static tier options for Anthropic (Claude-provider) groups — these ids are
 * not in the OpenRouter catalog, so the catalog picker can't offer them.
 * Any already-configured tier value not listed here is appended so a custom
 * id survives a Save round-trip.
 */
const ANTHROPIC_TIER_MODELS: { id: string; label: string }[] = [
  { id: 'opus', label: 'Opus — latest alias' },
  { id: 'claude-opus-5', label: 'Opus 5 — strongest, hard reasoning' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — strongest, hard reasoning' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7 — strong reasoning' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6 — strong reasoning' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5 — strong reasoning' },
  { id: 'sonnet', label: 'Sonnet — latest alias' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced default' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5 — balanced' },
  { id: 'haiku', label: 'Haiku — latest alias' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — cheapest, errands' },
];

const CODEX_TIER_MODELS: { id: string; label: string }[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
];

const XAI_TIER_MODELS: { id: string; label: string }[] = [
  { id: 'xai/grok-4.7', label: 'Grok 4.7 — newest frontier/agentic model' },
  { id: 'xai/grok-4.6', label: 'Grok 4.6 — strongest frontier/agentic model' },
  { id: 'xai/grok-4.5', label: 'Grok 4.5 — strong coding and agentic work' },
  { id: 'xai/grok-4.3', label: 'Grok 4.3 — fast general-purpose work' },
  { id: 'xai/grok-build-0.1', label: 'Grok Build 0.1 — coding-focused' },
];

function modelProvider(model: string | null | undefined): string | null {
  const slash = model?.indexOf('/') ?? -1;
  return slash > 0 ? model!.slice(0, slash).toLowerCase() : null;
}

function xaiModelName(model: string): string | null {
  return XAI_TIER_MODELS.find((candidate) => candidate.id === model)?.label.split(' — ', 1)[0] ?? null;
}

/**
 * Reversible Claude ↔ Codex ↔ OpenCode harness control. The server-side action stores the
 * active provider's model profile before switching and restores it when the
 * operator switches back; the first visit to the other provider uses native
 * defaults. It then runs one isolated web-chat probe after restart.
 */
export function providerSwitchCard(cfg: GroupConfigSnapshot | undefined): string {
  const gid = esc(cfg?.id ?? '');
  const current =
    cfg?.provider === 'codex' || cfg?.provider === 'opencode' || cfg?.provider === 'pi' ? cfg.provider : 'claude';
  const tiers = parseTiers(cfg?.model_tiers);
  const defaultModel = tiers ? tiers[tiers.default as 'high' | 'medium' | 'low'] : cfg?.model;
  const activeOpenCodeProvider = current === 'opencode' ? (modelProvider(defaultModel) ?? 'openrouter') : 'openrouter';
  const openCodeLabel = activeOpenCodeProvider === 'xai' ? 'OpenCode / xAI' : 'OpenCode / OpenRouter';
  const name = cfg?.name ?? 'this group';
  const labels: Record<'claude' | 'codex' | 'opencode' | 'pi', string> = {
    claude: 'Claude / Anthropic',
    codex: 'Codex / ChatGPT',
    opencode: openCodeLabel,
    pi: 'Pi',
  };
  const providers: ('claude' | 'codex' | 'opencode' | 'pi')[] = ['claude', 'codex', 'opencode', 'pi'];
  const buttons = providers
    .filter((target) => target !== current)
    .map((target) => {
      const confirm =
        `Switch ${name} from ${current} to ${target}? The current model profile will be saved, the container restarted, and one validation model turn will run.`
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'");
      return `<button onclick="act('/api/group/${gid}/provider',{provider:'${target}'},'${confirm}')">Use ${esc(labels[target])}</button>`;
    })
    .join(' ');
  return `<div class="card"><h3>Harness / provider</h3>
<div class="kv"><span>active harness <b>${esc(labels[current])}</b></span><span>current model <b>${esc(defaultModel ?? '–')}</b></span></div>
<p class="muted small">Switching saves this provider's model/tier profile and restores it when you switch back. The first switch to another provider uses its native defaults or the configured OpenCode model. After restart, Ops Center sends one isolated web-chat probe and verifies the provider continuation.${activeOpenCodeProvider === 'xai' ? ' This group uses xAI through OpenCode with SuperGrok OAuth.' : ''}</p>
${buttons}
<span class="muted small" style="margin-left:8px">Consumes one validation model turn.</span></div>`;
}

export function piRuntimeCard(health: import('./readers/pi-health.js').PiRuntimeHealth | null): string {
  if (!health)
    return `<div class="card"><h3>Pi runtime</h3><p class="muted small">No Pi health receipt has been written for this group yet.</p></div>`;
  const rows = Object.entries(health.servers)
    .map(
      ([name, server]) =>
        `<tr><td><b>${esc(name)}</b></td><td>${esc(server.status)}</td><td>${server.toolCount} tools</td><td>${server.calls} calls</td><td>${server.errors} errors</td><td>${server.lastLatencyMs == null ? '–' : `${server.lastLatencyMs} ms`}</td><td>${esc(server.error ?? '')}</td></tr>`,
    )
    .join('');
  return `<div class="card"><h3>Pi runtime</h3>
<div class="kv"><span>state <b>${esc(health.status)}</b></span><span>session <code>${esc(health.sessionId)}</code></span><span>catalog <b>${health.catalogTools}</b></span><span>active MCP <b>${health.activeTools}</b></span><span>recent events <b>${health.recentEventCount}</b></span></div>
<p class="muted small">Last receipt ${esc(health.updatedAt || 'unknown')}${health.lastEvent ? ` · last event ${esc(health.lastEvent.type)} at ${esc(health.lastEvent.ts)}` : ''}. Arguments, results, headers, and credentials are intentionally excluded.</p>
<div class="tablewrap"><table><thead><tr><th>Server</th><th>State</th><th>Catalog</th><th>Calls</th><th>Errors</th><th>Last latency</th><th>Last error</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No MCP servers</td></tr>'}</tbody></table></div></div>`;
}

function staticModelOptions(
  source: { id: string; label: string }[],
  selectedId: string | null,
  isCompatible: (id: string) => boolean,
): string {
  const models = [...source];
  // Preserve provider-native custom ids, but never carry a model from a
  // different harness into this provider's dropdown.
  if (selectedId && !models.some((m) => m.id === selectedId) && isCompatible(selectedId)) {
    models.push({ id: selectedId, label: selectedId });
  }
  return models
    .map((m) => `<option value="${esc(m.id)}"${m.id === selectedId ? ' selected' : ''}>${esc(m.label)}</option>`)
    .join('');
}

export function modelsCard(cfg: GroupConfigSnapshot | undefined, catalog: ModelCatalog | null): string {
  const gid = esc(cfg?.id ?? '');
  const tiers = parseTiers(cfg?.model_tiers);
  const defaultTier = tiers?.default ?? 'medium';
  const defaultModel = tiers ? tiers[tiers.default as 'high' | 'medium' | 'low'] : (cfg?.model ?? null);
  const isOpenCode = cfg?.provider === 'opencode' || cfg?.provider === 'pi';
  const isCodex = cfg?.provider === 'codex';
  const openCodeProvider = isOpenCode ? (modelProvider(defaultModel) ?? 'openrouter') : null;
  const nameFor = (id: string | null | undefined) => {
    if (!id) return '–';
    if (openCodeProvider === 'xai') return xaiModelName(id) ?? id;
    return findCatalogModel(catalog, id)?.name ?? id;
  };
  const fmtScore = (v: number | null | undefined) => (v != null ? v.toFixed(1) : '—');

  // Editable tier picker. Falls back to the current model / top of the catalog
  // when a group has no tiers yet, so "Save tiers" can create them from scratch.
  let editorHtml: string;
  if (!isOpenCode) {
    // Subscription-provider groups use provider-native ids, not the OpenRouter
    // catalog. `[tier:X]` switches the main session per turn.
    const cur = (t: 'high' | 'medium' | 'low') => (tiers ? tiers[t] : (cfg?.model ?? null));
    const nativeModels = isCodex ? CODEX_TIER_MODELS : ANTHROPIC_TIER_MODELS;
    const isCompatible = isCodex
      ? isSupportedCodexModelId
      : (id: string) => /^(claude-|opus$|sonnet$|haiku$)/i.test(id);
    const row = (t: 'high' | 'medium' | 'low') =>
      `<tr><td><b>${esc(t)}</b></td><td style="width:100%"><select id="mt-${gid}-${t}" style="width:100%;max-width:520px">${staticModelOptions(nativeModels, cur(t), isCompatible)}</select></td></tr>`;
    const defOpts = (['high', 'medium', 'low'] as const)
      .map((t) => `<option value="${t}"${defaultTier === t ? ' selected' : ''}>${t}</option>`)
      .join('');
    const tiersLiteral =
      `{high:document.getElementById('mt-${gid}-high').value,` +
      `medium:document.getElementById('mt-${gid}-medium').value,` +
      `low:document.getElementById('mt-${gid}-low').value,` +
      `default:document.getElementById('mt-${gid}-default').value}`;
    const routingHelp = isCodex
      ? 'Codex tier routing — the main session runs the <b>default</b> tier; a <code>[tier:high|medium|low]</code> directive switches that turn before its query starts.'
      : "Anthropic tier routing — the main session runs the <b>default</b> tier; a <code>[tier:high|medium|low]</code> directive in an inbound message switches that turn's model. Subagent delegation (haiku/opus) is separate and always available.";
    editorHtml = `<div class="muted small" style="margin-top:10px">${routingHelp}</div>
<table><tr><th>tier</th><th>model</th></tr>${row('high')}${row('medium')}${row('low')}</table>
<div class="kv" style="margin-top:6px;align-items:center">
  <span>default tier <select id="mt-${gid}-default">${defOpts}</select></span>
  <button onclick="act('/api/group/${gid}/model-tiers',{tiers:${tiersLiteral}},'Save these model tiers for ${esc(cfg?.name ?? 'this group')} and restart with a fresh provider context now?')">Save tiers</button>
</div>`;
  } else if (openCodeProvider === 'xai') {
    const fallback = cfg?.model ?? 'xai/grok-4.6';
    const cur = (t: 'high' | 'medium' | 'low') => (tiers ? tiers[t] : fallback);
    const row = (t: 'high' | 'medium' | 'low') =>
      `<tr><td><b>${esc(t)}</b></td><td style="width:100%"><select id="mt-${gid}-${t}" style="width:100%;max-width:520px">${staticModelOptions(XAI_TIER_MODELS, cur(t), (id) => /^xai\/grok-/i.test(id))}</select></td></tr>`;
    const defOpts = (['high', 'medium', 'low'] as const)
      .map((t) => `<option value="${t}"${defaultTier === t ? ' selected' : ''}>${t}</option>`)
      .join('');
    const tiersLiteral =
      `{high:document.getElementById('mt-${gid}-high').value,` +
      `medium:document.getElementById('mt-${gid}-medium').value,` +
      `low:document.getElementById('mt-${gid}-low').value,` +
      `default:document.getElementById('mt-${gid}-default').value}`;
    editorHtml = `<div class="muted small" style="margin-top:10px">xAI / Grok tier routing — the main session runs the <b>default</b> tier; a <code>[tier:high|medium|low]</code> directive switches that turn before its query starts. These are native xAI model ids used with the group's SuperGrok OAuth state.</div>
<table><tr><th>tier</th><th>model</th></tr>${row('high')}${row('medium')}${row('low')}</table>
<div class="kv" style="margin-top:6px;align-items:center">
  <span>default tier <select id="mt-${gid}-default">${defOpts}</select></span>
  <button onclick="act('/api/group/${gid}/model-tiers',{tiers:${tiersLiteral}},'Save these model tiers for ${esc(cfg?.name ?? 'this group')} and restart with a fresh provider context now?')">Save tiers</button>
</div>`;
  } else if (!catalog) {
    editorHtml = `<p class="muted small">Model catalog not cached yet — the host refreshes it on startup and every 12h, so the pickers can't populate. Try again shortly.</p>`;
  } else {
    const fallback = cfg?.model ?? catalogByIntelligence(catalog)[0]?.id ?? null;
    const cur = (t: 'high' | 'medium' | 'low') => (tiers ? tiers[t] : fallback);
    const row = (t: 'high' | 'medium' | 'low') =>
      `<tr><td><b>${esc(t)}</b></td><td style="width:100%"><select id="mt-${gid}-${t}" style="width:100%;max-width:520px">${catalogOptions(catalog, cur(t))}</select></td></tr>`;
    const defOpts = (['high', 'medium', 'low'] as const)
      .map((t) => `<option value="${t}"${defaultTier === t ? ' selected' : ''}>${t}</option>`)
      .join('');
    const tiersLiteral =
      `{high:document.getElementById('mt-${gid}-high').value,` +
      `medium:document.getElementById('mt-${gid}-medium').value,` +
      `low:document.getElementById('mt-${gid}-low').value,` +
      `default:document.getElementById('mt-${gid}-default').value}`;
    editorHtml = `<div class="muted small" style="margin-top:10px">Tier routing — the agent delegates subtasks to these; Jeeves can request a tier by name (<code>[tier:high]</code>). Pick a model per tier and choose which tier is the group's default.</div>
<table><tr><th>tier</th><th>model (sorted by Intelligence Index)</th></tr>${row('high')}${row('medium')}${row('low')}</table>
<div class="kv" style="margin-top:6px;align-items:center">
  <span>default tier <select id="mt-${gid}-default">${defOpts}</select></span>
  <button onclick="act('/api/group/${gid}/model-tiers',{tiers:${tiersLiteral}},'Save these model tiers for ${esc(cfg?.name ?? 'this group')} and restart with a fresh provider context now?')">Save tiers</button>
</div>`;
  }

  // Read-only reference: full catalog (top of the leaderboard + this group's
  // tiers), so the operator can compare cost/intelligence while picking.
  // OpenRouter-backed OpenCode groups only — the catalog is irrelevant to native
  // subscription/auth providers such as XAI.
  let refHtml = '';
  if (isOpenCode && openCodeProvider === 'openrouter' && catalog) {
    const tierIds = new Set(tiers ? [tiers.high, tiers.medium, tiers.low] : []);
    const top = catalogByIntelligence(catalog).slice(0, 25);
    for (const id of tierIds) {
      const m = catalog.models.find((x) => x.id === id);
      if (m && !top.includes(m)) top.push(m);
    }
    const rows = top
      .map((m) => {
        const sel = tierIds.has(m.id) ? ' style="background:rgba(120,160,255,.10)"' : '';
        return `<tr${sel}><td>${esc(m.name)}</td><td class="small muted">${esc(m.id.replace(/^openrouter\//, ''))}</td><td>${esc(fmtScore(m.intelligenceIndex))}</td><td>${esc(fmtCost(m.promptCost))}</td><td>${esc(fmtCost(m.completionCost))}</td></tr>`;
      })
      .join('');
    const age = Math.round((Date.now() - catalog.fetchedAt) / 3_600_000);
    refHtml = `<details style="margin-top:10px"><summary class="muted small">Browse catalog — ${catalog.models.length} models, sorted by Intelligence Index, cost per 1M tokens (cached ${age}h ago)</summary>
<table><tr><th>model</th><th>id</th><th>Intelligence</th><th>in $/M</th><th>out $/M</th></tr>${rows}</table></details>`;
  }

  return `<div class="card" id="models"><h3>Models</h3>
<div class="kv"><span>provider <b>${esc(cfg?.provider === 'opencode' ? `opencode / ${openCodeProvider === 'xai' ? 'xAI (SuperGrok OAuth)' : 'OpenRouter'}` : (cfg?.provider ?? '–'))}</b></span><span>default model <b>${esc(nameFor(defaultModel))}</b></span></div>
${editorHtml}
${refHtml}</div>`;
}

/** Parse a container_configs JSON column into a string list of labels. */
function jsonLabels(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    if (Array.isArray(v)) {
      return v.map((e) =>
        typeof e === 'string'
          ? e
          : e && typeof e === 'object'
            ? String(e.containerPath ?? e.name ?? JSON.stringify(e))
            : String(e),
      );
    }
    if (v && typeof v === 'object') return Object.keys(v); // mcp_servers is a map
    return [];
  } catch {
    return [];
  }
}

/**
 * Labels for the container-build card's "extra mounts": show the host source
 * path (what the mount is mounted *from*) → the container path it lands at.
 */
function mountLabels(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    if (!Array.isArray(v)) return [];
    return v.map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') {
        const host = String(e.hostPath ?? e.host ?? '');
        const container = String(e.containerPath ?? e.name ?? '');
        if (host && container) return `${host} → ${container}`;
        return host || container || JSON.stringify(e);
      }
      return String(e);
    });
  } catch {
    return [];
  }
}

/**
 * "Container build" card for the per-group page: what the shared image is built
 * from (base, pinned CLIs, apt/pip) plus this group's per-group config, and
 * whether opt-in tools like rtk are active for THIS group.
 */
export function containerBuildCard(
  manifest: ImageBuildManifest,
  cfg: GroupConfigSnapshot | undefined,
  hooks: GroupRuntimeHooks,
  imageStatus?: ContainerImageStatus,
  latestRuntime?: RuntimeManifest | null,
  currentRuntimeFingerprint?: string | null,
): string {
  const rtkBaked = manifest.bakedTools.find((t) => t.name === 'rtk');
  const rtkCell = rtkBaked
    ? hooks.rtkActive
      ? `<span class="dot ok"></span> active <span class="muted small">${esc(rtkBaked.version)}</span>`
      : `<span class="dot warn"></span> installed · inactive <span class="muted small">no Bash hook</span>`
    : `<span class="muted">not installed</span> <span class="muted small">no arm64 build compatible with the base image</span>`;

  // Render items as pills; overflow past `max` stays reachable via an inline
  // <details> toggle instead of a static "+N", so every item is visible.
  const pill = (x: string): string => `<span class="pill">${esc(x)}</span>`;
  const chipsExpandable = (items: string[], max = 12): string => {
    if (!items.length) return '<span class="muted">none</span>';
    if (items.length <= max) return items.map(pill).join(' ');
    return (
      items.slice(0, max).map(pill).join(' ') +
      ` <details class="morechips"><summary class="muted small">+${items.length - max} more</summary> ` +
      items.slice(max).map(pill).join(' ') +
      '</details>'
    );
  };

  const tools = manifest.bakedTools
    .map((t) => `<tr><td>${esc(t.name)}</td><td class="small">${esc(t.version)}</td></tr>`)
    .join('');
  const py = manifest.pythonPackages
    .map((t) => `<tr><td>${esc(t.name)}</td><td class="small">${esc(t.version)}</td></tr>`)
    .join('');

  const apt = jsonLabels(cfg?.packages_apt);
  const npm = jsonLabels(cfg?.packages_npm);
  const mcp = jsonLabels(cfg?.mcp_servers);
  const mounts = mountLabels(cfg?.additional_mounts);

  const imageState = imageStatus
    ? imageStatus.state === 'current'
      ? `<span class="dot ok"></span><span class="state info">current</span>`
      : imageStatus.state === 'stale'
        ? `<span class="dot warn"></span><span class="state warn">delta</span>`
        : imageStatus.state === 'missing'
          ? `<span class="dot warn"></span><span class="state warn">missing</span>`
          : `<span class="dot warn"></span><span class="state warn">unavailable</span>`
    : '<span class="muted">not probed</span>';
  const imageProvenance = imageStatus
    ? `<div style="margin-top:10px"><div class="muted small">Deployment freshness · Docker image vs current checkout</div>
<table><tr><th></th><th>value</th></tr>
<tr><td>status</td><td>${imageState} <span class="muted small">${esc(imageStatus.reason)}</span></td></tr>
<tr><td>image tag</td><td><code>${esc(imageStatus.imageTag)}</code></td></tr>
<tr><td>repo build fingerprint</td><td><code>${esc(imageStatus.repoBuildFingerprint ? `${imageStatus.repoBuildFingerprint.slice(0, 16)}…` : '–')}</code></td></tr>
<tr><td>deployed image fingerprint</td><td><code>${esc(imageStatus.deployedBuildFingerprint ? `${imageStatus.deployedBuildFingerprint.slice(0, 16)}…` : '–')}</code></td></tr>
<tr><td>image id / digest</td><td><code>${esc(imageStatus.image?.id ?? '–')}</code>${imageStatus.image?.digest ? ` <span class="muted small">${esc(imageStatus.image.digest)}</span>` : ''}</td></tr>
<tr><td>created / size</td><td>${esc(imageStatus.image?.createdAt ? fmtTs(imageStatus.image.createdAt) : '–')} · ${esc(fmtBytes(imageStatus.image?.sizeBytes))}</td></tr>
</table>${imageStatus.delta ? `<p class="muted small">${esc(imageStatus.delta)}</p>` : ''}</div>`
    : '';
  const runtimeFreshness =
    latestRuntime?.runtime_fingerprint && currentRuntimeFingerprint
      ? latestRuntime.runtime_fingerprint === currentRuntimeFingerprint
        ? '<span class="dot ok"></span><b>runtime current</b>'
        : '<span class="dot warn"></span><b>runtime source delta</b>'
      : latestRuntime
        ? '<span class="dot"></span><b>runtime not comparable</b>'
        : '<span class="dot"></span><b>runtime not stamped</b>';
  const runtimeImageDelta =
    latestRuntime && imageStatus && latestRuntime.image !== imageStatus.imageTag
      ? ` <span class="dot warn"></span><span class="muted small">latest session used ${esc(latestRuntime.image)}, not the configured tag</span>`
      : '';
  const runtimeStamp = latestRuntime
    ? `<div class="muted small" style="margin-top:8px">${runtimeFreshness} · latest session stamp: <code>${esc(latestRuntime.image)}</code> · ${esc(fmtTs(latestRuntime.generated_at))}${latestRuntime.image_fingerprint ? ` · image fp <code>${esc(latestRuntime.image_fingerprint.slice(0, 16))}…</code>` : ''}${runtimeImageDelta}</div>`
    : '<div class="muted small" style="margin-top:8px">No runtime manifest found for this group yet.</div>';

  return `<div class="card" style="grid-column:1/-1"><h3>Container build</h3>
<p class="muted small">The shared agent image (<code>${esc(manifest.dockerfilePath)}</code>) plus this group's per-group config. Opt-in tools show whether they're active for <b>this</b> group.${manifest.error ? ` <span class="dot"></span>parse error: ${esc(manifest.error)}` : ''}</p>
<div class="kv">
<span>base image <b>${esc(manifest.baseImage ?? '–')}</b></span>
<span>provider <b>${esc(cfg?.provider ?? 'claude')}</b></span>
<span>model <b>${esc(shortModel(cfg?.model ?? 'default'))}</b></span>
<span>effort <b>${esc(cfg?.effort ?? '–')}</b></span>
<span>image tag <b>${esc(imageStatus?.imageTag ?? cfg?.image_tag ?? 'shared')}</b></span>
</div>
<div class="kv"><span>rtk <b>${rtkCell}</b></span></div>
<div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:6px">
<div><div class="muted small">Baked CLIs (shared image)</div><table><tr><th>tool</th><th>version</th></tr>${tools || '<tr><td colspan=2 class="muted">–</td></tr>'}</table></div>
<div><div class="muted small">Python runtime (shared image)</div><table><tr><th>package</th><th>version</th></tr>${py || '<tr><td colspan=2 class="muted">–</td></tr>'}</table></div>
</div>
<div class="muted small" style="margin-top:8px">System packages (shared image)</div>
<div>${chipsExpandable(manifest.aptPackages, 20)}</div>
<div class="muted small" style="margin-top:8px">This group's extras</div>
<div class="kv">
<span>apt <b>${apt.length}</b> ${apt.length ? `<span class="muted small">${esc(apt.join(', '))}</span>` : ''}</span>
<span>npm <b>${npm.length}</b> ${npm.length ? `<span class="muted small">${esc(npm.join(', '))}</span>` : ''}</span>
</div>
<div class="kv">
<span>MCP servers <b>${mcp.length}</b> ${mcp.length ? `<span class="muted small">${esc(mcp.join(', '))}</span>` : ''}</span>
<span>extra mounts <b>${mounts.length}</b> ${mounts.length ? `<span class="muted small">${esc(mounts.join(', '))}</span>` : ''}</span>
</div>
${imageProvenance}${runtimeStamp}
</div>`;
}

export interface ModelMixEntry {
  model: string;
  out: number; // total output tokens today (main + sub)
  subOut: number; // subagent-lane output tokens today
  subSpawns: number; // subagent_spawn count today
}

/** "168.8k↑ sonnet-4-6 main · 12k↑ haiku 3 subs · 2.0k↑ opus 1 sub" */
export function modelMixLine(mix: ModelMixEntry[]): string {
  if (!mix.length) return `<div class="kv"><span>model mix <b>–</b></span></div>`;
  const chips = mix
    .sort((a, b) => b.out - a.out)
    .map((m) => {
      const lane = m.subSpawns > 0 ? `${m.subSpawns} sub${m.subSpawns > 1 ? 's' : ''}` : 'main';
      const tip = `main ${fmtTokens(m.out - m.subOut)}↑ · subagents ${fmtTokens(m.subOut)}↑`;
      return `<span title="${esc(tip)}">${fmtTokens(m.out)}↑ ${esc(shortModel(m.model))} <span class="muted small">${lane}</span></span>`;
    })
    .join(' · ');
  return `<div class="kv"><span>model mix <b>${chips}</b></span></div>`;
}

/** Compact per-card skills summary: "all (18)" or "4/18 · trip-core, trip-finance …". */
export function skillsLine(s: GroupSkillsSummary): string {
  if (s.mode === 'all')
    return `<div class="kv"><span>skills <b>all</b> <span class="muted small">(${s.total})</span></span></div>`;
  const shown = s.enabledIds
    .slice(0, 5)
    .map((x) => esc(x))
    .join(', ');
  const more = s.enabledIds.length > 5 ? ` <span class="muted">+${s.enabledIds.length - 5}</span>` : '';
  const names = s.enabledIds.length ? ` · <span class="muted small">${shown}${more}</span>` : '';
  return `<div class="kv"><span>skills <b>${s.enabledIds.length}</b><span class="muted">/${s.total}</span>${names}</span></div>`;
}

/** Short label for an OpenRouter tier model id (drop the `openrouter/` prefix). */
function shortTierModel(id: string): string {
  return id.replace(/^openrouter\//, '');
}

/** Compact read-only card used by the live Overview fleet grid. */
export function fleetCard(g: GroupLive, x: GroupCardExtras): string {
  const id = esc(g.id);
  const lane = laneColor(g.id);
  const status = g.lifecycleStatus ?? (g.containersUp > 0 ? 'running' : 'idle');
  const statusDot = status === 'running' ? 'ok' : status === 'error' ? 'bad' : status === 'paused' ? 'warn' : '';
  const lifecycleAction = g.desiredState === 'paused' ? 'resume' : 'run';
  const lifecycleLabel = g.desiredState === 'paused' ? 'Resume' : 'Run';
  const lifecycleButtons =
    `<button class="lc-run" onclick="act('/api/group/${id}/${lifecycleAction}',{},'${lifecycleLabel} ${esc(g.name)}?')" title="${lifecycleLabel}">▶ ${lifecycleLabel}</button>` +
    `<button class="lc-stop" onclick="act('/api/group/${id}/stop',{confirm:'STOP'},'Stop ${esc(g.name)}? Future messages may wake it, but its current container will stop.')" title="Stop">■ Stop</button>` +
    `<button class="lc-pause" onclick="act('/api/group/${id}/pause',{confirm:'PAUSE'},'Pause ${esc(g.name)}? It will not wake for messages or schedules until resumed.')" title="Pause">Ⅱ Pause</button>`;
  const tokIn = x.tokensToday.reduce((sum, t) => sum + t.in, 0);
  const tokOut = x.tokensToday.reduce((sum, t) => sum + t.out, 0);
  const rStat = ribbonStat(x.spans, x.nowMs, x.compactionsToday);
  const delegated = x.mix
    .filter((m) => m.subSpawns > 0)
    .sort((a, b) => b.subOut - a.subOut)
    .map((m) => shortModel(m.model))
    .slice(0, 2);
  const b = (s: string) => `<b>${esc(s)}</b>`;
  const shortTier = (m: string) => shortModel(shortTierModel(m));
  const channelNames: Record<string, string> = { telegram: 'TG', whatsapp: 'WA', cli: 'CLI', agent: 'A2A' };
  const channelCounts = new Map<string, number>();
  for (const w of x.wirings) {
    const channel = w.channel_type ?? 'chat';
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
  }
  const channelsHtml =
    [...channelCounts.entries()]
      .map(([channel, count]) => `${b(channelNames[channel] ?? channel)} ${count}`)
      .join(' · ') || 'none';
  const chat = x.wirings.filter((w) => !NON_CHAT_CHANNELS.has(w.channel_type ?? ''));
  const modes = [...new Set(chat.map((w) => matchPreset(w) ?? w.engage_mode).filter(Boolean))]
    .map((mode) => String(mode).replace('context', 'context-aware'))
    .join(' + ');
  const voiceOn = chat.filter((w) => w.voice_transcription !== 'off').length;
  const skillsHtml =
    x.skills.mode === 'all'
      ? `${b('all')} ${x.skills.total}`
      : `${b(String(x.skills.enabledIds.length))} / ${x.skills.total}`;
  const latest = g.currentTool
    ? `current tool · ${g.currentTool}`
    : x.subagentTicks.length
      ? `latest subagent · ${shortModel(x.subagentTicks[x.subagentTicks.length - 1].model)}`
      : g.unanswered > 0
        ? `${g.unanswered} unanswered`
        : 'no active tool';
  const recallsTip =
    x.recalls == null
      ? 'no memory store'
      : `${x.recalls} recalls all-time${x.recallHitRate != null ? ` · ${Math.round(x.recallHitRate * 100)}% hit-rate` : ''}`;
  const recallsHero = x.recalls == null ? '–' : String(x.recalls);
  const recallsSub =
    x.recalls == null
      ? 'no memory'
      : x.recallHitRate != null
        ? `${Math.round(x.recallHitRate * 100)}% hit-rate`
        : 'all-time';
  const p95Hero =
    x.latencyP95ProxyMs == null ? '–' : fmtAge(x.latencyP95ProxyMs).replace(/([a-z]+)$/i, '<span class="u">$1</span>');
  const p95Tip =
    x.latencyP95ProxyMs == null
      ? 'no latency samples yet'
      : `p95 of per-minute latency maxima over ${x.sloWindowDays}d — the SLO latency proxy`;
  // Top zone (activity): four hero metrics on a raised strip. msgs keeps its live
  // in/out spans; tokens is the day total + breakdown; p95 is the SLO latency proxy
  // (per-minute maxima, populated for every group); recalls is memory count + hit-rate.
  const heroHtml =
    `<div class="fc-hc"><span class="k">msgs</span><span class="v"><span id="g-${id}-in">${g.todayIn}</span><span class="s">/</span><span id="g-${id}-out">${g.todayOut}</span></span><span class="sub">in / out</span></div>` +
    `<div class="fc-hc"><span class="k">tokens</span><span class="v">${esc(fmtCompact(tokIn + tokOut))}</span><span class="sub">${esc(fmtTokens(tokIn))}↓ ${esc(fmtTokens(tokOut))}↑</span></div>` +
    `<div class="fc-hc p95" title="${esc(p95Tip)}"><span class="k">p95</span><span class="v">${p95Hero}</span><span class="sub">latency · ${x.sloWindowDays}d</span></div>` +
    `<div class="fc-hc" title="${esc(recallsTip)}"><span class="k">recalls</span><span class="v">${esc(recallsHero)}</span><span class="sub">${esc(recallsSub)}</span></div>`;
  // Senders band — who messaged in the last 24h + an amber flag for allowlist-unknowns.
  const sendersBand = (() => {
    const s = x.senders;
    if (!s || s.unique === 0)
      return `<div class="fc-senders"><span class="k">senders</span><span class="none">none in 24h</span></div>`;
    const who = s.top
      .map((t) => `<b>${esc(t.name)}</b> <span class="ch">${esc(channelNames[t.channel] ?? t.channel)}</span>`)
      .join(' · ');
    const more = s.unique > s.top.length ? ` <span class="more">+${s.unique - s.top.length}</span>` : '';
    const unknown = s.unknown > 0 ? `<span class="unk">${s.unknown} unknown</span>` : '';
    return `<div class="fc-senders"><span class="k">senders</span><span class="who">${who}${more}</span>${unknown}<span class="cnt"><b>${s.unique}</b> · 24h</span></div>`;
  })();
  // Bottom zone (configuration), as chips: model (+ delegated) · tiers · channels ·
  // engage modes · voice · skills. The live-updated model span (id `g-<id>-model`)
  // rides inside the model chip.
  const chips = [
    `<span class="fc-chip"><span class="mk">model</span><b><span id="g-${id}-model">${esc(shortModel(g.model ?? '–'))}</span></b></span>`,
  ];
  if (delegated.length)
    chips.push(`<span class="fc-chip">+${esc(delegated.join(' + '))} <span class="mk">deleg</span></span>`);
  if (g.modelTiers)
    chips.push(
      `<span class="fc-chip"><span class="mk">tiers</span><b>${esc(shortTier(g.modelTiers.high))}</b>·<b>${esc(shortTier(g.modelTiers.medium))}</b>·<b>${esc(shortTier(g.modelTiers.low))}</b></span>`,
    );
  chips.push(`<span class="fc-chip">${channelsHtml}</span>`);
  if (chat.length) {
    if (modes) chips.push(`<span class="fc-chip">${esc(modes)}</span>`);
    chips.push(`<span class="fc-chip"><span class="mk">voice</span><b>${voiceOn}/${chat.length}</b></span>`);
  }
  if (x.template?.status === 'ready') {
    const label = x.template.ref?.split('/').pop() ?? 'attached';
    const app = x.template.opsCenterLabel ? ` · ${x.template.opsCenterLabel}` : '';
    chips.push(
      `<span class="fc-chip" title="Live source-backed template · ${esc(x.template.ref ?? 'attached')}"><span class="mk">template</span><b>${esc(label)}</b> · ${x.template.skillCount} skills${esc(app)}</span>`,
    );
  } else if (x.template?.status === 'error') {
    chips.push(
      `<span class="fc-chip" title="Template reference could not be resolved" style="color:var(--warn)"><span class="mk">template</span><b>error</b></span>`,
    );
  }
  chips.push(`<span class="fc-chip"><span class="mk">skills</span>${skillsHtml}</span>`);
  const chipsHtml = chips.join('');
  return `<article class="fc-card" style="--lane:${lane}">
<header class="fc-head"><span class="fc-lz"><i class="dot ${statusDot}" id="g-${id}-dot"></i><b class="fc-cstat" id="g-${id}-cstat" title="${esc(g.lifecycleError ?? '')}">${esc(status)}</b></span><a class="fc-open" href="/group/${id}" title="Open ${esc(g.name)} — config, skills, journeys"><span class="fc-id"><span class="fc-name">${esc(g.name)}</span><span class="fc-route">${esc(x.routingName)}</span></span><span class="fc-arr">↗</span></a><span class="fc-actions">${lifecycleButtons}<button onclick="act('/api/group/${id}/restart',{},'Restart ${esc(g.name)}? Running containers stop; they come back on the next message.')" title="Restart">⟳</button><button onclick="act('/api/group/${id}/restart',{rebuild:true},'Restart ${esc(g.name)} with image REBUILD? This is slow (minutes).')" title="Rebuild">↻</button><button class="lc-fresh" aria-label="Restart fresh" onclick="act('/api/group/${id}/restart',{fresh:true},'Restart ${esc(g.name)} with a fresh context? This interrupts in-flight work and clears the provider context for running sessions.')" title="Restart fresh"><svg class="lc-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1 4"></path><path d="M20 5v6h-6"></path><path d="M7 3.5v4M5 5.5h4"></path></svg></button></span></header>
<div class="fc-top">
<div class="fc-vitals"><span class="m"><i id="g-${id}-sessions">${g.sessions}</i> sessions</span><span class="sep">·</span><span class="m">q<i id="g-${id}-queue">${g.queueDepth}</i></span><span class="sep">·</span><span class="m"><i id="g-${id}-inflight">${g.inflight}</i> inflight</span><span class="hb">♥ <span id="g-${id}-heartbeat">${g.minHeartbeatAgeMs != null ? fmtAge(g.minHeartbeatAgeMs) : '–'}</span></span></div>
<div class="fc-hero">${heroHtml}</div>
<div class="fc-ribbon"><div class="rb-cap"><span class="lbl">24h activity</span><span class="rb-stat">${esc(rStat)}</span></div>${activityRibbon(x.spans, x.subagentTicks, { w: 330, nowMs: x.nowMs, ariaLabel: `container activity, 24h · ${rStat}` })}</div>
${sendersBand}
</div>
<div class="fc-cfg"><span class="fc-zlab">configuration</span><div class="fc-chips">${chipsHtml}</div></div>
<footer class="fc-foot"><span class="latest">${esc(latest)}</span></footer>
</article>`;
}

export function shortModel(m: string): string {
  // OpenRouter/OpenCode ids are `vendor/family/model` (e.g. openrouter/anthropic/claude-3.7-sonnet);
  // show just the model leaf so they don't overflow the card. Native ids have no slash.
  const leaf = m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m;
  return leaf.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/**
 * System / Machine status panel — two cards for the /system page.
 *
 * Card 1 ("Machine · server") is the SERVER's own health: host vitals, disk,
 * Docker, the two launchd services, OneCLI, and the loopback listener.
 *
 * Card 2 ("Remote access · browser ⇄ server") deliberately keeps two perspectives
 * apart. The *client check* (measured in the viewer's browser) is the
 * authoritative tunnel test and is shown first. The *server view* is a caveated
 * "a client reached the local listener" signal — it never claims the tunnel is
 * healthy just because the listener is bound.
 *
 * The card is a static skeleton; values are filled by {@link machinePanelScript}
 * via textContent (never innerHTML), so probe output can't inject markup.
 */
export function machineCard(): string {
  return `<div class="card">
<h3>Machine · <b id="sys-host-label">server</b> <span class="muted small">(server)</span></h3>
<p class="muted small">Read-only vitals for the machine running NanoClaw + Ops Center. Refreshes every ~10s; probes are timeout-bounded so a stuck tool can't hang this panel.</p>
<table>
<tr><td>host</td><td><b id="sys-host-name">…</b> · <span id="sys-os">…</span></td></tr>
<tr><td>platform</td><td><span id="sys-arch">…</span> · <span class="muted" id="sys-kernel">…</span></td></tr>
<tr><td>uptime</td><td id="sys-uptime">…</td></tr>
<tr><td>CPU</td><td><i class="dot" id="sys-load-dot"></i><span id="sys-load">…</span></td></tr>
<tr><td class="muted small" id="sys-cpu-model">…</td><td class="muted small" id="sys-cpu-cores">…</td></tr>
<tr><td>top CPU process</td><td><i class="dot" id="sys-cpu-top-dot"></i><span id="sys-cpu-top">…</span></td></tr>
<tr><td>RAM</td><td><i class="dot" id="sys-mem-dot"></i><span id="sys-mem">…</span></td></tr>
<tr><td>memory pressure</td><td><i class="dot" id="sys-memory-pressure-dot"></i><span id="sys-memory-pressure">…</span></td></tr>
<tr><td>disk</td><td><i class="dot" id="sys-fs-dot"></i><span id="sys-fs">…</span></td></tr>
<tr><td></td><td class="muted small" id="sys-nc-disk">…</td></tr>
<tr><td>Docker</td><td><i class="dot" id="sys-docker-dot"></i><span id="sys-docker">…</span></td></tr>
<tr><td>Docker memory</td><td id="sys-docker-mem">…</td></tr>
<tr><td>NanoClaw service</td><td><i class="dot" id="sys-nanoclaw-dot"></i><span id="sys-nanoclaw">…</span></td></tr>
<tr><td>Ops Center service</td><td><i class="dot" id="sys-ops-dot"></i><span id="sys-ops">…</span></td></tr>
<tr><td>OneCLI</td><td><i class="dot" id="sys-onecli-dot"></i><span id="sys-onecli">…</span></td></tr>
<tr><td>Ops listener</td><td><i class="dot" id="sys-listener-dot"></i><span id="sys-listener">…</span></td></tr>
<tr><td>Ops Center responsiveness</td><td><i class="dot" id="sys-runtime-lag-dot"></i><span id="sys-runtime-lag">…</span></td></tr>
<tr><td>Mission / queue</td><td><i class="dot" id="sys-mission-dot"></i><span id="sys-mission">…</span></td></tr>
</table>
<p class="muted small">updated <span id="sys-updated">–</span> <span id="sys-probe-errs" style="color:var(--warn)"></span></p></div>
<div class="card">
<h3>Remote access · <b>browser ⇄ server</b></h3>
<p class="muted small">The listener above is bound to loopback on the server. This card checks the browser path through the configured Tailscale/SSH frontend. <b>Listening locally is not the same as a healthy remote path</b> — these two checks are kept separate on purpose.</p>
<div style="margin-top:8px">
<div class="kv"><span><i class="dot" id="sys-tun-cli-dot"></i><b>browser → server · client check</b></span></div>
<div class="small" id="sys-tun-cli">checking from this browser…</div>
<div class="muted small">Measured in this browser. The round-trip is the authoritative test of the remote frontend path.</div>
</div>
<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line,#2a3542)">
<div class="kv"><span><i class="dot" id="sys-tun-srv-dot"></i><b>server listener · server view</b></span></div>
<div class="small" id="sys-tun-srv">…</div>
<div class="muted small" id="sys-tun-note">Server-side signal only — reflects that a client reached the local listener, not that the remote frontend path is up.</div>
</div></div>`;
}

/**
 * Non-secret provider-auth planning card. The dates come from the explicit SSH
 * re-auth scripts, not from reading credential values. That distinction is
 * visible in the copy so an estimated Claude date is not mistaken for a live
 * provider introspection result, and the Pi-owned XAI credential is not
 * mistaken for a OneCLI secret.
 */
export function providerAuthCard(status: ProviderAuthStatus, now = Date.now()): string {
  const row = (label: string, auth: ProviderAuthRecord | null, command: string): string => {
    const state = providerAuthState(auth, now);
    const dot = state === 'expired' ? 'bad' : state === 'soon' ? 'warn' : auth ? 'ok' : '';
    let expiry = 'not recorded yet';
    if (auth && state === 'provider-managed') {
      expiry = 'provider-managed · no fixed expiry shown';
    } else if (auth && state === 'no-known-expiry') {
      expiry = 'no provider expiry recorded';
    } else if (auth?.expiresAt) {
      const days = providerAuthDaysRemaining(auth, now);
      expiry = `${auth.expiryMode === 'estimated' ? 'estimated ' : ''}${fmtTs(auth.expiresAt)}`;
      if (days != null) expiry += days < 0 ? ` · expired ${Math.abs(days)}d ago` : ` · ${days}d remaining`;
    }
    const statusText = auth
      ? state === 'expired'
        ? `reauthentication needed · ${expiry}`
        : expiry
      : 'run the script once to start tracking';
    return `<tr><td><i class="dot ${dot}"></i><b>${esc(label)}</b></td><td>${esc(statusText)}</td><td class="small">${
      auth ? `last refreshed ${esc(fmtTs(auth.refreshedAt))} · ${esc(auth.method)}` : 'no refresh receipt found'
    }</td><td><code>${esc(command)}</code></td></tr>`;
  };

  return `<div class="card" style="grid-column:1/-1"><h3>Provider authentication expiry</h3>
<p class="muted small">Planning information for the credentials used by NanoClaw through OneCLI and provider-owned state. Claude's date is an estimate based on the documented one-year <code>setup-token</code> lifetime. Codex and XAI are provider-managed because their credentials refresh through their provider harnesses and have no simple fixed expiry in this workflow. OpenRouter is an API-key connectivity receipt, not OAuth.</p>
<table><tr><th>provider</th><th>next expiry</th><th>last refresh</th><th>SSH command</th></tr>
${row('Claude', status.claude, './scripts/reauth-claude.sh')}
${row('Codex', status.codex, './scripts/reauth-codex.sh')}
${row('XAI / Grok', status.xai, './scripts/reauth-xai.sh')}
${row('OpenRouter', status.openrouter, './scripts/reauth-openrouter.sh --check')}
</table>
<p class="muted small">The scripts record timestamps only in <code>data/provider-auth-status.json</code>. Claude/Codex/OpenRouter credentials remain in OneCLI; XAI's OAuth credential remains in Pi's private group state. Existing credentials show “not recorded yet” until refreshed with the scripts.</p></div>`;
}

/**
 * Optional host recovery controls. Any recovery work is launched only through
 * a locally configured script; the browser sees a non-secret state file and
 * post-check report.
 */
export function recoveryCard(status: RecoveryStatus): string {
  const state = status.state;
  const report = status.report;
  const summary = state ? `${state.phase} · ${state.message}` : 'no recovery job has run on this host';
  const reportSummary = report
    ? `${report.overall.toUpperCase()} · ${report.failures} failure(s), ${report.warnings} warning(s) · ${fmtTs(report.finishedAt)}`
    : 'no post-check report yet';
  return `<div class="card" style="grid-column:1/-1"><h3>Host recovery</h3>
<p class="muted small">Clean recovery path for this installation. Ops Center runs as a non-admin service, so it cannot prompt for the administrator password needed to reboot the host. Use your platform's administrator recovery path if the host needs a reboot. Stopping Docker Desktop also affects other Docker workloads on this machine.</p>
<div class="kv"><span>job <b id="recovery-job">${esc(state?.jobId ?? '–')}</b></span><span>phase <b id="recovery-phase">${esc(summary)}</b></span></div>
<div class="kv small muted" style="margin-top:6px"><span>last report <b id="recovery-report">${esc(reportSummary)}</b></span></div>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
<button onclick="act('/api/system/recovery/recover',{},'Start runtime recovery and a runtime-only post-check?')">Recover runtime + check</button>
<button onclick="act('/api/system/recovery/postcheck',{},'Run the full read-only system and provider post-check now?')">Run full post-check</button>
</div>
<p class="muted small" style="margin-top:10px">Recovery is optional and installation-specific. This public checkout does not ship a privileged recovery script. Configure <code>NANOCLAW_RECOVERY_SCRIPT</code> only after reviewing a fixed local script and its permissions.</p>
<p class="muted small">report <code id="recovery-report-path">${esc(state?.reportPath ?? '–')}</code> · log <code id="recovery-log-path">${esc(state?.logPath ?? '–')}</code></p></div>`;
}

export function recoveryPanelScript(): string {
  return `(function(){
  var POLL=5000;
  function $(id){return document.getElementById(id)}
  function set(id,v){var el=$(id);if(el&&v!=null)el.textContent=v}
  function fmt(ts){if(!ts)return '–';try{return new Date(ts).toLocaleString()}catch(e){return ts}}
  function refresh(){fetch('/api/system/recovery/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){
    var st=s.state, rp=s.report;
    set('recovery-job',st?st.jobId:'–');
    set('recovery-phase',st?(st.phase+' · '+st.message):'no recovery job has run on this host');
    set('recovery-report',rp?(rp.overall.toUpperCase()+' · '+rp.failures+' failure(s), '+rp.warnings+' warning(s) · '+fmt(rp.finishedAt)):'no post-check report yet');
    set('recovery-report-path',st&&st.reportPath?st.reportPath:'–');
    set('recovery-log-path',st&&st.logPath?st.logPath:'–');
  }).catch(function(){});}
  refresh();
  if(!window.__recoveryTimer)window.__recoveryTimer=setInterval(refresh,POLL);
})();`;
}

/**
 * Self-contained client script for {@link machineCard}. Kept independent of the
 * shared CLIENT_JS (which layout() injects after the page body) so load order
 * can't break it: it defines its own tiny helpers, patches by id via textContent,
 * and runs on its own slow timer — decoupled from the 3s SSE lane so the weak
 * host is never hammered.
 *
 * The remote-path verdict is driven by the browser's own reachability ping (the
 * authoritative client check); the server view is rendered from the caveated
 * heartbeat state and never upgraded to "healthy" on the client's behalf.
 *
 * Written with quotes + concatenation only (no backticks / no ${'$'}{...}) so it
 * embeds verbatim inside a <script> tag without escaping surprises.
 */
export function machinePanelScript(): string {
  return `(function(){
  var POLL=10000;
  function $(id){return document.getElementById(id)}
  function set(id,v){var el=$(id);if(el&&v!=null)el.textContent=v}
  function dot(id,cls){var el=$(id);if(el)el.className='dot '+cls}
  function fmtB(n){if(n==null)return '–';n=+n;var u=['B','KB','MB','GB','TB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return (i?n.toFixed(1):Math.round(n))+' '+u[i]}
  function fmtAge(ms){if(ms==null)return '–';var s=Math.round(ms/1000);if(s<60)return s+'s';var m=Math.round(s/60);if(m<60)return m+'m';var h=m/60;if(h<24)return h.toFixed(1)+'h';return (h/24).toFixed(1)+'d'}
  function fmtUp(sec){if(sec==null)return '–';sec=+sec;var d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60);return (d?d+'d ':'')+(h?h+'h ':'')+m+'m'}
  function fmtMs(ms){if(ms==null)return '–';ms=+ms;return ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(1)+' s'}
  function pct(p){return (p==null)?'':(' ('+p+'%)')}
  function usageCls(p){return p==null?'':(p<80?'ok':(p<92?'warn':'bad'))}
  function cpuTopCls(p){return p==null?'':(p>=180?'bad':(p>=85?'warn':'ok'))}
  function pressureCls(p){return !p?'':(p.level==='critical'?'bad':p.level)}
  function runtimeCls(r){if(!r)return '';var lag=+r.eventLoopLagMs||0,probe=+r.probeDurationMs||0;return lag>=500||probe>=3000?'bad':(lag>=100||probe>=1000?'warn':'ok')}
  function missionCls(m){return !m?'':(m.state==='critical'?'bad':(m.state==='warn'||m.state==='stale'?'warn':(m.state==='ok'?'ok':'')))}
  function svcTxt(s){return s.running?('running · pid '+s.pid):(s.loaded?'loaded, not running':(s.label?'stopped':'not installed'))}
  function svcCls(s){return s.running?'ok':(s.loaded?'warn':'bad')}
  function refreshStatus(){
    fetch('/api/system/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){
      set('sys-host-name',s.host.hostname);
      set('sys-host-label',s.host.hostname || 'server');
      set('sys-os',(s.host.osName||s.host.platform)+(s.host.osBuild?(' · '+s.host.osBuild):''));
      set('sys-arch',s.host.arch);
      set('sys-kernel','kernel '+s.host.kernel);
      set('sys-uptime',fmtUp(s.host.uptimeSec));
      set('sys-cpu-model',s.host.cpu.model||'CPU');
      set('sys-cpu-cores',s.host.cpu.cores+' cores');
      set('sys-load','load '+s.host.cpu.loadAvg.map(function(x){return (+x).toFixed(2)}).join(' / ')+(s.host.cpu.loadPct!=null?(' · '+s.host.cpu.loadPct+'%'):''));
      dot('sys-load-dot',usageCls(s.host.cpu.loadPct));
      var tp=s.host.cpu.topProcess;
      dot('sys-cpu-top-dot',cpuTopCls(tp&&tp.cpuPct));
      set('sys-cpu-top',tp?(tp.command+' · pid '+tp.pid+' · '+(+tp.cpuPct).toFixed(1)+'% CPU'):'unavailable');
      set('sys-mem',fmtB(s.host.mem.usedBytes)+' / '+fmtB(s.host.mem.totalBytes)+pct(s.host.mem.usedPct));
      dot('sys-mem-dot',usageCls(s.host.mem.usedPct));
      var mp=s.host.memoryPressure;
      dot('sys-memory-pressure-dot',pressureCls(mp));
      set('sys-memory-pressure',mp?(mp.freePct!=null?('free '+(+mp.freePct).toFixed(0)+'% · '+mp.source):('stall '+(+mp.stallPct10).toFixed(1)+'% avg10 · '+mp.source)):'unavailable');
      if(s.disk.fs){set('sys-fs',fmtB(s.disk.fs.usedBytes)+' / '+fmtB(s.disk.fs.totalBytes)+pct(s.disk.fs.usedPct)+' · '+s.disk.fs.mount);dot('sys-fs-dot',usageCls(s.disk.fs.usedPct))}
      else{set('sys-fs','unavailable');dot('sys-fs-dot','warn')}
      set('sys-nc-disk',s.disk.nanoclaw?('NanoClaw data '+fmtB(s.disk.nanoclaw.totalBytes)):'');
      dot('sys-docker-dot',s.docker.daemonUp?'ok':'bad');
      set('sys-docker',s.docker.daemonUp?(s.docker.containerCount+' container(s) up'):(s.docker.available?'daemon down':'docker unavailable'));
      var dm=[];if(s.docker.containersMemBytes!=null)dm.push(fmtB(s.docker.containersMemBytes)+' containers');if(s.docker.vmMemTotalBytes!=null)dm.push(fmtB(s.docker.vmMemTotalBytes)+' VM');set('sys-docker-mem',dm.length?dm.join(' · '):'–');
      dot('sys-nanoclaw-dot',svcCls(s.services.nanoclaw));set('sys-nanoclaw',svcTxt(s.services.nanoclaw));
      dot('sys-ops-dot',svcCls(s.services.opsCenter));set('sys-ops',svcTxt(s.services.opsCenter));
      dot('sys-onecli-dot',s.onecli.up?'ok':'bad');set('sys-onecli',(s.onecli.up?'healthy':'unreachable')+' · '+(s.onecli.local?'local':'remote'));
      dot('sys-listener-dot',s.listener.bound?'ok':'bad');set('sys-listener',(s.listener.bound?'listening':'not bound')+' on '+s.listener.address+':'+s.listener.port+' · pid '+s.listener.pid);
      dot('sys-runtime-lag-dot',runtimeCls(s.runtime));
      set('sys-runtime-lag','event loop '+fmtMs(s.runtime&&s.runtime.eventLoopLagMs)+' · probe '+fmtMs(s.runtime&&s.runtime.probeDurationMs));
      var m=s.mission;
      dot('sys-mission-dot',missionCls(m));
      if(m){var mi=['queue '+m.queueDepth,'in flight '+m.inflight];if(m.unanswered>0)mi.push(m.unanswered+' unanswered');if(m.latencyMsMax!=null)mi.push('max reply '+fmtAge(m.latencyMsMax));mi.push('sample '+fmtAge(m.sampleAgeMs)+' ago');set('sys-mission',mi.join(' · '))}else set('sys-mission','unavailable');
      var st=s.tunnel.serverSideState;
      dot('sys-tun-srv-dot',st==='recent-client-contact'?'ok':(st==='stale-client-contact'?'warn':''));
      set('sys-tun-srv',st==='no-client-contact'?'No client has reached the listener this session.':('A client reached the listener '+fmtAge(s.tunnel.lastClientContactAgeMs)+' ago.'));
      if(s.tunnel.note)set('sys-tun-note',s.tunnel.note);
      set('sys-updated',new Date().toLocaleTimeString());
      set('sys-probe-errs',(s.probeErrors&&s.probeErrors.length)?(' · degraded: '+s.probeErrors.join(', ')):'');
    }).catch(function(){});
  }
  function pingTunnel(){
    var t0=(window.performance&&performance.now)?performance.now():Date.now();
    var ctrl=('AbortController' in window)?new AbortController():null;
    var to=ctrl?setTimeout(function(){ctrl.abort()},5000):null;
    fetch('/api/system/tunnel-ping',{cache:'no-store',signal:ctrl?ctrl.signal:undefined}).then(function(r){
      if(to)clearTimeout(to);
      if(!r.ok)throw new Error('http '+r.status);
      return r.json();
    }).then(function(){
      var rtt=Math.round(((window.performance&&performance.now)?performance.now():Date.now())-t0);
      dot('sys-tun-cli-dot',rtt<250?'ok':(rtt<1500?'warn':'bad'));
      set('sys-tun-cli','Reachable from this browser · round-trip '+rtt+' ms → tunnel is up.');
    }).catch(function(){
      if(to)clearTimeout(to);
      dot('sys-tun-cli-dot','bad');
      set('sys-tun-cli','This browser cannot reach the Ops Center endpoint → remote path appears down.');
    });
  }
  function tick(){refreshStatus();pingTunnel()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',tick);else tick();
  if(!window.__sysTimer)window.__sysTimer=setInterval(tick,POLL);
})();`;
}
