#!/usr/bin/env bun
// Reusable workflow runtime CLI.
//
// Usage: bun workflow.ts --db /workspace/agent/workflows.db <command> [options]

import { readFileSync } from 'node:fs';

import { openWorkflowDb, tableCount } from './db';
import {
  addEvent,
  advanceWorkflow,
  approveDraft,
  closeWorkflow,
  createDraftAction,
  createTimer,
  discardDraft,
  listDrafts,
  listWorkflows,
  quarantineEvent,
  rejectDraft,
  resolveInstanceForEvent,
  selectDraftsForSend,
  sendDrafts,
  startWorkflow,
  statusSnapshot,
  type WorkflowArchetype,
} from './runtime';

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function need(flags: Args['flags'], key: string): string {
  const value = str(flags, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function bool(flags: Args['flags'], key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function now(flags: Args['flags']): string {
  return str(flags, 'at') ?? new Date().toISOString();
}

function readJsonFlag(flags: Args['flags'], key: string, fileKey = `${key}-file`): unknown {
  const file = str(flags, fileKey);
  const raw = file ? readFileSync(file, 'utf8') : str(flags, key);
  if (!raw) return {};
  return JSON.parse(raw);
}

function readText(flags: Args['flags'], key: string, fileKey = `${key}-file`): string {
  const file = str(flags, fileKey);
  if (file) return readFileSync(file, 'utf8');
  return need(flags, key);
}

function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function numbers(raw: string | undefined): number[] {
  return csv(raw).map((item) => {
    const n = Number(item);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid draft number: ${item}`);
    return n;
  });
}

function print(value: unknown, asJson: boolean): void {
  if (asJson || typeof value !== 'string') console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function help(): string {
  return [
    'workflow-runtime commands:',
    '  init',
    '  start --type <name> --archetype solicit_remind_act_close|sequence_drip --payload <json|--payload-file file>',
    '  event --kind <kind> --source <source> [--instance id] [--external-id id] [--payload json]',
    '  advance --instance <id>',
    '  wait --instance <id> --timer-type <type> --due-at <iso>',
    '  draft --instance <id> --gmail-draft-id <id> --to a,b --subject <s> --body <text|--body-file file>',
    '  drafts [--include-sent]',
    '  show-draft <number>',
    '  approve-draft <number> --reviewer <name>',
    '  reject-draft <number> --reviewer <name> [--reason text]',
    '  select-drafts --numbers 1,2 | --all-reviewed',
    '  send-drafts --numbers 1,2 --reviewer <name> --gmail-message-id <id> [--gmail-thread-id id]',
    '  send-drafts --all-reviewed --reviewer <name> --gmail-message-id <id>',
    '  discard-draft <number>',
    '  close --instance <id> --outcome <name> [--result json]',
    '  list [--status open]',
    '  status --instance <id>',
  ].join('\n');
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const dbPath = str(flags, 'db') ?? './workflows.db';
  const asJson = bool(flags, 'json');

  if (!command || command === 'help' || bool(flags, 'help')) {
    print(help(), false);
    return;
  }

  const db = openWorkflowDb(dbPath);
  try {
    switch (command) {
      case 'init': {
        print(
          {
            ok: true,
            db: dbPath,
            tables: {
              workflow_instances: tableCount(db, 'workflow_instances'),
              workflow_events: tableCount(db, 'workflow_events'),
              workflow_timers: tableCount(db, 'workflow_timers'),
              workflow_actions: tableCount(db, 'workflow_actions'),
              workflow_correlations: tableCount(db, 'workflow_correlations'),
              workflow_quarantine: tableCount(db, 'workflow_quarantine'),
            },
          },
          true,
        );
        break;
      }

      case 'start': {
        const instance = startWorkflow(db, {
          id: str(flags, 'id'),
          workflowType: need(flags, 'type'),
          archetype: need(flags, 'archetype') as WorkflowArchetype,
          subjectType: str(flags, 'subject-type') ?? null,
          subjectId: str(flags, 'subject-id') ?? null,
          correlationKey: str(flags, 'correlation-key') ?? null,
          payload: readJsonFlag(flags, 'payload'),
          at: now(flags),
        });
        print(
          {
            ok: true,
            instanceId: instance.id,
            state: instance.state,
            status: instance.status,
            next: advanceWorkflow(db, instance.id, now(flags)).next,
          },
          true,
        );
        break;
      }

      case 'event': {
        const eventType = need(flags, 'kind');
        const source = need(flags, 'source');
        const externalId = str(flags, 'external-id') ?? null;
        const instanceId = resolveInstanceForEvent(db, {
          instanceId: str(flags, 'instance') ?? null,
          eventType,
          source,
          externalId,
        });
        const payload = readJsonFlag(flags, 'payload');
        if (!instanceId) {
          const id = quarantineEvent(db, {
            reason: eventType === 'gmail_reply' ? 'uncorrelated_gmail' : 'missing_instance',
            source,
            externalId,
            payload,
            at: now(flags),
          });
          print({ ok: true, quarantined: true, quarantineId: id }, true);
          break;
        }
        addEvent(db, { instanceId, eventType, source, externalId, payload, at: now(flags) });
        print({ ok: true, instanceId, eventType }, true);
        break;
      }

      case 'advance': {
        print(advanceWorkflow(db, need(flags, 'instance'), now(flags)), true);
        break;
      }

      case 'wait': {
        const envelope = createTimer(db, {
          instanceId: need(flags, 'instance'),
          timerType: need(flags, 'timer-type'),
          dueAt: need(flags, 'due-at'),
          scheduleTaskId: str(flags, 'schedule-task-id') ?? null,
          payload: readJsonFlag(flags, 'payload'),
          at: now(flags),
        });
        print({ ok: true, scheduleTask: envelope }, true);
        break;
      }

      case 'draft': {
        const to = csv(need(flags, 'to'));
        if (to.length === 0) throw new Error('--to must include at least one address');
        const action = createDraftAction(db, {
          instanceId: need(flags, 'instance'),
          gmailDraftId: need(flags, 'gmail-draft-id'),
          to,
          subject: need(flags, 'subject'),
          plainText: readText(flags, 'body'),
          purpose: str(flags, 'purpose'),
          idempotencyKey: str(flags, 'idempotency-key'),
          at: now(flags),
        });
        print({ ok: true, actionId: action.id, draftId: action.draft_id, reviewStatus: action.review_status }, true);
        break;
      }

      case 'drafts': {
        const drafts = listDrafts(db, { includeSent: bool(flags, 'include-sent') });
        if (asJson) print(drafts, true);
        else {
          print(
            drafts.length
              ? drafts
                  .map(
                    (draft) =>
                      `${draft.number}. ${draft.instanceId} · ${draft.reviewStatus ?? draft.status} · ${draft.to.join(', ')}\n   Subject: ${draft.subject}`,
                  )
                  .join('\n')
              : 'No pending workflow drafts.',
            false,
          );
        }
        break;
      }

      case 'show-draft': {
        const n = Number(rest[0]);
        const draft = listDrafts(db, { includeSent: true }).find((row) => row.number === n);
        if (!draft) throw new Error(`draft number not found: ${rest[0] ?? ''}`);
        print(
          asJson
            ? draft
            : [
                `Draft ${draft.number} is ready for review.`,
                '',
                `Workflow: ${draft.instanceId}`,
                `Gmail draft id: ${draft.draftId ?? 'unknown'}`,
                `To: ${draft.to.join(', ')}`,
                `Subject: ${draft.subject}`,
                '',
                'Plain text:',
                draft.plainText,
              ].join('\n'),
          asJson,
        );
        break;
      }

      case 'approve-draft': {
        const n = Number(rest[0]);
        if (!Number.isSafeInteger(n)) throw new Error('draft number is required');
        const draft = approveDraft(db, n, need(flags, 'reviewer'), now(flags));
        print({ ok: true, approved: { number: draft.number, draftId: draft.draftId, instanceId: draft.instanceId } }, true);
        break;
      }

      case 'reject-draft': {
        const n = Number(rest[0]);
        if (!Number.isSafeInteger(n)) throw new Error('draft number is required');
        const draft = rejectDraft(db, n, need(flags, 'reviewer'), str(flags, 'reason') ?? null, now(flags));
        print({ ok: true, rejected: { number: draft.number, draftId: draft.draftId, instanceId: draft.instanceId } }, true);
        break;
      }

      case 'select-drafts': {
        const drafts = selectDraftsForSend(db, { numbers: numbers(str(flags, 'numbers')), allReviewed: bool(flags, 'all-reviewed') });
        print(
          {
            ok: true,
            selected: drafts.map((draft) => ({ number: draft.number, instanceId: draft.instanceId, draftId: draft.draftId })),
          },
          true,
        );
        break;
      }

      case 'send-drafts': {
        const result = sendDrafts(db, {
          numbers: numbers(str(flags, 'numbers')),
          allReviewed: bool(flags, 'all-reviewed'),
          reviewer: need(flags, 'reviewer'),
          sentMethod: str(flags, 'sent-method') ?? 'chat_approved',
          gmailMessageId: need(flags, 'gmail-message-id'),
          gmailThreadId: str(flags, 'gmail-thread-id') ?? null,
          at: now(flags),
        });
        print(
          {
            ok: true,
            sent: result.sent.map((draft) => ({ number: draft.number, instanceId: draft.instanceId, draftId: draft.draftId })),
            schedules: result.schedules,
          },
          true,
        );
        break;
      }

      case 'discard-draft': {
        const n = Number(rest[0]);
        if (!Number.isSafeInteger(n)) throw new Error('draft number is required');
        const draft = discardDraft(db, n, now(flags));
        print({ ok: true, discarded: { number: draft.number, draftId: draft.draftId, instanceId: draft.instanceId } }, true);
        break;
      }

      case 'close': {
        const instance = closeWorkflow(db, {
          instanceId: need(flags, 'instance'),
          outcome: need(flags, 'outcome'),
          result: readJsonFlag(flags, 'result'),
          at: now(flags),
        });
        print({ ok: true, instanceId: instance.id, status: instance.status, result: JSON.parse(instance.result_json ?? '{}') }, true);
        break;
      }

      case 'list': {
        const rows = listWorkflows(db, str(flags, 'status')).map((row) => ({
          id: row.id,
          workflowType: row.workflow_type,
          archetype: row.archetype,
          status: row.status,
          state: row.state,
          updatedAt: row.updated_at,
        }));
        print(rows, true);
        break;
      }

      case 'status': {
        print(statusSnapshot(db, need(flags, 'instance')), true);
        break;
      }

      default:
        throw new Error(`unknown command "${command}"`);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
