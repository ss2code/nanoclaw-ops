/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { ContainerSlotPool } from './container-slot-pool.js';
import { materializeContainerJson, type HubAccess } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { readEnvFile } from './env.js';
import { ensureHardenedTopology } from './egress-filter.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import {
  beginAgentGroupWake,
  canWakeAgentGroup,
  isAgentGroupWakeLeaseCurrent,
  markAgentGroupContainerStopped,
  markAgentGroupWakeFailed,
  markAgentGroupWakeSucceeded,
  type WakeLease,
  type WakeSource,
} from './agent-group-lifecycle.js';
import { initGroupFilesystem } from './group-init.js';
import {
  ensureBaseImageFresh,
  imageFingerprintMatches,
  computeRuntimeFingerprint,
  writeRuntimeManifest,
} from './container-image.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { onShutdown } from './response-registry.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { checkOneCliHealth, OneCliCircuitOpenError, OneCliHealthError, OneCliWakeCircuit } from './onecli-health.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';
import {
  TEMPLATE_REFERENCE_FILE,
  templatePluginMount,
  templateRuntimeRoots,
  templateSkillMounts,
  templateSkillNames,
  templateWorkspaceMounts,
} from './template-runtime.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
const onecliWakeCircuit = new OneCliWakeCircuit();

/** Active containers tracked by session ID. */
const activeContainers = new Map<
  string,
  { process: ChildProcess; containerName: string; runtimeFingerprint: string }
>();
const containerSlots = new ContainerSlotPool(MAX_CONCURRENT_CONTAINERS);
onShutdown(() => containerSlots.close());

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

export function buildInboundAttachmentsMount(dataDir = DATA_DIR): VolumeMount {
  const attachmentsDir = path.join(dataDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  return { hostPath: attachmentsDir, containerPath: '/workspace/attachments', readonly: true };
}

/**
 * nano-pvt-hub store — the shared document repository agent groups can publish
 * into (dashboards, trackers, agent docs) and read back. Existing groups retain
 * read-write access by default; hardened workers can opt into read-only or no
 * access through their per-group profile.
 *
 * Ops Center serves the same directory read-only at /hub, so anything written
 * here becomes browsable over the tailnet — see `serveHubFile` in
 * ops-center/server.ts for the symlink/traversal guards that protect it.
 */
export function buildHubMount(dataDir = DATA_DIR, access: HubAccess = 'read-write'): VolumeMount | null {
  if (access === 'none') return null;
  const hubDir = path.join(dataDir, 'hub');
  fs.mkdirSync(hubDir, { recursive: true });
  return { hostPath: hubDir, containerPath: '/workspace/hub', readonly: access === 'read-only' };
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session, trigger?: string, source: WakeSource = 'automatic'): Promise<boolean> {
  const decision = canWakeAgentGroup(session.agent_group_id, source);
  if (!decision.allowed) {
    log.info('Container wake suppressed by agent-group lifecycle policy', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      source,
      reason: decision.reason,
    });
    return Promise.resolve(false);
  }
  const active = activeContainers.get(session.id);
  if (active) {
    let currentFingerprint: string | null = null;
    try {
      const group = getAgentGroup(session.agent_group_id);
      const groupDir = group ? path.resolve(GROUPS_DIR, group.folder) : '';
      currentFingerprint = computeRuntimeFingerprint(process.cwd(), groupDir ? templateRuntimeRoots(groupDir) : []);
    } catch {
      /* spawn path will report a useful error */
    }
    if (currentFingerprint && active.runtimeFingerprint !== currentFingerprint) {
      log.info('Container runtime inputs changed; recycling active container', { sessionId: session.id });
      killContainer(session.id, 'runtime inputs changed', () => {
        void wakeContainer(session, 'runtime-refresh', source);
      });
      return Promise.resolve(false);
    }
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const lease = beginAgentGroupWake(session.agent_group_id, source);
  if (!lease) return Promise.resolve(false);
  const promise = spawnContainer(session, trigger, lease)
    .then(() => true)
    .catch((err) => {
      if (isAgentGroupWakeLeaseCurrent(session.agent_group_id, lease)) {
        markAgentGroupWakeFailed(session.agent_group_id, lease, (err as Error).message);
      }
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

/**
 * Flatten a wake trigger to a single quote-free, length-capped token so it
 * survives the logger's `key="value"` serialization and Ops Center's field
 * parser intact (which reads `trigger="…"` off the "Spawning container" line).
 */
function sanitizeTrigger(trigger: string): string {
  return trigger
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function spawnContainer(session: Session, trigger: string | undefined, lease: WakeLease): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
  const baseFingerprint = ensureBaseImageFresh(process.cwd(), CONTAINER_IMAGE, CONTAINER_RUNTIME_BIN);
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  if (imageTag !== CONTAINER_IMAGE && !imageFingerprintMatches(imageTag, baseFingerprint, CONTAINER_RUNTIME_BIN)) {
    log.warn('Per-agent image is based on an older base image; Docker rebuild required before starting the container', {
      agentGroupId: agentGroup.id,
      imageTag,
    });
    await buildAgentGroupImage(agentGroup.id);
    if (!imageFingerprintMatches(imageTag, baseFingerprint, CONTAINER_RUNTIME_BIN)) {
      throw new Error(`per-agent image ${imageTag} is still stale after rebuild`);
    }
  }
  const runtimeFingerprint = computeRuntimeFingerprint(
    process.cwd(),
    templateRuntimeRoots(path.resolve(GROUPS_DIR, agentGroup.folder)),
  );
  writeRuntimeManifest(
    sessionDir(agentGroup.id, session.id),
    process.cwd(),
    imageTag,
    baseFingerprint,
    runtimeFingerprint,
  );
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  // Pause/stop can win while asynchronous setup is running. The lifecycle
  // revision check prevents a stale wake from spawning after that transition.
  if (!isAgentGroupWakeLeaseCurrent(session.agent_group_id, lease)) {
    throw new Error('container wake cancelled by a newer agent-group lifecycle transition');
  }

  // Hold the lease for the child process lifetime. On a constrained VPS this
  // prevents a burst across many groups from exhausting memory or shared CPU.
  const releaseSlot = await containerSlots.acquire(session.id);
  const cleanTrigger = trigger ? sanitizeTrigger(trigger) : '';
  log.info('Spawning container', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    containerName,
    ...(cleanTrigger ? { trigger: cleanTrigger } : {}),
  });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  let container: ChildProcess;
  try {
    container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    releaseSlot();
    throw err;
  }

  activeContainers.set(session.id, {
    process: container,
    containerName,
    runtimeFingerprint,
  });
  markContainerRunning(session.id);
  markAgentGroupWakeSucceeded(session.agent_group_id, lease);

  // Log stderr. A container that dies at boot (unknown provider, missing
  // binary, bad config) explains itself only here — and debug is below the
  // default log level — so keep a tail to surface on a non-zero exit.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    releaseSlot();
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    markAgentGroupContainerStopped(
      session.id,
      code !== 0 && code !== null ? `container exited with code ${code}` : undefined,
    );
    stopTypingRefresh(session.id);
    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    releaseSlot();
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    markAgentGroupContainerStopped(session.id, err.message);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   container_configs.provider
 *     → sessions.agent_provider (deprecated compatibility fallback)
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (containerConfigProvider || sessionProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
        configuredModel: containerConfig.model,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig, groupDir);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Channel adapters save inbound media here and prompt the agent with
  // /workspace/attachments/<file>. Keep it read-only inside the container.
  mounts.push(buildInboundAttachmentsMount());

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // The template reference controls host-side source mounts. Keep it
  // operator-owned even though the rest of the group workspace is writable.
  const templateReference = path.join(groupDir, TEMPLATE_REFERENCE_FILE);
  if (fs.existsSync(templateReference)) {
    mounts.push({
      hostPath: templateReference,
      containerPath: `/workspace/agent/${TEMPLATE_REFERENCE_FILE}`,
      readonly: true,
    });
  }

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared document hub at /workspace/hub. Existing groups default to RW;
  // hardened workers can be read-only or receive no mount.
  const hubAccess = containerConfig.hardening?.hubAccess ?? 'read-write';
  const hubMount = buildHubMount(DATA_DIR, hubAccess);
  if (hubMount) mounts.push(hubMount);

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  if (defaultSurfaces) {
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Template source is the live read-only plane. The group directory remains
  // the durable state/work plane, while app code, context, persona, and
  // template skills come directly from the checked-out template source.
  mounts.push(...templateWorkspaceMounts(groupDir));
  const pluginMount = templatePluginMount(groupDir);
  if (pluginMount) mounts.push(pluginMount);
  if (defaultSurfaces) mounts.push(...templateSkillMounts(groupDir, '/home/node/.claude/skills'));

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(
  claudeDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
  groupDir: string,
): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig).filter((name) => !templateSkillNames(groupDir).includes(name));
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return isSkillRoot(path.join(sharedSkillsDir, e));
        } catch {
          return false;
        }
      })
    : [];
}

function isSkillRoot(skillDir: string): boolean {
  if (!fs.statSync(skillDir).isDirectory()) return false;
  return fs.existsSync(path.join(skillDir, 'SKILL.md')) || fs.existsSync(path.join(skillDir, 'instructions.md'));
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Per-container resource caps (opt-in; empty = unbounded, today's behavior).
  // Only --memory is set. Whether that's a hard cap depends on the host having no
  // swap (a deployment concern) — on a swapless host --memory is hard and a runaway
  // is OOM-killed; we don't manage swap from here.
  // Per-group hardening caps override the global env limits when present.
  const hardening = containerConfig.hardening;
  const cpuLimit = hardening?.caps?.cpus ?? CONTAINER_CPU_LIMIT;
  const memoryLimit = hardening?.caps?.memory ?? CONTAINER_MEMORY_LIMIT;
  if (cpuLimit) args.push('--cpus', cpuLimit);
  if (memoryLimit) args.push('--memory', memoryLimit);
  if (hardening?.caps?.pidsLimit) args.push('--pids-limit', String(hardening.caps.pidsLimit));
  if (hardening?.caps?.tmpfs) args.push('--tmpfs', `/tmp:rw,size=${hardening.caps.tmpfs}`);
  if (hardening?.caps?.noNewPrivileges) args.push('--security-opt', 'no-new-privileges');
  if (hardening?.caps?.capDrop) args.push('--cap-drop', 'ALL');

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Claude session-hygiene tuning knobs. The agent-runner documents these as
  // host-env operator overrides, but container env is assembled here — without
  // this passthrough a value in the host .env silently never reaches the
  // container and the in-container defaults (12MB / 14d / 165k) always win.
  const claudeTuning = readEnvFile([
    'CLAUDE_TRANSCRIPT_ROTATE_BYTES',
    'CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  ]);
  for (const [key, value] of Object.entries(claudeTuning)) {
    args.push('-e', `${key}=${value}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Network selection, most restrictive first. All three paths throw rather
  // than fall back open when their topology can't be established.
  //
  // 1. Per-group hardened egress: agent joins its own internal network whose
  //    only hop is the allowlisting filter proxy (which relays to the OneCLI
  //    gateway). No host.docker.internal add-host mapping — the filter holds
  //    that alias on the per-group network.
  // 2. Global egress lockdown (env flag): shared internal network with the
  //    gateway as the only hop.
  // 3. Default: host gateway mapping, open egress.
  if (hardening?.egress) {
    const hardenedNetwork = await ensureHardenedTopology(agentGroup.folder, hardening.allowHosts ?? []);
    args.push('--network', hardenedNetwork);
    log.info('Hardened egress active', {
      containerName,
      network: hardenedNetwork,
      allowHosts: hardening.allowHosts,
    });
  } else if (ensureEgressNetwork()) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection, and mounts
  // any credential stubs the gateway serves (e.g. a sentinel auth file).
  // Runs AFTER the volume mounts so a stub nested inside one of our mounts
  // (a parent dir mounted RW above it) lands later in the args and isn't
  // shadowed by it. Treated as a transient hard failure: if we can't wire
  // the gateway, we don't spawn. The caller (router or host-sweep) catches
  // the throw, leaves the inbound message pending, and the next sweep tick
  // retries.
  try {
    await ensureOneCliGatewayReady();
    if (agentIdentifier) {
      await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
    }
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    onecliWakeCircuit.recordSuccess();
  } catch (err) {
    // Health failures and an already-open circuit have already been recorded.
    // SDK setup failures are classified separately so the next wake backs off
    // even when /v1/health is green but agent/config provisioning is broken.
    if (!(err instanceof OneCliHealthError) && !(err instanceof OneCliCircuitOpenError)) {
      onecliWakeCircuit.recordFailure('sdk');
    }
    throw err;
  }
  log.info('OneCLI gateway applied', { containerName });

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

async function ensureOneCliGatewayReady(): Promise<void> {
  const now = Date.now();
  if (!onecliWakeCircuit.canAttempt(now)) {
    const snapshot = onecliWakeCircuit.snapshot();
    const error = new OneCliCircuitOpenError(onecliWakeCircuit.retryAfterMs(now), snapshot.lastFailureKind);
    log.warn('OneCLI preflight skipped while wake circuit is open', {
      retryAfterMs: error.retryAfterMs,
      lastFailureKind: error.lastFailureKind,
    });
    throw error;
  }

  try {
    const result = await checkOneCliHealth(ONECLI_URL);
    log.debug('OneCLI gateway preflight passed', { url: result.url, status: result.status });
  } catch (err) {
    const kind = err instanceof OneCliHealthError ? err.kind : 'unreachable';
    onecliWakeCircuit.recordFailure(kind);
    log.warn('OneCLI gateway preflight failed', {
      kind,
      retryAfterMs: onecliWakeCircuit.retryAfterMs(),
      err,
    });
    throw err;
  }
}

/** Build a per-agent-group Docker image with custom packages. */
const execAsync = promisify(exec);

export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Keep the single-threaded host responsive while Docker/apt performs a
    // potentially multi-minute build. Awaited async exec preserves the old
    // timeout, buffered output, and non-zero-exit error propagation.
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
