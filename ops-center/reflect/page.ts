/**
 * Read-only Ops Center view of the deterministic reflection digest.
 *
 * The only action is an explicit, authenticated read-only digest run. There are
 * no proposal rows, mutation controls, or background jobs.
 */
import type Database from 'better-sqlite3';

import { esc } from '../ui.js';
import { buildEvidencePack } from './digest.js';
import { getLatestReflectRun } from './ops-run.js';
import { listAgentGroups } from '../readers/central.js';
import { computeSignals, type Signal } from './signals.js';
import { reflectRunScript } from './system-card.js';

const severityClass = (severity: Signal['severity']): string =>
  severity === 'high' ? 'err' : severity === 'medium' ? 'warn' : 'dim';

function numberFlag(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 30 ? value : fallback;
}

const money = (value: number | null): string => (value == null ? '–' : `$${value.toFixed(4)}`);
const pct = (value: number | null): string => (value == null ? '–' : `${(value * 100).toFixed(0)}%`);

function signalCard(signal: Signal): string {
  return `<div class="card rf-signal">
<div class="kv">
  <span class="badge ${severityClass(signal.severity)}">${esc(signal.severity.toUpperCase())}</span>
  <span>${esc(signal.lane)} · ${esc(signal.scope)}</span>
</div>
<h3>${esc(signal.title)}</h3>
<ul class="small">${signal.evidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
${signal.exhibitIds?.length ? `<p class="small"><b>Exhibits:</b> ${signal.exhibitIds.map((id) => `<a href="#rf-exhibit-${esc(id)}">${esc(id)}</a>`).join(', ')}</p>` : ''}
${signal.improvementIds?.length ? `<p class="small"><b>Prior history:</b> ${signal.improvementIds.map((id) => `<a href="#rf-improvement-${esc(id)}">${esc(id)}</a>`).join(', ')}</p>` : ''}
${signal.evidenceLimitations?.map((item) => `<p class="small warn">${esc(item)}</p>`).join('') ?? ''}
<p class="small muted"><b>Inspect next:</b> ${esc(signal.next)}</p>
</div>`;
}

export function reflectBody(opsDb: Database.Database, params: URLSearchParams): string {
  const days = numberFlag(params.get('days'), 7);
  const groupId = params.get('group')?.trim() || undefined;
  const pack = buildEvidencePack(opsDb, { windowDays: days, groupId });
  const signals = computeSignals(pack);
  const fleet = pack.fleet;
  let groups: { id: string; name: string }[] = [];
  try {
    groups = listAgentGroups().map((group) => ({ id: group.id, name: group.name }));
  } catch {
    // The digest already reports central-data availability; keep the page usable.
  }
  const knownGroup = groupId && groups.some((group) => group.id === groupId);
  const groupOptions = [
    '<option value="">all groups</option>',
    ...(groupId && !knownGroup
      ? [`<option value="${esc(groupId)}" selected>unknown group: ${esc(groupId)}</option>`]
      : []),
    ...groups.map(
      (group) =>
        `<option value="${esc(group.id)}"${group.id === groupId ? ' selected' : ''}>${esc(group.name)}</option>`,
    ),
  ].join('');
  const latest = getLatestReflectRun();
  const latestCard = latest.pack
    ? `<div class="card rf-latest"><h3>Last saved Ops Center run</h3><p class="small muted">${esc(latest.finishedAt ?? 'unknown time')} · ${latest.windowDays} day(s) · ${esc(latest.groupId ?? 'fleet')} · ${latest.snapshotSaved ? 'loaded from data/reflect-latest.json' : 'snapshot unavailable'}</p><div class="kv small"><span>${esc(latest.pack.health.complete ? 'evidence complete' : 'partial evidence')}</span><span>${latest.pack.fleet.outcomes.working} working · ${latest.pack.fleet.outcomes.ok} ok · ${latest.pack.fleet.outcomes.degraded} degraded · ${latest.pack.fleet.outcomes.failed} failed</span><span>${latest.signals.length} signal(s)</span></div></div>`
    : '<div class="card rf-latest"><h3>Last saved Ops Center run</h3><p class="small muted">No saved run yet. Use the button above to run /reflect and save a summary.</p></div>';

  const health = pack.health.complete
    ? `<div class="card rf-health rf-good"><h3>Evidence complete</h3><p class="small muted">All required sources were readable. An empty signal list is a valid no-action result.</p></div>`
    : `<div class="card rf-health rf-bad"><h3>Partial evidence</h3>
       <p class="small">Silence is not a health verdict while a source is empty or unavailable.</p>
       <ul class="small">${pack.health.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul></div>`;

  const groupCards = pack.groups.length
    ? pack.groups
        .map(
          (group) => `<div class="card">
<h3>${esc(group.name)}</h3>
<div class="kv"><span>working <b>${group.outcomes.working}</b></span><span>ok <b>${group.outcomes.ok}</b></span><span>degraded <b>${group.outcomes.degraded}</b></span><span>failed <b>${group.outcomes.failed}</b></span></div>
<div class="kv"><span>per priced workflow <b>${money(group.costPerWorkingTurn)}</b></span><span>per successful result <b>${money(group.costPerSuccessfulResult)}</b></span></div>
<div class="kv"><span>cache <b>${pct(group.medianCacheHitRatio)}</b></span><span>compactions/workflow <b>${group.compactionsPerWorkingTurn?.toFixed(2) ?? '–'}</b></span><span>ctx edits/workflow <b>${group.contextEditsPerWorkingWorkflow?.toFixed(2) ?? '–'}</b></span><span>median context <b>${group.medianContextTokens?.toLocaleString() ?? '–'}</b> (${group.contextObservations} observed)</span></div>
${group.unpricedTurns ? `<p class="small warn">${group.unpricedTurns} unpriced working workflow(s); complete cost ratios are withheld.</p>` : ''}
</div>`,
        )
        .join('')
    : '<div class="card empty"><p class="muted small">No groups have settled working workflows in this window.</p></div>';

  const signalCards = signals.length
    ? signals.map(signalCard).join('')
    : `<div class="card empty"><p class="muted small">${
        pack.health.complete
          ? 'Nothing crossed a conservative reporting threshold. No action is indicated.'
          : 'No signals were computed, but the evidence is partial; this is not a health verdict.'
      }</p></div>`;

  const exhibits = pack.exhibits.length
    ? `<div class="cards rf-grid">${pack.exhibits
        .map(
          (exhibit) => `<div class="card" id="rf-exhibit-${esc(exhibit.id)}">
<div class="kv"><span class="badge ${exhibit.outcome === 'failed' ? 'err' : exhibit.outcome === 'degraded' ? 'warn' : 'ok'}">${esc(exhibit.outcome)}</span><span>${esc(exhibit.groupId)} · phases ${exhibit.turnIndexes.join(', ')}</span><span>${money(exhibit.costUsd)}</span></div>
<p class="small">${esc(exhibit.intent || '(no intent preview)')}</p>
<p class="small muted">tools: ${esc(exhibit.toolSequence.join(' → ') || 'none')}</p>
<p class="small muted">${exhibit.recoveredErrors} recovered / ${exhibit.unresolvedErrors} unresolved error(s) · response evidence: ${esc(exhibit.responseEvidence)}</p>
${exhibit.redundant.length ? `<p class="small warn">repeated: ${esc(exhibit.redundant.map((item) => `${item.key} ×${item.count}`).join(', '))}</p>` : ''}
</div>`,
        )
        .join('')}</div>`
    : '<div class="card empty"><p class="muted small">No settled working workflow exhibits in this window.</p></div>';
  const improvements = pack.improvements.length
    ? `<div class="cards rf-grid">${pack.improvements
        .slice(0, 20)
        .map(
          (entry) => `<div class="card" id="rf-improvement-${esc(entry.id)}">
<div class="kv"><span class="badge">${esc(entry.status)}</span><span>${esc(entry.updatedAt)}</span></div>
<h3>${esc(entry.title)}</h3>
<p class="small"><b>Root cause:</b> ${esc(entry.rootCause)}</p>
<p class="small"><b>Change:</b> ${esc(entry.changeSummary)}</p>
<p class="small muted">Signals: ${esc(entry.signalIds.join(', ') || 'none')} · verification: ${esc(entry.verification.join('; ') || 'not recorded')}</p>
</div>`,
        )
        .join('')}</div>`
    : '<div class="card empty"><p class="muted small">No approved repair history has been recorded yet.</p></div>';

  return `<h1>Reflect</h1>
<p class="muted">A read-only execution-health digest. It reports evidence and possible investigation targets; it never changes configuration, edits instructions, or schedules itself.</p>
${latestCard}

<form class="rf-filter" method="get" action="/reflect">
  <label>Window <input id="rf-page-days" name="days" type="number" min="1" max="30" value="${days}"> days</label>
  <label>Group <select id="rf-page-group" name="group">${groupOptions}</select></label>
  <button type="submit">Refresh</button>
  <button type="button" onclick="runReflectFromOpsCenter()">Run /reflect and save summary</button>
</form>

<div class="cards kpi">
  <div class="card"><h3>Workflow outcomes</h3><div class="kv"><span>working <b class="big">${fleet.outcomes.working}</b></span><span>ok <b>${fleet.outcomes.ok}</b></span><span>degraded <b>${fleet.outcomes.degraded}</b></span><span>failed <b>${fleet.outcomes.failed}</b></span></div></div>
  <div class="card"><h3>Priced cost subset</h3><div class="kv"><span>priced total <b class="big">${money(fleet.costUsd)}</b></span><span>per priced workflow <b>${money(fleet.costPerWorkingTurn)}</b></span><span>per successful result <b>${money(fleet.costPerSuccessfulResult)}</b></span></div>${fleet.unpricedTurns ? `<p class="small warn">${fleet.unpricedTurns} unpriced workflow(s); this is not fleet total cost.</p>` : ''}</div>
  <div class="card"><h3>Signals</h3><div class="kv"><span>high <b class="big">${signals.filter((signal) => signal.severity === 'high').length}</b></span><span>medium <b>${signals.filter((signal) => signal.severity === 'medium').length}</b></span><span>low <b>${signals.filter((signal) => signal.severity === 'low').length}</b></span></div><p class="small muted">Pack ~${pack.packTokens.toLocaleString()} tokens; no model call.</p></div>
</div>

${health}

<h2>Groups</h2>
<div class="cards rf-grid">${groupCards}</div>

<h2>Signals</h2>
<div class="cards rf-grid">${signalCards}</div>

<h2>Signal-relevant, expensive, or troubled workflows</h2>
${exhibits}

<h2>Improvement history</h2>
${improvements}

<div class="card" style="margin-top:14px"><p class="small muted">CLI equivalent: <code>pnpm run reflect digest --days ${days}${groupId ? ` --group ${esc(groupId)}` : ''}</code></p></div>

<style>
.rf-filter{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:14px 0}
.rf-filter label{font-size:12px;color:var(--sub);display:grid;gap:4px}
.rf-filter input{background:var(--panel);color:var(--ink);border:1px solid var(--edge2);border-radius:7px;padding:7px 9px}
.rf-filter button{border:1px solid var(--edge2);background:transparent;color:var(--ink);border-radius:7px;padding:7px 12px;cursor:pointer}
.rf-grid{grid-template-columns:repeat(auto-fill,minmax(360px,1fr))}
.rf-health{margin:14px 0;border-left:3px solid var(--edge2)}
.rf-health.rf-good{border-left-color:var(--ok)}
.rf-health.rf-bad{border-left-color:var(--warn)}
.rf-signal{border-left:3px solid var(--edge2)}
.rf-signal ul{padding-left:18px}
.rf-latest{margin:14px 0;border-left:3px solid var(--act)}
</style>
<script>${reflectRunScript('rf-page-days', 'rf-page-group')}</script>`;
}
