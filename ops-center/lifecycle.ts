/**
 * Lifecycle actions. Host control goes through launchctl, spawned DETACHED so
 * the command survives anything happening to this process tree (the launchd
 * self-restart trap — see design §6). Group control goes through the existing
 * ncl CLI (bin/ncl → unix socket), same as a human operator.
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { PATHS, ROOT } from './config.js';
import { detectHostService, type HostService } from './readers/system.js';

const exec = promisify(execFile);

function uid(): number {
  return process.getuid ? process.getuid() : 501;
}

function detached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export async function hostStart(): Promise<ActionResult> {
  const svc = await detectHostService();
  if (!svc.plist) return { ok: false, message: 'No NanoClaw launchd plist found' };
  if (svc.running) return { ok: false, message: `Already running (pid ${svc.pid})` };
  try {
    await exec('launchctl', ['bootstrap', `gui/${uid()}`, svc.plist]);
    return { ok: true, message: 'Host starting' };
  } catch (e) {
    // Fall back to legacy load for older launchctl states
    try {
      await exec('launchctl', ['load', svc.plist]);
      return { ok: true, message: 'Host starting (legacy load)' };
    } catch {
      return { ok: false, message: `bootstrap failed: ${(e as Error).message.slice(0, 200)}` };
    }
  }
}

/** Clean full shutdown: bootout → SIGTERM → host's graceful shutdown() stops containers. */
export async function hostStop(): Promise<ActionResult> {
  const svc = await detectHostService();
  if (!svc.label) return { ok: false, message: 'No NanoClaw launchd service found' };
  if (!svc.loaded) return { ok: false, message: 'Service not loaded' };
  detached('launchctl', ['bootout', `gui/${uid()}/${svc.label}`]);
  return { ok: true, message: 'Clean shutdown requested (SIGTERM → graceful stop)' };
}

/** Atomic kill+restart performed by launchd itself. */
export async function hostRestart(): Promise<ActionResult> {
  const svc = await detectHostService();
  if (!svc.label) return { ok: false, message: 'No NanoClaw launchd service found' };
  if (!svc.loaded) return hostStart();
  detached('launchctl', ['kickstart', '-k', `gui/${uid()}/${svc.label}`]);
  return { ok: true, message: 'Restart requested (kickstart -k)' };
}

export async function hostState(): Promise<HostService> {
  return detectHostService();
}

/** Run an ncl command via the repo wrapper; returns combined output. */
export async function ncl(args: string[]): Promise<ActionResult> {
  try {
    const { stdout, stderr } = await exec('bash', [PATHS.nclBin, ...args], {
      cwd: ROOT,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, message: (stdout + stderr).trim().slice(0, 1000) || 'ok' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, message: (err.stderr || err.stdout || err.message).slice(0, 1000) };
  }
}

export function buildGroupRestartArgs(groupId: string, rebuild: boolean, fresh: boolean): string[] {
  const args = ['groups', 'restart', '--id', groupId];
  if (rebuild) args.push('--rebuild');
  if (fresh) args.push('--fresh');
  return args;
}

export async function groupRestart(groupId: string, rebuild: boolean, fresh = false): Promise<ActionResult> {
  const args = buildGroupRestartArgs(groupId, rebuild, fresh);
  return ncl(args);
}

export async function groupRun(groupId: string): Promise<ActionResult> {
  return ncl(['groups', 'run', '--id', groupId]);
}

export async function groupResume(groupId: string): Promise<ActionResult> {
  return ncl(['groups', 'resume', '--id', groupId]);
}

export async function groupStop(groupId: string): Promise<ActionResult> {
  return ncl(['groups', 'stop', '--id', groupId]);
}

export async function groupPause(groupId: string): Promise<ActionResult> {
  return ncl(['groups', 'pause', '--id', groupId]);
}

export async function groupSetModel(groupId: string, model: string, restart: boolean): Promise<ActionResult> {
  const upd = await ncl(['groups', 'config', 'update', '--id', groupId, '--model', model]);
  if (!upd.ok) return upd;
  if (!restart) return { ok: true, message: `Model set to ${model} (takes effect on next container spawn)` };
  const rs = await groupRestart(groupId, false);
  return { ok: rs.ok, message: `Model set to ${model}; restart: ${rs.message}` };
}

export interface ProviderConfigUpdate {
  provider: 'claude' | 'codex' | 'opencode' | 'pi';
  model: string | null;
  modelTiers: { high: string; medium: string; low: string; default: string } | null;
}

export function buildGroupProviderArgs(groupId: string, update: ProviderConfigUpdate): string[] {
  const args = ['groups', 'config', 'update', '--id', groupId, '--provider', update.provider];
  // A provider profile may intentionally have no scalar model (tier routing is
  // the source of truth). Emit an explicit clear so the previous provider's
  // model cannot survive the switch and be picked up by a fallback spawn.
  args.push('--model', update.model ?? 'none');
  args.push('--model-tiers', update.modelTiers ? JSON.stringify(update.modelTiers) : 'none');
  return args;
}

export async function groupSetProvider(groupId: string, update: ProviderConfigUpdate): Promise<ActionResult> {
  return ncl(buildGroupProviderArgs(groupId, update));
}

/**
 * Set a group's high/medium/low model tiers (OpenCode groups). `tiersJson` is a
 * validated `{high,medium,low,default}` object; the ncl CLI re-validates the ids
 * against the OpenRouter catalog. Restarts so the new tiers take effect.
 */
export async function groupSetModelTiers(groupId: string, tiersJson: string, restart: boolean): Promise<ActionResult> {
  const upd = await ncl(['groups', 'config', 'update', '--id', groupId, '--model-tiers', tiersJson]);
  if (!upd.ok) return upd;
  if (!restart) return { ok: true, message: 'Model tiers saved (takes effect on next container spawn)' };
  // A tier change must retire the provider continuation too. Otherwise a
  // long-lived OpenCode session can retain and repeat the previous tier map
  // when asked to self-report, even though the per-turn model pin is current.
  const rs = await groupRestart(groupId, false, true);
  return { ok: rs.ok, message: `Model tiers saved; restart: ${rs.message}` };
}

/** Update a wiring's engage_mode + ignored_message_policy. Host caller, so no approval gate. */
export async function wiringSetEngage(
  wiringId: string,
  engageMode: string,
  ignoredPolicy: string,
): Promise<ActionResult> {
  return ncl([
    'wirings',
    'update',
    '--id',
    wiringId,
    '--engage-mode',
    engageMode,
    '--ignored-message-policy',
    ignoredPolicy,
  ]);
}

/** Toggle a messaging group's ingest-time voice-note transcription. Applies
 *  live — the router reads the flag per message. Host caller, no approval gate. */
export async function messagingGroupSetVoiceTranscription(
  messagingGroupId: string,
  value: 'on' | 'off',
): Promise<ActionResult> {
  return ncl(['messaging-groups', 'update', '--id', messagingGroupId, '--voice-transcription', value]);
}

/** Update a group's max_messages_per_prompt. Takes effect on next container spawn. */
export async function groupSetMaxMessages(groupId: string, max: number): Promise<ActionResult> {
  return ncl(['groups', 'config', 'update', '--id', groupId, '--max-messages-per-prompt', String(max)]);
}

/**
 * Set a group's enabled skills. `'all'` restores the dynamic selection; an array
 * writes an explicit list. Takes effect on next container spawn — callers restart
 * the container to re-materialize the skill symlinks.
 */
export async function groupSetSkills(groupId: string, skills: string[] | 'all'): Promise<ActionResult> {
  const skillsArg = skills === 'all' ? 'all' : JSON.stringify(skills);
  return ncl(['groups', 'config', 'set-skills', '--id', groupId, '--skills', skillsArg]);
}
