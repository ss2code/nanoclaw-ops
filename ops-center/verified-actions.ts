import type Database from 'better-sqlite3';
import { runBackup } from './backup.js';
import { PATHS, type OpsConfig } from './config.js';
import {
  groupRestart,
  groupRun,
  groupResume,
  groupSetProvider,
  groupStop,
  groupPause,
  groupSetMaxMessages,
  groupSetModel,
  groupSetModelTiers,
  groupSetSkills,
  hostRestart,
  messagingGroupSetVoiceTranscription,
  wiringSetEngage,
  type ActionResult,
} from './lifecycle.js';
import { RuntimePowerController } from './runtime-power.js';
import {
  latestConfigSnapshot,
  pollUntil,
  runVerifiedOperation,
  saveConfigSnapshot,
  type OperationOutcome,
} from './operations.js';
import { cleanupOrphan, findOrphans } from './orphans.js';
import { getGroupConfig, getGroupLifecycle, listWiringsForGroup, type EngagePreset } from './readers/central.js';
import { listAvailableSkills, resolveGroupSkills } from './readers/skills.js';
import { dockerStatus } from './readers/system.js';
import {
  defaultProviderProfile,
  isSwitchableProvider,
  profileFromConfig,
  profileFromStoredConfig,
  providerProfileKind,
  validateProviderAfterRestart,
  type SwitchableProvider,
} from './provider-switch.js';

/** Field bundle each engagement preset writes. `context` also sets maxMessages=30 + restarts. */
const ENGAGE_PRESETS: Record<EngagePreset, { engageMode: string; ignoredPolicy: string }> = {
  mention: { engageMode: 'mention', ignoredPolicy: 'drop' },
  sticky: { engageMode: 'mention-sticky', ignoredPolicy: 'drop' },
  context: { engageMode: 'mention', ignoredPolicy: 'accumulate' },
};
const CONTEXT_MAX_MESSAGES = 30;

export class VerifiedActions {
  private readonly power: RuntimePowerController;

  constructor(
    private cfg: OpsConfig,
    private db: Database.Database,
    power?: RuntimePowerController,
  ) {
    this.power = power ?? new RuntimePowerController(db);
  }

  async host(action: 'start' | 'stop' | 'restart'): Promise<OperationOutcome> {
    const before = await this.power.snapshot();
    return runVerifiedOperation(this.db, {
      kind: `host_${action}`,
      scopeType: 'host',
      before,
      execute: async () => {
        if (action === 'start') return this.power.startRuntime();
        if (action === 'stop') return this.power.stopRuntime();
        const ready = await this.power.startRuntime();
        return ready.ok ? hostRestart() : ready;
      },
      verify: () =>
        pollUntil(async () => {
          const state = await this.power.snapshot();
          const ok =
            action === 'stop'
              ? state.runtimeStopped && state.wakeCyclerPaused
              : action === 'restart'
                ? state.runtimeRunning && state.host.pid != null && state.host.pid !== before.host.pid
                : state.runtimeRunning;
          return {
            ok,
            state,
            message: ok
              ? action === 'restart'
                ? `runtime running with new host pid ${state.host.pid}`
                : action === 'stop'
                  ? 'host and Docker are stopped; wake-cycler is paused'
                  : `runtime is running (host pid ${state.host.pid}); wake-cycler remains paused`
              : 'postcondition not reached',
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  async hardOff(): Promise<OperationOutcome> {
    const before = await this.power.snapshot();
    return runVerifiedOperation(this.db, {
      kind: 'system_hard_off',
      scopeType: 'system',
      before,
      execute: () => this.power.prepareHardOff(),
      verify: async () => {
        const state = await this.power.snapshot();
        return {
          ok: state.runtimeStopped && state.wakeCyclerPaused,
          state,
          message:
            state.runtimeStopped && state.wakeCyclerPaused
              ? 'runtime stopped, wake-cycler paused, Ops Center disabled'
              : 'hard-off postcondition not reached',
        };
      },
    });
  }

  scheduleOpsCenterStop(delayMs = 750): void {
    const timer = setTimeout(() => {
      this.power.stopOpsCenter().catch((error) => console.error('[ops-center] hard-off bootout failed:', error));
    }, delayMs);
    timer.unref();
  }

  async restartGroup(groupId: string, rebuild: boolean, fresh = false): Promise<OperationOutcome> {
    const group = getGroupConfig(groupId);
    if (!group) return missingGroup(groupId);
    const beforeDocker = await dockerStatus();
    const prefix = `nanoclaw-v2-${group.folder}-`;
    const oldIds = beforeDocker.containers.filter((c) => c.name.startsWith(prefix)).map((c) => c.id);
    return runVerifiedOperation(this.db, {
      kind: fresh ? 'group_restart_fresh' : rebuild ? 'group_restart_rebuild' : 'group_restart',
      scopeType: 'group',
      scopeId: groupId,
      before: { group, containerIds: oldIds },
      execute: () => groupRestart(groupId, rebuild, fresh),
      verify: () =>
        pollUntil(async () => {
          const docker = await dockerStatus();
          const current = docker.containers.filter((c) => c.name.startsWith(prefix));
          const oldGone = oldIds.every((id) => !current.some((c) => c.id === id));
          return {
            ok: oldGone,
            state: { containers: current },
            message: oldIds.length
              ? oldGone
                ? fresh
                  ? 'previous container exited; fresh-context container restart requested'
                  : 'previous container exited; group will wake on its next message'
                : 'previous container still present'
              : fresh
                ? 'group was idle; no running session was cleared'
                : 'group was idle; restart command accepted and no stale container exists',
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  /**
   * Switch Claude ↔ Codex ↔ OpenCode ↔ Pi while keeping a durable model profile for each
   * provider. The first visit to a provider uses its local native defaults;
   * subsequent visits restore the profile saved on the previous visit. A
   * single isolated web-chat turn verifies the restarted provider actually
   * answered and created its provider-specific continuation.
   */
  async switchProvider(groupId: string, provider: SwitchableProvider): Promise<OperationOutcome> {
    const before = getGroupConfig(groupId);
    if (!before) return missingGroup(groupId);
    if (before.provider && !isSwitchableProvider(before.provider)) {
      return {
        ok: false,
        operationId: '',
        status: 'failed',
        message: `Provider switching is currently limited to Claude, Codex, OpenCode, and Pi (group uses ${before.provider})`,
      };
    }
    const current = isSwitchableProvider(before.provider) ? before.provider : 'claude';
    if (current === provider) {
      return {
        ok: false,
        operationId: '',
        status: 'failed',
        message: `${before.name} is already using ${provider}`,
      };
    }

    const sourceProfile = profileFromConfig(before);
    const savedTarget = latestConfigSnapshot(this.db, groupId, providerProfileKind(provider));
    const targetProfile = savedTarget
      ? profileFromStoredConfig(savedTarget.config, provider)
      : defaultProviderProfile(provider, sourceProfile);
    saveConfigSnapshot(this.db, groupId, providerProfileKind(current), before);

    let test: Awaited<ReturnType<typeof validateProviderAfterRestart>> | null = null;
    return runVerifiedOperation(this.db, {
      kind: 'provider_switch',
      scopeType: 'group',
      scopeId: groupId,
      before: { config: before, sourceProfile, targetProfile },
      rollback: { provider: current, profile: sourceProfile },
      rollbackExecute: async (): Promise<ActionResult> => {
        const restored = await groupSetProvider(groupId, sourceProfile);
        if (!restored.ok) return restored;
        const restarted = await groupRestart(groupId, false, true);
        return {
          ok: restarted.ok,
          message: `restored ${current} profile; fresh restart: ${restarted.message}`,
        };
      },
      rollbackVerify: async () => {
        const restored = getGroupConfig(groupId);
        const ok = restored?.provider === current;
        return {
          ok,
          state: restored,
          message: ok ? `${current} profile restored` : `expected ${current}, found ${restored?.provider ?? 'missing'}`,
        };
      },
      execute: async (): Promise<ActionResult> => {
        const update = await groupSetProvider(groupId, {
          provider: targetProfile.provider,
          model: targetProfile.model,
          modelTiers: targetProfile.modelTiers,
        });
        if (!update.ok) return update;

        const restarted = await groupRestart(groupId, false);
        if (!restarted.ok) return restarted;

        test = await validateProviderAfterRestart(groupId, before.name, provider);
        return {
          ok: true,
          message: `provider switched to ${provider}; restart completed; ${test.message}`,
        };
      },
      verify: async () => {
        const after = getGroupConfig(groupId);
        const providerOk = after?.provider === provider;
        const ok = providerOk && test?.ok === true;
        return {
          ok,
          state: {
            provider: after?.provider ?? null,
            model: after?.model ?? null,
            model_tiers: after?.model_tiers ?? null,
            test,
          },
          message: ok
            ? `${provider} is active and passed the post-restart provider probe`
            : `provider=${after?.provider ?? 'unknown'}, probe=${test?.message ?? 'not run'}`,
        };
      },
    });
  }

  async lifecycleGroup(groupId: string, action: 'run' | 'resume' | 'stop' | 'pause'): Promise<OperationOutcome> {
    const group = getGroupConfig(groupId);
    if (!group) return missingGroup(groupId);
    const beforeControl = getGroupLifecycle(groupId);
    if (!beforeControl) return missingGroup(groupId);
    const beforeDocker = await dockerStatus();
    const prefix = `nanoclaw-v2-${group.folder}-`;
    const oldIds = beforeDocker.containers.filter((c) => c.name.startsWith(prefix)).map((c) => c.id);
    const desired = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running';
    return runVerifiedOperation(this.db, {
      kind: `group_${action}`,
      scopeType: 'group',
      scopeId: groupId,
      before: { lifecycle: beforeControl, containerIds: oldIds },
      execute: () =>
        action === 'run'
          ? groupRun(groupId)
          : action === 'resume'
            ? groupResume(groupId)
            : action === 'stop'
              ? groupStop(groupId)
              : groupPause(groupId),
      verify: () =>
        pollUntil(async () => {
          const lifecycle = getGroupLifecycle(groupId);
          const docker = await dockerStatus();
          const oldGone = oldIds.every((id) => !docker.containers.some((c) => c.id === id));
          const containers = docker.containers.filter((c) => c.name.startsWith(prefix));
          const lifecycleOk =
            lifecycle?.desired_state === desired && (desired !== 'running' || lifecycle.lifecycle_status !== 'error');
          const stopOk = desired === 'running' || oldGone;
          const ok = lifecycleOk && stopOk;
          return {
            ok,
            state: { lifecycle, containers, previousContainersGone: oldGone },
            message: ok
              ? `${action} applied; desired=${desired}; ${containers.length} current container(s)`
              : `desired=${lifecycle?.desired_state ?? 'unknown'}, status=${lifecycle?.lifecycle_status ?? 'unknown'}, previousContainersGone=${oldGone}`,
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  async setModel(groupId: string, model: string): Promise<OperationOutcome> {
    const before = getGroupConfig(groupId);
    if (!before) return missingGroup(groupId);
    const beforeDocker = await dockerStatus();
    const prefix = `nanoclaw-v2-${before.folder}-`;
    const oldIds = beforeDocker.containers.filter((c) => c.name.startsWith(prefix)).map((c) => c.id);
    saveConfigSnapshot(this.db, groupId, 'model_change', before);
    return runVerifiedOperation(this.db, {
      kind: 'model_change',
      scopeType: 'group',
      scopeId: groupId,
      before,
      rollback: { model: before.model },
      execute: () => groupSetModel(groupId, model, true),
      verify: () =>
        pollUntil(async () => {
          const after = getGroupConfig(groupId);
          const docker = await dockerStatus();
          const oldGone = oldIds.every((id) => !docker.containers.some((c) => c.id === id));
          const ok = after?.model === model && oldGone;
          return {
            ok,
            state: { config: after, previousContainerIds: oldIds, previousContainersGone: oldGone },
            message: ok
              ? `model is ${model}; previous container exited`
              : `model=${after?.model ?? 'unknown'}, previousContainersGone=${oldGone}`,
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  async setModelTiers(
    groupId: string,
    tiers: { high: string; medium: string; low: string; default: string },
  ): Promise<OperationOutcome> {
    const before = getGroupConfig(groupId);
    if (!before) return missingGroup(groupId);
    const tiersJson = JSON.stringify(tiers);
    const expectedModel = tiers[tiers.default as 'high' | 'medium' | 'low'];
    const beforeDocker = await dockerStatus();
    const prefix = `nanoclaw-v2-${before.folder}-`;
    const oldIds = beforeDocker.containers.filter((c) => c.name.startsWith(prefix)).map((c) => c.id);
    saveConfigSnapshot(this.db, groupId, 'model_tiers_change', before);
    return runVerifiedOperation(this.db, {
      kind: 'model_tiers_change',
      scopeType: 'group',
      scopeId: groupId,
      before,
      rollback: { model_tiers: before.model_tiers },
      execute: () => groupSetModelTiers(groupId, tiersJson, true),
      verify: () =>
        pollUntil(async () => {
          const after = getGroupConfig(groupId);
          const docker = await dockerStatus();
          const oldGone = oldIds.every((id) => !docker.containers.some((c) => c.id === id));
          const savedDefault = (() => {
            try {
              return after?.model_tiers ? (JSON.parse(after.model_tiers).default as string) : null;
            } catch {
              return null;
            }
          })();
          const ok = savedDefault === tiers.default && oldGone;
          return {
            ok,
            state: { config: after, previousContainerIds: oldIds, previousContainersGone: oldGone },
            message: ok
              ? `tiers saved (default=${tiers.default} → ${expectedModel}); previous container exited`
              : `default=${savedDefault ?? 'unknown'}, previousContainersGone=${oldGone}`,
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  async rollbackModel(groupId: string): Promise<OperationOutcome> {
    const snapshot = latestConfigSnapshot(this.db, groupId, 'model_change');
    const before = getGroupConfig(groupId);
    if (!before) return missingGroup(groupId);
    const model = snapshot?.config.model;
    if (typeof model !== 'string' || !model) {
      return {
        ok: false,
        operationId: '',
        status: 'failed',
        message: 'No previous model snapshot is available',
      };
    }
    const beforeDocker = await dockerStatus();
    const prefix = `nanoclaw-v2-${before.folder}-`;
    const oldIds = beforeDocker.containers.filter((c) => c.name.startsWith(prefix)).map((c) => c.id);
    saveConfigSnapshot(this.db, groupId, 'model_rollback', before);
    return runVerifiedOperation(this.db, {
      kind: 'model_rollback',
      scopeType: 'group',
      scopeId: groupId,
      before,
      rollback: { model: before.model },
      execute: () => groupSetModel(groupId, model, true),
      verify: () =>
        pollUntil(async () => {
          const after = getGroupConfig(groupId);
          const docker = await dockerStatus();
          const oldGone = oldIds.every((id) => !docker.containers.some((c) => c.id === id));
          const ok = after?.model === model && oldGone;
          return {
            ok,
            state: { config: after, previousContainerIds: oldIds, previousContainersGone: oldGone },
            message: ok ? `restored model ${model}; previous container exited` : 'rollback postcondition not reached',
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  /**
   * Set a group's enabled skills, then restart so the container re-materializes
   * the skill symlinks at its next spawn. `skills` is either `'all'` (dynamic) or
   * the explicit enabled list (already validated by the caller). Verify confirms
   * the stored selection resolves to the requested set and the old container is gone.
   */
  async setSkills(groupId: string, skills: string[] | 'all'): Promise<OperationOutcome> {
    const before = getGroupConfig(groupId);
    if (!before) return missingGroup(groupId);
    const available = listAvailableSkills();
    const desired = skills === 'all' ? new Set(available.map((s) => s.id)) : new Set(skills);
    const beforeDocker = await dockerStatus();
    const prefix = `nanoclaw-v2-${before.folder}-`;
    const oldIds = beforeDocker.containers.filter((c) => c.name.startsWith(prefix)).map((c) => c.id);
    saveConfigSnapshot(this.db, groupId, 'skills_change', before);
    return runVerifiedOperation(this.db, {
      kind: 'skills_change',
      scopeType: 'group',
      scopeId: groupId,
      before,
      rollback: { skills: before.skills },
      execute: async (): Promise<ActionResult> => {
        const w = await groupSetSkills(groupId, skills);
        if (!w.ok) return w;
        const rs = await groupRestart(groupId, false);
        return { ok: rs.ok, message: `skills updated; restart: ${rs.message}` };
      },
      verify: () =>
        pollUntil(async () => {
          const after = getGroupConfig(groupId);
          const resolved = resolveGroupSkills(after?.skills ?? null, available);
          const docker = await dockerStatus();
          const oldGone = oldIds.every((id) => !docker.containers.some((c) => c.id === id));
          const skillsOk =
            resolved.enabledIds.size === desired.size && [...desired].every((id) => resolved.enabledIds.has(id));
          const ok = skillsOk && oldGone;
          return {
            ok,
            state: {
              skills: after?.skills ?? null,
              enabled: [...resolved.enabledIds],
              previousContainersGone: oldGone,
            },
            message: ok
              ? `skills applied (${resolved.mode === 'all' ? 'all' : resolved.enabledIds.size}); previous container exited`
              : `skillsOk=${skillsOk}, previousContainersGone=${oldGone}`,
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  /**
   * Switch a wiring's engagement preset. `mention`/`sticky` only touch the
   * wiring row and are picked up live by the host router (no restart).
   * `context` additionally sets max_messages_per_prompt=30, which the container
   * reads only at startup — so it re-materializes container.json and restarts.
   *
   * messagingGroupId is required only when the group has more than one wiring.
   */
  async setEngageMode(
    groupId: string,
    messagingGroupId: string | undefined,
    preset: EngagePreset,
  ): Promise<OperationOutcome> {
    const group = getGroupConfig(groupId);
    if (!group) return missingGroup(groupId);

    const wirings = listWiringsForGroup(groupId);
    if (wirings.length === 0)
      return { ok: false, operationId: '', status: 'failed', message: `No channels are wired to group ${groupId}` };

    let targets = wirings;
    if (messagingGroupId) {
      targets = wirings.filter((w) => w.messaging_group_id === messagingGroupId);
      if (targets.length === 0)
        return {
          ok: false,
          operationId: '',
          status: 'failed',
          message: `No wiring for messaging group ${messagingGroupId} in this agent group`,
        };
    } else if (wirings.length > 1) {
      return {
        ok: false,
        operationId: '',
        status: 'failed',
        message: 'This group has multiple wirings — a specific channel must be chosen',
      };
    }

    const spec = ENGAGE_PRESETS[preset];
    const wantsRestart = preset === 'context';
    const before = {
      preset,
      wirings: targets.map((w) => ({
        id: w.id,
        engage_mode: w.engage_mode,
        ignored_message_policy: w.ignored_message_policy,
      })),
      maxMessagesPerPrompt: group.max_messages_per_prompt,
    };

    // Only the context preset restarts (it writes maxMessages); snapshot
    // container ids so verify can confirm the old one is gone.
    const prefix = `nanoclaw-v2-${group.folder}-`;
    const oldIds = wantsRestart
      ? (await dockerStatus()).containers.filter((c) => c.name.startsWith(prefix)).map((c) => c.id)
      : [];

    return runVerifiedOperation(this.db, {
      kind: 'engage_mode_change',
      scopeType: 'group',
      scopeId: groupId,
      before,
      execute: async (): Promise<ActionResult> => {
        const notes: string[] = [];
        for (const w of targets) {
          const r = await wiringSetEngage(w.id, spec.engageMode, spec.ignoredPolicy);
          if (!r.ok) return { ok: false, message: `wiring …${w.id.slice(-6)}: ${r.message}` };
          notes.push(`…${w.id.slice(-6)} → ${spec.engageMode}/${spec.ignoredPolicy}`);
        }
        if (wantsRestart) {
          const mr = await groupSetMaxMessages(groupId, CONTEXT_MAX_MESSAGES);
          if (!mr.ok) return { ok: false, message: `maxMessages: ${mr.message}` };
          notes.push(`maxMessagesPerPrompt → ${CONTEXT_MAX_MESSAGES}`);
          const rs = await groupRestart(groupId, false);
          notes.push(`restart: ${rs.message}`);
          if (!rs.ok) return { ok: false, message: notes.join('; ') };
        }
        return { ok: true, message: notes.join('; ') };
      },
      verify: () =>
        pollUntil(async () => {
          const after = listWiringsForGroup(groupId).filter((w) => targets.some((t) => t.id === w.id));
          const fieldsOk = after.every(
            (w) => w.engage_mode === spec.engageMode && w.ignored_message_policy === spec.ignoredPolicy,
          );
          let maxOk = true;
          let oldGone = true;
          if (wantsRestart) {
            maxOk = getGroupConfig(groupId)?.max_messages_per_prompt === CONTEXT_MAX_MESSAGES;
            const docker = await dockerStatus();
            oldGone = oldIds.every((id) => !docker.containers.some((c) => c.id === id));
          }
          const ok = fieldsOk && maxOk && oldGone;
          return {
            ok,
            state: { wirings: after, maxOk, oldGone },
            message: ok
              ? wantsRestart
                ? `context-aware set; maxMessages=${CONTEXT_MAX_MESSAGES}; previous container exited`
                : `engagement is ${spec.engageMode}`
              : `fields=${fieldsOk}, maxMessages=${maxOk}, previousContainersGone=${oldGone}`,
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  /**
   * Toggle ingest-time voice-note transcription for one wired chat. Applies
   * live (the router reads messaging_groups.voice_transcription per message)
   * — no restart. 'off' is the privacy switch: audio never leaves the machine.
   */
  async setVoiceTranscription(
    groupId: string,
    messagingGroupId: string,
    value: 'on' | 'off',
  ): Promise<OperationOutcome> {
    const group = getGroupConfig(groupId);
    if (!group) return missingGroup(groupId);

    const wirings = listWiringsForGroup(groupId);
    const target = wirings.find((w) => w.messaging_group_id === messagingGroupId);
    if (!target)
      return {
        ok: false,
        operationId: '',
        status: 'failed',
        message: `No wiring for messaging group ${messagingGroupId} in this agent group`,
      };

    return runVerifiedOperation(this.db, {
      kind: 'voice_transcription_change',
      scopeType: 'group',
      scopeId: groupId,
      before: { messagingGroupId, voice_transcription: target.voice_transcription },
      execute: async (): Promise<ActionResult> => {
        const r = await messagingGroupSetVoiceTranscription(messagingGroupId, value);
        if (!r.ok) return r;
        return { ok: true, message: `voice transcription → ${value} for ${target.name ?? messagingGroupId}` };
      },
      verify: () =>
        pollUntil(async () => {
          const after = listWiringsForGroup(groupId).find((w) => w.messaging_group_id === messagingGroupId);
          const ok = after?.voice_transcription === value;
          return {
            ok,
            state: { voice_transcription: after?.voice_transcription ?? null },
            message: ok ? `voice transcription is ${value}` : `still ${after?.voice_transcription ?? 'unknown'}`,
          };
        }, this.cfg.operationVerifyTimeoutMs),
    });
  }

  async backup(): Promise<OperationOutcome> {
    return runVerifiedOperation(this.db, {
      kind: 'backup',
      scopeType: 'system',
      before: null,
      execute: async (): Promise<ActionResult> => {
        const result = runBackup(PATHS.centralDb, PATHS.backupsDir, this.cfg.backupKeep);
        return {
          ok: result.ok,
          message: result.ok ? `backup written: ${result.file}` : (result.error ?? 'backup failed'),
        };
      },
      verify: async () => {
        const { listBackups } = await import('./backup.js');
        const latest = listBackups()[0];
        const fresh = latest != null && Date.now() - new Date(latest.mtime).getTime() < 60_000;
        return {
          ok: fresh,
          state: latest ?? null,
          message: fresh ? 'fresh backup is present' : 'fresh backup not found',
        };
      },
    });
  }

  async cleanupOrphan(relPath: string): Promise<OperationOutcome> {
    const before = findOrphans().find((o) => o.relPath === relPath);
    if (!before)
      return { ok: false, operationId: '', status: 'failed', message: `${relPath} is not currently an orphan` };
    return runVerifiedOperation(this.db, {
      kind: 'orphan_to_trash',
      scopeType: 'system',
      before,
      rollback: { relPath },
      execute: async () => cleanupOrphan(relPath),
      verify: async () => {
        const remains = findOrphans().some((o) => o.relPath === relPath);
        return {
          ok: !remains,
          state: { remains },
          message: remains ? 'orphan still present' : 'orphan moved to trash',
        };
      },
    });
  }
}

function missingGroup(groupId: string): OperationOutcome {
  return { ok: false, operationId: '', status: 'failed', message: `Unknown group ${groupId}` };
}
