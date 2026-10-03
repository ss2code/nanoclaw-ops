/** Terminal rendering for the read-only reflect digest. */
import type { EvidencePack } from './digest.js';
import type { Signal } from './signals.js';

const BAR = '─'.repeat(76);

export function renderDigest(pack: EvidencePack, signals: Signal[]): string {
  const lines: string[] = [
    BAR,
    `REFLECT · read-only · ${pack.windowDays}d · scope ${pack.scope} · ${pack.generatedAt}`,
    BAR,
  ];

  const fleet = pack.fleet;
  lines.push(
    `Fleet: ${fleet.runs} run(s) · ${fleet.outcomes.working} working workflow(s) ` +
      `(${fleet.outcomes.ok} ok / ${fleet.outcomes.degraded} degraded / ${fleet.outcomes.failed} failed; ${fleet.outcomes.idle} idle)`,
  );
  lines.push(
    `Spend: ${money(fleet.costUsd)} priced subset · ${money(fleet.costPerWorkingTurn)}/priced workflow · ` +
      `${money(fleet.costPerSuccessfulResult)}/successful result`,
  );
  if (fleet.unpricedTurns) {
    lines.push(
      `Cost coverage: ${fleet.pricedTurns} priced / ${fleet.outcomes.working} working workflows; the displayed spend is not fleet total cost.`,
    );
  }
  lines.push('');

  lines.push(
    pack.health.complete ? 'EVIDENCE  complete' : 'EVIDENCE  partial — do not interpret silence as healthy stasis',
  );
  lines.push(
    `  groups ${pack.health.groups} · runs ${pack.health.runs} · settled workflows ${pack.health.settledTurns} · ops.db ${pack.health.opsDb}`,
  );
  for (const warning of pack.health.warnings) lines.push(`  ! ${warning}`);
  lines.push('');

  lines.push('GROUPS');
  if (!pack.groups.length) {
    lines.push('  No groups have settled working workflows in this window.');
  } else {
    for (const group of pack.groups) {
      lines.push(
        `  ${pad(group.name, 22)} ${pad(`${group.outcomes.working}t`, 6)} ` +
          `${pad(money(group.costPerWorkingTurn), 11)}/work   success ${pad(money(group.costPerSuccessfulResult), 11)}  ` +
          `cache ${pad(group.medianCacheHitRatio == null ? '–' : pct(group.medianCacheHitRatio), 5)}  ` +
          `compact ${group.compactionsPerWorkingTurn?.toFixed(2) ?? '–'}  ` +
          `ctx edits ${group.contextEditsPerWorkingWorkflow?.toFixed(2) ?? '–'}`,
      );
    }
  }
  lines.push('');

  if (!signals.length) {
    lines.push('SIGNALS  none above threshold.');
    if (pack.health.complete) {
      lines.push('  Evidence is complete and nothing crossed a conservative reporting threshold.');
      lines.push('  No action is indicated for this window.');
    } else {
      lines.push('  Evidence is incomplete, so this is not a health verdict.');
    }
  } else {
    lines.push(`SIGNALS  ${signals.length} above threshold`);
    for (const signal of signals) {
      lines.push(`  [${signal.severity.toUpperCase().padEnd(6)}] ${signal.lane}/${signal.scope} — ${signal.title}`);
      for (const evidence of signal.evidence) lines.push(`             · ${evidence}`);
      if (signal.exhibitIds?.length) lines.push(`             · exhibits: ${signal.exhibitIds.join(', ')}`);
      if (signal.improvementIds?.length)
        lines.push(`             · prior history: ${signal.improvementIds.join(', ')}`);
      for (const limitation of signal.evidenceLimitations ?? []) lines.push(`             ! ${limitation}`);
      lines.push(`             → ${signal.next}`);
      lines.push('');
    }
  }

  if (pack.exhibits.length) {
    lines.push('');
    lines.push(`SIGNAL-RELEVANT / EXPENSIVE / TROUBLED WORKFLOWS  ${pack.exhibits.length}`);
    for (const exhibit of pack.exhibits) {
      const tools = exhibit.toolSequence.length ? exhibit.toolSequence.join(' → ') : 'no tools';
      lines.push(
        `  ${exhibit.id} · phases ${exhibit.turnIndexes.join(',')} · ${exhibit.outcome} · ${money(exhibit.costUsd)} · ${exhibit.trigger}`,
      );
      lines.push(`    ${exhibit.intent || '(no intent preview)'}`);
      lines.push(`    tools: ${tools}`);
      lines.push(
        `    errors: ${exhibit.recoveredErrors} recovered / ${exhibit.unresolvedErrors} unresolved · response evidence ${exhibit.responseEvidence}`,
      );
    }
  }

  if (pack.improvements.length) {
    lines.push('');
    lines.push(`IMPROVEMENT HISTORY  ${pack.improvements.length} recorded`);
    for (const entry of pack.improvements.slice(0, 8)) {
      lines.push(`  [${entry.status}] ${entry.id} · ${entry.title} · ${entry.updatedAt}`);
      lines.push(`    ${entry.changeSummary}`);
    }
  }

  lines.push('');
  lines.push(`Pack size: ~${pack.packTokens.toLocaleString()} tokens. No model calls or writes were made.`);
  return lines.join('\n');
}

const money = (value: number | null): string => (value == null ? '–' : `$${value.toFixed(4)}`);
const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
const pad = (value: string, width: number): string =>
  value.length >= width ? `${value.slice(0, width - 1)} ` : value.padEnd(width);
