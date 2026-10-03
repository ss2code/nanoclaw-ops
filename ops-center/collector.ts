/**
 * Collector orchestration — two lanes (design §1):
 *  - fast lane (3s): buildLiveSnapshot() — cheap probes, never persisted
 *  - sample lane (60s): sampleTick() — persisted to ops.db, plus hourly
 *    maintenance (rollups, prune, log rotation) and the nightly backup.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import {
  addEvent,
  getMeta,
  insertSamples,
  listIncidents,
  prune,
  rollupDaily,
  rollupHourly,
  setMeta,
  type Sample,
} from './opsdb.js';
import { listAgentGroups, listSessions, queueCounts, channelTypes, type AgentGroupInfo } from './readers/central.js';
import { lastDeliveryTs, listSessionDirs, readMessageDeltas, readSessionStats } from './readers/sessiondbs.js';
import {
  backfillSubagentReasons,
  collectContextWindows,
  collectTokenDeltas,
  type ContextWindow,
} from './readers/tokens.js';
import { readClaudeQuota, type QuotaSnapshot } from './readers/quota.js';
import { readNewLogText, rotateLogs, scanLogSignals, tailLines } from './readers/logs.js';
import { backfillLifecycle, ingestLifecycleLines } from './readers/lifecycle.js';
import { channelLiveness, detectHostService, diskUsage, dockerStatus, onecliStatus } from './readers/system.js';
import { Alerter } from './alerter.js';
import { runBackup } from './backup.js';
import { PATHS, type OpsConfig } from './config.js';
import { reconcileIncidents, type IncidentSignal } from './incidents.js';

/** Parsed high/medium/low tier map (OpenCode groups). */
export interface GroupTiers {
  high: string;
  medium: string;
  low: string;
  default: 'high' | 'medium' | 'low';
}

export interface GroupLive {
  id: string;
  name: string;
  /** Effective default model — derived from the default tier when tiers are set. */
  model: string | null;
  provider: string | null;
  modelTiers: GroupTiers | null;
  sessions: number;
  containersUp: number;
  minHeartbeatAgeMs: number | null;
  currentTool: string | null;
  queueDepth: number;
  inflight: number;
  todayIn: number;
  todayOut: number;
  unanswered: number;
  contextWindows: ContextWindow[];
  desiredState: 'running' | 'stopped' | 'paused';
  lifecycleStatus: 'running' | 'idle' | 'stopped' | 'paused' | 'starting' | 'error';
  lifecycleError: string | null;
}

export interface LiveSnapshot {
  ts: string;
  host: { label: string | null; running: boolean; pid: number | null; loaded: boolean };
  channels: Record<string, boolean>;
  docker: { daemonUp: boolean; containers: number };
  onecliUp: boolean;
  queues: { approvals: number; droppedSenders: number; droppedMessages: number };
  lastDelivery: string | null;
  groups: GroupLive[];
  diskTotalBytes: number;
  opsDbBytes: number;
  recentLog: string[];
  openIncidents: number;
}

export class Collector {
  private channelsLive: Record<string, boolean> = {};
  private alerter: Alerter;
  private cachedDisk = { total: 0, opsDb: 0 };
  private sampleCount = 0;
  /** Live log lines pushed to SSE clients between fast ticks. */
  pendingLogLines: string[] = [];

  constructor(
    private cfg: OpsConfig,
    private opsDb: Database.Database,
  ) {
    this.alerter = new Alerter(cfg, opsDb);
    this.initChannelLiveness();
    const folderMap = new Map(safe(() => listAgentGroups(), [] as AgentGroupInfo[]).map((g) => [g.folder, g.id]));
    safe(() => backfillLifecycle(opsDb, PATHS.hostLog, folderMap, Date.now()), 0);
    // Fill reasons on subagent_spawn events recorded before reason capture, so the
    // Events table and routing card describe past delegations, not just new ones.
    safe(() => backfillSubagentReasons(opsDb), 0);
  }

  private initChannelLiveness(): void {
    const channels = safe(() => channelTypes(), [] as string[]);
    const tail = tailLines(PATHS.hostLog, 50_000, 2 * 1024 * 1024);
    // Only consider lines after the most recent host start.
    let startIdx = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i].includes('NanoClaw starting')) {
        startIdx = i;
        break;
      }
    }
    this.channelsLive = channelLiveness(channels, tail.slice(startIdx));
  }

  async buildLiveSnapshot(): Promise<LiveSnapshot> {
    const nowMs = Date.now();
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    const midnightIso = midnight.toISOString();

    const [host, docker, onecli] = await Promise.all([detectHostService(), dockerStatus(), onecliStatus()]);
    const groups = safe(() => listAgentGroups(), [] as AgentGroupInfo[]);
    const sessions = safe(() => listSessions(), []);
    const dirs = safe(() => listSessionDirs(), []);
    const sessionsByGroup = new Map<string, typeof sessions>();
    for (const session of sessions) {
      const bucket = sessionsByGroup.get(session.agent_group_id) ?? [];
      bucket.push(session);
      sessionsByGroup.set(session.agent_group_id, bucket);
    }
    const dirsByGroup = new Map<string, typeof dirs>();
    for (const dir of dirs) {
      const bucket = dirsByGroup.get(dir.groupId) ?? [];
      bucket.push(dir);
      dirsByGroup.set(dir.groupId, bucket);
    }
    const queues = safe(() => queueCounts(), {
      pendingApprovals: 0,
      pendingSenderApprovals: 0,
      droppedSenders: 0,
      droppedMessages: 0,
    });
    const contexts = safe(() => collectContextWindows(), [] as ContextWindow[]);

    const groupLive: GroupLive[] = groups.map((g) => {
      const gDirs = dirsByGroup.get(g.id) ?? [];
      const tiers = parseGroupTiers(g.model_tiers);
      const live: GroupLive = {
        id: g.id,
        name: g.name,
        // Tiered groups have a null `model` column; the effective default is the
        // default tier's model.
        model: tiers ? tiers[tiers.default] : g.model,
        provider: g.provider,
        modelTiers: tiers,
        sessions: (sessionsByGroup.get(g.id) ?? []).filter((s) => s.status === 'active').length,
        // Containers are named nanoclaw-v2-<folder>-<ts>; docker is the truth
        // (an idle container doesn't touch its heartbeat, so hb age alone lies).
        containersUp: docker.containers.filter((c) => c.name?.startsWith(`nanoclaw-v2-${g.folder}-`)).length,
        minHeartbeatAgeMs: null,
        currentTool: null,
        queueDepth: 0,
        inflight: 0,
        todayIn: 0,
        todayOut: 0,
        unanswered: 0,
        contextWindows: contexts.filter((c) => c.groupId === g.id),
        desiredState: g.desired_state ?? 'running',
        lifecycleStatus: g.lifecycle_status ?? 'idle',
        lifecycleError: g.lifecycle_error ?? null,
      };
      // The persisted status records transitions and spawn failures; Docker
      // remains the source of truth for whether a container is actually up.
      // This prevents a stale 'running' row after a host restart from lying in
      // the Overview while preserving starting/error transitions.
      if (live.desiredState === 'paused') live.lifecycleStatus = 'paused';
      else if (live.lifecycleStatus === 'starting' || live.lifecycleStatus === 'error') {
        // keep the transition/error state for operator visibility
      } else if (live.containersUp > 0) live.lifecycleStatus = 'running';
      else if (live.desiredState === 'stopped') live.lifecycleStatus = 'stopped';
      else live.lifecycleStatus = 'idle';
      for (const d of gDirs) {
        const st = safeSession(d.dir, midnightIso, this.cfg.alerts.unansweredAfterMs, nowMs);
        if (!st) continue;
        live.todayIn += st.msgsIn;
        live.todayOut += st.msgsOut;
        live.queueDepth += st.queueDepth;
        live.inflight += st.inflight;
        live.unanswered += st.unanswered;
        if (st.currentTool) live.currentTool = st.currentTool;
        if (st.heartbeatAgeMs != null) {
          if (live.minHeartbeatAgeMs == null || st.heartbeatAgeMs < live.minHeartbeatAgeMs)
            live.minHeartbeatAgeMs = st.heartbeatAgeMs;
        }
      }
      return live;
    });

    const logLines = this.pendingLogLines.splice(0, this.pendingLogLines.length);

    return {
      ts: new Date(nowMs).toISOString(),
      host: { label: host.label, running: host.running, pid: host.pid, loaded: host.loaded },
      channels: host.running
        ? this.channelsLive
        : Object.fromEntries(Object.keys(this.channelsLive).map((k) => [k, false])),
      docker: { daemonUp: docker.daemonUp, containers: docker.containers.length },
      onecliUp: onecli.up,
      queues: {
        approvals: queues.pendingApprovals + queues.pendingSenderApprovals,
        droppedSenders: queues.droppedSenders,
        droppedMessages: queues.droppedMessages,
      },
      lastDelivery: safe(() => lastDeliveryTs(dirs), null),
      groups: groupLive,
      diskTotalBytes: this.cachedDisk.total,
      opsDbBytes: this.cachedDisk.opsDb,
      recentLog: logLines,
      openIncidents: listIncidents(this.opsDb, 'open', 500).length,
    };
  }

  /** 60s lane: persist samples, scan logs, hourly/daily maintenance, nightly backup, alerts. */
  async sampleTick(now: Date = new Date()): Promise<void> {
    const nowIso = now.toISOString();
    const lastIso = getMeta(this.opsDb, 'last_sample') ?? new Date(now.getTime() - this.cfg.sampleTickMs).toISOString();
    const samples: Sample[] = [];
    const push = (group_id: string, metric: string, value: number) => {
      if (value !== 0) samples.push({ ts: nowIso, group_id, metric, value });
    };

    // ---- per-group message/queue/latency stats
    const groups = safe(() => listAgentGroups(), [] as AgentGroupInfo[]);
    const dirs = safe(() => listSessionDirs(), []);
    const docker = await dockerStatus();
    const totals = { in: 0, out: 0, queue: 0, inflight: 0, unanswered: 0 };
    const groupHealth: {
      id: string;
      name: string;
      containersUp: number;
      queue: number;
      inflight: number;
      unanswered: number;
    }[] = [];
    for (const g of groups) {
      const containersUp = docker.containers.filter((c) => c.name?.startsWith(`nanoclaw-v2-${g.folder}-`)).length;
      let msgsIn = 0,
        msgsOut = 0,
        queue = 0,
        inflight = 0,
        unanswered = 0;
      const lat: number[] = [];
      const senders = new Set<string>();
      for (const d of dirs.filter((x) => x.groupId === g.id)) {
        const st = safeSession(d.dir, lastIso, this.cfg.alerts.unansweredAfterMs, now.getTime());
        if (!st) continue;
        // Messages: rowid-cursor delta (timestamp-window counting silently drops
        // messages that become visible after their stamp leaves the window).
        const inKey = `msgcur:in:${d.dir}`;
        const outKey = `msgcur:out:${d.dir}`;
        const inStored = getMeta(this.opsDb, inKey);
        const outStored = getMeta(this.opsDb, outKey);
        const md = safe(
          () =>
            readMessageDeltas(
              d.dir,
              inStored != null ? Number(inStored) : null,
              outStored != null ? Number(outStored) : null,
            ),
          { msgsIn: 0, msgsOut: 0, inMax: Number(inStored ?? 0), outMax: Number(outStored ?? 0) },
        );
        setMeta(this.opsDb, inKey, String(md.inMax));
        setMeta(this.opsDb, outKey, String(md.outMax));
        msgsIn += md.msgsIn;
        msgsOut += md.msgsOut;
        queue += st.queueDepth;
        inflight += st.inflight;
        unanswered += st.unanswered;
        lat.push(...st.latencies);
        for (const set of st.sendersToday.values()) for (const s of set) senders.add(s);
      }
      push(g.id, 'msgs_in', msgsIn);
      push(g.id, 'msgs_out', msgsOut);
      push(g.id, 'queue_depth', queue);
      push(g.id, 'inflight', inflight);
      push(g.id, 'unanswered', unanswered);
      push(g.id, 'containers_up', containersUp);
      push(g.id, 'unique_senders', senders.size);
      if (lat.length) {
        push(g.id, 'latency_ms_avg', lat.reduce((a, b) => a + b, 0) / lat.length);
        push(g.id, 'latency_ms_max', Math.max(...lat));
      }
      totals.in += msgsIn;
      totals.out += msgsOut;
      totals.queue += queue;
      totals.inflight += inflight;
      totals.unanswered += unanswered;
      groupHealth.push({ id: g.id, name: g.name, containersUp, queue, inflight, unanswered });
    }
    push('all', 'msgs_in', totals.in);
    push('all', 'msgs_out', totals.out);
    push('all', 'queue_depth', totals.queue);
    push('all', 'inflight', totals.inflight);
    push('all', 'unanswered', totals.unanswered);

    // ---- token deltas from JSONLs (lane-aware: sub_* metrics + spawn events on
    // top of combined totals, so existing charts/costs keep their main+sub values)
    const tok = safe(() => collectTokenDeltas(this.opsDb), { deltas: [], newSubagents: [], newCompactions: [] });
    const combined = new Map<
      string,
      { groupId: string; model: string; in: number; out: number; cr: number; cc: number; req: number }
    >();
    for (const t of tok.deltas) {
      const key = `${t.groupId}|${t.model}`;
      const c = combined.get(key) ?? { groupId: t.groupId, model: t.model, in: 0, out: 0, cr: 0, cc: 0, req: 0 };
      c.in += t.inputTokens;
      c.out += t.outputTokens;
      c.cr += t.cacheRead;
      c.cc += t.cacheCreate;
      c.req += t.requests;
      combined.set(key, c);
      if (t.lane === 'subagent') {
        push(t.groupId, `sub_tokens_out.${t.model}`, t.outputTokens);
        push(t.groupId, `sub_requests.${t.model}`, t.requests);
      }
    }
    for (const c of combined.values()) {
      push(c.groupId, `tokens_in.${c.model}`, c.in);
      push(c.groupId, `tokens_out.${c.model}`, c.out);
      push(c.groupId, `tokens_cache_read.${c.model}`, c.cr);
      push(c.groupId, `tokens_cache_create.${c.model}`, c.cc);
      push(c.groupId, `requests.${c.model}`, c.req);
      push('all', `tokens_out.${c.model}`, c.out);
      push('all', `tokens_in.${c.model}`, c.in);
    }
    for (const s of tok.newSubagents) {
      addEvent(this.opsDb, {
        ts: s.firstTimestamp || nowIso,
        group_id: s.groupId,
        kind: 'subagent_spawn',
        severity: 'info',
        detail: JSON.stringify({ model: s.model, file: s.file.split('/').pop(), reason: s.reason || undefined }),
      });
    }
    for (const c of tok.newCompactions) {
      addEvent(this.opsDb, {
        ts: c.firstTimestamp || nowIso,
        group_id: c.groupId,
        kind: 'compaction',
        severity: 'info',
        detail: JSON.stringify({ session: c.sessionId }),
      });
    }

    // ---- Claude subscription quota (5h/7d utilization gauges). Only persist a
    // fresh snapshot; a stale/missing cache leaves an honest gap in the chart.
    // Pushed directly (not via push()) because 0% is a valid gauge reading.
    const quota = safe(
      () =>
        readClaudeQuota(
          {
            source: this.cfg.quotaSource,
            cacheFile: PATHS.statuslineUsageCache,
            staleMs: this.cfg.quotaStaleMs,
            fetchTtlMs: this.cfg.quotaFetchTtlMs,
          },
          now.getTime(),
        ),
      null as QuotaSnapshot | null,
    );
    if (quota && quota.fresh) {
      samples.push({ ts: nowIso, group_id: 'host', metric: 'quota.claude_5h', value: quota.fiveHourPct });
      samples.push({ ts: nowIso, group_id: 'host', metric: 'quota.claude_7d', value: quota.sevenDayPct });
    }

    // ---- host log scan → events + counters + channel liveness + live tail
    let rateLimitsThisTick = 0;
    let killsThisTick = 0;
    let errorsThisTick = 0;
    const folderMap = new Map(groups.map((g) => [g.folder, g.id]));
    for (const file of [PATHS.hostLog, PATHS.hostErrLog]) {
      const text = safe(() => readNewLogText(this.opsDb, file), '');
      if (!text) continue;
      const sig = scanLogSignals(text);
      safe(() => ingestLifecycleLines(this.opsDb, sig.newLines, folderMap, now.getTime()), 0);
      this.pendingLogLines.push(...sig.newLines.slice(-200));
      if (sig.newLines.some((l) => l.includes('NanoClaw starting'))) this.initChannelLiveness();
      else {
        const updated = channelLiveness(Object.keys(this.channelsLive), sig.newLines);
        for (const [ch, live] of Object.entries(updated)) if (live) this.channelsLive[ch] = true;
      }
      // Only "abnormal" kills (container hung mid-message → work retried) are a
      // crash-loop signal. Idle GC (absolute-ceiling) and intentional restarts
      // are normal lifecycle — recorded as info, excluded from the crash-loop
      // alert + incident. sig.killEvents is already de-duped to one per kill.
      const abnormalKills = sig.killEvents.filter((k) => k.abnormal);
      const normalKills = sig.killEvents.filter((k) => !k.abnormal);
      push('host', 'rate_limit_events', sig.rateLimitEvents.length);
      push('host', 'kills', abnormalKills.length);
      push('host', 'errors', sig.errorLines.length);
      rateLimitsThisTick += sig.rateLimitEvents.length;
      killsThisTick += abnormalKills.length;
      errorsThisTick += sig.errorLines.length;
      const evt = (kind: string, lines: string[], severity: 'info' | 'warn' | 'error') => {
        for (const line of lines.slice(0, 10))
          addEvent(this.opsDb, { ts: nowIso, group_id: 'host', kind, severity, detail: line });
      };
      evt('rate_limit', sig.rateLimitEvents, 'warn');
      evt(
        'container_kill',
        abnormalKills.map((k) => k.line),
        'warn',
      );
      evt(
        'container_kill',
        normalKills.map((k) => k.line),
        'info',
      );
    }

    // ---- disk gauges every 10 minutes
    if (this.sampleCount % 10 === 0) {
      const disk = await diskUsage();
      const total = disk.sessions + disk.logs + disk.backups + disk.opsDb + disk.centralDb;
      this.cachedDisk = { total, opsDb: disk.opsDb };
      push('host', 'disk_sessions', disk.sessions);
      push('host', 'disk_logs', disk.logs);
      push('host', 'disk_backups', disk.backups);
      push('host', 'disk_ops_db', disk.opsDb);
      push('host', 'disk_total', total);
    }
    this.sampleCount++;

    insertSamples(this.opsDb, samples);
    setMeta(this.opsDb, 'last_sample', nowIso);

    // ---- hourly maintenance
    const hour = nowIso.slice(0, 13);
    if (getMeta(this.opsDb, 'last_maintenance_hour') !== hour) {
      setMeta(this.opsDb, 'last_maintenance_hour', hour);
      rollupHourly(this.opsDb, now);
      rollupDaily(this.opsDb, now);
      prune(this.opsDb, now, {
        rawHours: this.cfg.rawRetentionHours,
        hourlyDays: this.cfg.hourlyRetentionDays,
        dailyDays: this.cfg.dailyRetentionDays,
        eventDays: this.cfg.eventRetentionDays,
      });
      const rot = rotateLogs([PATHS.hostLog, PATHS.hostErrLog], this.cfg.logRotateBytes, this.cfg.logRotateKeep);
      for (const f of rot.rotated)
        addEvent(this.opsDb, { ts: nowIso, group_id: 'host', kind: 'rotation', severity: 'info', detail: f });
      const month = nowIso.slice(0, 7);
      if (getMeta(this.opsDb, 'last_vacuum_month') !== month) {
        setMeta(this.opsDb, 'last_vacuum_month', month);
        try {
          this.opsDb.exec('VACUUM');
        } catch {
          /* busy */
        }
      }
    }

    // ---- nightly backup at backupHour:30
    const day = nowIso.slice(0, 10);
    if (
      now.getHours() === this.cfg.backupHour &&
      now.getMinutes() >= 30 &&
      getMeta(this.opsDb, 'last_backup_day') !== day
    ) {
      setMeta(this.opsDb, 'last_backup_day', day);
      const res = runBackup(PATHS.centralDb, PATHS.backupsDir, this.cfg.backupKeep);
      addEvent(this.opsDb, {
        ts: nowIso,
        group_id: 'host',
        kind: res.ok ? 'backup_ok' : 'backup_fail',
        severity: res.ok ? 'info' : 'error',
        detail: res.ok ? `${res.file} (${res.sizeBytes} bytes)` : (res.error ?? 'unknown'),
      });
      if (!res.ok) this.lastBackupFailed = true;
      else this.lastBackupFailed = false;
    }

    await this.evaluateAlerts(now, totals.unanswered);
    await this.reconcileCurrentIncidents(now, groupHealth, {
      rateLimits: rateLimitsThisTick,
      kills: killsThisTick,
      errors: errorsThisTick,
    });
  }

  private lastBackupFailed = false;
  private hostDownTicks = 0;

  private async evaluateAlerts(now: Date, unanswered: number): Promise<void> {
    const host = await detectHostService();
    this.hostDownTicks = host.running ? 0 : this.hostDownTicks + 1;
    const windowIso = new Date(now.getTime() - this.cfg.alerts.crashLoopWindowMs).toISOString();
    // severity <> 'info' excludes idle GC + intentional restarts (recorded as
    // info-severity container_kill) so only genuine abnormal kills count.
    const kills = (
      this.opsDb
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'container_kill' AND severity <> 'info' AND ts >= ?")
        .get(windowIso) as { n: number }
    ).n;
    const dayAgoIso = new Date(now.getTime() - 86_400_000).toISOString();
    const diskDayAgo = this.opsDb
      .prepare(
        "SELECT value FROM samples WHERE group_id = 'host' AND metric = 'disk_total' AND ts <= ? ORDER BY ts DESC LIMIT 1",
      )
      .get(dayAgoIso) as { value: number } | undefined;
    const diskGrowth = diskDayAgo ? this.cachedDisk.total - diskDayAgo.value : 0;

    await this.alerter.evaluate(
      [
        { key: 'host_down', red: this.hostDownTicks >= 2, message: 'host process is down (launchd reports no PID)' },
        {
          key: 'unanswered',
          red: unanswered > 0,
          message: `${unanswered} inbound message(s) unanswered for >${Math.round(this.cfg.alerts.unansweredAfterMs / 60000)} min`,
        },
        {
          key: 'crash_loop',
          red: kills >= this.cfg.alerts.crashLoopKills,
          message: `${kills} container kills in the last ${Math.round(this.cfg.alerts.crashLoopWindowMs / 60000)} min`,
        },
        {
          key: 'disk_growth',
          red: diskGrowth > this.cfg.alerts.diskGrowthBytesPerDay,
          message: `disk grew ${(diskGrowth / 1e6).toFixed(0)} MB in 24h`,
        },
        {
          key: 'ops_db_size',
          red: this.cachedDisk.opsDb > this.cfg.opsDbMaxBytes,
          message: `ops.db is ${(this.cachedDisk.opsDb / 1e6).toFixed(1)} MB (ceiling ${(this.cfg.opsDbMaxBytes / 1e6).toFixed(0)} MB)`,
        },
        { key: 'backup', red: this.lastBackupFailed, message: 'nightly v2.db backup failed — check System tab' },
      ],
      now.getTime(),
    );
  }

  private async reconcileCurrentIncidents(
    now: Date,
    groups: { id: string; name: string; containersUp: number; queue: number; inflight: number; unanswered: number }[],
    logSignals: { rateLimits: number; kills: number; errors: number },
  ): Promise<void> {
    const host = await detectHostService();
    const signals: IncidentSignal[] = [];
    if (!host.running) {
      signals.push({
        scopeKey: 'host',
        kind: 'host_down',
        severity: 'error',
        summary: 'NanoClaw host has no running PID.',
        evidence: host,
        recommendation: 'Start the host, then verify channel adapters reconnect.',
      });
    }
    if (host.running) {
      for (const [channel, live] of Object.entries(this.channelsLive)) {
        if (!live)
          signals.push({
            scopeKey: `channel:${channel}`,
            kind: 'channel_not_live',
            severity: 'warn',
            summary: `${channel} has not reported a live adapter since the last host start.`,
            evidence: { channel },
            recommendation: 'Inspect recent adapter logs before restarting the host.',
          });
      }
    }
    for (const group of groups) {
      if (group.unanswered > 0)
        signals.push({
          scopeKey: `group:${group.id}`,
          groupId: group.id,
          kind: 'unanswered',
          severity: 'error',
          summary: `${group.unanswered} trigger message(s) are unanswered.`,
          evidence: group,
          recommendation:
            'Inspect the message journey and current container state; restart only this group if processing is stuck.',
        });
      if (group.queue > 0 && group.containersUp === 0)
        signals.push({
          scopeKey: `group:${group.id}`,
          groupId: group.id,
          kind: 'queued_without_container',
          severity: 'warn',
          summary: `${group.queue} queued message(s) exist while no group container is running.`,
          evidence: group,
          recommendation: 'Verify the host can spawn the group container and inspect the latest host errors.',
        });
    }
    if (logSignals.rateLimits > 0)
      signals.push({
        scopeKey: 'provider',
        kind: 'rate_limit',
        severity: 'warn',
        summary: `${logSignals.rateLimits} rate-limit signal(s) appeared in the latest log interval.`,
        evidence: logSignals,
        recommendation: 'Reduce concurrent or high-cost work and watch quota recovery.',
      });
    if (logSignals.kills > 0 || logSignals.errors > 2)
      signals.push({
        scopeKey: 'host-runtime',
        kind: logSignals.kills > 0 ? 'container_kill' : 'error_burst',
        severity: logSignals.kills > 0 ? 'error' : 'warn',
        summary: `${logSignals.kills} container kill(s) and ${logSignals.errors} error line(s) appeared this interval.`,
        evidence: logSignals,
        recommendation: 'Open the incident evidence and correlated host logs before taking a lifecycle action.',
      });
    if (this.cachedDisk.opsDb > this.cfg.opsDbMaxBytes)
      signals.push({
        scopeKey: 'storage',
        kind: 'ops_db_size',
        severity: 'warn',
        summary: `ops.db exceeded its configured ceiling.`,
        evidence: { bytes: this.cachedDisk.opsDb, ceiling: this.cfg.opsDbMaxBytes },
        recommendation: 'Verify pruning and rollups, then vacuum only after confirming retention is healthy.',
      });
    if (this.lastBackupFailed)
      signals.push({
        scopeKey: 'backup',
        kind: 'backup_failed',
        severity: 'error',
        summary: 'The latest scheduled central DB backup failed.',
        recommendation: 'Run a verified backup and inspect the operation result.',
      });
    reconcileIncidents(this.opsDb, signals, now);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Parse a container_configs.model_tiers JSON column; null when absent/invalid. */
function parseGroupTiers(raw: string | null): GroupTiers | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as GroupTiers;
    if (t && t.high && t.medium && t.low && ['high', 'medium', 'low'].includes(t.default)) return t;
  } catch {
    /* fall through */
  }
  return null;
}

function safeSession(dir: string, sinceIso: string, unansweredAfterMs: number, nowMs: number) {
  try {
    return readSessionStats(dir, sinceIso, { unansweredAfterMs, nowMs });
  } catch {
    return null;
  }
}

export { safe };
export type { OpsConfig };
export const _internal = { fsExists: (p: string) => fs.existsSync(p) };
