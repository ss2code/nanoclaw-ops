import { esc, fmtTs } from '../ui.js';
import type { AgentGroupInfo } from '../readers/central.js';
import type { ReflectRunState } from './ops-run.js';

function countLine(state: ReflectRunState): string {
  const outcomes = state.pack?.fleet.outcomes;
  if (!outcomes) return 'No result captured.';
  return `${outcomes.working} working · ${outcomes.ok} ok · ${outcomes.degraded} degraded · ${outcomes.failed} failed`;
}

function runHref(state: ReflectRunState): string {
  const group = state.groupId ? `&group=${encodeURIComponent(state.groupId)}` : '';
  return `/reflect?days=${state.windowDays}${group}`;
}

export function reflectSystemCard(state: ReflectRunState, groups: AgentGroupInfo[]): string {
  const options = [
    '<option value="">Fleet</option>',
    ...groups.map((group) => `<option value="${esc(group.id)}">${esc(group.name)}</option>`),
  ].join('');

  let result = '<p class="muted small">No Ops Center-triggered Reflect run in this process yet.</p>';
  if (state.status === 'error') {
    result = `<p class="small bad">Reflect failed: ${esc(state.error ?? 'unknown error')}</p>`;
  } else if (state.pack) {
    const pack = state.pack;
    const signalCounts = {
      high: state.signals.filter((signal) => signal.severity === 'high').length,
      medium: state.signals.filter((signal) => signal.severity === 'medium').length,
      low: state.signals.filter((signal) => signal.severity === 'low').length,
    };
    const signalList = state.signals.length
      ? `<ul class="small rf-run-list">${state.signals
          .slice(0, 4)
          .map((signal) => `<li><b>${esc(signal.severity.toUpperCase())}</b> ${esc(signal.title)}</li>`)
          .join('')}</ul>`
      : '<p class="small muted">No conservative thresholds fired.</p>';
    const exhibits = pack.exhibits.length
      ? `<p class="small muted">${pack.exhibits.length} expensive/troubled exhibit(s) captured for inspection.</p>`
      : '<p class="small muted">No settled exhibits in this window.</p>';
    result = `<div class="kv small"><span>${esc(pack.health.complete ? 'evidence complete' : 'partial evidence')}</span><span>${esc(countLine(state))}</span></div>
<div class="kv small"><span>priced subset <b>${pack.fleet.costUsd == null ? '–' : `$${pack.fleet.costUsd.toFixed(4)}`}</b></span><span>${pack.fleet.pricedTurns}/${pack.fleet.outcomes.working} priced workflows</span><span>signals <b>${signalCounts.high} high · ${signalCounts.medium} medium · ${signalCounts.low} low</b></span></div>
${pack.health.warnings.length ? `<p class="small warn">${esc(pack.health.warnings[0])}</p>` : ''}
${signalList}${exhibits}
<a class="pill" href="${esc(runHref(state))}">Open full result</a>`;
  }

  return `<div class="card rf-system-card" style="grid-column:1/-1"><h3>Reflect · read-only execution health</h3>
<p class="muted small">Run the same deterministic digest as <code>/reflect</code> and keep its latest result visible here. It reads traces and ops.db; it does not change NanoClaw state.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
  <label class="small muted">window <select id="rf-system-days"><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
  <label class="small muted">scope <select id="rf-system-group">${options}</select></label>
  <button onclick="runReflectFromOpsCenter()">Run /reflect</button>
</div>
<div class="kv small muted" style="margin-top:8px"><span>status <b>${esc(state.status)}</b></span><span>${state.finishedAt ? `last run ${esc(fmtTs(state.finishedAt))}` : 'not run'}</span><span>${state.runId ? `id ${esc(state.runId.slice(0, 8))}` : ''}</span><span>${state.pack ? (state.snapshotSaved ? 'saved to data/reflect-latest.json' : 'snapshot unavailable') : ''}</span></div>
${state.snapshotError ? `<p class="small warn">Could not save the latest snapshot: ${esc(state.snapshotError)}</p>` : ''}
<div style="margin-top:10px">${result}</div>
</div>`;
}

export function reflectRunScript(daysId = 'rf-system-days', groupId = 'rf-system-group'): string {
  return `
async function runReflectFromOpsCenter(){
  const days=Number(document.getElementById('${daysId}')?.value||7);
  const group=document.getElementById('${groupId}')?.value||undefined;
  toast('Running /reflect…');
  try{
    const r=await fetch('/api/reflect/run',{method:'POST',headers:{'content-type':'application/json','x-ops-action-token':window.__opsToken},body:JSON.stringify({days,group})});
    const j=await r.json();
    toast(j.message||(j.ok?'Reflect complete':'Reflect failed'),j.ok);
    if(j.ok)setTimeout(()=>location.reload(),250);
  }catch(e){toast('Reflect request failed: '+e,false)}
}`;
}

/** Backward-compatible name for the System tab's embedded handler. */
export const reflectSystemScript = reflectRunScript;
