/**
 * HTTP server: pages, SSE live lane, and control actions.
 * Binds 127.0.0.1 only — this is an admin surface (design §1).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import { Collector, type LiveSnapshot } from './collector.js';
import {
  getSeries,
  listIncidents,
  listEventsByKind,
  lastActiveSampleMs,
  readMissionHealth,
  sumWindow,
  usageBuckets,
  usageBucketsByGroup,
  type SeriesPoint,
} from './opsdb.js';
import { buildSpans } from './readers/lifecycle.js';
import {
  getGroupConfig,
  listAgentGroups,
  listMembersForGroup,
  listApps,
  listAgentConnections,
  listWiringsForGroup,
  channelTypes,
  senderKey,
  type EngagePreset,
  type MemberInfo,
  type WiringInfo,
  type AgentConnectionInfo,
} from './readers/central.js';
import { listAvailableSkills, planSkillsUpdate, resolveGroupSkills, type SkillInfo } from './readers/skills.js';
import {
  listSessionDirs,
  mergeRoutingDecisions,
  readMessageJourneys,
  readRecentFirings,
  readRoutingDecisions,
  readSessionStats,
  readSessionWork,
  type MessageJourney,
  type ScheduledFiring,
  type SessionWorkItem,
  type SpawnDecision,
} from './readers/sessiondbs.js';
import { readLogEvents, searchLogs, stripLogFormatting, tailLines } from './readers/logs.js';
import {
  groupDbPaths,
  isMemorySort,
  MEMORY_SORTS,
  readAllGroupMemories,
  readEmptyRecalls,
  readMemoryEventsStats,
  readPerGroupMemoryStats,
  type EmptyRecall,
  type MemorySort,
} from './readers/memory.js';
import {
  listGroupArtifacts,
  resolveStoreForDetail,
  scanFleetSharedKnowledge,
  scanFleetStores,
  type GroupStores,
  type HealthBadge,
  type StoreHit,
} from './readers/knowledge-stores.js';
import {
  classifyTags,
  freshnessBadges,
  readMemoryDetail,
  type FreshnessBadge,
  type MemoryDetail,
  type StructuralTag,
} from './readers/memory-detail.js';
import { buildLintSnapshots, runKnowledgeLints, type Finding, type Severity } from './readers/knowledge-lints.js';
import { readTripCompanions, type TripCompanionSnapshot } from './readers/trips.js';
import { recentRouteEvents, type ForwardRouteEvent } from './readers/routes.js';
import {
  correlateA2aLinks,
  deliveryByTurn,
  hostSessionIdFor,
  taskChildLinks,
  type DeliveryState,
} from './readers/run-links.js';
import {
  delegationStats,
  nearestA2aSentTag,
  readA2aRunTags,
  readDelegationExchanges,
  type A2aRunTag,
  type DelegationExchange,
} from './readers/delegations.js';
import {
  applyRunFilters,
  computeRunFacets,
  readExecutionRuns,
  runDurationMs,
  shortModelName,
  sortRuns,
  type ExecutionRun,
  type FacetValue,
  type RunFilters,
  type RunSort,
  type RunTurn,
  type RunToolCall,
  type RunArtifact,
  type RunModelCall,
  callCostUsd,
} from './readers/runs.js';
import { readWorkflowEventsByTurn, type WorkflowEvent } from './readers/workflow-events.js';
import { readRuntimeManifest, type RuntimeManifest } from './readers/runtime-manifest.js';
import { inspectSqliteDb, type SqliteTableSummary } from './readers/sqlite-inventory.js';
import { listBackups } from './backup.js';
import { addEvent } from './opsdb.js';
import {
  allowlistCard,
  channelsCard,
  containerBuildCard,
  esc,
  fmtAge,
  fmtBytes,
  fmtTokens,
  fmtTs,
  fleetCard,
  laneColor,
  layout,
  machineCard,
  machinePanelScript,
  modelsCard,
  NON_CHAT_CHANNELS,
  quotaChart,
  shortModel,
  skillsCard,
  templateCard,
  svgChart,
  usageChart,
  providerSwitchCard,
  piRuntimeCard,
  providerAuthCard,
  recoveryCard,
  recoveryPanelScript,
  voiceTranscriptionControls,
  type GroupCardExtras,
  type ModelMixEntry,
  type UsageMarker,
} from './ui.js';
import { reflectBody } from './reflect/page.js';
import { getLatestReflectRun, reflectRunResponse, runReflectFromOpsCenter } from './reflect/ops-run.js';
import { reflectSystemCard, reflectSystemScript } from './reflect/system-card.js';
import { readGroupRuntimeHooks, readImageBuildManifest } from './readers/container-build.js';
import { readContainerImageStatus } from './readers/container-image.js';
import { readGroupTemplate, type GroupTemplateInfo } from './readers/templates.js';
import { machineStatus, type MachineStatus } from './readers/machine.js';
import { recordClientContact } from './readers/tunnel-heartbeat.js';
import { readModelCatalog } from './readers/model-catalog.js';
import { readClaudeQuota } from './readers/quota.js';
import { readProviderAuthStatus } from './readers/provider-auth.js';
import { readPiRuntimeHealth } from './readers/pi-health.js';
import { PATHS, ROOT, readEnvKey, type OpsConfig } from './config.js';
import { computeRuntimeFingerprint } from '../src/container-image.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { getRuntimeDesiredState } from './runtime-state.js';
import { VerifiedActions } from './verified-actions.js';
import { recoveryStatus, startRecovery } from './machine-recovery.js';
import {
  discoverTemplateOpsCenterApps,
  findTemplateAppByApi,
  findTemplateAppByPage,
  serveTemplateAppAsset,
  templateAppEmbedPath,
  templateAppFrame,
  templateAppNavigation,
} from './template-apps.js';
import {
  ensureWebChat,
  getWebChatState,
  readChatSlice,
  readContinuationIds,
  sendViaCliSock,
  type ChatMessage,
} from './chat.js';
import {
  WEBQI_ACTION_PATH,
  WEBQI_BOOTSTRAP_PATH,
  WEBQI_ENABLED,
  WEBQI_GRAPH_PATH,
  WEBQI_GRAPH_FILE_PATH,
  WEBQI_CONVERSATION_PATH,
  WEBQI_HELP_PATH,
  WEBQI_PATH,
  WEBQI_SOURCE_PATH,
  WEBQI_ACTIVITY_PATH,
  runWebQiAction,
  webQiBody,
  webQiBootstrap,
  webQiActivity,
  webQiConversation,
  webQiHelpBody,
  webQiGraph,
  webQiGraphFile,
  webQiSource,
  chatSubnav,
} from './webqi.js';
import { calculateGroupSlo } from './slo.js';
import { TripConsoleService, type TripConsoleDraft, type TripOnboardingChannel, type TripTelegramBotIdentity } from './trips-console.js';
const RANGES: Record<string, number> = {
  '24h': 24 * 3.6e6,
  '7d': 7 * 8.64e7,
  '30d': 30 * 8.64e7,
  '90d': 90 * 8.64e7,
  '1y': 365 * 8.64e7,
};

export async function startServer(cfg: OpsConfig, opsDb: Database.Database, collector: Collector): Promise<http.Server> {
  const sseClients = new Set<http.ServerResponse>();
  const actionToken = randomBytes(24).toString('base64url');
  const actions = new VerifiedActions(cfg, opsDb);
  const tripConsole = new TripConsoleService(ROOT, undefined, undefined, {
    restartHost: async () => {
      const outcome = await actions.host('restart');
      if (!outcome.ok) throw new Error(outcome.message);
    },
  });
  const templateApps = await discoverTemplateOpsCenterApps(ROOT);

  // Fast lane: push snapshot to all SSE clients
  const liveTimer = setInterval(async () => {
    if (!sseClients.size) return;
    try {
      const snap = await collector.buildLiveSnapshot();
      const payload = `data: ${JSON.stringify(snap)}\n\n`;
      for (const res of sseClients) res.write(payload);
    } catch (e) {
      console.error('[ops-center] live tick failed:', (e as Error).message);
    }
  }, cfg.liveTickMs);
  liveTimer.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!hostAllowed(req, cfg)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('forbidden');
      }
      // ---------- SSE ----------
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(await collector.buildLiveSnapshot())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jeeves/domain') {
        return json(res, await buildJeevesDomainSnapshot(cfg, collector));
      }
      if (req.method === 'GET' && url.pathname === '/api/trips/bootstrap') {
        return json(res, tripConsole.bootstrap());
      }
      if (req.method === 'GET' && url.pathname === '/api/trips/status') {
        return json(res, tripStatusPayload(cfg));
      }
      const onboardingStatusMatch = url.pathname.match(/^\/api\/trips\/onboarding\/([^/]+)$/);
      if (req.method === 'GET' && onboardingStatusMatch) {
        try {
          return json(res, await tripConsole.onboardingStatus(decodeURIComponent(onboardingStatusMatch[1])));
        } catch (error) {
          return json(res, { ok: false, message: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/trips/onboarding/discovered') {
        const channel = url.searchParams.get('channel');
        if (channel !== 'telegram' && channel !== 'whatsapp') return json(res, { ok: false, message: 'unsupported onboarding channel' }, 400);
        return json(res, tripConsole.discoverChannel(channel as TripOnboardingChannel));
      }
      const templateApiApp = findTemplateAppByApi(templateApps, url.pathname);
      if (req.method === 'GET' && templateApiApp) {
        res.setHeader('cache-control', 'no-store');
        try {
          const result = await templateApiApp.app.handleApi('GET', url.pathname);
          return result === undefined
            ? json(res, { error: 'Unknown template application API route.' }, 404)
            : json(res, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json(res, { error: message.slice(0, 4000) }, 400);
        }
      }
      // Chat poll: new bubbles past the rowid cursors + live activity from the
      // transcript. Read-only (session DBs + parsed transcripts); group id is
      // validated against the live agent group list.
      if (req.method === 'GET' && url.pathname === '/api/chat/updates') {
        const groupId = url.searchParams.get('group') ?? '';
        const groups = safe(() => listAgentGroups(), []);
        if (!groups.some((g) => g.id === groupId)) return json(res, { ok: false, message: 'unknown group' }, 404);
        const inCur = Number(url.searchParams.get('in') ?? '0') || 0;
        const outCur = Number(url.searchParams.get('out') ?? '0') || 0;
        return json(res, chatUpdates(groupId, inCur, outCur));
      }
      if (WEBQI_ENABLED && req.method === 'GET' && url.pathname === WEBQI_BOOTSTRAP_PATH) {
        try {
          return json(res, webQiBootstrap());
        } catch (error) {
          return json(res, { ok: false, message: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      if (WEBQI_ENABLED && req.method === 'GET' && url.pathname === WEBQI_GRAPH_PATH) {
        try {
          const groupId = url.searchParams.get('group') ?? '';
          const sessionId = url.searchParams.get('session') ?? '';
          const rootId = url.searchParams.get('root') ?? '';
          return json(res, webQiGraph(groupId, sessionId, rootId));
        } catch (error) {
          return json(res, { ok: false, message: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (WEBQI_ENABLED && req.method === 'GET' && url.pathname === WEBQI_GRAPH_FILE_PATH) {
        try {
          const text = webQiGraphFile(
            url.searchParams.get('group') ?? '',
            url.searchParams.get('session') ?? '',
            url.searchParams.get('root') ?? '',
          );
          if (text === null) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
            return res.end('Graph not found.');
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-disposition': 'inline',
            'x-content-type-options': 'nosniff',
          });
          return res.end(text);
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
          return res.end(error instanceof Error ? error.message : String(error));
        }
      }
      if (WEBQI_ENABLED && req.method === 'GET' && url.pathname === WEBQI_CONVERSATION_PATH) {
        try {
          const text = webQiConversation(
            url.searchParams.get('group') ?? '',
            url.searchParams.get('session') ?? '',
            url.searchParams.get('root') ?? '',
          );
          if (text === null) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
            return res.end('Conversation not found.');
          }
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'content-disposition': 'inline',
            'x-content-type-options': 'nosniff',
          });
          return res.end(text);
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
          return res.end(error instanceof Error ? error.message : String(error));
        }
      }
      if (WEBQI_ENABLED && req.method === 'GET' && url.pathname === WEBQI_SOURCE_PATH) {
        try {
          const text = webQiSource(
            url.searchParams.get('group') ?? '',
            url.searchParams.get('session') ?? '',
            url.searchParams.get('root') ?? '',
            url.searchParams.get('node') ?? '',
          );
          if (text === null) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
            return res.end('Source not found.');
          }
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'content-disposition': 'inline',
            'x-content-type-options': 'nosniff',
          });
          return res.end(text);
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
          return res.end(error instanceof Error ? error.message : String(error));
        }
      }
      if (WEBQI_ENABLED && req.method === 'GET' && url.pathname === WEBQI_ACTIVITY_PATH) {
        try {
          const groupId = url.searchParams.get('group') ?? '';
          if (!safe(() => listAgentGroups(), []).some((group) => group.id === groupId)) {
            return json(res, { ok: false, message: 'unknown group' }, 404);
          }
          return json(
            res,
            webQiActivity(
              groupId,
              url.searchParams.get('session') || undefined,
              url.searchParams.get('root') || undefined,
              url.searchParams.get('tag') || undefined,
            ),
          );
        } catch (error) {
          return json(res, { ok: false, message: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      // Lazy knowledge-store detail fragment. The (group, path) pair is validated
      // against the store registry, so only registry-known paths are ever served.
      if (req.method === 'GET' && url.pathname === '/api/knowledge/store') {
        const groupParam = url.searchParams.get('group') ?? '';
        const relPath = url.searchParams.get('path') ?? '';
        const groups = safe(() => listAgentGroups(), []);
        const hit = resolveStoreForDetail(groupParam, relPath, groups);
        res.writeHead(hit ? 200 : 404, {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        return res.end(hit ? renderStoreDetail(hit) : '<p class="muted small">Unknown store.</p>');
      }
      // Lazy per-memory detail drawer. group is validated against the live agent
      // group list; the reader opens that group's memory.db read-only.
      if (req.method === 'GET' && url.pathname === '/api/knowledge/memory') {
        const groupParam = url.searchParams.get('group') ?? '';
        const id = Number(url.searchParams.get('id') ?? '');
        const groups = safe(() => listAgentGroups(), []);
        const frag = Number.isFinite(id) ? renderMemoryDrawer(groups, groupParam, id) : null;
        res.writeHead(frag ? 200 : 404, {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        return res.end(frag ?? '<p class="muted small">Unknown memory.</p>');
      }
      // ---------- system / machine status ----------
      // Read-only machine status for the /system panel. Slow-polled by the panel
      // (not the 3s SSE lane) and briefly cached, so the weak host is never hit
      // with heavy probes more than once per cache window. GET → shared host gate.
      if (req.method === 'GET' && url.pathname === '/api/system/status') {
        return json(res, await getMachineStatusCached(cfg, server, opsDb));
      }
      if (req.method === 'GET' && url.pathname === '/api/system/recovery/status') {
        res.setHeader('cache-control', 'no-store');
        return json(res, recoveryStatus());
      }
      // Featherweight tunnel heartbeat. Records that a client reached the loopback
      // listener and echoes server time so the browser can measure its own
      // round-trip latency. This records client contact, not tunnel health.
      if (req.method === 'GET' && url.pathname === '/api/system/tunnel-ping') {
        recordClientContact(Date.now());
        return json(res, { t: Date.now() });
      }
      // User-triggered Reflect is read-only. Keep it outside the generic action
      // logger because running the digest must not write an ops.db event.
      if (req.method === 'POST' && url.pathname === '/api/reflect/run') {
        if (req.headers['x-ops-action-token'] !== actionToken || !originAllowed(req, cfg)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, message: 'invalid action origin or token' }));
        }
        const body = await readBody(req);
        const rawDays = Number(body.days ?? 7);
        const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 30 ? rawDays : 7;
        const group = typeof body.group === 'string' && body.group.trim() ? body.group.trim() : undefined;
        const state = runReflectFromOpsCenter(opsDb, { windowDays: days, groupId: group, exhibitLimit: 8 });
        const ok = state.status === 'complete';
        res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            ok,
            message: ok
              ? `/reflect complete: ${state.signals.length} signal(s) found; latest result is shown in System${state.snapshotSaved ? ' and saved to data/reflect-latest.json.' : '.'}`
              : `/reflect failed: ${state.error ?? 'unknown error'}`,
            ...reflectRunResponse(state),
          }),
        );
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/trips/')) {
        if (req.headers['x-ops-action-token'] !== actionToken || !originAllowed(req, cfg)) {
          return json(res, { ok: false, message: 'invalid action origin or token' }, 403);
        }
        const body = await readBody(req);
        try {
          let result: Record<string, unknown>;
          if (url.pathname === '/api/trips/draft') {
            result = tripConsole.saveDraft(body.draft as TripConsoleDraft) as unknown as Record<string, unknown>;
          } else if (url.pathname === '/api/trips/instantiate') {
            result = await tripConsole.instantiate(body.draft as TripConsoleDraft) as unknown as Record<string, unknown>;
          } else if (url.pathname === '/api/trips/onboarding/telegram') {
            result = await tripConsole.startTelegramOnboarding(
              body.draft as TripConsoleDraft,
              typeof body.token === 'string' ? body.token : '',
            ) as unknown as Record<string, unknown>;
          } else if (url.pathname === '/api/trips/onboarding/whatsapp') {
            const method = body.method === 'pairing-code' ? 'pairing-code' : 'qr';
            result = await tripConsole.startWhatsAppOnboarding(method, typeof body.phone === 'string' ? body.phone : '') as unknown as Record<string, unknown>;
          } else if (url.pathname === '/api/trips/onboarding/apply') {
            const channel = body.channel === 'telegram' || body.channel === 'whatsapp' ? body.channel : '';
            if (!channel || typeof body.platformId !== 'string') throw new Error('channel and platformId are required');
            result = tripConsole.applyOnboarding(body.draft as TripConsoleDraft, {
              channel,
              platformId: body.platformId,
              userId: typeof body.userId === 'string' ? body.userId : undefined,
              displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
              chatName: typeof body.chatName === 'string' ? body.chatName : undefined,
              bot: body.bot && typeof body.bot === 'object' ? body.bot as TripTelegramBotIdentity : undefined,
            }) as unknown as Record<string, unknown>;
          } else {
            const actionMatch = url.pathname.match(/^\/api\/trips\/([^/]+)\/action$/);
            const cleanupMatch = url.pathname.match(/^\/api\/trips\/([^/]+)\/cleanup$/);
            if (actionMatch) {
              const groupId = decodeURIComponent(actionMatch[1]);
              const action = String(body.action ?? '');
              if (!['pause', 'resume', 'run', 'stop', 'restart'].includes(action)) throw new Error('unsupported trip action');
              result = (action === 'restart'
                ? await actions.restartGroup(groupId, false, false)
                : await actions.lifecycleGroup(groupId, action as 'pause' | 'resume' | 'run' | 'stop')) as unknown as Record<string, unknown>;
            } else if (cleanupMatch) {
              const id = decodeURIComponent(cleanupMatch[1]);
              const mode = body.mode === 'archive' ? 'archive' : body.mode === 'retain' ? 'retain' : '';
              if (!mode) throw new Error('cleanup mode must be retain or archive');
              result = await tripConsole.cleanup(id, mode, String(body.confirmation ?? '')) as unknown as Record<string, unknown>;
            } else {
              return json(res, { ok: false, message: 'unknown trip action' }, 404);
            }
          }
          const groupId = typeof result.id === 'string' ? result.id : 'host';
          addEvent(opsDb, {
            ts: new Date().toISOString(),
            group_id: groupId,
            kind: `action:${url.pathname}`,
            severity: result.ok === false ? 'warn' : 'info',
            detail: String(result.message ?? result.output ?? 'Trip action completed').slice(0, 300),
          });
          return json(res, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          addEvent(opsDb, {
            ts: new Date().toISOString(),
            group_id: 'host',
            kind: `action:${url.pathname}`,
            severity: 'warn',
            detail: message.slice(0, 300),
          });
          return json(res, { ok: false, message }, 400);
        }
      }
      if (req.method === 'POST' && templateApiApp) {
        if (req.headers['x-ops-action-token'] !== actionToken || !originAllowed(req, cfg)) {
          return json(res, { error: 'Invalid action origin or token. Refresh Ops Center.' }, 403);
        }
        const body = await readBody(req);
        res.setHeader('cache-control', 'no-store');
        try {
          const result = await templateApiApp.app.handleApi('POST', url.pathname, body);
          if (result === undefined) return json(res, { error: 'Unknown template application action.' }, 404);
          const detail = typeof result.message === 'string' ? result.message : `${templateApiApp.contribution.label} action completed.`;
          recordTemplateAppAction(opsDb, url.pathname, 'info', detail);
          return json(res, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordTemplateAppAction(opsDb, url.pathname, 'warn', message);
          return json(res, { error: message.slice(0, 4000) }, 400);
        }
      }
      // ---------- actions ----------
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-ops-action-token'] !== actionToken || !originAllowed(req, cfg)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, message: 'invalid action origin or token' }));
        }
        const body = await readBody(req);
        const json = (r: { ok: boolean; message: string }, groupId = 'host') => {
          addEvent(opsDb, {
            ts: new Date().toISOString(),
            group_id: groupId,
            kind: `action:${url.pathname}`,
            severity: r.ok ? 'info' : 'warn',
            detail: r.message.slice(0, 300),
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        };
        if (WEBQI_ENABLED && url.pathname === WEBQI_ACTION_PATH) {
          const result = await runWebQiAction(body);
          return json(result, typeof body.groupId === 'string' ? body.groupId : 'host');
        }
        if (url.pathname === '/api/host/start') return json(await actions.host('start'));
        if (url.pathname === '/api/host/stop') return json(await actions.host('stop'));
        if (url.pathname === '/api/host/restart') return json(await actions.host('restart'));
        if (url.pathname === '/api/host/hard-off') {
          const outcome = await actions.hardOff();
          json(outcome);
          if (outcome.ok) actions.scheduleOpsCenterStop();
          return;
        }
        if (url.pathname === '/api/system/recovery/recover') return json(startRecovery('recover'));
        if (url.pathname === '/api/system/recovery/reboot') {
          if (body.confirm !== 'REBOOT') return json({ ok: false, message: 'reboot requires confirmation' });
          return json(startRecovery('reboot'));
        }
        if (url.pathname === '/api/system/recovery/postcheck') return json(startRecovery('postcheck'));
        if (url.pathname === '/api/orphans/cleanup') {
          if (!body.path) return json({ ok: false, message: 'path required' });
          return json(await actions.cleanupOrphan(String(body.path)));
        }
        if (url.pathname === '/api/backup') {
          return json(await actions.backup());
        }
        if (url.pathname === '/api/selftest/run') {
          const { startSelfTest } = await import('./selftest.js');
          return json(startSelfTest(typeof body.group === 'string' && body.group ? String(body.group) : 'all'));
        }
        const cm = url.pathname.match(/^\/api\/chat\/([^/]+)\/send$/);
        if (cm) {
          const groupId = decodeURIComponent(cm[1]);
          const group = safe(() => listAgentGroups(), []).find((g) => g.id === groupId);
          if (!group) return json({ ok: false, message: 'unknown group' });
          const text = String(body.text ?? '').trim();
          if (!text) return json({ ok: false, message: 'empty message' });
          if (text.length > 8000) return json({ ok: false, message: 'message too long (8000 char max)' });
          const wired = await ensureWebChat(groupId, group.name);
          if (!wired.ok) return json({ ok: false, message: `web chat wiring failed: ${wired.message}` });
          return json(await sendViaCliSock(groupId, text));
        }
        const gm = url.pathname.match(
          /^\/api\/group\/([^/]+)\/(restart|run|resume|stop|pause|model|model-tiers|rollback-model|provider|engage-mode|skills|voice-transcription)$/,
        );
        if (gm) {
          const [, groupId, verb] = gm;
          if (verb === 'stop' || verb === 'pause') {
            const expected = verb.toUpperCase();
            if (body.confirm !== expected)
              return json({ ok: false, message: `${verb} requires confirmation` }, groupId);
          }
          if (verb === 'restart')
            return json(await actions.restartGroup(groupId, Boolean(body.rebuild), Boolean(body.fresh)), groupId);
          if (verb === 'provider') {
            if (body.provider !== 'claude' && body.provider !== 'codex' && body.provider !== 'opencode' && body.provider !== 'pi')
              return json({ ok: false, message: 'provider must be claude, codex, opencode, or pi' }, groupId);
            return json(await actions.switchProvider(groupId, body.provider), groupId);
          }
          if (verb === 'run' || verb === 'resume') return json(await actions.lifecycleGroup(groupId, verb), groupId);
          if (verb === 'stop' || verb === 'pause') return json(await actions.lifecycleGroup(groupId, verb), groupId);
          if (verb === 'model-tiers') {
            const t = body.tiers as { high?: unknown; medium?: unknown; low?: unknown; default?: unknown } | undefined;
            const ok =
              t &&
              typeof t.high === 'string' &&
              typeof t.medium === 'string' &&
              typeof t.low === 'string' &&
              ['high', 'medium', 'low'].includes(String(t.default));
            if (!ok) return json({ ok: false, message: 'tiers must be {high, medium, low, default}' });
            return json(
              await actions.setModelTiers(groupId, {
                high: String(t!.high),
                medium: String(t!.medium),
                low: String(t!.low),
                default: String(t!.default),
              }),
              groupId,
            );
          }
          if (verb === 'skills') {
            const requested = Array.isArray(body.skills) ? body.skills.map((s: unknown) => String(s)) : [];
            const plan = planSkillsUpdate(
              requested,
              safe(() => listAvailableSkills(), [] as SkillInfo[]),
            );
            if (!plan.ok) return json({ ok: false, message: plan.error });
            return json(await actions.setSkills(groupId, plan.value), groupId);
          }
          if (verb === 'model') {
            if (!body.model) return json({ ok: false, message: 'model required' });
            return json(await actions.setModel(groupId, String(body.model)), groupId);
          }
          if (verb === 'rollback-model') return json(await actions.rollbackModel(groupId), groupId);
          if (verb === 'voice-transcription') {
            const value = String(body.value ?? '');
            if (!['on', 'off'].includes(value)) return json({ ok: false, message: 'value must be "on" or "off"' });
            if (!body.messagingGroupId) return json({ ok: false, message: 'messagingGroupId required' });
            return json(
              await actions.setVoiceTranscription(groupId, String(body.messagingGroupId), value as 'on' | 'off'),
              groupId,
            );
          }
          if (verb === 'engage-mode') {
            const preset = String(body.preset ?? '');
            if (!['mention', 'sticky', 'context'].includes(preset))
              return json({ ok: false, message: 'preset must be one of: mention, sticky, context' });
            return json(
              await actions.setEngageMode(
                groupId,
                body.messagingGroupId ? String(body.messagingGroupId) : undefined,
                preset as EngagePreset,
              ),
              groupId,
            );
          }
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: 'unknown action' }));
      }
      // Legacy /docs — the Docs tab is now the nano-pvt-hub surface at /hub/,
      // where repo docs live under the read-only `nanoclaw-docs` root. Old
      // bookmarks and in-page links keep working via these redirects.
      if (url.pathname === '/docs' || url.pathname === '/docs/') {
        res.writeHead(302, { location: '/hub/' });
        return res.end();
      }
      if (url.pathname.startsWith('/docs/')) {
        res.writeHead(302, { location: `/hub/nanoclaw-docs/${url.pathname.slice('/docs/'.length)}` });
        return res.end();
      }
      if (url.pathname === '/hub') {
        res.writeHead(302, { location: '/hub/' });
        return res.end();
      }
      if (url.pathname.startsWith('/hub/') && url.pathname !== '/hub/') {
        return serveHubFile(url.pathname, req, res);
      }
      const templatePageApp = findTemplateAppByPage(templateApps, url.pathname);
      if (req.method === 'GET' && templatePageApp && templateAppEmbedPath(templatePageApp, url.pathname)) {
        const page = templatePageApp.app.renderEmbedded(actionToken);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
          'x-content-type-options': 'nosniff',
        });
        return res.end(page);
      }
      const templateAsset = templatePageApp ? serveTemplateAppAsset(templatePageApp, url.pathname) : undefined;
      if (req.method === 'GET' && templateAsset) {
        res.writeHead(200, {
          'content-type': templateAsset.contentType,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        return res.end(fs.readFileSync(templateAsset.file));
      }
      // ---------- pages ----------
      const channels = safe(() => channelTypes(), [] as string[]);
      const html = (title: string, active: string, body: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(layout(title, active, body, channels, actionToken, templateAppNavigation(templateApps)));
      };
      if (url.pathname === '/trace-file') {
        return serveTraceFile(url, req, res, channels, actionToken);
      }
      if (url.pathname === '/hub/') return html('Docs Hub', '/hub/', hubBody());
      if (url.pathname === '/') return html('Overview', '/', await overviewBody(cfg, opsDb, collector));
      if (url.pathname === '/logs') return html('Logs', '/logs', logsBody(url.searchParams));
      if (url.pathname === '/reflect') return html('Reflect', '/reflect', reflectBody(opsDb, url.searchParams));
      if (url.pathname === '/runs') return html('Runs', '/runs', runsBody(url.searchParams));
      if (url.pathname === '/runs/session') return html('Run', '/runs', sessionRunBody(url.searchParams));
      if (url.pathname === '/chat') return html('Chat', '/chat', chatBody());
      if (url.pathname === '/chat/group') return html('Chat', '/chat', chatGroupBody(url.searchParams));
      if (WEBQI_ENABLED && url.pathname === WEBQI_HELP_PATH) return html('Consult command reference', '/chat', webQiHelpBody());
      if (WEBQI_ENABLED && url.pathname === WEBQI_PATH) return html('Consult', '/chat', webQiBody());
      if (url.pathname === '/apps') return html('Apps', '/apps', await appsBody(collector));
      if (templatePageApp && url.pathname === templatePageApp.navigation.path) {
        return html(templatePageApp.contribution.label, templatePageApp.navigation.path, templateAppFrame(templatePageApp));
      }
      // Legacy routes retained as small compatibility redirects. The former
      // triage views now live on the Overview, Apps, Runs, System, and Logs
      // surfaces instead of a separate tab.
      if (url.pathname === '/triage') {
        const view = url.searchParams.get('view');
        const target = view === 'diagnostics' ? '/logs' : view === 'work' ? '/apps' : '/';
        res.writeHead(302, { location: `${target}${target === '/logs' && url.search ? url.search : ''}` });
        return res.end();
      }
      if (url.pathname === '/flows') {
        res.writeHead(302, { location: '/runs' });
        return res.end();
      }
      const g = url.pathname.match(/^\/group\/([^/]+)$/);
      if (g)
        return html(g[1], '', await groupBody(cfg, opsDb, collector, g[1], url.searchParams.get('range') ?? '24h'));
      if (url.pathname === '/incidents' || url.pathname === '/operations') {
        res.writeHead(302, { location: '/system#host-events' });
        return res.end();
      }
      if (url.pathname === '/queues') {
        res.writeHead(302, { location: '/apps' });
        return res.end();
      }
      if (url.pathname === '/activity') {
        const view = url.searchParams.get('view');
        const target = view === 'diagnostics' ? `/logs${url.search ? url.search : ''}` : '/runs';
        res.writeHead(302, { location: target });
        return res.end();
      }
      if (url.pathname === '/memory') {
        res.writeHead(302, { location: `/knowledge${url.search ?? ''}` });
        return res.end();
      }
      if (url.pathname === '/knowledge') return html('Knowledge', '/knowledge', knowledgeBody(url.searchParams));
      if (url.pathname === '/trips') return html('Trip Companion', '/trips', tripsBody(cfg, tripConsole.bootstrap().draft));
      if (url.pathname === '/system') return html('System', '/system', await systemBody(cfg, opsDb));
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      console.error('[ops-center] request failed:', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`error: ${(e as Error).message}`);
    }
  });

  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`[ops-center] listening on http://127.0.0.1:${cfg.port}`);
  });
  return server;
}

export async function buildJeevesDomainSnapshot(cfg: OpsConfig, collector: Pick<Collector, 'buildLiveSnapshot'>) {
  const groups = safe(() => listAgentGroups(), []);
  return {
    ok: true,
    ts: new Date().toISOString(),
    live: await collector.buildLiveSnapshot(),
    apps: safe(() => listApps(), []),
    trips: readTripCompanions(groups, {
      showMessageSnippets: cfg.tripCompanion.showMessageSnippets,
    }),
  };
}

function tripStatusPayload(cfg: OpsConfig): { instances: TripCompanionSnapshot[]; checkedAt: string } {
  return {
    instances: readTripCompanions(safe(() => listAgentGroups(), []), {
      showMessageSnippets: cfg.tripCompanion.showMessageSnippets,
    }),
    checkedAt: new Date().toISOString(),
  };
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function recordTemplateAppAction(
  opsDb: Database.Database,
  pathname: string,
  severity: 'info' | 'warn',
  detail: string,
): void {
  addEvent(opsDb, {
    ts: new Date().toISOString(),
    group_id: 'host',
    kind: `action:${pathname}`,
    severity,
    detail: detail.slice(0, 300),
  });
}

/**
 * Brief server-side cache for the machine-status probe. The probe shells out
 * (df, Docker, and service inspection), so a browser refresh or stray curl
 * cannot hammer the host more often than the cache window.
 */
const MACHINE_STATUS_TTL_MS = 8000;
let machineStatusCache: { value: MachineStatus; expiresAt: number } | null = null;

async function getMachineStatusCached(cfg: OpsConfig, server: http.Server, opsDb: Database.Database): Promise<MachineStatus> {
  const now = Date.now();
  if (machineStatusCache && now < machineStatusCache.expiresAt) return machineStatusCache.value;
  const addr = server.address();
  const listener = {
    // `server.listening` is the server's honest self-report. It is deliberately
    // not propagated into any tunnel-health claim.
    bound: server.listening,
    address: addr && typeof addr === 'object' ? addr.address : '127.0.0.1',
    port: addr && typeof addr === 'object' ? addr.port : cfg.port,
  };
  const value = await machineStatus({ listener, mission: safe(() => readMissionHealth(opsDb), null) });
  machineStatusCache = { value, expiresAt: now + MACHINE_STATUS_TTL_MS };
  return value;
}

/**
 * The server binds 127.0.0.1, so a request can only arrive from this machine or
 * from a reverse proxy on it. The Host check is the second layer: it defeats DNS
 * rebinding, where a hostile page resolves its own domain to 127.0.0.1 and drives
 * this admin surface from the victim's browser. Loopback Host values are always
 * accepted; `trustedHosts` additionally allows named front-ends (e.g. a Tailscale
 * Serve hostname). Entries must be exact hostnames — never a wildcard — because
 * each one is a name an attacker may resolve to 127.0.0.1.
 */
export function hostAllowed(req: http.IncomingMessage, cfg: Pick<OpsConfig, 'port' | 'trustedHosts'>): boolean {
  const host = req.headers.host?.toLowerCase();
  if (!host) return false;
  if (host === `127.0.0.1:${cfg.port}` || host === `localhost:${cfg.port}`) return true;
  // A proxied Host may or may not carry a port (:443 is usually elided).
  const bare = host.replace(/:\d+$/, '');
  return cfg.trustedHosts.some((h) => {
    const t = h.toLowerCase();
    return host === t || bare === t.replace(/:\d+$/, '');
  });
}

/**
 * CSRF guard for mutating actions, paired with the action token. A cross-site
 * form post carries the attacker's Origin, so requiring a known one blocks it.
 * Trusted front-ends are accepted over https as well as http.
 */
export function originAllowed(req: http.IncomingMessage, cfg: Pick<OpsConfig, 'port' | 'trustedHosts'>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === `http://127.0.0.1:${cfg.port}` || origin === `http://localhost:${cfg.port}`) return true;
  const host = safe(() => new URL(origin).host.toLowerCase(), '');
  if (!host) return false;
  const bare = host.replace(/:\d+$/, '');
  return cfg.trustedHosts.some((h) => {
    const t = h.toLowerCase().replace(/:\d+$/, '');
    return bare === t;
  });
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ─────────────────────────── nano-pvt-hub (Docs Hub) ───────────────────────────
//
// The Docs tab is the hub surface at /hub/. The old /docs/* static server was
// folded into serveHubFile below: repo docs are reached through the read-only
// `nanoclaw-docs` symlink inside the store, and /docs/* now 302s there.

const HUB_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.ndjson': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

/**
 * Resolve a request under the hub store against a realpath ALLOWLIST of roots:
 * the hub dir itself plus the repo docs directory, which is legitimately
 * reachable through the read-only `nanoclaw-docs` symlink inside it.
 *
 * The allowlist is what lets those symlinks resolve while still rejecting any
 * escape symlink an agent might plant in the writable part of the tree — the
 * store is mounted read-write into every container, so this is the boundary
 * that keeps `→ /etc/passwd` or `→ ~/.ssh` from ever being served.
 *
 * The repo docs surface includes the `docs/local/**` overlay. It is read-only
 * here; the realpath allowlist still prevents writable-store symlink escapes.
 */
export function resolveHubPath(hubDir: string, relative: string, docsRoots: string[]): string | null {
  const base = path.resolve(hubDir);
  let file = path.resolve(base, `.${relative || '/'}`);
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) return null;
  if (safe(() => fs.statSync(file).isDirectory(), false)) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !safe(() => fs.statSync(file).isFile(), false)) return null;
  const real = safe(() => fs.realpathSync(file), file);
  const under = (root: string) => real === root || real.startsWith(`${root}${path.sep}`);
  const realRoot = (r: string) => safe(() => fs.realpathSync(r), path.resolve(r));
  const realDocsRoots = docsRoots.map(realRoot);
  if (![realRoot(hubDir), ...realDocsRoots].some(under)) return null;
  return real;
}

function resolveHubFile(relative: string): string | null {
  return resolveHubPath(PATHS.hubDir, relative, [PATHS.projectDocsDir]);
}

function serveHubFile(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice('/hub'.length));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad path');
    return;
  }
  const file = resolveHubFile(relative);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const type = HUB_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': fs.statSync(file).size,
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}

interface HubCatalogRecord {
  id: string;
  kind: string;
  route: string;
  audience: string;
  series?: string;
  title: string;
  summary?: string;
  shape?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  url: string;
}

/** Read the derived catalog.json (titles/summaries/urls). Never throws. */
function readHubCatalog(): HubCatalogRecord[] {
  const cat = safe(
    () =>
      JSON.parse(fs.readFileSync(path.join(PATHS.hubDir, 'catalog.json'), 'utf8')) as {
        artifacts?: HubCatalogRecord[];
      },
    { artifacts: [] as HubCatalogRecord[] },
  );
  return Array.isArray(cat.artifacts) ? cat.artifacts : [];
}

/** Walk the read-only nanoclaw-docs surface for the Docs index. */
export function listHubDocsFiles(docsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) isDir = safe(() => fs.statSync(path.join(dir, e.name)).isDirectory(), false);
      if (isDir) {
        walk(path.join(dir, e.name), childRel);
      } else if (/\.(html?|md|markdown|txt|pdf|json|csv|svg|png|jpe?g|webp|gif)$/i.test(e.name)) {
        out.push(childRel);
      }
    }
  };
  walk(docsRoot, '');
  return out.sort();
}

function hubDocsFiles(): string[] {
  return listHubDocsFiles(path.join(PATHS.hubDir, 'nanoclaw-docs'));
}

function hubBody(): string {
  const artifacts = readHubCatalog();
  const byKind = (k: string): HubCatalogRecord[] => artifacts.filter((a) => a.kind === k);
  const docs = hubDocsFiles();

  const artifactSection = (title: string, kind: string, blurb: string, emptyHint: string): string => {
    const rows = byKind(kind);
    const body = rows.length
      ? `<table><tr><th>title</th><th>updated</th><th>expires</th></tr>${rows
          .map(
            (a) =>
              `<tr><td><a href="${esc(a.url)}">${esc(a.title)}</a>${
                a.shape ? ` <span class="state info">${esc(a.shape)}</span>` : ''
              }${a.summary ? `<br><span class="muted small">${esc(a.summary)}</span>` : ''}</td>` +
              `<td class="small">${esc(fmtTs(a.updatedAt))}</td>` +
              `<td class="small muted">${a.expiresAt ? esc(fmtTs(a.expiresAt)) : 'durable'}</td></tr>`,
          )
          .join('')}</table>`
      : `<div class="card empty"><p class="muted small">${esc(emptyHint)}</p></div>`;
    return `<h2>${esc(title)} <span class="muted small">${rows.length}</span></h2>
<p class="muted small">${esc(blurb)}</p>${body}`;
  };

  const renderDocGroups = (files: string[], openRoot = true): string => {
    const docGroups = new Map<string, string[]>();
    for (const rel of files) {
      const slash = rel.indexOf('/');
      const bucket = slash === -1 ? '(root)' : rel.slice(0, slash);
      let arr = docGroups.get(bucket);
      if (!arr) {
        arr = [];
        docGroups.set(bucket, arr);
      }
      arr.push(rel);
    }
    return files.length
      ? [...docGroups.entries()]
          .map(
            ([bucket, groupFiles]) =>
              `<details class="docs-group"${bucket === '(root)' && openRoot ? ' open' : ''}><summary><span>${esc(
                bucket,
              )}</span> <span class="muted small">${groupFiles.length} document${
                groupFiles.length === 1 ? '' : 's'
              }</span></summary>
<ul class="chips docs-chips" aria-label="${esc(bucket)} documents">${groupFiles
                .map(
                  (rel) =>
                    `<li><a class="chip" aria-label="Open ${esc(rel)}" href="${esc(
                      encodeURI(`/hub/nanoclaw-docs/${rel}`),
                    )}">${esc(rel.split('/').pop() || rel)}</a></li>`,
                )
                .join('')}</ul></details>`,
          )
          .join('')
      : '';
  };
  const docsHtml = docs.length
    ? renderDocGroups(docs)
    : '<div class="card empty"><p class="muted small">No docs found — is <code>data/hub/nanoclaw-docs</code> linked to the repo <code>docs/</code> folder? Re-run the nano-pvt-hub scaffold.</p></div>';

  return `<h1>Docs Hub</h1>
<p class="muted">A tailnet-only document repository. NanoClaw Docs are the complete read-only view of the repo <code>docs/</code>, including the <code>local/</code> overlay. Dashboards, Trackers, and Agent Docs are published by agents and the host through the <code>nano-pvt-hub</code> skill. Nothing here is search-indexed.</p>
<section aria-labelledby="nanoclaw-docs-title"><h2 id="nanoclaw-docs-title">NanoClaw Docs <span class="muted small">${docs.length}</span></h2>
<p class="muted small">Canonical project documentation, served read-only — the live repo docs folder, not a regenerated copy.</p>
${docsHtml}
</section>
${artifactSection('Dashboards', 'dashboard', 'Dashboards agents build for you.', 'No dashboards yet — publish one with the nano-pvt-hub skill.')}
${artifactSection('Trackers', 'tracker', 'Live status pages, append-only logs, and tables agents maintain.', 'No trackers yet.')}
${artifactSection('Agent Docs', 'agent-doc', 'Reference docs agents keep for themselves.', 'No agent docs yet.')}`;
}

/**
 * Serve a trace/session file for viewing in the browser. Restricted to files
 * that resolve (after symlink resolution) under data/v2-sessions — the only
 * root trace-file paths ever point into (see readers/tokens.ts listJsonlFiles)
 * — so a tampered `path` query can't read arbitrary disk.
 *
 * Default view pretty-prints the JSONL transcript (one event per block, long
 * embedded values elided so base64 blobs don't bloat the page). `?raw=1`
 * streams the file unmodified.
 */
function serveTraceFile(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  channels: string[],
  actionToken: string,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  const requested = url.searchParams.get('path') ?? '';
  const root = path.resolve(PATHS.sessionsDir);
  const realRoot = safe(() => fs.realpathSync(root), root);
  const target = path.resolve(requested);
  const isFile = safe(() => fs.statSync(target).isFile(), false);
  const real = isFile ? safe(() => fs.realpathSync(target), target) : null;
  const withinRoot = real === realRoot || real?.startsWith(`${realRoot}${path.sep}`);
  if (!isFile || !real || !withinRoot) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  // Raw escape hatch — stream unmodified, no whole-file memory load.
  if (url.searchParams.get('raw') === '1') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': fs.statSync(real).size,
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(real).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.method === 'HEAD') return void res.end();
  res.end(layout('Trace', '', traceFileBody(real, requested), channels, actionToken));
}

/** Cap for a single string leaf before it's elided in the pretty-printed trace. */
const TRACE_MAX_VALUE_CHARS = 300;

/** Recursively shorten long string leaves so embedded base64/blobs (some trace
 * lines carry 100KB+ of inline image/tool-result data) don't bloat the page. */
function elideLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= TRACE_MAX_VALUE_CHARS
      ? value
      : `${value.slice(0, TRACE_MAX_VALUE_CHARS)}… [${value.length - TRACE_MAX_VALUE_CHARS} more chars elided]`;
  }
  if (Array.isArray(value)) return value.map(elideLongStrings);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = elideLongStrings(v);
    return out;
  }
  return value;
}

/** Pretty-printed JSONL transcript: one indented block per event, headed by its
 * line number, `type`, and timestamp. Unparseable lines are shown verbatim. */
function traceFileBody(absPath: string, displayPath: string): string {
  const stat = safe(() => fs.statSync(absPath), null);
  const raw = safe(() => fs.readFileSync(absPath, 'utf8'), null);
  if (raw === null) return `<h1>Trace file</h1><p class="muted">Unable to read this file.</p>`;
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const blocks = lines
    .map((line, i) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return `<div class="trace-ev"><div class="trace-hd">#${i + 1} · <span class="muted">unparseable line</span></div><pre class="log">${esc(line.slice(0, 2000))}</pre></div>`;
      }
      const rec = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const type = typeof rec.type === 'string' ? rec.type : '?';
      const ts = typeof rec.timestamp === 'string' ? fmtTs(rec.timestamp) : '';
      const pretty = JSON.stringify(elideLongStrings(parsed), null, 2);
      return `<div class="trace-ev"><div class="trace-hd">#${i + 1} · <b>${esc(type)}</b>${ts ? ` · <span class="muted">${esc(ts)}</span>` : ''}</div><pre class="log">${esc(pretty)}</pre></div>`;
    })
    .join('\n');
  return `<div class="flow-head"><h1 style="margin:0">Trace file</h1>
<a class="chip" href="/trace-file?path=${encodeURIComponent(displayPath)}&raw=1" target="_blank" rel="noopener">raw ↗</a></div>
<p class="muted small"><code>${esc(displayPath)}</code> · ${lines.length} events${stat ? ` · ${fmtBytes(stat.size)}` : ''} · long values elided</p>
${blocks || '<p class="muted">Empty file.</p>'}`;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

/** Sum a metric family (e.g. tokens_out.*) per matching metric over a window. */
function sumByMetricLike(
  opsDb: Database.Database,
  groupId: string,
  like: string,
  sinceIso: string,
): { metric: string; total: number }[] {
  return opsDb
    .prepare(
      `SELECT metric, SUM(value) AS total FROM samples WHERE group_id = ? AND metric LIKE ? AND ts >= ? GROUP BY metric`,
    )
    .all(groupId, like, sinceIso) as { metric: string; total: number }[];
}

function costEstimate(
  cfg: OpsConfig,
  byModel: Map<string, { in: number; out: number; cr: number; cc: number }>,
): number {
  let usd = 0;
  for (const [model, t] of byModel) {
    const price = Object.entries(cfg.pricing).find(([k]) => model.includes(k))?.[1] ?? { input: 3, output: 15 };
    usd +=
      (t.in / 1e6) * price.input +
      (t.out / 1e6) * price.output +
      (t.cr / 1e6) * price.input * cfg.cacheReadMult +
      (t.cc / 1e6) * price.input * cfg.cacheWriteMult;
  }
  return usd;
}

/** Rolling 5h / 7d consumption (messages + tokens) for a group — the headline usage figure. */
function consumptionStrip(opsDb: Database.Database, groupId: string): string {
  const now = new Date();
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const win = (fromIso: string) => {
    const msgs =
      sumWindow(opsDb, groupId, 'msgs_in', fromIso, now) + sumWindow(opsDb, groupId, 'msgs_out', fromIso, now);
    const tokOut = sumWindow(opsDb, groupId, 'tokens_out.%', fromIso, now, true);
    const tokIn = sumWindow(opsDb, groupId, 'tokens_in.%', fromIso, now, true);
    return { msgs, tokOut, tokIn };
  };
  const h5 = win(since(5 * 3.6e6));
  const d7 = win(since(7 * 8.64e7));
  const cell = (label: string, w: { msgs: number; tokOut: number; tokIn: number }) =>
    `<span>${label} <b>${Math.round(w.msgs)} msgs · ${fmtTokens(w.tokOut)}↑ ${fmtTokens(w.tokIn)}↓ tokens</b></span>`;
  return `${cell('last 5h', h5)}${cell('last 7d', d7)}`;
}

function tokensByModel(opsDb: Database.Database, groupId: string, sinceIso: string) {
  const byModel = new Map<string, { in: number; out: number; cr: number; cc: number }>();
  const grab = (like: string, key: 'in' | 'out' | 'cr' | 'cc') => {
    for (const r of sumByMetricLike(opsDb, groupId, like, sinceIso)) {
      const model = r.metric.split('.').slice(1).join('.');
      const t = byModel.get(model) ?? { in: 0, out: 0, cr: 0, cc: 0 };
      t[key] += r.total;
      byModel.set(model, t);
    }
  };
  grab('tokens_in.%', 'in');
  grab('tokens_out.%', 'out');
  grab('tokens_cache_read.%', 'cr');
  grab('tokens_cache_create.%', 'cc');
  return byModel;
}

function p95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

/**
 * p95 of the SLO "latency proxy" — per-minute `latency_ms_max` samples over a
 * window. This is the same signal shown on the SLO baseline card and, unlike
 * per-message reply latency (which needs `in_reply_to` linkage agents rarely
 * set), it is populated for every group with traffic.
 */
function latencyP95Proxy(opsDb: Database.Database, groupId: string, fromIso: string, toIso: string): number | null {
  const rows = opsDb
    .prepare("SELECT value FROM samples WHERE group_id = ? AND metric = 'latency_ms_max' AND ts >= ? AND ts <= ?")
    .all(groupId, fromIso, toIso) as { value: number }[];
  return p95(rows.map((r) => r.value));
}

function midnightIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function aggregateTrafficChart(
  opsDb: Database.Database,
  groups: { id: string; name: string }[],
  toIso: string,
  markers?: UsageMarker[],
): string {
  const fromIso = new Date(Date.parse(toIso) - 8.64e7).toISOString();
  return usageChart(
    usageBucketsByGroup(
      opsDb,
      groups.map((group) => group.id),
      fromIso,
      toIso,
    ),
    {
      w: 1040,
      h: 130,
      label: 'Traffic & usage — all groups, last 24h',
      groups: Object.fromEntries(groups.map((group) => [group.id, group.name])),
      markers,
    },
  );
}

// ---------------------------------------------------------------- overview
async function overviewBody(cfg: OpsConfig, opsDb: Database.Database, collector: Collector): Promise<string> {
  const snap = await collector.buildLiveSnapshot();
  const since = midnightIso();
  const dayAgo = new Date(Date.now() - 8.64e7).toISOString();
  const nowMs = Date.parse(snap.ts);
  const availableSkills = safe(() => listAvailableSkills(), [] as SkillInfo[]);
  const rows: string[] = [];
  const agentGroups = safe(() => listAgentGroups(), []);
  const routingNames = new Map(agentGroups.map((group) => [group.id, group.folder]));
  // Per-group all-time recall stats for the card metrics row. groupDbPaths only
  // includes groups with an existing memory.db, so storeless groups fall through
  // to null (rendered as "–") rather than a misleading 0.
  const memStatsByGroup = new Map(
    safe(() => readPerGroupMemoryStats(groupDbPaths(agentGroups)), []).map((s) => [s.group.id, s] as const),
  );
  for (const g of snap.groups) {
    const byModel = tokensByModel(opsDb, g.id, since);
    const { latencies } = todaysDetail(cfg, g.id, since);
    const lifecycleRows = listEventsByKind(opsDb, g.id, ['container_spawn', 'container_exit'], dayAgo);
    const spans = buildSpans(lifecycleRows, {
      fromMs: nowMs - 8.64e7,
      nowMs,
      containersUpNow: g.containersUp,
      lastActiveSampleMs: lastActiveSampleMs(opsDb, g.id, dayAgo),
    });
    const subagentTicks = listEventsByKind(opsDb, g.id, ['subagent_spawn'], dayAgo).flatMap((r) => {
      try {
        const d = JSON.parse(r.detail) as { model?: string };
        return [{ tsMs: Date.parse(r.ts), model: d.model ?? 'unknown' }];
      } catch {
        return [];
      }
    });
    const compactionsToday = listEventsByKind(opsDb, g.id, ['compaction'], since).length;
    const subOut = new Map(
      sumByMetricLike(opsDb, g.id, 'sub_tokens_out.%', since).map((r) => [
        r.metric.split('.').slice(1).join('.'),
        r.total,
      ]),
    );
    const spawnsByModel = new Map<string, number>();
    for (const t of subagentTicks) {
      if (t.tsMs >= Date.parse(since)) spawnsByModel.set(t.model, (spawnsByModel.get(t.model) ?? 0) + 1);
    }
    const mix: ModelMixEntry[] = [...byModel.entries()].map(([model, t]) => ({
      model,
      out: t.out,
      subOut: subOut.get(model) ?? 0,
      subSpawns: spawnsByModel.get(model) ?? 0,
    }));
    const gcfg = safe(() => getGroupConfig(g.id), null);
    const sk = resolveGroupSkills(gcfg?.skills ?? null, availableSkills);
    const template = groupTemplateInfo(routingNames.get(g.id) ?? g.id);
    // Senders + latency proxy for the card. Senders come from the last 24h (the
    // band is labelled "24h" and matches the ribbon), classified against the
    // allowlist; the p95 latency proxy is the SLO signal over its configured window.
    const memberIds = new Set(safe(() => listMembersForGroup(g.id), [] as MemberInfo[]).map((m) => m.user_id));
    const senderAgg = aggregateSenders(g.id, dayAgo, memberIds);
    const sloFromIso = new Date(nowMs - cfg.sloWindowDays * 86_400_000).toISOString();
    const extras: GroupCardExtras = {
      routingName: routingNames.get(g.id) ?? g.id,
      skills: { mode: sk.mode, enabledIds: [...sk.enabledIds], total: availableSkills.length },
      template:
        template.status === 'none'
          ? undefined
          : {
              status: template.status,
              ref: template.ref,
              skillCount: template.skills.length,
              opsCenterLabel: template.opsCenter?.label ?? null,
            },
      tokensToday: [...byModel.entries()].map(([model, t]) => ({ model, out: t.out, in: t.in })),
      costTodayUsd: costEstimate(cfg, byModel),
      senders: {
        unique: senderAgg.length,
        unknown: senderAgg.filter((s) => !senderChannelInternal(s.channel) && !s.member).length,
        top: senderAgg.slice(0, 2).map((s) => ({ name: s.name, channel: s.channel })),
      },
      latencyP95ProxyMs: latencyP95Proxy(opsDb, g.id, sloFromIso, snap.ts),
      sloWindowDays: cfg.sloWindowDays,
      p95Ms: p95(latencies),
      spans,
      subagentTicks,
      compactionsToday,
      recalls: memStatsByGroup.get(g.id)?.recalls ?? null,
      recallHitRate: memStatsByGroup.get(g.id)?.hitRate ?? null,
      nowMs,
      mix,
      wirings: safe(() => listWiringsForGroup(g.id), [] as WiringInfo[]),
      maxMessagesPerPrompt: gcfg?.max_messages_per_prompt ?? null,
    };
    rows.push(fleetCard(g, extras));
  }
  const allByModel = tokensByModel(opsDb, 'all', since);
  // Scheduled section first: it emits the numbered fire-markers the traffic
  // chart overlays, so the chip badges and chart pins share one numbering.
  const sched = buildScheduledSection(nowMs);
  const totalRow = `<div class="card" style="margin-bottom:14px"><h3>All groups — usage</h3>
<div class="kv">${consumptionStrip(opsDb, 'all')}</div>
<div class="kv">
<span>today <b>${snap.groups.reduce((a, g) => a + g.todayIn, 0)} in / ${snap.groups.reduce((a, g) => a + g.todayOut, 0)} out</b></span>
<span>by model <b>${[...allByModel.entries()].map(([m, t]) => `${fmtTokens(t.out)}↑ ${shortModel(m)}`).join(' · ') || '0'}</b></span>
</div>
${aggregateTrafficChart(opsDb, snap.groups, snap.ts, sched.markers)}
</div>`;
  const curQuota = safe(
    () =>
      readClaudeQuota({ source: cfg.quotaSource, cacheFile: PATHS.statuslineUsageCache, staleMs: cfg.quotaStaleMs }),
    null,
  );
  const quotaRow = `<div style="margin-bottom:14px">${quotaChart(
    getSeries(opsDb, 'host', 'quota.claude_5h', dayAgo, snap.ts, 'max'),
    getSeries(opsDb, 'host', 'quota.claude_7d', dayAgo, snap.ts, 'max'),
    { w: 1040, h: 170, label: 'Subscription quota — last 24h (5h / 7d window utilization)', current: curQuota, nowMs },
  )}</div>`;

  const activeN = snap.groups.filter((g) => g.containersUp > 0).length;

  const attention = attentionCard(snap, sched.retrying, opsDb);

  // Global-info band leads the page: fleet-wide usage, scheduled automation,
  // and a compact attention summary. Per-group detail and the subscription-
  // quota chart follow.
  return `<h1>Overview</h1>
${totalRow}
${sched.card}
${attention}
<h2>Fleet · ${snap.groups.length} group${snap.groups.length === 1 ? '' : 's'} · ${activeN} active now</h2>
<div class="compact-fleet">${rows.join('')}</div>
${quotaRow}`;
}

/** Humanize a 5-field cron expression into a glanceable cadence phrase. Falls
 *  back to the raw expression for anything it doesn't recognize. */
function humanizeCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length < 5) return cron;
  const [, , dom, mon, dow] = f;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (dom === '*' && mon === '*' && dow === '*') return 'daily';
  if (dow !== '*') {
    const n = Number(dow);
    return Number.isInteger(n) && n >= 0 && n <= 6 ? `weekly · ${DOW[n]}` : 'weekly';
  }
  if (dom !== '*') return `monthly · day ${dom}`;
  return cron;
}

/** Every scheduled-task firing across the fleet in a window (completed rows). */
function allFirings(sinceMs: number, nowMs: number): ScheduledFiring[] {
  return safe(() => listSessionDirs(), []).flatMap((dir) => safe(() => readRecentFirings(dir.dir, sinceMs, nowMs), []));
}

/**
 * Overview "Scheduled actions" strip + the chart's fire-markers, built together
 * so the numbering stays in sync. Every pending/paused scheduled task is a chip
 * (soonest first); a chip whose series already fired in the last 24h gets a
 * number badge, and the returned `markers` place that same number on the traffic
 * chart at each firing — so the operator can see the action actually ran.
 */
function buildScheduledSection(nowMs: number): { card: string; markers: UsageMarker[]; retrying: number } {
  const tasks = allWork()
    .filter((w) => w.kind === 'task')
    .sort((a, b) => {
      const pri = (s: string) => (s === 'due' ? 0 : s === 'scheduled' ? 1 : 2);
      return pri(a.state) - pri(b.state) || (a.state === 'scheduled' ? a.ageMs - b.ageMs : b.ageMs - a.ageMs);
    });

  // Firings in the last 24h, most-recent kept per series, then number the chips
  // that fired (in display order) so badge N ⟺ chart marker N.
  const firings = allFirings(nowMs - 8.64e7, nowMs);
  const lastFired = new Map<string, number>();
  for (const f of firings) {
    const cur = lastFired.get(f.seriesId);
    if (cur == null || f.firedAtMs > cur) lastFired.set(f.seriesId, f.firedAtMs);
  }
  const seriesNum = new Map<string, number>();
  for (const t of tasks) {
    if (t.seriesId && lastFired.has(t.seriesId) && !seriesNum.has(t.seriesId))
      seriesNum.set(t.seriesId, seriesNum.size + 1);
  }
  const markers: UsageMarker[] = firings.flatMap((f) => {
    const n = seriesNum.get(f.seriesId);
    return n == null ? [] : [{ atMs: f.firedAtMs, n, label: f.summary.slice(0, 60) }];
  });

  const CAP = 14;
  const chips = tasks.slice(0, CAP).map((t) => {
    const rec = t.recurrence ?? null;
    const clean = rec && t.summary.endsWith(` · ${rec}`) ? t.summary.slice(0, -(3 + rec.length)) : t.summary;
    const truncated = clean.length > 40;
    const label = truncated ? clean.slice(0, 39).trimEnd() + '…' : clean;
    const cadence = rec ? humanizeCron(rec) : 'one-time';
    const when = t.state === 'paused' ? 'paused' : t.state === 'due' ? 'due now' : `in ${fmtAge(t.ageMs)}`;
    const num = t.seriesId ? seriesNum.get(t.seriesId) : undefined;
    const firedMs = t.seriesId ? lastFired.get(t.seriesId) : undefined;
    const cls = `${t.state === 'due' ? ' due' : t.state === 'paused' ? ' paused' : ''}${num ? ' fired' : ''}`;
    const lead = num ? `<span class="sn">${num}</span>` : '<span class="ic">◷</span>';
    const firedLine =
      firedMs != null
        ? `<span class="lastfire">▲ fired ${esc(fmtTs(new Date(firedMs).toISOString()))} · ${esc(fmtAge(nowMs - firedMs))} ago — marker ${num} on the chart above</span>`
        : '';
    const next =
      t.state === 'paused'
        ? 'Paused — will not fire until resumed'
        : `Next: ${fmtTs(t.dueAt)} · ${t.state === 'scheduled' ? `in ${fmtAge(t.ageMs)}` : 'overdue'}`;
    return `<span class="sched-chip${cls}" tabindex="0">${lead}<span class="lbl">${esc(
      label,
    )}</span><span class="when">${esc(when)}</span><span class="sched-pop"><b>${esc(
      truncated ? label : clean,
    )}</b><span class="meta">${esc(t.groupName)} · ${esc(cadence)}</span>${
      truncated ? `<span class="body">${esc(clean)}</span>` : ''
    }${firedLine}<span class="next">${esc(next)}</span></span></span>`;
  });
  const more =
    tasks.length > CAP
      ? `<span class="sched-chip"><span class="lbl muted">+${tasks.length - CAP} more · see group pages</span></span>`
      : '';
  const activeN = tasks.filter((t) => t.state !== 'paused').length;
  const pausedN = tasks.length - activeN;
  const firedN = seriesNum.size;
  const body = chips.length
    ? `<div class="sched-row">${chips.join('')}${more}</div>`
    : `<div class="sched-empty">No scheduled actions across the fleet.</div>`;
  const card = `<div class="card sched"><h3>Scheduled actions <span class="hint">${activeN} active${
    pausedN ? ` · ${pausedN} paused` : ''
  }${firedN ? ` · <span class="fired-hint">${firedN} fired in 24h ↓</span>` : ''}${
    tasks.length ? ' · hover for details' : ''
  }</span></h3>${body}</div>`;
  return { card, markers, retrying: tasks.filter((task) => (task.tries ?? 0) >= 2).length };
}

function attentionCard(
  snap: LiveSnapshot,
  retrying: number,
  opsDb: Database.Database,
): string {
  const unanswered = snap.groups.reduce((total, group) => total + group.unanswered, 0);
  const blocked = snap.groups.filter((group) => group.queueDepth > 0 && group.containersUp === 0);
  const incidents = safe(() => listIncidents(opsDb, 'open', 4), []);
  const current = snap.openIncidents + unanswered + snap.queues.approvals + retrying + blocked.length;
  const history = snap.queues.droppedSenders + snap.queues.droppedMessages;
  const groupLinks = blocked
    .concat(snap.groups.filter((group) => group.unanswered > 0 && !blocked.some((item) => item.id === group.id)))
    .slice(0, 4)
    .map(
      (group) =>
        `<a href="/group/${encodeURIComponent(group.id)}">${esc(group.name)}</a> · ${group.unanswered > 0 ? `${group.unanswered} unanswered` : `${group.queueDepth} queued without a container`}`,
    )
    .join(' · ');
  return `<div class="card attention-summary"><h3>Attention <span class="hint">${current ? `${current} current signal${current === 1 ? '' : 's'}` : 'all clear'}</span></h3>
<div class="kv"><span>incidents <b>${snap.openIncidents}</b></span><span>unanswered <b>${unanswered}</b></span><span>approvals <b>${snap.queues.approvals}</b></span><span>blocked queues <b>${blocked.length}</b></span><span>retrying tasks <b>${retrying}</b></span>${history ? `<span>historical dropped <b>${snap.queues.droppedSenders} sender${snap.queues.droppedSenders === 1 ? '' : 's'} / ${snap.queues.droppedMessages} message${snap.queues.droppedMessages === 1 ? '' : 's'}</b></span>` : ''}</div>
${incidents.length ? `<p class="small"><b>Open incidents:</b> ${incidents.map((incident) => `<a href="/system#host-events">${esc(incident.title)}</a>`).join(' · ')}</p>` : ''}
${groupLinks ? `<p class="small"><b>Groups to inspect:</b> ${groupLinks}</p>` : ''}
${current === 0 && !history ? '<p class="muted small">No incidents, unanswered messages, pending approvals, retried tasks, or blocked queues.</p>' : ''}
</div>`;
}

async function appsBody(collector: Collector): Promise<string> {
  const snap = await collector.buildLiveSnapshot();
  const rows = snap.groups
    .map(
      (
        g,
      ) => `<tr data-rowhref="/group/${encodeURIComponent(g.id)}"><td><a href="/group/${encodeURIComponent(g.id)}"><b>${esc(g.name)}</b></a>
<div class="muted small">${esc(g.id)}</div></td>
<td><span class="dot ${g.lifecycleStatus === 'running' ? 'ok' : g.lifecycleStatus === 'error' ? 'bad' : g.lifecycleStatus === 'paused' ? 'warn' : ''}"></span>${esc(g.lifecycleStatus)}</td>
<td><span style="color:var(--ok);font:500 11.5px var(--mono)">${esc(shortModel(g.model ?? '–'))}</span></td><td>${g.sessions}</td>
<td>${g.queueDepth > 0 ? `<b style="color:var(--act)">${g.queueDepth}</b>` : g.queueDepth}</td>
<td>${g.inflight > 0 ? `<b style="color:var(--act)">${g.inflight}</b>` : g.inflight}</td>
<td>${g.unanswered > 0 ? `<b style="color:var(--warn)">${g.unanswered}</b>` : g.unanswered}</td>
<td>${g.currentTool ? `<span class="state info">${esc(g.currentTool)}</span>` : '–'}</td></tr>`,
    )
    .join('');
  return `<h1>Apps</h1>
<p class="muted">Container-oriented index. Open an app for controls, skills, allowlist, scheduled tasks, events, and message journeys.</p>
<table><tr><th>app</th><th>container</th><th>model</th><th>sessions</th><th>queue</th><th>in flight</th><th>unanswered</th><th>current tool</th></tr>
${rows || '<tr><td colspan=8 class="muted">No agent groups found.</td></tr>'}</table>`;
}

function todaysDetail(cfg: OpsConfig, groupId: string, sinceIso: string) {
  const latencies: number[] = [];
  const senders = new Map<string, Set<string>>();
  for (const d of safe(() => listSessionDirs(), []).filter((x) => x.groupId === groupId)) {
    const st = safe(
      () => readSessionStats(d.dir, sinceIso, { unansweredAfterMs: cfg.alerts.unansweredAfterMs, nowMs: Date.now() }),
      null,
    );
    if (!st) continue;
    latencies.push(...st.latencies);
    for (const [ch, set] of st.sendersToday) {
      if (!senders.has(ch)) senders.set(ch, new Set());
      for (const s of set) senders.get(ch)!.add(s);
    }
  }
  return { latencies, senders };
}

/** Most recently stamped runtime provenance for a group's session tree. */
function latestRuntimeManifestForGroup(groupId: string): RuntimeManifest | null {
  return (
    safe(
      () =>
        listSessionDirs()
          .filter((session) => session.groupId === groupId)
          .map((session) => readRuntimeManifest(session.dir))
          .filter((manifest): manifest is RuntimeManifest => manifest != null)
          .sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at))[0] ?? null,
      null,
    ) ?? null
  );
}

function groupTemplateInfo(groupFolder: string): GroupTemplateInfo {
  return safe(
    () => readGroupTemplate(path.join(PATHS.groupsDir, groupFolder)),
    readGroupTemplate(path.join(PATHS.groupsDir, groupFolder), () => null),
  );
}

// ---------------------------------------------------------------- group page
async function groupBody(
  cfg: OpsConfig,
  opsDb: Database.Database,
  collector: Collector,
  groupId: string,
  range: string,
): Promise<string> {
  const spanMs = RANGES[range] ?? RANGES['24h'];
  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.now() - spanMs).toISOString();
  const snap = await collector.buildLiveSnapshot();
  const g = snap.groups.find((x) => x.id === groupId);
  if (!g) return `<h1>Unknown group ${esc(groupId)}</h1>`;
  const routingName = safe(() => listAgentGroups().find((group) => group.id === groupId)?.folder ?? groupId, groupId);

  const ranges = Object.keys(RANGES)
    .map((r) => `<a href="/group/${esc(groupId)}?range=${r}" class="${r === range ? 'active' : ''}">${r}</a>`)
    .join('');

  const byModel = tokensByModel(opsDb, groupId, fromIso);
  const { latencies, senders } = todaysDetail(cfg, groupId, midnightIso());

  // token series: sum tokens_out.* per timestamp
  const tokenSeries = mergeSeries(
    [...byModel.keys()].map((m) => getSeries(opsDb, groupId, `tokens_out.${m}`, fromIso, toIso, 'sum')),
  );

  const availableSkills = safe(() => listAvailableSkills(), [] as SkillInfo[]);
  const members = safe(() => listMembersForGroup(groupId), [] as MemberInfo[]);
  const memberIds = new Set(members.map((m) => m.user_id));
  const wirings = safe(() => listWiringsForGroup(groupId), [] as WiringInfo[]);
  const connectedChannels = [...new Set(wirings.map((w) => w.channel_type).filter((c): c is string => !!c))];
  const sendersRows = sendersTable(cfg, groupId, fromIso, memberIds);
  // "Recent routing decisions" is driven by the reliable subagent_spawn event
  // stream (collected from agent JSONLs). Each spawn carries a reason derived
  // from its transcript (parent Task description, or the subagent's own prompt);
  // `[model — reason]` text lines are a secondary source only when a spawn has
  // no transcript reason.
  const lineDecisions = safe(() => listSessionDirs(), [])
    .filter((d) => d.groupId === groupId)
    .flatMap((d) => safe(() => readRoutingDecisions(d.dir, fromIso), []));
  const spawnDecisions = safe(
    () =>
      listEventsByKind(opsDb, groupId, ['subagent_spawn'], fromIso).flatMap((r) => {
        try {
          const det = JSON.parse(r.detail) as { model?: string; file?: string; reason?: string };
          return [{ ts: r.ts, model: det.model ?? 'unknown', file: det.file, reason: det.reason }];
        } catch {
          return [];
        }
      }),
    [] as SpawnDecision[],
  );
  const decisions = mergeRoutingDecisions(spawnDecisions, lineDecisions).slice(0, 15);
  const events = opsDb
    .prepare(
      "SELECT ts, kind, severity, detail FROM events WHERE group_id IN (?, 'host') AND ts >= ? ORDER BY ts DESC LIMIT 80",
    )
    .all(groupId, fromIso) as { ts: string; kind: string; severity: string; detail: string }[];
  const tasks = safe(() => listSessionDirs(), [])
    .filter((d) => d.groupId === groupId)
    .flatMap((d) =>
      safe(
        () =>
          readSessionStats(d.dir, toIso, { unansweredAfterMs: cfg.alerts.unansweredAfterMs, nowMs: Date.now() })
            .scheduledTasks,
        [],
      ),
    );
  const agentNames = new Map(safe(() => listAgentGroups(), []).map((g) => [g.id, g.name]));
  const agentConnections = safe(() => listAgentConnections(groupId), [] as AgentConnectionInfo[]);
  const journeys = safe(() => listSessionDirs(), [])
    .filter((d) => d.groupId === groupId)
    .flatMap((d) => safe(() => readMessageJourneys(d.dir, { limit: 30, agentNames }), []))
    .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    .slice(0, 60);
  const slo = calculateGroupSlo(opsDb, groupId, journeys, new Date(), cfg.sloWindowDays, cfg.passiveCanaryMaxAgeMs);

  const groupConfig = safe(() => getGroupConfig(groupId), undefined);
  const piHealth = groupConfig?.provider === 'pi' ? safe(() => readPiRuntimeHealth(PATHS.sessionsDir, groupId), null) : null;
  const template = groupTemplateInfo(routingName);
  const latestRuntime = latestRuntimeManifestForGroup(groupId);
  const currentRuntimeFingerprint =
    safe(
      () => computeRuntimeFingerprint(ROOT, template.status === 'ready' && template.root ? [template.root] : []),
      null,
    );
  const imageTag = groupConfig?.image_tag || readEnvKey('CONTAINER_IMAGE') || getDefaultContainerImage(ROOT);
  const imageStatus = safe(() => readContainerImageStatus(imageTag), null);
  const imageBuild = safe(() => readImageBuildManifest(), {
    dockerfilePath: 'container/Dockerfile',
    baseImage: null,
    bakedTools: [],
    pythonPackages: [],
    aptPackages: [],
  });
  const runtimeHooks = safe(() => readGroupRuntimeHooks(groupId), {
    settingsPath: '',
    exists: false,
    preToolUse: [],
    rtkActive: false,
  });

  const dayAgo = new Date(Date.now() - 8.64e7).toISOString();
  return `<a class="backlink" href="/">← Overview</a>
<h1>${esc(g.name)} <span class="pill">${esc(routingName)}</span></h1>
<div class="kv" style="margin-bottom:10px">${consumptionStrip(opsDb, groupId)}</div>
${usageChart(usageBuckets(opsDb, groupId, dayAgo, toIso), { w: 1040, h: 150, label: 'Activity — last 24h (10-min buckets)' })}
<div class="range">Range: ${ranges}</div>
<div class="cards kpi">
<div class="card"><h3>Messages</h3>
${svgChart(getSeries(opsDb, groupId, 'msgs_in', fromIso, toIso, 'sum'), { w: 480, h: 70, label: 'in' })}
${svgChart(getSeries(opsDb, groupId, 'msgs_out', fromIso, toIso, 'sum'), { w: 480, h: 70, label: 'out', color: '#a78bfa' })}
<div class="kv"><span>p95 latency today <b>${p95(latencies) != null ? fmtAge(p95(latencies)) : '–'}</b></span>
<span>unanswered <b>${g.unanswered}</b></span><span>queue <b id="g-${esc(groupId)}-queue">${g.queueDepth}</b></span></div></div>
<div class="card"><h3>Tokens (${esc(range)})</h3>
${svgChart(tokenSeries, { w: 480, h: 70, label: 'tokens out (all models)', color: '#ffb020' })}
<table><tr><th>model</th><th>in</th><th>out</th><th>cache read</th><th>cache write</th></tr>
${[...byModel.entries()]
  .map(
    ([m, t]) =>
      `<tr><td>${esc(shortModel(m))}</td><td>${fmtTokens(t.in)}</td><td>${fmtTokens(t.out)}</td><td>${fmtTokens(t.cr)}</td><td>${fmtTokens(t.cc)}</td></tr>`,
  )
  .join('')}</table>
<div class="kv"><span>≈ cost (${esc(range)}) <b>$${costEstimate(cfg, byModel).toFixed(3)}</b> <span class="muted small">estimate</span></span></div></div>
<div class="card"><h3>Recent routing decisions</h3>
${
  decisions.length
    ? `<table><tr><th>when</th><th>model</th><th>reason</th></tr>${decisions
        .map(
          (d) =>
            `<tr><td class="muted small">${esc(new Date(d.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td><td><b>${esc(d.model)}</b>${d.source === 'spawn' ? ' <span class="pill">subagent</span>' : ''}</td><td>${esc(d.reason)}${d.source === 'spawn' && d.file ? ` <span class="muted small">${esc(d.file)}</span>` : ''}</td></tr>`,
        )
        .join('')}</table>`
    : `<p class="muted small">No delegations in this range. Rows appear when the agent spawns a subagent; the reason is the parent task's description, or the subagent's own prompt when that isn't available.</p>`
}</div>
</div>
<div class="masonry">
${skillsCard(
  groupId,
  g.name,
  availableSkills,
  resolveGroupSkills(
    safe(() => getGroupConfig(groupId)?.skills ?? null, null),
    availableSkills,
  ),
  `<div class="kv"><span>container <b id="g-${esc(groupId)}-cstat">…</b></span></div>`,
)}
${templateCard(template, { currentRuntimeFingerprint, latestRuntime })}
${channelsCard(wirings)}
${allowlistCard(members, connectedChannels)}
${agentConnectionsCard(agentConnections)}
<div class="card"><h3>Senders (${esc(range)})</h3>
<p class="muted small">Everyone who messaged this group in range. "status" shows whether the sender is on the allowlist (wakes the agent) or is ignored as unknown.</p>
<div class="scrollbox"><table><tr><th>sender</th><th>channel</th><th>msgs</th><th>last seen</th><th>status</th></tr>${sendersRows}</table></div>
<div class="kv"><span>unique today <b>${[...senders.values()].reduce((a, s) => a + s.size, 0)}</b></span></div></div>
<div class="card"><h3>Scheduled tasks <span class="muted small">${tasks.length}</span></h3>
<div class="scrollbox"><table><tr><th>id</th><th>status</th><th>content</th></tr>
${tasks.map((t) => `<tr><td class="small">${esc(t.id)}</td><td>${esc(t.status)}</td><td class="small">${esc(t.content.slice(0, 160))}</td></tr>`).join('') || '<tr><td colspan=3 class="muted">none</td></tr>'}</table></div></div>
<div class="card"><h3>SLO baseline · ${slo.windowDays}d</h3>
<div class="kv"><span>out/in proxy <b>${slo.responseRatio == null ? '–' : `${(slo.responseRatio * 100).toFixed(1)}%`}</b></span>
<span>latency p95 proxy <b>${slo.latencyP95ProxyMs == null ? '–' : fmtAge(slo.latencyP95ProxyMs)}</b></span>
<span>tokens / response <b>${slo.tokensPerResponse == null ? '–' : fmtTokens(slo.tokensPerResponse)}</b></span>
<span>unanswered sample-minutes <b>${slo.unansweredSamples}</b></span></div>
<p class="muted small">Out/in is capped at 100% because out-of-band sends can exceed inbound count. Latency is p95 of per-minute maxima until individual latency samples are persisted.</p>
<p><span class="dot ${slo.passiveCanary.status === 'healthy' ? 'ok' : slo.passiveCanary.status === 'stale' ? 'warn' : ''}"></span>
Passive canary: <b>${esc(slo.passiveCanary.status)}</b> · last confirmed delivery
${slo.passiveCanary.ageMs == null ? 'unknown' : `${fmtAge(slo.passiveCanary.ageMs)} ago`}</p></div>
</div>
<div class="stack">
<div class="card"><h3>Voice notes</h3>
<p class="muted small">Inbound voice notes are transcribed at ingest (host-side, OneCLI gateway → OpenRouter whisper-large-v3) and the transcript is embedded in the message text. Per-chat toggle; applies live, no restart.</p>
${voiceTranscriptionControls(g, wirings)}</div>
${containerBuildCard(imageBuild, groupConfig, runtimeHooks, imageStatus ?? undefined, latestRuntime, currentRuntimeFingerprint)}
${providerSwitchCard(groupConfig)}
${groupConfig?.provider === 'pi' ? piRuntimeCard(piHealth) : ''}
${groupConfig?.provider === 'opencode' || groupConfig?.provider === 'pi' || groupConfig?.model_tiers ? modelsCard(groupConfig, readModelCatalog()) : ''}
<details class="card fold" style="grid-column:1/-1"><summary><h3>Events <span class="muted small">${events.length}${events.length >= 80 ? '+' : ''}</span></h3></summary>
<div class="fold-body"><p class="muted small">Container lifecycle, kills and host events for this group — newest first, times local. Hover a detail cell for the raw log line.</p>
${eventsTable(events)}</div></details>
<details class="card fold" style="grid-column:1/-1"><summary><h3>Message journey <span class="muted small">${journeys.length}</span></h3></summary>
<div class="fold-body"><p class="muted small">Exact linkage uses <code>in_reply_to</code>; inferred means outbound activity followed this inbound before the next trigger.</p>
${journeyTable(journeys)}</div></details>
</div>`;
}

function agentConnectionsCard(connections: AgentConnectionInfo[]): string {
  const policyLabel = (connection: AgentConnectionInfo): string => {
    if (connection.policyIds.length)
      return connection.policyIds.map((id) => `<span class="pill">${esc(id)}</span>`).join(' ');
    if (connection.revokedPolicyIds.length) {
      return connection.revokedPolicyIds
        .map(
          (id) =>
            `<span class="pill muted" title="The ACL remains because another/manual destination owns this edge">${esc(id)} revoked</span>`,
        )
        .join(' ');
    }
    return '<span class="muted small">manual ACL</span>';
  };
  const rows = connections
    .map((connection) => {
      const peerHref = `/group/${encodeURIComponent(connection.peerGroupId)}`;
      const local =
        connection.localName === '—' ? '<span class="muted">—</span>' : `<code>@${esc(connection.localName)}</code>`;
      const peerLocal = connection.peerLocalName
        ? `<code>@${esc(connection.peerLocalName)}</code>`
        : '<span class="muted">—</span>';
      return `<tr><td><span class="pill">${esc(connection.direction)}</span></td>
<td><a href="${esc(peerHref)}"><b>${esc(connection.peerName)}</b></a><div class="muted small">${esc(connection.peerGroupId)}</div></td>
<td>${local}</td><td>${peerLocal}</td><td>${policyLabel(connection)}</td></tr>`;
    })
    .join('');
  return `<div class="card"><h3>Allowed connections <span class="muted small">${connections.length} explicit A2A ACL${connections.length === 1 ? '' : 's'}</span></h3>
<p class="muted small">Outbound routes are destinations this container may address; inbound routes are peers allowed to message it. The host re-checks every A2A delivery against this ACL.</p>
<div class="scrollbox"><table><tr><th>direction</th><th>peer</th><th>local address</th><th>peer address</th><th>policy</th></tr>
${rows || '<tr><td colspan=5 class="muted">No agent-to-agent connections.</td></tr>'}</table></div></div>`;
}

/**
 * Translate a stored event's machine detail into a plain-English summary.
 * Returns '' when the kind/detail isn't recognized, so callers can fall back to '—'.
 */
export function describeEvent(kind: string, detail: string): string {
  const num = (re: RegExp): number | null => {
    const m = detail.match(re);
    return m ? Number(m[1]) : null;
  };
  const dur = (ms: number | null): string =>
    ms == null ? '?' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
  const sessTag = (id: string | undefined): string => (id ? ` · …${id.slice(-6)}` : '');
  try {
    switch (kind) {
      case 'container_spawn': {
        const d = JSON.parse(detail) as { sessionId?: string; trigger?: string };
        return `Container started${sessTag(d.sessionId)}${d.trigger ? ` — ${d.trigger}` : ''}`;
      }
      case 'subagent_spawn': {
        const d = JSON.parse(detail) as { model?: string; reason?: string };
        const fam = /(haiku|sonnet|opus)/i.exec(d.model ?? '')?.[1]?.toLowerCase() ?? (d.model || 'subagent');
        return d.reason ? `Subagent ${fam} — ${d.reason}` : `Subagent spawned (${fam})`;
      }
      case 'container_exit': {
        const d = JSON.parse(detail) as { code?: number; sessionId?: string; reason?: string };
        // Kill-derived exits carry a teardown reason instead of an OS code.
        const note =
          d.code === 0
            ? 'clean exit'
            : d.code === 137
              ? 'SIGKILL'
              : d.code === 143
                ? 'SIGTERM'
                : d.code != null
                  ? `code ${d.code}`
                  : (d.reason ?? 'killed');
        return `Container exited · ${note}${sessTag(d.sessionId)}`;
      }
      case 'container_kill': {
        if (/absolute ceiling/i.test(detail)) {
          const idleAge = num(/idleAgeMs=(\d+)/) ?? num(/heartbeatAgeMs=(\d+)/);
          const source = detail.match(/idleSource="?([\w-]+)"?/)?.[1] ?? 'heartbeat';
          const label = source === 'host-activity' ? 'host activity' : 'heartbeat';
          return `Killed — ${label} idle ${dur(idleAge)}, past ${dur(num(/ceilingMs=(\d+)/))} ceiling`;
        }
        if (/Killing container/i.test(detail)) {
          const reason = detail.match(/reason="?([\w-]+)"?/)?.[1];
          return `Killing container${reason ? ` (${reason})` : ''}`;
        }
        if (/Cleared orphan processing claims/i.test(detail))
          return `Cleared ${num(/cleared=(\d+)/) ?? '?'} orphan processing claim(s)`;
        if (/Reset stale message/i.test(detail))
          return `Stale message reset · try ${num(/tries=(\d+)/) ?? '?'}, retry in ${dur(num(/backoffMs=(\d+)/))}`;
        return 'Container kill signal';
      }
      case 'rate_limit':
        return 'Rate limit hit (HTTP 429)';
      case 'alert_sent':
        return detail; // already human-readable
      case 'backup_ok':
        return `Backup saved · ${path.basename(detail.split(' (')[0] ?? detail)}`;
      case 'rotation':
        return `Log rotated · ${path.basename(detail)}`;
      case 'opscenter_start':
        return `Ops Center started (${detail})`;
      default:
        return kind.startsWith('action:') ? `Operator action: ${kind.slice('action:'.length)}` : '';
    }
  } catch {
    return '';
  }
}

function eventsTable(events: { ts: string; kind: string; severity: string; detail: string }[]): string {
  return `<table><tr><th>time</th><th>event</th><th>what happened</th><th>detail</th></tr>
${
  events
    .map((e) => {
      const sev = e.severity === 'error' ? 'bad' : e.severity === 'warn' ? 'warn' : '';
      const summary = describeEvent(e.kind, e.detail);
      return `<tr><td class="small">${esc(fmtTs(e.ts))}</td><td><span class="dot ${sev}"></span>${esc(e.kind)}</td><td class="small">${esc(summary || '—')}</td><td class="small muted" title="${esc(e.detail)}">${esc(e.detail.slice(0, 120))}</td></tr>`;
    })
    .join('') || '<tr><td colspan=4 class="muted">none in range</td></tr>'
}</table>`;
}

function journeyTable(journeys: MessageJourney[]): string {
  return `<table><tr><th>received</th><th>sender</th><th>message</th><th>session</th><th>stage</th><th>ack</th><th>link</th><th>age</th></tr>
${
  journeys
    .map((j) => {
      // Agent-to-agent hops get a distinct, linked tag so they're never
      // mistaken for a channel message; the sender is the sending agent group.
      const senderCell = j.sourceAgentGroupId
        ? `${esc(j.sender)} <a class="pill" style="color:var(--violet);border-color:var(--violet)" href="/group/${encodeURIComponent(
            j.sourceAgentGroupId,
          )}" title="agent-to-agent message from ${esc(j.sender)}">↔ agent</a>`
        : `${esc(j.sender)} <span class="muted">(${esc(j.channel)})</span>`;
      return `<tr><td class="small">${esc(fmtTs(j.receivedAt))}</td><td>${senderCell}</td>
<td class="small muted" style="max-width:380px">${esc(j.preview) || '—'}</td>
<td class="small">${esc(j.sessionId)}</td><td><span class="pill">${esc(j.stage)}</span></td><td>${esc(j.ackStatus ?? '–')}</td>
<td>${esc(j.linkage)}</td><td>${fmtAge(j.ageMs)}</td></tr>`;
    })
    .join('') || '<tr><td colspan=8 class="muted">no recent trigger messages</td></tr>'
}</table>`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '–';
  if (ms < 950) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '–';
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

function trigChip(turn: RunTurn): string {
  const kind = turn.trigger.kind;
  const label = turn.trigger.label && turn.trigger.label !== kind ? turn.trigger.label : kind;
  return `<span class="trig trig-${esc(kind)}" title="${esc(kind)}">${esc(label.slice(0, 26))}</span>`;
}

function artifactChips(artifacts: RunArtifact[]): string {
  if (!artifacts.length) return '';
  const chips = artifacts
    .slice(0, 8)
    .map(
      (a) =>
        `<span class="art" title="${esc(a.file)}${a.intent ? ` — ${esc(a.intent)}` : ''}"><b>${esc(shortenPath(a.file))}</b>${
          a.intent ? `<span class="why">${esc(a.intent)}</span>` : `<span class="muted">${esc(a.kind)}</span>`
        }</span>`,
    )
    .join(' ');
  return `<div class="kv" style="margin-top:7px"><span>wrote <span class="chips">${chips}</span></span></div>`;
}

function stepRow(tool: RunToolCall, subagentHref?: string, link?: { href: string; label: string }): string {
  const err = tool.error
    ? `<span class="errcell" title="${esc(tool.resultPreview ?? 'tool_result is_error')}">ERR</span>`
    : '';
  const detail = tool.detail
    ? `<details><summary class="muted small">input</summary><pre class="log">${esc(tool.detail)}</pre></details>`
    : '';
  const result =
    tool.resultPreview && !tool.error
      ? `<details><summary class="muted small">result</summary><pre class="log">${esc(tool.resultPreview)}</pre></details>`
      : tool.error && tool.resultPreview
        ? `<details open><summary class="errcell small">error</summary><pre class="log">${esc(tool.resultPreview)}</pre></details>`
        : '';
  // Exact per-tool link (Task → its child transcript, send_message → the
  // receiving group's a2a turn) beats the generic "subagent runs below" anchor.
  const childLink = link
    ? `<div class="small"><a href="${esc(link.href)}">${esc(link.label)}</a></div>`
    : subagentHref && (tool.name === 'Task' || tool.name === 'Agent')
      ? `<div class="small"><a href="${esc(subagentHref)}">↳ spawned subagent run${tool.name === 'Agent' ? '' : 's'} ↓</a></div>`
      : '';
  return `<tr${tool.error ? ' class="error-row"' : ''}><td class="small">${esc(fmtTs(tool.ts))}</td><td><span class="state info">${esc(tool.name)}</span> ${err}</td><td>${esc(tool.summary)}${detail}${result}${childLink}</td><td class="dur">${esc(fmtMs(tool.durationMs))}</td></tr>`;
}

export function modelRow(call: RunModelCall): string {
  const title = `in ${call.inputTokens} · out ${call.outputTokens} · cache ${call.cacheRead} read / ${call.cacheCreate} write`;
  const verb = call.stopReason === 'end_turn' || call.stopReason === 'stop' ? 'replied:' : 'decided:';
  const text = call.text
    ? `<details><summary>${esc(`${verb} ${call.text}`)}</summary><pre class="log">${esc(call.text)}</pre></details>`
    : '';
  const reasoning = call.reasoning
    ? `<details><summary class="muted small">reasoning / COT</summary><pre class="log">${esc(call.reasoning)}</pre></details>`
    : '';
  const tools = call.toolNames.length ? `<span class="muted">→ ${esc(call.toolNames.join(', '))}</span>` : '';
  return `<tr class="mrow"><td class="small">${esc(fmtTs(call.ts))}</td><td><span class="state info">${esc(shortModel(call.model))}</span></td><td>${reasoning}${reasoning && text ? '<br>' : ''}${text}${(reasoning || text) && tools ? '<br>' : ''}${tools}</td><td class="dur" title="${esc(title)}">${fmtTokens(call.outputTokens)}↑ ${call.durationMs != null ? `<span class="muted">${esc(fmtMs(call.durationMs))}</span>` : ''}</td><td class="small muted">${esc(fmtCost(callCostUsd(call)))}</td></tr>`;
}

function timelineRows(
  turn: RunTurn,
  subagentHref?: string,
  toolLinks?: Map<RunToolCall, { href: string; label: string }>,
): string {
  const entries: ({ type: 'model'; item: RunModelCall } | { type: 'tool'; item: RunToolCall })[] = [
    ...turn.modelCalls.map((item) => ({ type: 'model' as const, item })),
    ...turn.tools.map((item) => ({ type: 'tool' as const, item })),
  ];
  return (
    entries
      .sort((a, b) => a.item.ts.localeCompare(b.item.ts) || (a.type === 'model' ? -1 : 1))
      .map((e) => (e.type === 'model' ? modelRow(e.item) : stepRow(e.item, subagentHref, toolLinks?.get(e.item))))
      .join('') || '<tr><td colspan=5 class="muted">No model or tool activity this turn.</td></tr>'
  );
}

export function turnDetails(
  turn: RunTurn,
  opts: {
    open?: boolean;
    subagentHref?: string;
    toolLinks?: Map<RunToolCall, { href: string; label: string }>;
    delivery?: DeliveryState;
    workflowEvents?: WorkflowEvent[];
  } = {},
): string {
  const meta: string[] = [];
  meta.push(esc(fmtMs(turn.activeMs)));
  meta.push(`${turn.totals.modelCalls} calls · ${turn.totals.toolCalls} tools`);
  if (opts.delivery === 'delivered')
    meta.push('<span title="a chat outbound row is linked to this turn via in_reply_to">✓ delivered</span>');
  else if (opts.delivery === 'pending')
    meta.push(
      '<span class="err" style="color:var(--amber,orange)" title="outbound activity in the window but no in_reply_to linkage">delivery unlinked</span>',
    );
  if (turn.totals.outputTokens) meta.push(`${fmtTokens(turn.totals.outputTokens)}↑`);
  if (turn.costUsd != null) meta.push(esc(fmtCost(turn.costUsd)));
  if (turn.contextTokens != null) meta.push(`ctx ${fmtTokens(turn.contextTokens)}`);
  if (turn.errorCount) meta.push(`<span class="err">${turn.errorCount} err</span>`);
  if (turn.compactions) meta.push(`<span class="err" style="color:var(--rose)">compacted</span>`);
  if (turn.contextEdits) meta.push(`<span title="Append-only provider context edits">${turn.contextEdits} ctx edits</span>`);
  if (turn.memoryOps.length) meta.push(`🧠 ${turn.memoryOps.length}`);
  if (opts.workflowEvents?.length) meta.push(`workflow ${opts.workflowEvents.length}`);

  const responses = turn.outMessages.length
    ? turn.outMessages
        .slice(0, 2)
        .map((m) => `<div class="resp"><span class="to">→ ${esc(m.to)}</span>${esc(m.preview)}</div>`)
        .join('')
    : turn.responsePreview
      ? `<div class="resp"><span class="to">reply</span>${esc(turn.responsePreview)}</div>`
      : '';

  const memory =
    turn.memoryOps.length || turn.memoryInjected
      ? `<div class="memline">${turn.memoryOps.map((op) => `${op.op === 'recall' ? '⟲ recalled' : op.op === 'remember' ? '✎ remembered' : '⚙ ' + op.op}${op.detail ? ` “${esc(op.detail)}”` : ''}${op.hits != null ? ` (${op.hits} hits)` : ''}${op.error ? ' <span class="err">error</span>' : ''}`).join(' · ')}${turn.memoryOps.length && turn.memoryInjected ? '<br>' : ''}${turn.memoryInjected ? `grounding: ${turn.memoryInjected.count} memories injected${turn.memoryInjected.titles.length ? ` (${esc(turn.memoryInjected.titles.join(', '))})` : ''}` : ''}</div>`
      : '';

  const workflow = opts.workflowEvents?.length
    ? `<details class="workflow"><summary>workflow receipts (${opts.workflowEvents.length})</summary><table><tr><th>time</th><th>source</th><th>step</th><th>status</th><th>data</th></tr>${opts.workflowEvents
        .map((event) => `<tr><td class="small">${esc(fmtTs(event.at))}</td><td><span class="state info">${esc(event.source)}</span></td><td>${esc(event.name)}</td><td>${event.status === 'failed' ? '<span class="err">failed</span>' : esc(event.status)}</td><td>${event.data && typeof event.data === 'object' ? `<code>${esc(JSON.stringify(event.data))}</code>` : esc(String(event.data ?? ''))}</td></tr>`)
        .join('')}</table></details>`
    : '';

  return `<details class="turn" id="turn-${turn.index}"${opts.open ? ' open' : ''}>
<summary><span class="t-time">${esc(fmtTs(turn.startedAt))}</span>${trigChip(turn)}
<span class="t-intent" title="${esc(turn.trigger.intent)}">${esc(turn.trigger.intent || '(no prompt text)')}</span>
<span class="t-meta">${meta.join(' · ')}</span></summary>
<div class="turn-body">
<div class="muted small">Each model call receives the trigger or tool results shown above it; token hover shows full input/cache context.</div>
<table class="steps"><tr><th>time</th><th>step</th><th>response / action</th><th>tokens / took</th><th>cost</th></tr>${timelineRows(turn, opts.subagentHref, opts.toolLinks)}</table>
${artifactChips(turn.artifacts)}
${memory}
${workflow}
${responses}
</div></details>`;
}

function runModelRows(run: ExecutionRun): string {
  return (
    run.modelCalls
      .slice(-8)
      .reverse()
      .map(
        (call) => `<tr><td class="small">${esc(fmtTs(call.ts))}</td><td>${esc(shortModel(call.model))}</td>
<td>${fmtTokens(call.inputTokens)}</td><td>${fmtTokens(call.outputTokens)}</td>
<td>${fmtTokens(call.cacheRead)}</td><td>${fmtTokens(call.cacheCreate)}</td></tr>`,
      )
      .join('') || '<tr><td colspan=6 class="muted">No model usage rows found.</td></tr>'
  );
}

function runToolRows(run: ExecutionRun): string {
  return (
    run.tools
      .slice(-18)
      .reverse()
      .map(
        (
          tool,
        ) => `<tr><td class="small">${esc(fmtTs(tool.ts))}</td><td><span class="state info">${esc(tool.name)}</span></td>
<td>${esc(tool.summary)}</td><td>${
          tool.detail
            ? `<details><summary class="muted small">input</summary><pre class="log">${esc(tool.detail)}</pre></details>`
            : '<span class="muted small">redacted</span>'
        }</td></tr>`,
      )
      .join('') || '<tr><td colspan=4 class="muted">No tool calls found.</td></tr>'
  );
}

const RUN_WINDOWS: Record<string, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};
const RUN_MIN_OUTPUT: Record<string, number> = {
  '10k': 10_000,
  '50k': 50_000,
  '100k': 100_000,
};
const RUN_SORTS: readonly RunSort[] = ['recent', 'output', 'tools', 'duration', 'cost', 'errors'];

interface ParsedRunQuery {
  filters: RunFilters;
  sort: RunSort;
  limit: number;
  sinceKey: string;
  minKey: string;
  limitKey: string;
}

function parseRunQuery(params: URLSearchParams): ParsedRunQuery {
  const sinceKey = params.get('since') || 'all';
  const minKey = params.get('min') || 'all';
  const limitKey = params.get('limit') || '60';
  const sortRaw = (params.get('sort') || 'recent') as RunSort;
  const filters: RunFilters = {
    groupId: params.get('group') || undefined,
    lanes: params.getAll('lane').filter(Boolean),
    skills: params.getAll('skill').filter(Boolean),
    tools: params.getAll('tool').filter(Boolean),
    models: params.getAll('model').filter(Boolean),
    triggers: params.getAll('trigger').filter(Boolean),
    errorsOnly: params.get('errors') === '1',
    memoryOnly: params.get('memory') === '1',
    file: (params.get('file') || '').trim() || undefined,
    query: (params.get('q') || '').trim() || undefined,
    sinceMs: RUN_WINDOWS[sinceKey] ? Date.now() - RUN_WINDOWS[sinceKey] : null,
    minOutput: RUN_MIN_OUTPUT[minKey] ?? 0,
  };
  return {
    filters,
    sort: RUN_SORTS.includes(sortRaw) ? sortRaw : 'recent',
    limit: limitKey === 'all' ? Infinity : Math.max(1, Number(limitKey) || 60),
    sinceKey,
    minKey,
    limitKey,
  };
}

/** Serialize params back to a `/runs` href, dropping empty query strings. */
function runsHref(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `/runs?${qs}` : '/runs';
}

/** Toggle one value of a repeated (multi-select) param; returns a fresh URLSearchParams. */
function toggleParam(params: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  const existing = next.getAll(key);
  next.delete(key);
  let removed = false;
  for (const v of existing) {
    if (v === value && !removed) {
      removed = true;
      continue;
    }
    next.append(key, v);
  }
  if (!removed) next.append(key, value);
  return next;
}

/** Set (or clear, if already equal) a single-value param. Used for the `file` chip. */
function setParam(params: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (next.get(key) === value) next.delete(key);
  else next.set(key, value);
  return next;
}

function chipLink(key: string, value: string, on: boolean, params: URLSearchParams, label = value): string {
  return `<a class="chip${on ? ' on' : ''}" href="${esc(runsHref(toggleParam(params, key, value)))}">${esc(label)}</a>`;
}

/** A labeled row of facet chips with per-value run counts. */
function facetRow(label: string, key: string, values: FacetValue[], active: string[], params: URLSearchParams): string {
  if (!values.length) return '';
  const activeSet = new Set(active);
  const chips = values
    .map((fv) => {
      const on = activeSet.has(fv.value);
      const href = esc(runsHref(toggleParam(params, key, fv.value)));
      return `<a class="chip${on ? ' on' : ''}" href="${href}">${esc(fv.value)} <span class="c">${fv.count}</span></a>`;
    })
    .join('');
  return `<div class="facet-row"><span class="flabel fl-${esc(key)}">${esc(label)}</span><span class="chips">${chips}</span></div>`;
}

/** Hidden inputs so the text/select filter form preserves active facet chips on submit. */
function hiddenFacets(f: RunFilters): string {
  const pairs: [string, string][] = [];
  for (const v of f.lanes ?? []) pairs.push(['lane', v]);
  for (const v of f.skills ?? []) pairs.push(['skill', v]);
  for (const v of f.tools ?? []) pairs.push(['tool', v]);
  for (const v of f.models ?? []) pairs.push(['model', v]);
  for (const v of f.triggers ?? []) pairs.push(['trigger', v]);
  // errorsOnly is a visible checkbox in the same form — no hidden input, else
  // unchecking could never clear it.
  return pairs.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
}

/** Trim a long path to its last two segments for chip display (full path kept in title). */
function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

function a2aPeerRunHref(groupId: string, sessionId: string, pool: ExecutionRun[]): string | null {
  const peer = pool.find((candidate) => candidate.groupId === groupId && hostSessionIdFor(candidate) === sessionId);
  return peer
    ? `/runs/session?group=${encodeURIComponent(peer.groupId)}&session=${encodeURIComponent(peer.sessionId)}`
    : null;
}

function a2aRouteTags(tags: A2aRunTag[], names: Map<string, string>, pool: ExecutionRun[]): string {
  return (
    tags
      .slice(0, 8)
      .map((tag) => {
        const sourceName = names.get(tag.sourceGroupId) ?? tag.sourceGroupId;
        const destinationName = names.get(tag.destinationGroupId) ?? tag.destinationGroupId;
        const sourceHref = a2aPeerRunHref(tag.sourceGroupId, tag.sourceSessionId, pool);
        const destinationHref = a2aPeerRunHref(tag.destinationGroupId, tag.destinationSessionId, pool);
        const source = sourceHref
          ? `<a href="${esc(sourceHref)}">source: ${esc(sourceName)}</a>`
          : `source: ${esc(sourceName)}`;
        const destination = destinationHref
          ? `<a href="${esc(destinationHref)}">destination: ${esc(destinationName)}</a>`
          : `destination: ${esc(destinationName)}`;
        return `<span class="chip" title="${esc(`${tag.summary} · ${tag.a2aMsgId}`)}">${tag.direction === 'sent' ? '↗' : '↙'} ${source} → ${destination}</span>`;
      })
      .join('') + (tags.length > 8 ? ` <span class="muted small">+${tags.length - 8} more</span>` : '')
  );
}

function a2aRoutesLine(tags: A2aRunTag[], names: Map<string, string>, pool: ExecutionRun[]): string {
  if (!tags.length) return '';
  return `<div class="kv"><span>A2A routes <span class="chips">${a2aRouteTags(tags, names, pool)}</span></span></div>`;
}

function runCard(
  run: ExecutionRun,
  names: Map<string, string>,
  params: URLSearchParams,
  f: RunFilters,
  pool: ExecutionRun[],
  a2aTags: A2aRunTag[],
): string {
  const laneOn = (f.lanes ?? []).includes(run.lane);
  const skillChips = run.skills.length
    ? run.skills.map((s) => chipLink('skill', s, (f.skills ?? []).includes(s), params)).join(' ')
    : '<span class="muted small">–</span>';

  const toolNames = [...new Set(run.tools.map((t) => t.name))];
  const toolChips = toolNames.length
    ? toolNames
        .slice(0, 10)
        .map((t) => chipLink('tool', t, (f.tools ?? []).includes(t), params))
        .join(' ') + (toolNames.length > 10 ? ` <span class="muted small">+${toolNames.length - 10}</span>` : '')
    : '<span class="muted small">–</span>';

  const modelNames = [...new Set(run.modelCalls.map((c) => shortModelName(c.model)))];
  const modelChips = modelNames.length
    ? modelNames.map((m) => chipLink('model', m, (f.models ?? []).includes(m), params)).join(' ')
    : '<span class="muted small">–</span>';

  const fileChips = run.files.length
    ? run.files
        .slice(0, 6)
        .map((file) => {
          const on = (f.file ?? '') === file;
          return `<a class="chip${on ? ' on' : ''}" href="${esc(runsHref(setParam(params, 'file', file)))}" title="${esc(file)}"><code>${esc(shortenPath(file))}</code></a>`;
        })
        .join(' ') + (run.files.length > 6 ? ` <span class="muted small">+${run.files.length - 6}</span>` : '')
    : '<span class="muted small">–</span>';

  const dur = runDurationMs(run);
  const sessionHref = `/runs/session?group=${encodeURIComponent(run.groupId)}&session=${encodeURIComponent(run.sessionId)}`;
  const shownTurns = run.turns.slice(-8).reverse();
  const turnList = run.turns.length
    ? `<div class="turns">${shownTurns.map((turn) => turnDetails(turn)).join('')}</div>` +
      (run.turns.length > shownTurns.length
        ? `<p class="small" style="margin:7px 0 0"><a href="${esc(sessionHref)}">all ${run.turns.length} turns →</a></p>`
        : `<p class="small" style="margin:7px 0 0"><a href="${esc(sessionHref)}">open session view →</a></p>`)
    : `<details><summary>Model calls</summary><table><tr><th>time</th><th>model</th><th>input</th><th>output</th><th>cache read</th><th>cache write</th></tr>${runModelRows(run)}</table></details>
<details><summary>Tool calls</summary><table><tr><th>time</th><th>tool</th><th>summary</th><th>input</th></tr>${runToolRows(run)}</table></details>`;

  return `<div class="card runcard" style="--lane:${laneColor(run.groupId)}">
<div class="run-hd"><span class="av">${esc((names.get(run.groupId) ?? run.groupId).trim().charAt(0).toUpperCase())}</span><a class="nm" href="${esc(sessionHref)}">${esc(names.get(run.groupId) ?? run.groupId)}</a>
<a class="chip${laneOn ? ' on' : ''}" href="${esc(runsHref(toggleParam(params, 'lane', run.lane)))}">${esc(run.lane)}</a>
<span class="when" title="debug tag ${esc(run.debugTag)}">${esc(fmtTs(run.lastAt))}</span>
<span class="agg"><b>${run.turns.length || '–'} turns</b>
<span title="Sum of per-turn working time; idle gaps over 2 minutes excluded.">active ${run.activeMs ? esc(fmtMs(run.activeMs)) : '–'}</span>
<span title="Wall-clock from first to last event. One SDK session is resumed across many container wakes, so this is calendar span, not runtime.">span ${dur > 0 ? esc(fmtAge(dur)) : '–'}</span>
<span title="${run.totals.modelCalls} model calls · ${run.totals.toolCalls} tool calls">${fmtTokens(run.totals.outputTokens)}↑ ${fmtTokens(run.totals.inputTokens)}↓</span>
<span class="cost" title="${run.costIsExact ? 'Provider-recorded cost.' : 'Estimated from public per-MTok prices incl. cache reads/writes. Ignores subscription/quota billing.'}">${esc(fmtCost(run.costUsd))}</span>
${run.errorCount ? `<span class="err">${run.errorCount} err</span>` : ''}
${run.compactions ? `<span title="Context compactions in this session">${run.compactions} compact</span>` : ''}
${run.contextEdits ? `<span title="Append-only provider context edits in this session">${run.contextEdits} ctx edits</span>` : ''}</span></div>
<div class="kv"><span>model <span class="chips">${modelChips}</span></span></div>
<div class="kv"><span>skills <span class="chips">${skillChips}</span></span></div>
<div class="kv"><span>tools <span class="chips">${toolChips}</span></span></div>
<div class="kv"><span>files <span class="chips">${fileChips}</span></span></div>
${a2aRoutesLine(a2aTags, names, pool)}
${turnList}
<details><summary class="muted small">Trace file</summary><p class="small">${
    run.file.endsWith('.jsonl')
      ? `<a href="${esc(`/trace-file?path=${encodeURIComponent(run.file)}`)}" target="_blank" rel="noopener"><code>${esc(run.file)}</code></a>`
      : `<code>${esc(run.file)}</code> <span class="muted">(OpenCode SQLite store — not a viewable transcript)</span>`
  }</p></details>
</div>`;
}

/** Full-session drill-down: every turn of one run, plus its subagent children. */
function sessionRunBody(params: URLSearchParams): string {
  const groupId = params.get('group') || '';
  const sessionId = params.get('session') || '';
  const groups = safe(() => listAgentGroups(), []);
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const pool = readExecutionRuns({ limit: Infinity, groupId: groupId || undefined });
  const run = pool.find((r) => r.groupId === groupId && r.sessionId === sessionId);
  if (!run) {
    return `<h1>Run not found</h1><p class="muted">No transcript for <code>${esc(groupId)}:${esc(sessionId)}</code>. <a href="/runs">Back to Runs</a></p>`;
  }
  const dur = runDurationMs(run);
  const children = pool.filter((r) => r.file.includes(`${path.sep}${sessionId}${path.sep}subagents${path.sep}`));
  const parentMatch = run.file.match(/[/\\]([^/\\]+)[/\\]subagents[/\\]/);
  const parentId = parentMatch ? parentMatch[1] : null;

  // Cross-run joins (readers/run-links.ts): exact Task→child transcript links,
  // send_message→receiving-turn links via logged host forwards, and per-turn
  // delivery evidence from the session's outbound.db.
  const fullPool = groupId ? readExecutionRuns({ limit: Infinity }) : pool;
  const a2aTagsByRun = safe(() => readA2aRunTags(), new Map<string, A2aRunTag[]>());
  const a2aTags = a2aTagsByRun.get(`${run.groupId}:${hostSessionIdFor(run)}`) ?? [];
  const forwards = safe(() => recentRouteEvents(400), [] as ReturnType<typeof recentRouteEvents>).filter(
    (r): r is ForwardRouteEvent => r.kind === 'forward',
  );
  const toolLinks = new Map<RunToolCall, { href: string; label: string }>();
  for (const [tool, child] of safe(() => taskChildLinks(run, children), new Map<RunToolCall, ExecutionRun>())) {
    toolLinks.set(tool, {
      href: `/runs/session?group=${encodeURIComponent(child.groupId)}&session=${encodeURIComponent(child.sessionId)}`,
      label: '↳ subagent run',
    });
  }
  for (const link of safe(() => correlateA2aLinks(run, fullPool, forwards), [])) {
    toolLinks.set(link.tool, {
      href: link.href,
      label: `↪ received by ${names.get(link.toGroupId) ?? link.toGroupId}`,
    });
  }
  for (const tool of run.tools.filter((item) => item.name === 'mcp__nanoclaw__send_message')) {
    const at = Date.parse(tool.ts);
    const tag = nearestA2aSentTag(a2aTags, at);
    if (!tag) continue;
    const href = a2aPeerRunHref(tag.destinationGroupId, tag.destinationSessionId, fullPool);
    if (href) {
      toolLinks.set(tool, {
        href,
        label: `↗ source: ${names.get(tag.sourceGroupId) ?? tag.sourceGroupId} → destination: ${names.get(tag.destinationGroupId) ?? tag.destinationGroupId}`,
      });
    }
  }
  const delivery = safe(() => deliveryByTurn(run.sessionId, run.turns), new Map<number, DeliveryState>());
  const workflowByTurn = safe(
    () => readWorkflowEventsByTurn(path.join(PATHS.sessionsDir, run.groupId, hostSessionIdFor(run)), run.turns),
    new Map<number, WorkflowEvent[]>(),
  );
  const runtimeManifest = safe(
    () => readRuntimeManifest(path.join(PATHS.sessionsDir, run.groupId, hostSessionIdFor(run))),
    null as RuntimeManifest | null,
  );

  const childRows = children
    .map((child) => {
      const href = `/runs/session?group=${encodeURIComponent(child.groupId)}&session=${encodeURIComponent(child.sessionId)}`;
      const firstIntent = child.turns[0]?.trigger.intent ?? '';
      return `<tr><td class="small">${esc(fmtTs(child.startedAt))}</td><td><a href="${esc(href)}"><code>${esc(child.sessionId)}</code></a></td>
<td>${esc(firstIntent.slice(0, 120))}</td><td>${child.totals.modelCalls}</td><td>${fmtTokens(child.totals.outputTokens)}</td><td>${esc(fmtCost(child.costUsd))}</td></tr>`;
    })
    .join('');

  return `<p class="small"><a href="/runs">← Runs</a>${
    parentId
      ? ` · subagent of <a href="${esc(`/runs/session?group=${encodeURIComponent(run.groupId)}&session=${encodeURIComponent(parentId)}`)}"><code>${esc(parentId)}</code></a>`
      : ''
  }</p>
<h1>${esc(names.get(run.groupId) ?? run.groupId)} <span class="muted" style="font-weight:400">· ${esc(run.lane)} session</span></h1>
<div class="kv"><span>debug tag <code>${esc(run.debugTag)}</code></span></div>
${a2aRoutesLine(a2aTags, names, fullPool)}
<div class="statstrip">
<div class="stat"><span class="lbl">Turns</span><span class="num">${run.turns.length}</span><span class="sub">${esc(fmtTs(run.startedAt))} → ${esc(fmtTs(run.lastAt))}</span></div>
<div class="stat"><span class="lbl">Active</span><span class="num">${esc(fmtMs(run.activeMs))}</span><span class="sub">span ${dur > 0 ? esc(fmtAge(dur)) : '–'}</span></div>
<div class="stat"><span class="lbl">Tokens</span><span class="num">${fmtTokens(run.totals.outputTokens)}↑</span><span class="sub">${fmtTokens(run.totals.cacheRead)} cache read</span></div>
<div class="stat"><span class="lbl">Est cost</span><span class="num">${esc(fmtCost(run.costUsd))}</span><span class="sub">${run.errorCount ? `<span style="color:var(--red)">${run.errorCount} tool errors</span>` : 'no tool errors'}${run.compactions ? ` · ${run.compactions} compactions` : ''}${run.contextEdits ? ` · ${run.contextEdits} context edits` : ''}</span></div>
</div>
${runtimeManifest ? `<div class="kv"><span>image <code>${esc(runtimeManifest.image)}</code></span><span>image fp <code>${esc(runtimeManifest.image_fingerprint.slice(0, 16))}…</code></span><span>runner fp <code>${esc(runtimeManifest.agent_runner_fingerprint.slice(0, 16))}…</code></span><span>skills fp <code>${esc(runtimeManifest.skills_fingerprint.slice(0, 16))}…</code></span>${runtimeManifest.runtime_fingerprint ? `<span>runtime fp <code>${esc(runtimeManifest.runtime_fingerprint.slice(0, 16))}…</code></span>` : ''}<span>runtime stamped ${esc(fmtTs(runtimeManifest.generated_at))}</span></div>` : '<p class="muted small">No runtime provenance manifest for this session (older run or pre-refresh container).</p>'}
<div class="turns">${[...run.turns]
    .reverse()
    .map((turn) =>
      turnDetails(turn, {
        subagentHref: children.length ? '#subagent-runs' : undefined,
        toolLinks,
        delivery: delivery.get(turn.index),
        workflowEvents: workflowByTurn.get(turn.index),
      }),
    )
    .join('')}</div>
<script>if(location.hash.startsWith('#turn-')){const el=document.getElementById(location.hash.slice(1));if(el){el.open=true;el.scrollIntoView();}}</script>
${
  children.length
    ? `<h2 id="subagent-runs" style="margin-top:20px">Subagent runs (${children.length})</h2>
<table><tr><th>started</th><th>transcript</th><th>task</th><th>model calls</th><th>output</th><th>est cost</th></tr>${childRows}</table>`
    : ''
}
<details style="margin-top:14px"><summary class="muted small">Trace file</summary><p class="small">${
    run.file.endsWith('.jsonl')
      ? `<a href="${esc(`/trace-file?path=${encodeURIComponent(run.file)}`)}" target="_blank" rel="noopener"><code>${esc(run.file)}</code></a>`
      : `<code>${esc(run.file)}</code>`
  }</p></details>`;
}

// ---------- chat (web conversation with an agent group) ----------

function chatBubble(m: ChatMessage): string {
  const who = m.role === 'user' ? m.sender : 'agent';
  return `<div class="cmsg ${m.role}"><div class="bub">${esc(m.text)}</div><div class="cmeta">${esc(who)} · ${esc(fmtTs(m.ts))}</div></div>`;
}

/**
 * Live-activity fragment: the newest transcript turn of the group's web
 * session, rendered with the same turnDetails used by /runs/session. Joins
 * host session → run via the provider continuation ids in session_state, so
 * both Claude (JSONL) and OpenCode (opencode.db) groups resolve.
 */
function chatSteps(groupId: string, sessionDir: string, working: boolean): { html: string; runHref: string | null } {
  const ids = safe(() => readContinuationIds(sessionDir), [] as string[]);
  if (!ids.length) return { html: '', runHref: null };
  const pool = safe(() => readExecutionRuns({ limit: Infinity, groupId }), [] as ExecutionRun[]);
  const run = pool.find((r) => r.groupId === groupId && ids.includes(r.sessionId));
  if (!run || !run.turns.length) return { html: '', runHref: null };
  const runHref = `/runs/session?group=${encodeURIComponent(groupId)}&session=${encodeURIComponent(run.sessionId)}`;
  const turn = run.turns[run.turns.length - 1];
  return { html: turnDetails(turn, { open: working }), runHref };
}

function chatUpdates(
  groupId: string,
  inCur: number,
  outCur: number,
): {
  ok: boolean;
  html: string;
  in: number;
  out: number;
  status: string;
  steps: string;
  runHref: string | null;
} {
  const state = safe(() => getWebChatState(groupId), {
    mgId: null,
    wired: false,
    hasDestination: false,
    sessionId: null,
    sessionDir: null,
  });
  if (!state.sessionDir) {
    return { ok: true, html: '', in: inCur, out: outCur, status: 'idle', steps: '', runHref: null };
  }
  const slice = safe(() => readChatSlice(state.sessionDir!, inCur, outCur), {
    messages: [],
    inMax: inCur,
    outMax: outCur,
    status: 'idle' as const,
  });
  const { html: steps, runHref } = chatSteps(groupId, state.sessionDir, slice.status === 'working');
  return {
    ok: true,
    html: slice.messages.map(chatBubble).join(''),
    in: slice.inMax,
    out: slice.outMax,
    status: slice.status,
    steps,
    runHref,
  };
}

function chatBody(): string {
  const groups = safe(() => listAgentGroups(), []);
  const rows = groups
    .map((g) => {
      const state = safe(() => getWebChatState(g.id), {
        mgId: null,
        wired: false,
        hasDestination: false,
        sessionId: null,
        sessionDir: null,
      });
      const wired = state.wired
        ? '<span style="color:var(--ok)">wired ✓</span>'
        : '<span class="muted">wires on first message</span>';
      const sess = state.sessionId ? `<code>${esc(state.sessionId)}</code>` : '<span class="muted">–</span>';
      return `<tr data-rowhref="/chat/group?id=${encodeURIComponent(g.id)}"><td><b>${esc(g.name)}</b></td><td class="small">${wired}</td><td class="small">${sess}</td>
<td><a href="/chat/group?id=${encodeURIComponent(g.id)}">Open chat →</a></td></tr>`;
    })
    .join('');
  return `${chatSubnav('/chat')}<p class="muted small" style="max-width:760px">Talk to an agent group from here. Each group gets its own dedicated web session
(channel <code>cli</code>, platform <code>web:&lt;group&gt;</code>) — parallel to its WhatsApp/Telegram sessions, so nothing leaks into your phone threads.
Messages are injected through the host's CLI socket; replies and live activity are read from the session's own DBs and transcript.</p>
<div class="card"><h3>Agent groups</h3>
<table><tr><th>group</th><th>web chat</th><th>session</th><th></th></tr>${rows || '<tr><td colspan=4 class="muted">no agent groups</td></tr>'}</table></div>`;
}

function chatGroupBody(params: URLSearchParams): string {
  const groupId = params.get('id') ?? '';
  const groups = safe(() => listAgentGroups(), []);
  const group = groups.find((g) => g.id === groupId);
  if (!group) {
    return `<h1>Unknown group</h1><p class="muted"><a href="/chat">← Chat</a></p>`;
  }
  const state = safe(() => getWebChatState(groupId), {
    mgId: null,
    wired: false,
    hasDestination: false,
    sessionId: null,
    sessionDir: null,
  });
  const initial = state.sessionDir
    ? safe(() => readChatSlice(state.sessionDir!, 0, 0), { messages: [], inMax: 0, outMax: 0, status: 'idle' as const })
    : { messages: [], inMax: 0, outMax: 0, status: 'idle' as const };
  const { html: steps, runHref } = state.sessionDir
    ? chatSteps(groupId, state.sessionDir, initial.status === 'working')
    : { html: '', runHref: null };

  return `${chatSubnav('/chat')}<p class="small"><a href="/chat">← Chat</a></p>
<h1>${esc(group.name)} <span class="muted" style="font-weight:400">· web session</span></h1>
<div class="chatwrap">
<div style="display:flex;align-items:center;gap:10px">
  <span class="cpill ${esc(initial.status)}" id="cstatus">${initial.status === 'working' ? '● agent working…' : initial.status === 'queued' ? '○ queued' : 'idle'}</span>
  <span class="sp"></span>
  <a id="crunlink" href="${esc(runHref ?? '#')}" style="${runHref ? '' : 'display:none'}" class="small">open in Runs →</a>
</div>
<div class="cx" id="cx" data-in="${initial.inMax}" data-out="${initial.outMax}">${
    initial.messages.map(chatBubble).join('') ||
    '<div class="muted small" style="margin:auto">No messages yet. Say hello — the first message wires the channel and spawns the session container.</div>'
  }</div>
<div class="crow">
  <textarea id="ctext" placeholder="Message ${esc(group.name)}… (Enter to send, Shift+Enter for newline)" autofocus></textarea>
  <button id="csend">Send</button>
  ${WEBQI_ENABLED ? `<a class="btn" href="/chat/webqi?group=${encodeURIComponent(groupId)}${state.sessionId ? `&session=${encodeURIComponent(state.sessionId)}` : ''}&new=1&web=1">Get a second opinion</a>` : ''}
</div>
<details class="csteps" ${initial.status === 'working' ? 'open' : ''}><summary class="muted small">Live activity (latest turn)</summary>
<div id="csteps">${steps || '<p class="muted small">No transcript yet for this session.</p>'}</div></details>
</div>
<script>
// Deferred: the shared CLIENT_JS ($, toast) is injected at the end of <body>
// by layout(), after this inline script — so bind on DOMContentLoaded.
window.addEventListener('DOMContentLoaded',function(){
const GID=${JSON.stringify(groupId)};
const T=$('cx'),S=$('csend'),TA=$('ctext'),ST=$('cstatus'),SP=$('csteps');
let inCur=+T.dataset.in,outCur=+T.dataset.out,timer=null,busy=false;
function label(st){return st==='working'?'\\u25cf agent working\\u2026':st==='queued'?'\\u25cb queued':'idle'}
async function poll(){
  try{
    const r=await fetch('/api/chat/updates?group='+encodeURIComponent(GID)+'&in='+inCur+'&out='+outCur);
    const j=await r.json();
    if(j.html){const stick=T.scrollHeight-T.scrollTop-T.clientHeight<80;T.insertAdjacentHTML('beforeend',j.html);
      const ph=T.querySelector('.muted');if(ph&&T.querySelector('.cmsg'))ph.remove();
      if(stick)T.scrollTop=T.scrollHeight;}
    inCur=j.in;outCur=j.out;
    ST.textContent=label(j.status);ST.className='cpill '+j.status;
    // Replace the live-activity fragment only when it actually changed, and
    // carry the user's open/closed choice across the swap — innerHTML
    // replacement would otherwise collapse the turn on every poll tick.
    if(j.steps&&j.steps!==window.__csteps){
      window.__csteps=j.steps;
      const prev=SP.querySelector('details.turn');
      const wasOpen=prev?prev.open:null;
      SP.innerHTML=j.steps;
      const t=SP.querySelector('details.turn');
      if(t&&wasOpen!==null)t.open=wasOpen;
    }
    if(j.runHref){const a=$('crunlink');a.href=j.runHref;a.style.display='';}
    schedule(j.status);
  }catch(e){schedule('idle')}
}
function schedule(st){clearTimeout(timer);timer=setTimeout(poll,st==='idle'?5000:2000);}
async function send(){
  const text=TA.value.trim();if(!text||busy)return;
  busy=true;S.disabled=true;
  try{
    const r=await fetch('/api/chat/'+encodeURIComponent(GID)+'/send',{method:'POST',
      headers:{'content-type':'application/json','x-ops-action-token':window.__opsToken},
      body:JSON.stringify({text})});
    const j=await r.json();
    if(j.ok){TA.value='';clearTimeout(timer);setTimeout(poll,500);}
    else toast(j.message||'send failed',false);
  }catch(e){toast('send failed: '+e,false)}
  busy=false;S.disabled=false;TA.focus();
}
S.onclick=send;
TA.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
T.scrollTop=T.scrollHeight;
schedule('working');
});</script>`;
}

function runsBody(params: URLSearchParams): string {
  const { filters, sort, limit, sinceKey, minKey, limitKey } = parseRunQuery(params);
  const groups = safe(() => listAgentGroups(), []);
  const names = new Map(groups.map((g) => [g.id, g.name]));

  const pool = readExecutionRuns({ limit: Infinity });
  const filtered = sortRuns(applyRunFilters(pool, filters), sort);
  const facets = computeRunFacets(pool, filters);
  const shown = Number.isFinite(limit) ? filtered.slice(0, limit) : filtered;

  const groupOptions = groups
    .map((g) => `<option value="${esc(g.id)}"${filters.groupId === g.id ? ' selected' : ''}>${esc(g.name)}</option>`)
    .join('');
  const sel = (value: string, current: string) => (value === current ? ' selected' : '');

  const a2aTagsByRun = safe(() => readA2aRunTags(), new Map<string, A2aRunTag[]>());
  const tagsFor = (run: ExecutionRun) => a2aTagsByRun.get(`${run.groupId}:${hostSessionIdFor(run)}`) ?? [];
  const cards = shown.map((run) => runCard(run, names, params, filters, pool, tagsFor(run))).join('');
  const facetRows =
    facetRow('lane', 'lane', facets.lane, filters.lanes ?? [], params) +
    facetRow('trigger', 'trigger', facets.trigger, filters.triggers ?? [], params) +
    facetRow('skill', 'skill', facets.skill, filters.skills ?? [], params) +
    facetRow('tool', 'tool', facets.tool, filters.tools ?? [], params) +
    facetRow('model', 'model', facets.model, filters.models ?? [], params);

  const totalModelCalls = filtered.reduce((sum, run) => sum + run.totals.modelCalls, 0);
  const totalToolCalls = filtered.reduce((sum, run) => sum + run.totals.toolCalls, 0);
  const totalOut = filtered.reduce((sum, run) => sum + run.totals.outputTokens, 0);
  const a2aRouteIds = new Set<string>();
  let a2aSent = 0;
  let a2aReceived = 0;
  for (const run of filtered) {
    for (const tag of tagsFor(run)) {
      a2aRouteIds.add(tag.a2aMsgId);
      if (tag.direction === 'sent') a2aSent++;
      else a2aReceived++;
    }
  }
  const showingNote =
    Number.isFinite(limit) && filtered.length > shown.length
      ? `showing ${shown.length} of ${filtered.length} matching`
      : `${filtered.length} matching`;

  const forwards = safe(() => recentRouteEvents(200), [])
    .filter((route) => route.kind === 'forward')
    .slice(0, 25);
  return `<h1>Runs</h1>
<p class="muted">Execution traces reconstructed from existing agent transcripts. Start here when you want to improve skill use, memory use, model efficiency, or agent-to-agent behavior.</p>
<div class="runs-controls">
<form class="filters" method="get" action="/runs">
${hiddenFacets(filters)}
<label>app <select name="group" onchange="this.form.submit()"><option value="">all</option>${groupOptions}</select></label>
<label>since <select name="since" onchange="this.form.submit()"><option value="all"${sel('all', sinceKey)}>all time</option><option value="24h"${sel('24h', sinceKey)}>24h</option><option value="7d"${sel('7d', sinceKey)}>7 days</option><option value="30d"${sel('30d', sinceKey)}>30 days</option></select></label>
<label>min out <select name="min" onchange="this.form.submit()"><option value="all"${sel('all', minKey)}>any</option><option value="10k"${sel('10k', minKey)}>&gt;10k</option><option value="50k"${sel('50k', minKey)}>&gt;50k</option><option value="100k"${sel('100k', minKey)}>&gt;100k</option></select></label>
<label>sort <select name="sort" onchange="this.form.submit()"><option value="recent"${sel('recent', sort)}>most recent</option><option value="output"${sel('output', sort)}>output tokens</option><option value="tools"${sel('tools', sort)}>tool calls</option><option value="duration"${sel('duration', sort)}>duration</option><option value="cost"${sel('cost', sort)}>est cost</option><option value="errors"${sel('errors', sort)}>errors</option></select></label>
<label title="Only runs with at least one failed tool call"><input type="checkbox" name="errors" value="1"${filters.errorsOnly ? ' checked' : ''} onchange="this.form.submit()"> errors</label>
<label title="Only runs with transcript-detected memory commands or injected memory grounding"><input type="checkbox" name="memory" value="1"${filters.memoryOnly ? ' checked' : ''} onchange="this.form.submit()"> memory activity</label>
<label>show <select name="limit" onchange="this.form.submit()"><option value="30"${sel('30', limitKey)}>30</option><option value="60"${sel('60', limitKey)}>60</option><option value="120"${sel('120', limitKey)}>120</option><option value="all"${sel('all', limitKey)}>all</option></select></label>
<input name="file" placeholder="file path contains…" value="${esc(filters.file ?? '')}">
<input name="q" placeholder="search tool / session / skill…" value="${esc(filters.query ?? '')}">
<span class="acts"><button>Filter</button><a href="/runs">clear</a></span></form>
<div class="facet-grid">${facetRows}</div>
</div>
<div class="statstrip">
<div class="stat"><span class="lbl">Runs</span><span class="num">${filtered.length}</span><span class="sub">${esc(showingNote)}</span></div>
<div class="stat"><span class="lbl">Model Calls</span><span class="num">${totalModelCalls}</span><span class="sub">across matching runs</span></div>
<div class="stat"><span class="lbl">Tool Calls</span><span class="num">${totalToolCalls}</span><span class="sub">across matching runs</span></div>
<div class="stat"><span class="lbl">A2A Routes</span><span class="num">${a2aRouteIds.size}</span><span class="sub">${a2aSent} sent · ${a2aReceived} received run tags</span></div>
<div class="stat"><span class="lbl">Output Tokens</span><span class="num">${fmtTokens(totalOut)}</span><span class="sub">est cost ${esc(fmtCost(filtered.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) || null))}</span></div>
</div>
${cards || '<div class="card empty"><h3>No matching runs</h3><p class="muted">No transcript traces match these filters. <a href="/runs">Clear filters</a> or widen the time window.</p></div>'}
${delegationsSection(pool, names)}
<details style="margin-top:10px"><summary class="muted small">Raw host-log a2a forwards (volatile — rotates with the log)</summary>
<table><tr><th>time</th><th>from</th><th>to</th><th>debug tag</th><th>files</th></tr>
${
  forwards
    .map(
      (
        route,
      ) => `<tr><td class="small">${esc(route.clock)}</td><td>${esc(names.get(route.fromGroupId) ?? route.fromGroupId)}</td>
<td>${esc(names.get(route.toGroupId) ?? route.toGroupId)}</td><td><code>${esc(`from=${route.fromGroupId} to=${route.toGroupId} session=${route.targetSession}${route.messageId ? ` message=${route.messageId}` : ''}`)}</code></td>
<td>${route.forwardedFileCount}</td></tr>`,
    )
    .join('') || '<tr><td colspan=5 class="muted">No recent agent-to-agent forwarding in the host log.</td></tr>'
}</table></details>`;
}

/**
 * "Model ran" join: find the receiving run's a2a turn nearest after the
 * request and list the distinct models that actually handled it, linked to
 * the exact turn. Ledger session ids are nanoclaw `sess-…` ids, so runs are
 * matched via hostSessionIdFor (transcript UUID → host session dir).
 */
function delegationModelCell(x: DelegationExchange, pool: ExecutionRun[]): string {
  const target = pool.find((r) => r.groupId === x.request.to_group && hostSessionIdFor(r) === x.request.to_session);
  if (!target) return '<span class="muted">–</span>';
  const reqMs = Date.parse(x.request.ts);
  const turn = target.turns
    .filter((t) => t.trigger.kind === 'a2a' && Date.parse(t.startedAt) >= reqMs - 60_000)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
  const href = `/runs/session?group=${encodeURIComponent(target.groupId)}&session=${encodeURIComponent(target.sessionId)}${turn ? `#turn-${turn.index}` : ''}`;
  const models = turn ? [...new Set(turn.modelCalls.map((c) => shortModel(c.model)))].join(', ') : '';
  return `<a href="${esc(href)}">${esc(models || 'view run')}</a>`;
}

/**
 * Delegations panel: the durable a2a ledger (central DB `a2a_delegations`)
 * paired into request/reply exchanges, with outcome badges and per-tier
 * 30-day effectiveness stats. This is the panel to read when evaluating
 * whether down/up delegation is actually working.
 */
function delegationsSection(pool: ExecutionRun[], names: Map<string, string>): string {
  const exchanges = safe(() => readDelegationExchanges(40), [] as DelegationExchange[]);
  const stats = safe(() => delegationStats(30), null);

  const outcomeBadge = (x: DelegationExchange) =>
    x.outcome === 'answered'
      ? '<span class="pill" style="color:var(--green,#3fb950);border-color:var(--green,#3fb950)">answered</span>'
      : x.outcome === 'escalated'
        ? `<span class="pill" style="color:var(--red,#f85149);border-color:var(--red,#f85149)" title="${esc(x.reply?.escalation ?? '')}">escalated</span>`
        : '<span class="pill muted">pending</span>';

  const rows = exchanges
    .map((x) => {
      const tier = x.request.tier
        ? `<span class="pill">${esc(x.request.tier)}</span>`
        : '<span class="muted small">–</span>';
      return `<tr><td class="small">${esc(fmtTs(x.request.ts))}</td>
<td>${esc(names.get(x.request.from_group) ?? x.request.from_group)} → ${esc(names.get(x.request.to_group) ?? x.request.to_group)}</td>
<td>${tier}</td><td class="small" style="max-width:420px" title="${esc(x.request.summary)}">${esc(x.request.summary.slice(0, 140))}</td>
<td>${outcomeBadge(x)}</td><td>${delegationModelCell(x, pool)}</td>
<td class="dur">${esc(fmtMs(x.latencyMs))}</td><td>${x.request.file_count || ''}</td></tr>`;
    })
    .join('');

  const tierStats =
    stats && stats.total
      ? Object.entries(stats.byTier)
          .map(([tier, t]) => `${tier}: ${t.total}${t.escalated ? ` (${t.escalated} esc)` : ''}`)
          .join(' · ')
      : '';
  const statLine =
    stats && stats.total
      ? `<p class="muted small">Last ${stats.windowDays}d: <b>${stats.total}</b> delegations · ${stats.answered} answered · ${stats.escalated} escalated · ${stats.pending} pending${tierStats ? ` — by tier: ${tierStats}` : ''}</p>`
      : '<p class="muted small">No ledger rows yet. Rows appear when one agent group messages another (e.g. Jeeves → Errand Runner). For ad-hoc analysis: <code>pnpm exec tsx scripts/q.ts data/v2.db "SELECT * FROM a2a_delegations"</code>.</p>';

  return `<h2>Delegations</h2>
<p class="muted">Durable a2a delegation ledger (central DB, survives log rotation). Request/reply exchanges with tier directives, outcomes, and the model that actually ran the work.</p>
${statLine}
<table><tr><th>time</th><th>route</th><th>tier</th><th>task</th><th>outcome</th><th>model ran</th><th>latency</th><th>files</th></tr>
${rows || '<tr><td colspan=8 class="muted">none recorded yet</td></tr>'}</table>`;
}

function mergeSeries(seriesList: SeriesPoint[][]): SeriesPoint[] {
  const byT = new Map<string, number>();
  for (const series of seriesList) for (const p of series) byT.set(p.t, (byT.get(p.t) ?? 0) + p.value);
  return [...byT.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, value]) => ({ t, value }));
}

interface SenderAgg {
  name: string;
  channel: string;
  n: number;
  last: string;
  member: boolean;
}

/**
 * Aggregate senders for a group straight from its session inbound DBs (small
 * data, render-time only). `member` flags whether the sender is on the allowlist
 * (agent_group_members): the per-message key `${channel}:${id}` is the same
 * `<channel>:<handle>` shape as a member user id, so a Set lookup classifies each
 * sender directly. Shared by the detail-page table and the Overview card band.
 */
function aggregateSenders(groupId: string, fromIso: string, memberIds: Set<string>): SenderAgg[] {
  const counts = new Map<string, SenderAgg>();
  for (const d of safe(() => listSessionDirs(), []).filter((x) => x.groupId === groupId)) {
    const rows = safe(() => {
      const db = new Database(path.join(d.dir, 'inbound.db'), { readonly: true, fileMustExist: true });
      try {
        return db
          .prepare("SELECT content, channel_type, timestamp FROM messages_in WHERE kind != 'task' AND timestamp >= ?")
          .all(fromIso) as { content: string; channel_type: string; timestamp: string }[];
      } finally {
        db.close();
      }
    }, []);
    for (const r of rows) {
      try {
        const c = JSON.parse(r.content);
        const id = String(c.senderId ?? c.author?.userId ?? c.sender ?? 'unknown');
        // Normalize to the canonical `<channel>:<handle>` so the key matches
        // agent_group_members ids and the bare-vs-already-prefixed representations of
        // one sender collapse into a single row. See senderKey for the why.
        const key = senderKey(r.channel_type, id);
        const cur = counts.get(key) ?? {
          name: String(c.senderName ?? c.sender ?? id),
          channel: r.channel_type,
          n: 0,
          last: '',
          member: memberIds.has(key),
        };
        cur.n++;
        if (r.timestamp > cur.last) cur.last = r.timestamp;
        counts.set(key, cur);
      } catch {
        /* skip */
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n);
}

/**
 * True when a channel has no allowlist semantics — internal transports (cli/agent)
 * and system rows. Such senders are neither "allowlisted" nor "unknown".
 */
function senderChannelInternal(channel: string): boolean {
  return !channel || NON_CHAT_CHANNELS.has(channel);
}

function sendersTable(cfg: OpsConfig, groupId: string, fromIso: string, memberIds: Set<string>): string {
  void cfg; // kept for call-site symmetry; aggregation needs only the group + window
  return (
    aggregateSenders(groupId, fromIso, memberIds)
      .map((s) => {
        // The allowlist only gates real chat channels; internal transports (cli/agent)
        // and system rows have no allowlist semantics, so show a neutral dash there
        // rather than mislabeling them "not on allowlist".
        const status = senderChannelInternal(s.channel)
          ? '<span class="muted small">—</span>'
          : s.member
            ? '<span class="state info">allowlisted</span>'
            : '<span class="state warn">not on allowlist</span>';
        return `<tr><td>${esc(s.name)}</td><td>${esc(s.channel)}</td><td>${s.n}</td><td class="small">${esc(fmtTs(s.last))}</td><td>${status}</td></tr>`;
      })
      .join('') || '<tr><td colspan=5 class="muted">none in range</td></tr>'
  );
}

interface GroupWorkItem extends SessionWorkItem {
  groupId: string;
  groupName: string;
}

function allWork(): GroupWorkItem[] {
  const names = new Map(safe(() => listAgentGroups(), []).map((g) => [g.id, g.name]));
  return safe(() => listSessionDirs(), [])
    .flatMap((dir) =>
      safe(
        () =>
          readSessionWork(dir.dir).map((item) => ({
            ...item,
            groupId: dir.groupId,
            groupName: names.get(dir.groupId) ?? dir.groupId,
          })),
        [],
      ),
    )
    .sort((a, b) => b.ageMs - a.ageMs);
}

function logsBody(params: URLSearchParams): string {
  const filters = {
    query: params.get('q') ?? '',
    level: params.get('level') ?? 'all',
    source: params.get('source') ?? 'all',
    category: params.get('category') ?? 'all',
    groupId: params.get('group') ?? '',
    sessionId: params.get('session') ?? '',
    limit: 300,
  };
  const events = readLogEvents(filters);
  const groups = safe(() => listAgentGroups(), []);
  const archiveHits = filters.query ? searchLogs(filters.query, 100) : [];
  const options = (values: string[], selected: string) =>
    values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const raw = [...tailLines(PATHS.hostLog, 200), ...tailLines(PATHS.hostErrLog, 100)]
    .map(stripLogFormatting)
    .join('\n');
  return `<form class="filters" method="get" action="/logs">
<input type="text" name="q" value="${esc(filters.query)}" placeholder="message, field, session, group">
<label>level <select name="level">${options(['all', 'fatal', 'error', 'warn', 'info', 'debug', 'unknown'], filters.level)}</select></label>
<label>category <select name="category">${options(['all', 'error', 'container', 'delivery', 'routing', 'cli', 'channel', 'approval', 'rate_limit', 'system'], filters.category)}</select></label>
<label>source <select name="source">${options(['all', 'nanoclaw.log', 'nanoclaw.error.log'], filters.source)}</select></label>
<label>group <select name="group"><option value="">all</option>${groups
    .map((g) => `<option value="${esc(g.id)}"${g.id === filters.groupId ? ' selected' : ''}>${esc(g.name)}</option>`)
    .join('')}</select></label>
<input type="text" name="session" value="${esc(filters.sessionId)}" placeholder="session id">
<button>Apply filters</button><a href="/logs">clear</a></form>
<p class="muted small">${events.length} structured events from current host and error logs, newest first. Search also includes rotated archives.</p>
<table><tr><th>time</th><th>level</th><th>category</th><th>event</th><th>scope</th><th>source</th></tr>
${
  events
    .map(
      (
        event,
      ) => `<tr><td class="small">${esc(event.clock ?? '–')}</td><td><span class="state ${esc(event.level)}">${esc(event.level)}</span></td>
<td>${esc(event.category)}</td><td><span class="diag-message">${esc(event.message)}</span><div class="diag-fields">${esc(formatDiagnosticFields(event.fields))}</div></td>
<td>${event.groupId ? esc(event.groupId) : ''}${event.groupId && event.sessionId ? '<br>' : ''}${event.sessionId ? `<code>${esc(event.sessionId)}</code>` : ''}</td>
<td class="small">${esc(event.source)}</td></tr>`,
    )
    .join('') || '<tr><td colspan=6 class="muted">No events match these filters.</td></tr>'
}</table>
${filters.query ? `<h2>Archive matches</h2><div class="log">${archiveHits.map((h) => `[${esc(h.source)}] ${esc(h.line)}`).join('\n') || 'no archive matches'}</div>` : ''}
<details class="raw"><summary>Raw logs</summary>
<p class="muted small">Fallback evidence from both live files. New lines stream here while this disclosure is open.</p>
<div class="log" id="livelog">${esc(raw)}\n</div></details>`;
}

function formatDiagnosticFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .slice(0, 8)
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}

// ---------------------------------------------------------------- trips
function healthState(trip: TripCompanionSnapshot): { label: string; css: string } {
  if (trip.core.error || trip.memory.error) return { label: 'unreadable', css: 'failed' };
  if (trip.warnings.length > 0) return { label: 'attention', css: 'warn' };
  return { label: 'healthy', css: 'info' };
}

function tableFreshness(table: TripCompanionSnapshot['databases'][number]['tables'][number]): string {
  if (!table.timestampColumn || !table.latestTimestamp) return '–';
  return `${esc(table.timestampColumn)} ${esc(fmtTs(table.latestTimestamp))}`;
}

function tablePreview(
  db: TripCompanionSnapshot['databases'][number],
  table: TripCompanionSnapshot['databases'][number]['tables'][number],
): string {
  if (db.scope !== 'group') return '';
  if (table.previewRows.length === 0) return '';
  const header = table.previewColumns.map((column) => `<th>${esc(column)}</th>`).join('');
  const rows = table.previewRows
    .map(
      (row) =>
        `<tr>${table.previewColumns
          .map((column) => `<td class="small">${esc((row[column] ?? '').slice(0, 180))}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<details class="raw"><summary class="muted small">Preview latest ${table.previewRows.length} row(s)</summary><table><tr>${header}</tr>${rows}</table></details>`;
}

function tripDatabaseRows(trip: TripCompanionSnapshot): string {
  return (
    trip.databases
      .map((db) => {
        const state = !db.exists || !db.readable ? 'failed' : db.tables.some((table) => table.error) ? 'warn' : 'info';
        const tableList =
          db.tables
            .slice(0, 12)
            .map(
              (table) =>
                `<div><b>${esc(table.name)}</b> <span class="muted">${table.rowCount ?? '–'} rows · ${tableFreshness(table)}</span>${
                  table.error ? `<div class="small state failed">${esc(table.error)}</div>` : ''
                }${tablePreview(db, table)}</div>`,
            )
            .join('') || '<span class="muted">No user tables.</span>';
        return `<tr><td><span class="state ${state}">${db.readable ? 'readable' : 'unreadable'}</span></td>
<td><b>${esc(db.label)}</b><div class="muted small">${esc(db.path)}</div></td>
<td>${esc(db.scope)}</td><td>${fmtBytes(db.sizeBytes)}</td><td>${esc(fmtTs(db.mtime))}</td>
<td class="small">${tableList}${db.tables.length > 12 ? `<div class="muted">+${db.tables.length - 12} more table(s)</div>` : ''}${
          db.error ? `<div class="state failed">${esc(db.error)}</div>` : ''
        }</td></tr>`;
      })
      .join('') || '<tr><td colspan=6 class="muted">No SQLite databases found for this trip group.</td></tr>'
  );
}

function tripOperationRows(trip: TripCompanionSnapshot): string {
  return (
    trip.operations
      .map(
        (event) => `<tr><td class="small">${esc(fmtTs(event.ts))}</td>
<td><span class="state ${esc(event.level)}">${esc(event.source)}</span><div class="muted small">${esc(event.category)}</div></td>
<td class="small">${esc(event.sessionId ?? '–')}</td><td>${esc(event.actor ?? '–')}<div class="muted small">${esc(event.channel ?? '')}</div></td>
<td><b>${esc(event.summary)}</b>${event.snippet ? `<div class="muted small">${esc(event.snippet)}</div>` : ''}</td></tr>`,
      )
      .join('') || '<tr><td colspan=5 class="muted">No recent operational events found.</td></tr>'
  );
}

function tripStatusCard(trip: TripCompanionSnapshot, cfg: OpsConfig, telegramBot?: TripTelegramBotIdentity): string {
  const health = healthState(trip);
  const latest = trip.grounding[0];
  const runtime = trip.host.lifecycleStatus ?? trip.host.desiredState ?? 'unknown';
  const active = trip.host.activeSessions > 0 || runtime === 'running';
  const runtimeCss = runtime === 'error' ? 'failed' : active ? 'info' : runtime === 'paused' ? 'warn' : 'scheduled';
  const memberNames = trip.host.members.map((member) => member.displayName || member.userId).join(', ');
  const wires = trip.host.wires
    .map((wire) => `${wire.channel ?? 'channel'} · ${wire.name || wire.platformId || 'unnamed'}${wire.hasDestination ? '' : ' · no destination'}`)
    .join(' · ');
  const action = trip.host.desiredState === 'paused' || trip.host.desiredState === 'stopped' ? 'resume' : 'pause';
  const actionLabel = action === 'resume' ? 'Resume agent' : 'Pause agent';
  return `<article class="card trip-agent-card">
<div class="flow-head"><h2 style="margin:0;border:0;padding:0;text-transform:none;font:600 16px var(--sans);color:var(--ink)">${esc(trip.name)}</h2>
<span class="state ${health.css}">${health.label}</span><span class="state ${runtimeCss}">${esc(runtime)}</span>
<span class="muted small">${esc(trip.id)} · groups/${esc(trip.folder)}</span></div>
<div class="trip-agent-metrics">
<div><span>Trip stage</span><b>${esc(trip.core.stage ?? (trip.core.configured ? 'configured' : 'not configured'))}</b></div>
<div><span>Agent runtime</span><b>${active ? 'active' : esc(runtime)}</b><small>${trip.host.activeSessions}/${trip.host.sessions.length} active sessions</small></div>
<div><span>Model</span><b>${esc(trip.host.model ?? 'default')}</b><small>${esc(trip.host.provider ?? 'claude')}</small></div>
<div><span>Members</span><b>${trip.host.members.length || trip.core.activeMembers}</b><small>${trip.core.families} families</small></div>
<div><span>Memory</span><b>${trip.memory.active} active</b><small>${trip.memory.pending} pending · ${trip.memory.rejected} rejected</small></div>
<div><span>Decisions / notes</span><b>${trip.core.openDecisions} / ${trip.core.openNotes}</b><small>open items</small></div>
</div>
<div class="trip-agent-detail-grid">
<div><h3>Host activity</h3><p class="small">Last activity <b>${esc(fmtTs(trip.host.lastActivity))}</b></p><p class="small">Latest grounding <b>${latest ? latest.coreOk && latest.memoryOk ? 'passed' : 'failed' : 'no evidence'}</b> <span class="muted">${esc(fmtTs(latest?.createdAt))}</span></p>
<p class="small">Sessions <b>${trip.host.sessions.length}</b> · pending <b>${trip.host.sessions.reduce((n, session) => n + session.pendingMessages, 0)}</b> · processing <b>${trip.host.sessions.reduce((n, session) => n + session.processingClaims, 0)}</b></p></div>
<div><h3>Roster &amp; wires</h3>${telegramBot ? `<p class="small"><b>Telegram bot for this group:</b> ${esc(telegramBot.username || telegramBot.displayName)}${telegramBot.username && telegramBot.displayName ? ` <span class="muted">(${esc(telegramBot.displayName)})</span>` : ''}</p>` : ''}<p class="small"><b>${esc(memberNames || 'No members recorded')}</b></p><p class="small muted">${esc(wires || 'No chat wires recorded')}</p></div>
</div>
${trip.warnings.length ? `<div class="trip-attention"><b>Attention</b> ${trip.warnings.map((warning) => esc(warning)).join(' · ')}</div>` : ''}
<div class="trip-agent-actions"><button data-trip-action="${action}" data-trip-id="${esc(trip.id)}">${actionLabel}</button><button data-trip-action="restart" data-trip-id="${esc(trip.id)}">Restart agent</button><button class="danger" data-trip-cleanup="${esc(trip.id)}">Clean up…</button></div>
<details><summary>Domain and runner details</summary><div class="trip-detail-summary"><span>Workflows <b>${trip.workflows.available ? trip.workflows.total : 'not initialized'}</b></span><span>failed actions <b>${trip.workflows.failedActions}</b></span><span>next timer <b>${esc(fmtTs(trip.workflows.nextTimer))}</b></span><span>memory owner <b>${esc(trip.memory.owner ?? 'not set')}</b></span><span><a href="/knowledge?group=${esc(trip.id)}&amp;status=all">View ${trip.memory.rows.length} memory rows in Knowledge →</a></span></div>
<details><summary>Grounding events (${trip.grounding.length})</summary><table><tr><th>time</th><th>session</th><th>core</th><th>memory</th><th>remember</th><th>errors</th></tr>${trip.grounding.map((event) => `<tr><td>${esc(fmtTs(event.createdAt))}</td><td class="small">${esc(event.sessionId)}</td><td><span class="state ${event.coreOk ? 'info' : 'failed'}">${event.coreOk ? 'ok' : 'failed'}</span></td><td><span class="state ${event.memoryOk ? 'info' : 'failed'}">${event.memoryOk ? 'ok' : 'failed'}</span><div class="muted">${event.memoryCountBefore} → ${event.memoryCountAfter ?? '–'}</div></td><td>${event.rememberRequested ? (event.rememberSatisfied ? 'saved' : event.rememberSatisfied === false ? 'not saved' : 'pending') : '–'}</td><td class="small">${esc(event.errors.join('; ') || '–')}</td></tr>`).join('') || '<tr><td colspan=6 class="muted">No grounding events yet.</td></tr>'}</table></details>
<details><summary>Database inventory (${trip.databases.length})</summary><p class="muted small">Read-only SQLite inventory for this group folder and its session DBs.</p><table><tr><th>state</th><th>database</th><th>scope</th><th>size</th><th>modified</th><th>tables</th></tr>${tripDatabaseRows(trip)}</table></details>
<details><summary>Recent operational messages (${trip.operations.length})</summary><p class="muted small">Recent host, session, and grounding evidence. Message snippets are ${cfg.tripCompanion.showMessageSnippets ? 'enabled' : 'disabled'}.</p><table><tr><th>time</th><th>source</th><th>session</th><th>actor</th><th>summary</th></tr>${tripOperationRows(trip)}</table></details></details>
</article>`;
}

function tripChannelSetupGuide(): string {
  return `<details class="trip-setup-guide" open>
<summary>Read this first: connect the external chat from this browser</summary>
<p class="small">This browser orchestrates the NanoClaw-side setup. You still perform the short security-sensitive action in Telegram or WhatsApp, then this page watches for completion and fills the exact chat/member identities into the trip draft. You do not need to type NanoClaw console commands.</p>
<div class="trip-channel-guides">
<details open><summary>Telegram — BotFather token, chat pairing, and user identities</summary>
<ol class="small">
<li><b>Create the bot for this trip group in Telegram.</b> Open <code>@BotFather</code>, send <code>/newbot</code>, choose the bot name and username, and copy the token for the bot you intend to add to this trip’s group. The token is for that one bot, not for individual people.</li>
<li><b>Start Telegram setup below.</b> Paste that BotFather token into the browser field when asked. The page installs/configures the adapter if necessary, stores the token on the host, restarts the host, and generates a one-time four-digit pairing code.</li>
<li><b>Create the trip group on Telegram.</b> Create a new private group, add the bot and the first trip participant, and leave this page open. Do not reuse a group already wired to another agent.</li>
<li><b>Send the exact code from that group.</b> With Group Privacy on, address the bot as <code>@your_bot_username 1234</code>; with privacy off, send the four digits alone. The browser detects the consumed code and fills the canonical Telegram group ID and first member automatically.</li>
<li><b>Add other participants from this page.</b> Have each person send one message in the group, click <b>Refresh discovered chats</b>, and add their discovered Telegram identity under Members. No participant token is needed.</li>
</ol>
<p class="trip-howto-note small"><b>Important:</b> there is no per-user Telegram token. The BotFather token belongs to the one bot. NanoClaw’s member allowlist uses identities such as <code>telegram:12345</code>, which this page discovers and inserts for you.</p>
</details>
<details><summary>WhatsApp — linked device, new group, and native JIDs</summary>
<ol class="small">
<li><b>Start WhatsApp setup below.</b> The browser installs the adapter if necessary and starts linked-device authentication. There is no WhatsApp bot token.</li>
<li><b>On the phone, link the assistant number.</b> Open <code>WhatsApp → Settings → Linked Devices → Link a Device</code>, then scan the QR shown here. The browser also offers phone-number pairing when QR scanning is not convenient.</li>
<li><b>Wait for the browser confirmation.</b> It saves the linked-device credentials and restarts NanoClaw automatically; keep the page open until it says WhatsApp is authenticated.</li>
<li><b>Create the trip group on WhatsApp.</b> Create a brand-new group containing the linked assistant number and the first participant. Send one message in that group so NanoClaw can discover it.</li>
<li><b>Select the discovered group here.</b> Click <b>Refresh discovered chats</b>, choose the exact group, then add each discovered participant. The page inserts the native group ID such as <code>&lt;digits&gt;@g.us</code> and member identities such as <code>whatsapp:&lt;phone&gt;@s.whatsapp.net</code>.</li>
</ol>
<p class="trip-howto-note small"><b>Members are not WhatsApp tokens.</b> The linked assistant phone authenticates the adapter; each participant is separately allowlisted by sender identity. For a group wire, keep <code>@mention</code> selected and mention the linked assistant in WhatsApp.</p>
</details>
</div>
<div class="trip-channel-apply small"><b>Recommended order:</b> start the browser connection below, complete the requested Telegram/WhatsApp action, let it fill the draft, add any remaining participants, then instantiate the trip. After it is live, send <code>@trip set up the trip</code> followed by <code>@trip status</code> in the connected chat.</div>
</details>`;
}

function tripsSetupBody(draft: TripConsoleDraft): string {
  const members = draft.members.length ? draft.members : [{ user: '', displayName: '' }];
  const wires = draft.wires.length ? draft.wires : [{
    channel: 'cli', platformId: '', engageMode: 'pattern', engagePattern: '@trip', senderScope: 'known',
    ignoredMessagePolicy: 'accumulate', sessionMode: 'shared', name: '',
  }];
  const memberRows = members.map((member, index) => `<div class="trip-config-row" data-member-row>
<span class="trip-row-number">${String(index + 1).padStart(2, '0')}</span><label><span>User identity *</span><input type="text" data-member-field="user" value="${esc(member.user)}" placeholder="telegram:12345"></label><label><span>Display name</span><input type="text" data-member-field="displayName" value="${esc(member.displayName)}" placeholder="Alex"></label><button type="button" class="trip-remove" data-remove-row>Remove</button></div>`).join('');
  const wireRows = wires.map((wire, index) => `<div class="trip-config-row trip-wire-row" data-wire-row>
<span class="trip-row-number">${String(index + 1).padStart(2, '0')}</span><label><span>Channel *</span><input type="text" data-wire-field="channel" value="${esc(wire.channel)}" placeholder="telegram or whatsapp"></label><label><span>Chat / platform ID *</span><input type="text" data-wire-field="platformId" value="${esc(wire.platformId)}" placeholder="telegram:-100… or 120…@g.us"></label><label><span>Engage (groups: @mention)</span><select data-wire-field="engageMode"><option value="mention" ${wire.engageMode === 'mention' ? 'selected' : ''}>@mention</option><option value="mention-sticky" ${wire.engageMode === 'mention-sticky' ? 'selected' : ''}>sticky mention</option><option value="pattern" ${wire.engageMode === 'pattern' ? 'selected' : ''}>pattern</option></select></label><label><span>Pattern (CLI / if used)</span><input type="text" data-wire-field="engagePattern" value="${esc(wire.engagePattern)}" placeholder="@trip"></label><button type="button" class="trip-remove" data-remove-row>Remove</button></div>`).join('');
  return `<section class="card trip-setup-card">
<div class="flow-head"><div><h2 style="margin:0;border:0;padding:0;text-transform:none;font:600 16px var(--sans);color:var(--ink)">Instantiate a trip agent</h2><p class="muted small">Uses the same validated config and host wiring as <code>/new-trip</code>. A new agent wakes on its first routed message.</p></div><span class="state info">config → apply</span></div>
${tripChannelSetupGuide()}
<section class="trip-channel-onboarding" aria-labelledby="trip-channel-onboarding-title">
<div class="flow-head"><div><h3 id="trip-channel-onboarding-title">Connect a Telegram or WhatsApp chat from this browser</h3><p class="muted small">This starts the pairing/authentication flow and keeps the external-platform instructions beside the live result.</p></div><span class="state info">web setup</span></div>
<div class="trip-onboarding-controls">
<label><span>Platform</span><select id="trip-onboarding-channel"><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option></select></label>
<label id="trip-telegram-token-wrap"><span>Token for this trip’s Telegram bot <small>(from @BotFather; only needed once)</small></span><input id="trip-telegram-token" type="password" autocomplete="off" placeholder="Paste the token for the bot joining this group"></label>
<label id="trip-whatsapp-method-wrap" hidden><span>WhatsApp link method</span><select id="trip-whatsapp-method"><option value="qr">QR code</option><option value="pairing-code">Phone pairing code</option></select></label>
<label id="trip-whatsapp-phone-wrap" hidden><span>WhatsApp phone number <small>(digits, country code)</small></span><input id="trip-whatsapp-phone" type="text" inputmode="tel" placeholder="15550000005"></label>
<button type="button" data-start-trip-onboarding>Start Telegram setup</button>
</div>
${draft.telegramBot ? `<div class="trip-bot-context"><b>Telegram bot for this trip group:</b> ${esc(draft.telegramBot.username || draft.telegramBot.displayName)}${draft.telegramBot.username && draft.telegramBot.displayName ? ` <span class="muted">(${esc(draft.telegramBot.displayName)})</span>` : ''}<span class="muted small"> · verified from BotFather token; bot name is display context, not a required credential</span></div>` : '<div class="trip-bot-context muted small">For Telegram, this token identifies the specific bot that will join this trip group. The bot name is not required; after verification, its @username and display name will be shown here.</div>'}
<div id="trip-onboarding-status" class="trip-onboarding-status" hidden aria-live="polite"></div>
<div id="trip-discovered-results" class="trip-discovered-results" hidden></div>
</section>
<form id="trip-config-form" data-draft="${esc(JSON.stringify(draft))}">
<div class="trip-form-grid"><label><span>Trip name *</span><input type="text" data-trip-field="name" value="${esc(draft.name)}" placeholder="Goa 2026"></label><label><span>Model</span><select data-trip-field="model"><option value="haiku" ${draft.model === 'haiku' ? 'selected' : ''}>haiku</option><option value="sonnet" ${draft.model === 'sonnet' ? 'selected' : ''}>sonnet</option><option value="opus" ${draft.model === 'opus' ? 'selected' : ''}>opus</option></select></label><label><span>Messages per wake</span><input type="text" data-trip-field="maxMessagesPerPrompt" value="${esc(draft.maxMessagesPerPrompt)}" inputmode="numeric"></label></div>
<details class="trip-advanced"><summary>Advanced identity</summary><div class="trip-form-grid"><label><span>Agent group ID</span><input type="text" data-trip-field="id" value="${esc(draft.id)}" placeholder="ag-goa-2026"></label><label><span>Workspace folder</span><input type="text" data-trip-field="folder" value="${esc(draft.folder)}" placeholder="goa-2026"></label></div></details>
<div class="trip-form-section"><div class="flow-head"><h3>Members</h3><button type="button" data-add-member>Add member</button></div><p class="muted small">These are human participants allowed to wake the trip, not bot credentials: Telegram <code>telegram:&lt;numeric-user-id&gt;</code>; WhatsApp <code>whatsapp:&lt;phone&gt;@s.whatsapp.net</code>. The Telegram bot for this trip group is shown separately above and is not added as a human member.</p><div id="trip-members">${memberRows}</div></div>
<div class="trip-form-section"><div class="flow-head"><h3>Chat wires</h3><button type="button" data-add-wire>Add wire</button></div><p class="muted small">Telegram groups use <code>telegram:-100…</code> (raw <code>-100…</code> is normalized). WhatsApp groups use native <code>&lt;digits&gt;@g.us</code>; WhatsApp DMs use <code>&lt;phone&gt;@s.whatsapp.net</code>. A CLI wire is useful for a private smoke test and uses <code>@trip</code>.</p><div id="trip-wires">${wireRows}</div></div>
<div class="trip-form-actions"><button type="button" data-save-trip>Save draft</button><button type="submit">Instantiate trip agent →</button><span id="trip-form-message" class="muted small" aria-live="polite"></span></div>
</form></section>`;
}

function tripsBody(cfg: OpsConfig, draft: TripConsoleDraft): string {
  const trips = readTripCompanions(
    safe(() => listAgentGroups(), []),
    {
      showMessageSnippets: cfg.tripCompanion.showMessageSnippets,
    },
  );
  const active = trips.filter((trip) => trip.host.activeSessions > 0 || trip.host.lifecycleStatus === 'running').length;
  const attention = trips.filter((trip) => trip.warnings.length > 0 || trip.core.error || trip.memory.error).length;
  return `<h1>Trip Companion</h1>
<p class="muted">Instantiate and retire Trip Companion agents here. Status combines the trip ledger with host lifecycle, session, roster, wire, memory, and grounding evidence.</p>
<div class="statstrip trip-statstrip"><div class="stat"><span class="lbl">Instantiated</span><span class="num">${trips.length}</span><span class="sub">trip workspaces found</span></div><div class="stat"><span class="lbl">Active agents</span><span class="num">${active}</span><span class="sub">running or serving sessions</span></div><div class="stat"><span class="lbl">Attention</span><span class="num">${attention}</span><span class="sub">warnings or unreadable stores</span></div><div class="stat"><span class="lbl">Last checked</span><span class="num" style="font-size:16px">${esc(fmtTs(new Date().toISOString()))}</span><span class="sub">refresh for current host state</span></div></div>
${tripsSetupBody(draft)}
<section class="trip-status-section"><div class="flow-head"><div><h2>Instantiated trip agents</h2><p class="muted small">A trip can be configured before its first message. “Active” means the host lifecycle is running or one of its sessions is running/idle.</p></div><button type="button" data-refresh-trips>↻ Refresh status</button></div>
<div id="trip-status-grid">${trips.length ? trips.map((trip) => tripStatusCard(trip, cfg, trip.id === draft.id ? draft.telegramBot : undefined)).join('') : '<div class="card empty"><h3>No trip agents instantiated</h3><p class="muted">Use the setup form above to create the first trip workspace.</p></div>'}</div></section>
<dialog id="trip-cleanup-dialog"><form method="dialog"><button type="button" class="trip-dialog-close" data-close-cleanup>×</button><p class="muted small">DANGER ZONE</p><h2 id="trip-cleanup-title">Clean up trip</h2><p id="trip-cleanup-copy" class="small"></p><label class="trip-confirm-label"><span>Type the exact agent group ID to confirm</span><input id="trip-cleanup-confirmation" type="text" autocomplete="off"></label><div class="trip-cleanup-options"><label><input type="radio" name="trip-cleanup-mode" value="retain" checked><span><b>Remove registration</b><small>Pause the agent and remove host wiring. Keep groups/ and session files for recovery.</small></span></label><label><input type="radio" name="trip-cleanup-mode" value="archive"><span><b>Archive and purge</b><small>Only for archived/cancelled trips. Creates and verifies the archive, then removes the live workspace and host records.</small></span></label></div><div class="trip-dialog-actions"><button type="button" data-close-cleanup>Cancel</button><button type="button" class="danger" data-confirm-cleanup>Clean up</button></div></form></dialog>
<script>(function(){
const form=document.getElementById('trip-config-form'); const msg=document.getElementById('trip-form-message'); let cleanupId='';
const onboardingBox=document.getElementById('trip-onboarding-status'); const discoveredBox=document.getElementById('trip-discovered-results'); const onboardingChannelSelect=document.getElementById('trip-onboarding-channel'); const telegramToken=document.getElementById('trip-telegram-token'); const telegramTokenWrap=document.getElementById('trip-telegram-token-wrap'); const whatsappMethod=document.getElementById('trip-whatsapp-method'); const whatsappMethodWrap=document.getElementById('trip-whatsapp-method-wrap'); const whatsappPhone=document.getElementById('trip-whatsapp-phone'); const whatsappPhoneWrap=document.getElementById('trip-whatsapp-phone-wrap'); const startOnboarding=document.querySelector('[data-start-trip-onboarding]'); let onboardingTimer=null; let onboardingSession=''; let activeOnboardingChannel=''; const appliedSessions=new Set();
const escClient=(v)=>String(v??'').replace(/[&<>\"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const api=async(path,options)=>{const init=Object.assign({},options||{}, {headers:Object.assign({},(options&&options.headers)||{})}); if(init.body&&typeof init.body!=='string'){init.headers['content-type']='application/json';init.body=JSON.stringify(init.body)} if((init.method||'GET')==='POST')init.headers['x-ops-action-token']=window.__opsToken; const r=await fetch(path,init); const j=await r.json().catch(()=>({message:'HTTP '+r.status})); if(!r.ok)throw new Error(j.message||j.error||('HTTP '+r.status)); return j};
const setMsg=(text,kind)=>{msg.textContent=text;msg.className='small '+(kind||'muted')};
const input=(row,field)=>row.querySelector('[data-'+(row.hasAttribute('data-member-row')?'member':'wire')+'-field="'+field+'"]');
const readDraft=()=>{const d=JSON.parse(form.dataset.draft||'{}'); form.querySelectorAll('[data-trip-field]').forEach((el)=>{const f=el.dataset.tripField; d[f]=f==='maxMessagesPerPrompt'?Number(el.value):el.value}); d.members=[...document.querySelectorAll('[data-member-row]')].map((row)=>({user:input(row,'user').value,displayName:input(row,'displayName').value})); d.wires=[...document.querySelectorAll('[data-wire-row]')].map((row)=>({channel:input(row,'channel').value,platformId:input(row,'platformId').value,engageMode:input(row,'engageMode').value,engagePattern:input(row,'engagePattern').value,senderScope:'known',ignoredMessagePolicy:'accumulate',sessionMode:'shared',name:''})); return d};
const bindRemove=()=>document.querySelectorAll('[data-remove-row]').forEach((b)=>b.onclick=()=>{const row=b.closest('.trip-config-row'); if(row.parentElement.children.length>1)row.remove();});
const addMember=()=>{const n=document.querySelectorAll('[data-member-row]').length+1; document.getElementById('trip-members').insertAdjacentHTML('beforeend','<div class="trip-config-row" data-member-row><span class="trip-row-number">'+String(n).padStart(2,'0')+'</span><label><span>User identity *</span><input type="text" data-member-field="user" placeholder="telegram:12345"></label><label><span>Display name</span><input type="text" data-member-field="displayName" placeholder="Alex"></label><button type="button" class="trip-remove" data-remove-row>Remove</button></div>');bindRemove()};
const addWire=()=>{const n=document.querySelectorAll('[data-wire-row]').length+1; document.getElementById('trip-wires').insertAdjacentHTML('beforeend','<div class="trip-config-row trip-wire-row" data-wire-row><span class="trip-row-number">'+String(n).padStart(2,'0')+'</span><label><span>Channel *</span><input type="text" data-wire-field="channel" placeholder="telegram or whatsapp"></label><label><span>Chat / platform ID *</span><input type="text" data-wire-field="platformId" placeholder="telegram:-100… or 120…@g.us"></label><label><span>Engage (groups: @mention)</span><select data-wire-field="engageMode"><option value="mention" selected>@mention</option><option value="mention-sticky">sticky mention</option><option value="pattern">pattern</option></select></label><label><span>Pattern (CLI / if used)</span><input type="text" data-wire-field="engagePattern" value="@trip" placeholder="@trip"></label><button type="button" class="trip-remove" data-remove-row>Remove</button></div>');bindRemove()};
const submit=async(saveOnly)=>{const draft=readDraft(); setMsg(saveOnly?'Saving draft…':'Validating and instantiating…','muted'); try{const result=await api(saveOnly?'/api/trips/draft':'/api/trips/instantiate',{method:'POST',body:{draft}}); form.dataset.draft=JSON.stringify(result.draft||draft); setMsg(saveOnly?'Draft saved.':('Trip '+(result.id||'agent')+' instantiated. Refreshing…'),'good'); if(!saveOnly)setTimeout(()=>location.reload(),500)}catch(e){setMsg(e.message,'err')}};
const syncOnboardingControls=()=>{const telegram=activeOnboardingChannel==='telegram'; telegramTokenWrap.hidden=!telegram; whatsappMethodWrap.hidden=telegram; whatsappPhoneWrap.hidden=telegram||whatsappMethod.value!=='pairing-code'; startOnboarding.textContent=telegram?'Start Telegram setup':'Start WhatsApp setup'};
const renderInstructions=(j)=>{const list=(j.instructions||[]).map((x)=>'<li>'+escClient(x)+'</li>').join(''); let html='<h4>'+escClient(j.channel==='telegram'?'Telegram pairing':'WhatsApp connection')+' · '+escClient(j.status)+'</h4>'; if(j.bot)html+='<div class="trip-bot-context"><b>Bot for this trip group:</b> '+escClient(j.bot.username||j.bot.displayName)+(j.bot.username&&j.bot.displayName?' <span class="muted">('+escClient(j.bot.displayName)+')</span>':'')+'<div class="muted small">Verified from the BotFather token. The name is shown for clarity; it is not a separate credential.</div></div>'; if(j.code)html+='<div class="small">One-time code</div><div class="trip-onboarding-code">'+escClient(j.code)+'</div>'; if(j.pairingCode)html+='<div class="small">Enter this code on the phone</div><div class="trip-onboarding-code">'+escClient(j.pairingCode)+'</div>'; if(j.qrDataUrl)html+='<img class="trip-onboarding-qr" alt="WhatsApp linked-device QR code" src="'+escClient(j.qrDataUrl)+'">'; if(j.error)html+='<p class="state failed">'+escClient(j.error)+'</p>'; html+='<ol>'+list+'</ol>'; if(j.channel==='whatsapp'&&j.status==='authenticated')html+='<p><button type="button" data-discover-chats>Refresh discovered chats</button></p>'; if(j.channel==='telegram'&&(j.status==='consumed'||j.status==='needs-group'))html+='<p class="muted small">The pairing result is ready to apply to the draft.</p>'; onboardingBox.innerHTML=html; onboardingBox.hidden=false; const discover=onboardingBox.querySelector('[data-discover-chats]'); if(discover)discover.onclick=()=>discoverChannel('whatsapp')};
const applyConnection=async(connection)=>{try{const result=await api('/api/trips/onboarding/apply',{method:'POST',body:{draft:readDraft(),...connection}}); form.dataset.draft=JSON.stringify(result.draft); setMsg('Connected '+connection.channel+' chat and saved its exact NanoClaw identities.','good'); location.reload()}catch(e){setMsg(e.message,'err')}};
const discoverChannel=async(channel)=>{try{const result=await api('/api/trips/onboarding/discovered?channel='+encodeURIComponent(channel)); let html='<h4>Discovered '+escClient(channel)+' chats and people</h4>'; html+='<div class="small muted">Choose the exact new trip chat. Then add the participants who should be allowed to wake the trip.</div>'; html+='<div>'+((result.chats||[]).map((chat)=>'<div class="trip-discovered-row"><span><b>'+escClient(chat.name||chat.platformId)+'</b><br><code>'+escClient(chat.platformId)+'</code></span><button type="button" data-use-chat="'+escClient(chat.platformId)+'" data-chat-name="'+escClient(chat.name||'')+'">Use chat</button></div>').join('')||'<p class="muted small">No chats discovered yet. Create the new group, send one message, then refresh.</p>')+'</div>'; html+='<h4 style="margin-top:12px">Participants</h4>'; html+='<div>'+((result.users||[]).map((user)=>'<div class="trip-discovered-row"><span><b>'+escClient(user.displayName||user.id)+'</b><br><code>'+escClient(user.id)+'</code></span><button type="button" data-use-user="'+escClient(user.id)+'" data-user-name="'+escClient(user.displayName||'')+'">Add member</button></div>').join('')||'<p class="muted small">No participant identities discovered yet. Have each person send one message in the group.</p>')+'</div>'; discoveredBox.innerHTML=html; discoveredBox.hidden=false; discoveredBox.querySelectorAll('[data-use-chat]').forEach((b)=>b.onclick=()=>applyConnection({channel,platformId:b.dataset.useChat,chatName:b.dataset.chatName})); discoveredBox.querySelectorAll('[data-use-user]').forEach((b)=>b.onclick=()=>applyConnection({channel,userId:b.dataset.useUser,displayName:b.dataset.userName,platformId:''}))}catch(e){setMsg(e.message,'err')}};
const pollOnboarding=async()=>{if(!onboardingSession)return; try{const j=await api('/api/trips/onboarding/'+encodeURIComponent(onboardingSession)); renderInstructions(j); if(j.channel==='telegram'&&j.status==='consumed'&&!appliedSessions.has(j.sessionId)){appliedSessions.add(j.sessionId); await applyConnection({channel:'telegram',platformId:j.consumed.platformId,userId:j.consumed.userId,displayName:j.consumed.name||'',chatName:j.consumed.name||'',bot:j.bot}); return} const done=j.status==='failed'||j.status==='invalidated'||j.status==='needs-group'||j.status==='needs-token'||(j.channel==='whatsapp'&&j.status==='authenticated'&&j.hostRestart!=='pending'); if(done&&onboardingTimer){clearInterval(onboardingTimer);onboardingTimer=null}}catch(e){if(onboardingTimer){clearInterval(onboardingTimer);onboardingTimer=null}setMsg(e.message,'err')}};
const start=async()=>{const channel=activeOnboardingChannel; startOnboarding.disabled=true; setMsg(channel==='telegram'?'Starting Telegram pairing…':'Starting WhatsApp authentication…','muted'); try{const result=await api('/api/trips/onboarding/'+channel,{method:'POST',body:channel==='telegram'?{draft:readDraft(),token:telegramToken.value}:{method:whatsappMethod.value,phone:whatsappPhone.value}}); onboardingSession=result.sessionId; activeOnboardingChannel=channel; renderInstructions(result); if(onboardingTimer)clearInterval(onboardingTimer); onboardingTimer=setInterval(pollOnboarding,1200); await pollOnboarding(); telegramToken.value=''}catch(e){setMsg(e.message,'err')}finally{startOnboarding.disabled=false}};
onboardingChannelSelect.onchange=()=>{activeOnboardingChannel=onboardingChannelSelect.value;syncOnboardingControls()}; whatsappMethod.onchange=syncOnboardingControls; activeOnboardingChannel=onboardingChannelSelect.value; syncOnboardingControls(); startOnboarding.onclick=start; form.addEventListener('submit',(e)=>{e.preventDefault();submit(false)}); document.querySelector('[data-save-trip]').onclick=()=>submit(true); document.querySelector('[data-add-member]').onclick=addMember; document.querySelector('[data-add-wire]').onclick=addWire; bindRemove();
let dialog=document.getElementById('trip-cleanup-dialog'); const copy=document.getElementById('trip-cleanup-copy'); const confirmInput=document.getElementById('trip-cleanup-confirmation'); const close=()=>dialog.close(); document.querySelectorAll('[data-close-cleanup]').forEach((b)=>b.onclick=close); document.querySelectorAll('[data-trip-cleanup]').forEach((b)=>b.onclick=()=>{cleanupId=b.dataset.tripCleanup;document.getElementById('trip-cleanup-title').textContent='Clean up '+cleanupId;copy.textContent='Choose whether to remove the live registration and retain files, or archive and purge a completed trip. The action cannot be undone after confirmation.';confirmInput.value='';dialog.showModal()});
document.querySelector('[data-confirm-cleanup]').onclick=async()=>{const mode=document.querySelector('input[name="trip-cleanup-mode"]:checked').value; if(confirmInput.value!==cleanupId){copy.textContent='Type '+cleanupId+' exactly to continue.';return} const b=document.querySelector('[data-confirm-cleanup]');b.disabled=true;try{await api('/api/trips/'+encodeURIComponent(cleanupId)+'/cleanup',{method:'POST',body:{mode,confirmation:confirmInput.value}});dialog.close();location.reload()}catch(e){copy.textContent=e.message;b.disabled=false}};
document.querySelectorAll('[data-trip-action]').forEach((b)=>b.onclick=async()=>{b.disabled=true;try{await api('/api/trips/'+encodeURIComponent(b.dataset.tripId)+'/action',{method:'POST',body:{action:b.dataset.tripAction}});location.reload()}catch(e){setMsg(e.message,'err');b.disabled=false}}); document.querySelector('[data-refresh-trips]').onclick=()=>location.reload();
})();</script>`;
}

// ---------------------------------------------------------------- knowledge
const KNOWLEDGE_TEXT_PREVIEW_BYTES = 24_000;
const KNOWLEDGE_SQLITE_SHADOW_TABLE = /_fts(?:_|$)/i;

function readKnowledgeTextPreview(file: string): { text: string; truncated: boolean; size: number } | null {
  return safe(() => {
    const buf = fs.readFileSync(file);
    const slice = buf.subarray(0, KNOWLEDGE_TEXT_PREVIEW_BYTES);
    return { text: slice.toString('utf8'), truncated: buf.length > slice.length, size: buf.length };
  }, null);
}

function knowledgeTextDetails(file: string): string {
  const preview = readKnowledgeTextPreview(file);
  if (!preview) return '<p class="muted small">Unable to read this file.</p>';
  const suffix = preview.truncated
    ? `<p class="muted small">Showing first ${fmtBytes(KNOWLEDGE_TEXT_PREVIEW_BYTES)} of ${fmtBytes(preview.size)}.</p>`
    : `<p class="muted small">${fmtBytes(preview.size)} text file.</p>`;
  return `${suffix}<pre class="log">${esc(preview.text || '(empty file)')}</pre>`;
}

/** Directory listing (names/sizes/mtime only — never transcript bodies). */
function knowledgeDirDetails(dir: string): string {
  const files = safe(
    () =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => {
          const file = path.join(dir, entry.name);
          const stat = fs.statSync(file);
          return {
            name: entry.name,
            kind: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            updated: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, 40),
    [],
  );
  if (!files.length) return '<p class="muted small">No visible files in this folder.</p>';
  return `<p class="muted small">Most recently changed files (names only).</p>
<table><tr><th>name</th><th>kind</th><th>size</th><th>updated</th></tr>${files
    .map(
      (file) =>
        `<tr><td><code>${esc(file.name)}</code></td><td>${esc(file.kind)}</td><td>${fmtBytes(file.size)}</td><td class="small">${esc(fmtTs(file.updated))}</td></tr>`,
    )
    .join('')}</table>`;
}

function knowledgeArtifactsDetails(groupDir: string): string {
  const files = safe(() => listGroupArtifacts(groupDir), []);
  if (!files.length) return '<p class="muted small">No generated artifacts.</p>';
  return `<p class="muted small">Generated knowledge artifacts sitting outside a first-class store.</p>
<table><tr><th>name</th><th>size</th><th>updated</th></tr>${files
    .map(
      (f) =>
        `<tr><td><code>${esc(f.name)}</code></td><td>${fmtBytes(f.size)}</td><td class="small">${esc(fmtTs(f.updated))}</td></tr>`,
    )
    .join('')}</table>`;
}

/** memory.config.json rendered as a policy summary, not raw JSON. */
function knowledgeConfigDetails(file: string): string {
  const cfg = safe(() => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>, null);
  if (!cfg) return knowledgeTextDetails(file);
  const cats = Array.isArray(cfg.categories) ? (cfg.categories as unknown[]).map(String) : [];
  const approval = cfg.approval as { required?: boolean; owner?: string } | undefined;
  const reflection = cfg.reflection as { cadence?: string; autoCommit?: boolean; proposeTopN?: number } | undefined;
  const decay = cfg.decay as { halflifeDays?: number } | undefined;
  const retrieval = cfg.retrieval as { semantic?: boolean; k?: number; weights?: Record<string, number> } | undefined;
  const rows: string[] = [];
  rows.push(`<tr><td>scope</td><td><code>${esc(String(cfg.scope ?? '–'))}</code></td></tr>`);
  rows.push(
    `<tr><td>categories</td><td>${cats.map((c) => `<span class="pill">${esc(c)}</span>`).join(' ') || '<span class="muted">none declared</span>'}</td></tr>`,
  );
  rows.push(
    `<tr><td>approval</td><td>${approval?.required ? `required${approval.owner ? ` · owner ${esc(approval.owner)}` : ''}` : 'auto-commit'}</td></tr>`,
  );
  rows.push(
    `<tr><td>reflection</td><td>${reflection ? `${esc(reflection.cadence ?? 'manual')}${reflection.autoCommit ? ' · auto-commit' : ''}${reflection.proposeTopN ? ` · top ${reflection.proposeTopN}` : ''}` : '–'}</td></tr>`,
  );
  if (decay?.halflifeDays) rows.push(`<tr><td>decay</td><td>half-life ${decay.halflifeDays}d</td></tr>`);
  if (retrieval)
    rows.push(
      `<tr><td>retrieval</td><td>${retrieval.semantic ? 'semantic' : 'lexical'} · k=${retrieval.k ?? '–'}${
        retrieval.weights
          ? ` · ${Object.entries(retrieval.weights)
              .map(([k, v]) => `${esc(k)} ${v}`)
              .join(' / ')}`
          : ''
      }</td></tr>`,
    );
  return `<p class="muted small">Engine policy (from memory.config.json).</p><table>${rows.join('')}</table>`;
}

function knowledgeTablePreview(table: SqliteTableSummary): string {
  if (table.error) return `<p class="muted small">Could not inspect table: ${esc(table.error)}</p>`;
  if (!table.previewRows.length || !table.previewColumns.length) {
    return '<p class="muted small">No preview rows available.</p>';
  }
  const cell = (value: string) => {
    const display = value.length > 320 ? `${value.slice(0, 320)}...` : value;
    return `<td class="small" title="${esc(value)}">${esc(display)}</td>`;
  };
  return `<table><tr>${table.previewColumns.map((column) => `<th>${esc(column)}</th>`).join('')}</tr>${table.previewRows
    .map((row) => `<tr>${table.previewColumns.map((column) => cell(row[column] ?? '')).join('')}</tr>`)
    .join('')}</table>`;
}

function knowledgeDbDetails(file: string, label: string): string {
  const db = safe(() => inspectSqliteDb(file, { label, scope: 'knowledge' }), null);
  if (!db) return '<p class="muted small">Unable to inspect this database.</p>';
  if (!db.readable) {
    return `<p class="muted small">Database exists but could not be read: ${esc(db.error ?? 'unknown error')}</p>`;
  }
  const visibleTables = db.tables.filter((table) => !KNOWLEDGE_SQLITE_SHADOW_TABLE.test(table.name));
  const hiddenTables = db.tables.length - visibleTables.length;
  const tables = visibleTables
    .map(
      (table) =>
        `<details><summary>${esc(table.name)} <span class="muted small">${table.rowCount ?? 'unknown'} rows${
          table.latestTimestamp ? ` · latest ${esc(fmtTs(table.latestTimestamp))}` : ''
        }</span></summary>${knowledgeTablePreview(table)}</details>`,
    )
    .join('');
  return `<p class="muted small">Read-only SQLite snapshot: ${fmtBytes(db.sizeBytes ?? 0)} · ${visibleTables.length} meaningful table${visibleTables.length === 1 ? '' : 's'}${hiddenTables ? ` · ${hiddenTables} FTS shadow table${hiddenTables === 1 ? '' : 's'} hidden` : ''}. Latest rows are ordered by a timestamp column when one exists, otherwise rowid.</p>${
    tables || '<p class="muted small">No user tables found.</p>'
  }`;
}

/**
 * Render the lazily-fetched detail body for one store. Called by the
 * /api/knowledge/store endpoint after the (group, path) pair has been validated
 * against the registry (resolveStoreForDetail) — never with an arbitrary path.
 */
export function renderStoreDetail(hit: StoreHit): string {
  if (!hit.absPath) return '<p class="muted small">Nothing to inspect for this store.</p>';
  switch (hit.detail) {
    case 'text':
      return knowledgeTextDetails(hit.absPath);
    case 'config':
      return knowledgeConfigDetails(hit.absPath);
    case 'docs':
      return knowledgeDirDetails(hit.absPath);
    case 'artifacts':
      return knowledgeArtifactsDetails(hit.absPath);
    case 'sqlite':
      return knowledgeDbDetails(hit.absPath, hit.relPath);
    default:
      return '<p class="muted small">Nothing to inspect for this store.</p>';
  }
}

const STORE_STATUS_CSS: Record<string, string> = {
  present: 'info',
  'expected-missing': 'warn',
  orphaned: 'warn',
  unreadable: 'error',
};

function healthBadgesHtml(health: HealthBadge[]): string {
  return health
    .map(
      (h) =>
        ` <span class="state ${h.level === 'error' ? 'error' : h.level === 'warn' ? 'warn' : 'info'}">${esc(h.text)}</span>`,
    )
    .join('');
}

function storeRowHtml(hit: StoreHit, groupParam: string): string {
  const lazy =
    hit.detail !== 'none' && hit.absPath
      ? `<details class="fold" data-lazy="/api/knowledge/store?group=${esc(encodeURIComponent(groupParam))}&amp;path=${esc(encodeURIComponent(hit.relPath))}"><summary><span class="muted small">inspect</span></summary><div class="fold-body lazy-body"><span class="muted small">Loading…</span></div></details>`
      : '';
  return `<tr>
<td><span class="state ${STORE_STATUS_CSS[hit.status] ?? 'info'}">${esc(hit.status)}</span></td>
<td>${esc(hit.label)}${healthBadgesHtml(hit.health)}</td>
<td><code>${esc(hit.relPath)}</code>${lazy}</td>
<td class="small">${esc(hit.summary)}</td>
<td class="small">${esc(fmtTs(hit.updated))}</td></tr>`;
}

function storeTableHtml(stores: StoreHit[], groupParam: string): string {
  return `<table><tr><th>status</th><th>store</th><th>path</th><th>summary</th><th>updated</th></tr>
${stores.map((s) => storeRowHtml(s, groupParam)).join('') || '<tr><td colspan=5 class="muted">No stores.</td></tr>'}</table>`;
}

function groupStoresCardHtml(gs: GroupStores): string {
  const warn = gs.warnCount ? ` <span class="state warn">${gs.warnCount} to review</span>` : '';
  return `<details class="fold card"${gs.warnCount ? ' open' : ''}><summary><h3>${esc(gs.group.name)}</h3><span class="muted small">${gs.stores.length} store${gs.stores.length === 1 ? '' : 's'}</span>${warn}</summary>
<div class="fold-body">${storeTableHtml(gs.stores, gs.group.id)}</div></details>`;
}

/**
 * The "Knowledge Stores" section: a fleet-shared card (base container/CLAUDE.md +
 * container skills, inherited by every app) followed by one collapsible profile
 * card per app. Detail bodies are fetched lazily via /api/knowledge/store, so the
 * page HTML no longer embeds every file preview and SQLite dump.
 */
export function knowledgeStoresSection(
  groups: ReturnType<typeof listAgentGroups>,
  opts: { groupsDir?: string } = {},
): string {
  const fleet = safe(() => scanFleetSharedKnowledge(), [] as StoreHit[]);
  const perGroup = safe(() => scanFleetStores(groups, opts), [] as GroupStores[]);
  const fleetCard = fleet.length
    ? `<details class="fold card"><summary><h3>Shared knowledge</h3><span class="muted small">inherited by every app · ${fleet.length} file${fleet.length === 1 ? '' : 's'}</span></summary>
<div class="fold-body">${storeTableHtml(fleet, '__fleet__')}</div></details>`
    : '';
  const cards = perGroup.map(groupStoresCardHtml).join('');
  return `<h2>Knowledge Stores</h2>
<p class="muted small">Memory is only one source. Each app card is its knowledge profile — the files, databases, and external stores it may ground itself from. Rows needing attention (missing, orphaned, or unreadable) sort to the top; open <b>inspect</b> to lazily load a read-only preview.</p>
${fleetCard}
${cards || '<div class="card empty"><p class="muted">No app knowledge stores found under groups/.</p></div>'}`;
}

const STRUCT_TAG_ICON: Record<StructuralTag['kind'], string> = {
  cal: '📅',
  trip: '🧭',
  rel: '🔗',
  'time-bound': '⏳',
};

/** Structural tags (cal:/trip:/rel:/time-bound) render as edge chips, not pills. */
function structuralChipHtml(s: StructuralTag): string {
  return `<span class="chip" title="${esc(s.raw)}">${STRUCT_TAG_ICON[s.kind]} ${esc(s.label)}</span>`;
}

function freshnessBadgesHtml(badges: FreshnessBadge[]): string {
  return badges
    .map((b) => ` <span class="state ${b.level === 'warn' ? 'warn' : 'info'}">${esc(b.text)}</span>`)
    .join('');
}

function describeJournal(action: string, detail: Record<string, unknown> | null): string {
  const verb =
    {
      'memory.commit': 'committed',
      'memory.approve': 'approved',
      'memory.reject': 'rejected',
      'memory.forget': 'forgotten',
      'memory.reinforce': 'reinforced',
      'memory.update': 'updated',
    }[action] ?? action.replace(/^memory\./, '');
  const by = detail && typeof detail.by === 'string' ? ` by ${detail.by}` : '';
  const src =
    detail && typeof detail.source === 'string' && detail.source !== 'auto' ? ` · source ${detail.source}` : '';
  return `${verb}${by}${src}`;
}

/**
 * The Memory Explorer drawer body: one memory's full content, fields, structural
 * tag chips, a lifecycle timeline (journal + recalls that referenced it), derived
 * related memories, and freshness badges. Fetched lazily via
 * /api/knowledge/memory after the (group, id) pair is validated.
 */
export function renderMemoryDrawer(
  groups: ReturnType<typeof listAgentGroups>,
  groupParam: string,
  id: number,
): string | null {
  const g = groups.find((x) => x.id === groupParam);
  if (!g) return null;
  const dbPath = path.join(PATHS.groupsDir, g.folder, 'memory.db');
  const d = safe(() => readMemoryDetail(dbPath, id), null as MemoryDetail | null);
  if (!d) return null;
  const row = d.row;

  const timeline = [
    ...d.journal.map((j) => ({ at: j.at, text: describeJournal(j.action, j.detail) })),
    ...d.recalls.map((r) => ({
      at: r.at,
      text: `recalled for “${esc(r.query ?? '?')}”${r.score != null ? ` · score ${r.score.toFixed(2)}` : ''}${r.hitCount != null ? ` · ${r.hitCount} hit${r.hitCount === 1 ? '' : 's'}` : ''}`,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const structural = d.structuralTags.length
    ? `<div class="chips" style="margin:6px 0">${d.structuralTags.map(structuralChipHtml).join(' ')}</div>`
    : '';
  const topical = d.topicalTags.length
    ? `<div style="margin:4px 0">${d.topicalTags.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</div>`
    : '';
  const tl = timeline.length
    ? `<div class="flow">${timeline
        .map((e) => `<div class="flow-step done"><b class="small">${esc(fmtTs(e.at))}</b><span>${e.text}</span></div>`)
        .join('')}</div>`
    : '<p class="muted small">No lifecycle events recorded.</p>';
  const related = d.related.length
    ? `<ul>${d.related.map((r) => `<li>#${r.id} ${esc(r.title)} <span class="muted small">— ${esc(r.reason)}</span></li>`).join('')}</ul>`
    : '<p class="muted small">No related memories derived.</p>';

  const label = (t: string) =>
    `<div class="muted small" style="text-transform:uppercase;letter-spacing:.05em;margin:12px 0 4px">${t}</div>`;
  return `<div class="kv">
<span>#${row.id}</span><span>scope <b>${esc(row.scope)}</b></span><span>category <b>${esc(row.category)}</b></span>
<span>importance <b>${'★'.repeat(Math.max(0, Math.min(5, row.importance)))}</b></span>
<span>status <b>${esc(row.status)}</b></span><span>source <b>${esc(row.source ?? 'auto')}</b></span>
<span>recalls <b>${row.accessCount}</b></span></div>
${freshnessBadgesHtml(d.freshness)}
<p style="margin:8px 0 4px"><b>${esc(row.title)}</b></p>
<div class="log">${esc(row.content || '(no content)')}</div>
${structural}${topical}
${label('Lifecycle')}${tl}
${label('Related memories')}${related}`;
}

const LINT_SEV_CSS: Record<Severity, string> = { high: 'error', medium: 'warn', low: 'info' };

function findingCardHtml(f: Finding): string {
  return `<div class="card attention${f.severity === 'high' ? ' critical' : ''}" style="margin-bottom:8px">
<h3><span class="state ${LINT_SEV_CSS[f.severity]}">${esc(f.severity)}</span> ${esc(f.title)}</h3>
<p class="muted small">${esc(f.group)} · <code>${esc(f.lint)}</code></p>
${f.evidence.length ? `<ul>${f.evidence.map((e) => `<li class="small muted">${esc(e)}</li>`).join('')}</ul>` : ''}
<pre class="log">${esc(f.fix)}</pre></div>`;
}

/**
 * View 3 — Health & Consistency: pure-function lints over the same read-only
 * snapshots the page already loads. The tab stays read-only; each finding
 * carries a copyable fix command for the operator / memory CLI.
 */
export function knowledgeHealthSection(
  groups: ReturnType<typeof listAgentGroups>,
  opts: { groupsDir?: string } = {},
): string {
  const findings = safe(() => runKnowledgeLints(buildLintSnapshots(groups, opts)), [] as Finding[]);
  const counts = { high: 0, medium: 0, low: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  const summary = findings.length
    ? `<span class="state error">${counts.high} high</span> <span class="state warn">${counts.medium} medium</span> <span class="state info">${counts.low} low</span>`
    : '';
  return `<h2>Health &amp; Consistency</h2>
<p class="muted small">Read-only lints over the fleet's storage policy (scope/category consistency, config↔db, tagging, store-separation, staleness). Fixes run through the memory CLI — copy the command. ${summary}</p>
${
  findings.length
    ? findings.map(findingCardHtml).join('')
    : '<div class="card good"><p class="muted small">No consistency issues detected ✓</p></div>'
}`;
}

function knowledgeBody(params: URLSearchParams): string {
  const q = params.get('q')?.trim() ?? '';
  const category = params.get('category')?.trim() ?? '';
  const group = params.get('group')?.trim() ?? '';
  const scope = params.get('scope')?.trim() ?? '';
  const status = params.get('status')?.trim() || 'active';
  const tag = params.get('tag')?.trim() ?? '';
  const sortParam = params.get('sort')?.trim() ?? '';
  const sort: MemorySort = isMemorySort(sortParam) ? sortParam : 'newest';
  const groups = safe(() => listAgentGroups(), []);
  const mem = readAllGroupMemories(groups, { q, category, group, scope, status, tag, sort });
  const stores = knowledgeStoresSection(groups);
  const health = knowledgeHealthSection(groups);

  if (mem.groupsWithMemory === 0) {
    return `<h1>Knowledge</h1>
<p class="muted">Read-only map of app knowledge sources: local instructions, deterministic app databases, curated memory, docs, and grounding evidence.</p>
${stores}
${health}
<h2>Curated Memory</h2>
<div class="card empty"><h3>No memory databases found</h3>
<p class="muted">A group's curated memory appears here once <code>groups/&lt;folder&gt;/memory.db</code> exists. Other knowledge stores may still be present above.</p></div>`;
  }

  // Per-group observability: stats/events honor the group filter; the per-group
  // table + empty-recall mining are the actionable gap views (finding #8).
  const gdbs = groupDbPaths(groups);
  const statsPaths = group ? gdbs.filter((e) => e.group.id === group).map((e) => e.dbPath) : mem.dbPaths;
  const stats = readMemoryEventsStats(statsPaths);
  const perGroupStats = readPerGroupMemoryStats(gdbs);
  const emptyRecalls = readEmptyRecalls(group ? gdbs.filter((e) => e.group.id === group) : gdbs, { days: 30 });

  const statusCss = (s: string) => (s === 'pending' ? 'warn' : s === 'rejected' ? 'error' : 'info');
  const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);
  const ms = (v: number | null) => (v == null ? '–' : `${Math.round(v)}ms`);
  const covCss = (v: number | null) => (v == null ? 'info' : v === 0 ? 'error' : v < 0.3 ? 'warn' : 'info');
  const perGroupTable = `<h3>Per-group memory <span class="muted small">reinforcement coverage = % of rows ever recalled</span></h3>
<table><tr><th>group</th><th>rows</th><th>recalls</th><th>hit-rate</th><th>empty</th><th>reinforcement</th></tr>
${
  perGroupStats
    .map(
      (
        g,
      ) => `<tr><td><a href="${esc(`/knowledge?group=${encodeURIComponent(g.group.id)}&status=all`)}">${esc(g.group.name)}</a> <a class="small muted" href="${esc(`/runs?group=${encodeURIComponent(g.group.id)}`)}">see usage</a></td>
<td>${g.rows}</td><td>${g.recalls}</td><td>${pct(g.hitRate)}</td><td>${g.emptyRecalls}</td>
<td><span class="state ${covCss(g.reinforcementCoverage)}">${pct(g.reinforcementCoverage)}</span></td></tr>`,
    )
    .join('') || '<tr><td colspan=6 class="muted">No memory groups.</td></tr>'
}</table>
<h3>Empty recalls <span class="muted small">what agents searched for and didn't find · last 30d</span></h3>
${
  emptyRecalls.length
    ? `<table><tr><th>query</th><th>times</th><th>last</th><th>group</th></tr>
${emptyRecalls
  .map(
    (e: EmptyRecall) =>
      `<tr><td>${esc(e.query)}</td><td>${e.count}</td><td class="small">${esc(fmtTs(e.lastAt))}</td><td class="small">${esc(e.groups.join(', '))}</td></tr>`,
  )
  .join('')}</table>`
    : '<p class="muted small">No empty recalls in the last 30 days — every recall matched something.</p>'
}`;

  const groupOptions = mem.groups
    .map(
      (gp) =>
        `<option value="${esc(gp.id)}"${group === gp.id ? ' selected' : ''}>${esc(gp.name)} (${gp.total})</option>`,
    )
    .join('');
  const scopeOptions = mem.scopes
    .map((s) => `<option value="${esc(s)}"${scope === s ? ' selected' : ''}>${esc(s)}</option>`)
    .join('');
  const statusOptions = ['active', 'pending', 'rejected', 'all']
    .map((s) => `<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`)
    .join('');
  const categoryOptions = mem.categories
    .map(
      (c) =>
        `<option value="${esc(c.category)}"${category === c.category ? ' selected' : ''}>${esc(c.category)} (${c.count})</option>`,
    )
    .join('');
  const sortOptions = Object.entries(MEMORY_SORTS)
    .map(([k, label]) => `<option value="${k}"${sort === k ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');

  // Preserve the active filter set while overriding one key (facet links / clears).
  const buildQs = (over: Record<string, string | undefined>): string => {
    // `newest` is the default, so it stays out of the URL.
    const base: Record<string, string> = {
      group,
      scope,
      status,
      category,
      tag,
      q,
      sort: sort === 'newest' ? '' : sort,
    };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/knowledge?${s}` : '/knowledge';
  };

  // Tag cloud (topical tags only — structural cal:/trip:/rel: are edges, not facets).
  const tagCounts = new Map<string, number>();
  for (const r of mem.rows) for (const t of classifyTags(r.tags).topical) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tagCloud = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30);
  const tagCloudHtml = tagCloud.length
    ? `<p class="muted small" style="margin:0 0 4px">Tags <span class="muted">(click to filter)</span></p><div class="chips" style="margin:0 0 12px">${tagCloud
        .map(
          ([t, n]) =>
            `<a class="chip${tag === t ? ' on' : ''}" href="${esc(buildQs({ tag: tag === t ? undefined : t }))}">${esc(t)}<span class="c">${n}</span></a>`,
        )
        .join('')}</div>`
    : '';

  const obs = stats.available
    ? `<div class="cards" style="margin:6px 0 14px">
<div class="card"><h3>Recall hit-rate</h3><div class="big">${pct(stats.hitRate)}</div><p class="muted small">${stats.recalls} recall${stats.recalls === 1 ? '' : 's'} · ${pct(stats.emptyRecallRate)} empty</p></div>
<div class="card"><h3>Recall latency</h3><div class="big">${ms(stats.p95Ms)}</div><p class="muted small">p95 · p50 ${ms(stats.p50Ms)}</p></div>
<div class="card"><h3>Writes</h3><div class="big">${stats.writes}</div><p class="muted small">${stats.dedupCollisions} dedup collision${stats.dedupCollisions === 1 ? '' : 's'}</p></div>
<div class="card"><h3>Approvals</h3><div class="big">✓ ${stats.approvals} / ✗ ${stats.rejects}</div><p class="muted small">${stats.totalEvents} events · last ${esc(fmtTs(stats.lastEventAt))}</p></div>
</div>`
    : `<div class="card" style="margin:6px 0 14px"><p class="muted small">No <code>memory_events</code> yet — recall/remember activity through the engine CLI will populate hit-rate, latency p50/p95, approvals, and per-recall score traces here.</p></div>`;

  return `<h1>Knowledge</h1>
<p class="muted">Read-only map of app knowledge sources. Curated memory is shown below, but app state may also live in local instructions, deterministic databases, docs, and generated files.</p>
${stores}
${health}
<h2>Curated Memory</h2>
<div class="cards" style="margin-bottom:6px">
<div class="card"><h3>Groups</h3><div class="big">${mem.groupsWithMemory}</div><p class="muted small">with a memory.db</p></div>
<div class="card"><h3>Memories</h3><div class="big">${mem.totalMemories}</div><p class="muted small">${mem.totalPending} pending approval</p></div>
<div class="card"><h3>Scopes</h3><div class="big">${mem.scopes.length}</div><p class="muted small">${esc(mem.scopes.slice(0, 4).join(', ')) || '–'}</p></div>
</div>
<h2>Observability</h2>
${obs}
${perGroupTable}
<form class="filters" method="get" action="/knowledge">
<label>group <select name="group"><option value="">all</option>${groupOptions}</select></label>
<label>scope <select name="scope"><option value="">all</option>${scopeOptions}</select></label>
<label>status <select name="status">${statusOptions}</select></label>
<label>category <select name="category"><option value="">all</option>${categoryOptions}</select></label>
<label>sort <select name="sort">${sortOptions}</select></label>
<input type="text" name="q" value="${esc(q)}" placeholder="match title, content, tags">
${tag ? `<input type="hidden" name="tag" value="${esc(tag)}">` : ''}
<button>Filter</button><a href="/knowledge">clear</a>
<a href="/docs/local/memory-engine-design-and-implementation.html">design document</a>
</form>
${tagCloudHtml}
<p class="muted small">${mem.rows.length} of ${mem.shown} matching row${mem.shown === 1 ? '' : 's'} shown · status <b>${esc(status)}</b>${tag ? ` · tag <b>${esc(tag)}</b> <a href="${esc(buildQs({ tag: undefined }))}">clear tag</a>` : ''} · sorted <b>${esc(MEMORY_SORTS[sort])}</b>. Click a memory title to open its detail drawer.</p>
<table><tr><th>group</th><th>scope</th><th>status</th><th>imp</th><th>memory</th><th>tags</th><th>source</th><th>added</th></tr>
${
  mem.rows
    .map((row) => {
      const { structural, topical } = classifyTags(row.tags);
      const fresh = freshnessBadgesHtml(freshnessBadges(row));
      const gid = row.group?.id ?? '';
      const preview = row.content.length > 160 ? `${row.content.slice(0, 160)}…` : row.content;
      const tagCell =
        [
          ...structural.map(structuralChipHtml),
          ...topical.map((t) => `<a class="pill" href="${esc(buildQs({ tag: t }))}">${esc(t)}</a>`),
        ].join(' ') || '–';
      return `<tr><td class="small">${esc(row.group?.name ?? '–')}</td>
<td><a class="pill" href="${esc(buildQs({ scope: row.scope, tag: undefined }))}">${esc(row.scope)}</a></td>
<td><span class="state ${statusCss(row.status)}">${esc(row.status)}</span></td>
<td>${'★'.repeat(Math.max(0, Math.min(5, row.importance)))}</td>
<td><details data-lazy="/api/knowledge/memory?group=${esc(encodeURIComponent(gid))}&amp;id=${row.id}"><summary><b>${esc(row.title)}</b></summary><div class="lazy-body" style="margin:6px 0"><span class="muted small">Loading…</span></div></details>
<div class="muted">${esc(preview)}</div>
<div class="small muted">#${row.id}${row.accessCount ? ` · ${row.accessCount} recall${row.accessCount === 1 ? '' : 's'}` : ''}${fresh}</div></td>
<td>${tagCell}</td>
<td>${esc(row.source ?? '–')}</td>
<td class="small">${esc(fmtTs(row.createdAt || row.updatedAt))}${
        row.createdAt && row.updatedAt && row.updatedAt !== row.createdAt
          ? `<div class="muted">upd ${esc(fmtTs(row.updatedAt))}</div>`
          : ''
      }</td></tr>`;
    })
    .join('') || '<tr><td colspan=8 class="muted">No memories match these filters.</td></tr>'
}</table>
<p class="muted small">Per-operation activity now lives in <a href="/runs">Runs</a> — each turn shows its recalls and writes in context.</p>`;
}

// ---------------------------------------------------------------- system
async function systemBody(cfg: OpsConfig, opsDb: Database.Database): Promise<string> {
  const { diskUsage, dockerStatus } = await import('./readers/system.js');
  const { findOrphans, listTrash } = await import('./orphans.js');
  const { listSelfTestGroups, selfTestState } = await import('./selftest.js');
  const stGroups = safe(() => listSelfTestGroups(), [] as { id: string; name: string; provider: string }[]);
  const reflectGroups = safe(() => listAgentGroups(), []);
  const reflectState = getLatestReflectRun();
  const st = selfTestState();
  const disk = await diskUsage();
  const docker = await dockerStatus();
  const backups = listBackups();
  const orphans = safe(() => findOrphans(), []);
  const trash = safe(() => listTrash(), []);
  const monthAgo = new Date(Date.now() - 30 * 8.64e7).toISOString();
  const desiredState = getRuntimeDesiredState(opsDb);
  const events = opsDb
    .prepare("SELECT ts, kind, severity, detail FROM events WHERE group_id = 'host' ORDER BY ts DESC LIMIT 60")
    .all() as { ts: string; kind: string; severity: string; detail: string }[];
  return `<h1>System</h1>
<div class="cards">
${machineCard()}
${providerAuthCard(readProviderAuthStatus())}
${recoveryCard(recoveryStatus())}
${reflectSystemCard(reflectState, reflectGroups)}
<div class="card"><h3>Host lifecycle</h3>
<p class="muted small">Desired runtime state: <b>${desiredState}</b>. Stop runtime keeps this dashboard available, but disables the host, drains this install's NanoClaw containers, stops Docker Desktop, and pauses the wake-cycler. Start waits for Docker and a healthy OneCLI gateway before enabling NanoClaw; it does not silently resume wake cycling.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap">
<button onclick="act('/api/host/start',{})">Start runtime</button>
<button onclick="act('/api/host/restart',{},'Restart the NanoClaw host now? In-flight work is interrupted (containers are stopped cleanly).')">Restart</button>
<button class="danger" onclick="act('/api/host/stop',{},'STOP RUNTIME: disable NanoClaw, stop its containers and Docker Desktop, and pause wake cycling? Ops Center stays available. Docker workloads from other projects will also stop.','STOP')">Stop runtime</button>
<button class="danger" onclick="act('/api/host/hard-off',{},'HARD OFF: stop the runtime and Docker Desktop, pause wake cycling, then disable and close Ops Center itself? Recover from Terminal with ./bin/nanoclaw-power start.','HARD OFF')">Hard off everything</button>
</div></div>
<div class="card"><h3>Self-tests</h3>
<p class="muted small">Live E2E validation through the real host → container → provider path (suite: model-routing, 10 probes per group, each a real model turn). Verdicts + a run id go to Telegram; artifacts land in <code>logs/self-tests/&lt;runId&gt;/</code> for triage.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
<select id="st-group">
<option value="all">All groups (${stGroups.length})</option>
${stGroups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)} · ${esc(g.provider)}</option>`).join('')}
</select>
<button onclick="act('/api/selftest/run',{group:document.getElementById('st-group').value},'Run the model-routing self-test? Each group consumes ~10 model turns; verdicts arrive on Telegram.')">Run</button>
</div>
<div class="kv small muted" style="margin-top:8px">${
    st.running
      ? `running ${esc(st.runId ?? '')} · on ${esc(st.current ?? 'queue')} · ${st.done.length} done, ${st.queue.length} queued`
      : st.lastRunId
        ? `last run ${esc(st.lastRunId)}: ${esc(st.lastSummary ?? '')}`
        : 'no runs yet this ops-center session'
  }</div></div>
<div class="card"><h3>Disk</h3>
<table>
<tr><td>session data</td><td>${fmtBytes(disk.sessions)}</td></tr>
<tr><td>logs</td><td>${fmtBytes(disk.logs)}</td></tr>
<tr><td>backups</td><td>${fmtBytes(disk.backups)}</td></tr>
<tr><td>ops.db</td><td>${fmtBytes(disk.opsDb)} <span class="muted small">(ceiling ${fmtBytes(cfg.opsDbMaxBytes)})</span></td></tr>
<tr><td>central db</td><td>${fmtBytes(disk.centralDb)}</td></tr>
<tr><td>docker image</td><td>${fmtBytes(disk.dockerImage)}</td></tr>
</table>
${svgChart(getSeries(opsDb, 'host', 'disk_total', monthAgo, new Date().toISOString(), 'max'), { w: 480, h: 56, label: 'disk total · 30d' })}</div>
<div class="card"><h3>Docker</h3>
<div class="kv"><span>daemon <b>${docker.daemonUp ? 'up' : 'down'}</b></span></div>
<table><tr><th>name</th><th>image</th><th>status</th></tr>
${docker.containers.map((c) => `<tr><td class="small">${esc(c.name)}</td><td class="small">${esc(c.image)}</td><td class="small">${esc(c.status)}</td></tr>`).join('') || '<tr><td colspan=3 class="muted">no nanoclaw containers running</td></tr>'}</table></div>
<div class="card"><h3>Backups (central DB)</h3>
<button onclick="act('/api/backup',{})">Back up now</button>
<table><tr><th>file</th><th>size</th><th>written</th></tr>
${
  backups
    .slice(0, 14)
    .map(
      (b) =>
        `<tr><td class="small">${esc(b.file)}</td><td>${fmtBytes(b.sizeBytes)}</td><td class="small">${esc(fmtTs(b.mtime))}</td></tr>`,
    )
    .join('') || '<tr><td colspan=3 class="muted">none yet (nightly at 0' + cfg.backupHour + ':30)</td></tr>'
}</table>
<p class="muted small">Restore runbook: docs/local/apps/ops-center/control-center-design.html §8.</p></div>
<div class="card"><h3>Orphans ${orphans.length ? `<span class="pill" style="color:var(--amber)">${orphans.length}</span>` : ''}</h3>
<p class="muted small">Leftover directories from deleted agent groups — <code>ncl groups delete</code> removes DB rows
only, never disk data. Cleanup <b>moves</b> the directory to <code>data/trash/</code> (reversible), it never deletes.</p>
<table><tr><th>kind</th><th>name</th><th>size</th><th></th></tr>
${
  orphans
    .map(
      (o) =>
        `<tr><td>${esc(o.kind)}</td><td class="small">${esc(o.name)}</td><td>${fmtBytes(o.sizeBytes)}</td>
<td><button onclick="act('/api/orphans/cleanup',{path:'${esc(o.relPath)}'},'Move ${esc(o.name)} (${fmtBytes(o.sizeBytes)}) to data/trash/? Reversible — nothing is deleted.')">Move to trash</button></td></tr>`,
    )
    .join('') || '<tr><td colspan=4 class="muted">none — every directory maps to a live agent group ✓</td></tr>'
}</table>
${trash.length ? `<p class="muted small">In trash: ${trash.map((t) => `${esc(t.name)} (${fmtBytes(t.sizeBytes)})`).join(' · ')} — empty it manually with <code>rm -rf data/trash/&lt;stamp&gt;</code> when sure.</p>` : ''}</div>
<div class="card" id="host-events" style="grid-column:1/-1"><h3>Host events</h3>
<table><tr><th>time</th><th>kind</th><th>sev</th><th>detail</th></tr>
${
  events
    .map(
      (e) =>
        `<tr><td class="small">${esc(fmtTs(e.ts))}</td><td>${esc(e.kind)}</td><td>${esc(e.severity)}</td><td class="small">${esc(e.detail.slice(0, 180))}</td></tr>`,
    )
    .join('') || '<tr><td colspan=4 class="muted">none</td></tr>'
}</table></div>
</div>
<script>${machinePanelScript()}${recoveryPanelScript()}${reflectSystemScript()}</script>`;
}
