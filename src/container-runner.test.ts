import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { buildHubMount, buildInboundAttachmentsMount, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers the current container config over the deprecated session value', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('claude');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildInboundAttachmentsMount', () => {
  it('mounts shared inbound attachments where runner prompts point', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-attachments-'));
    const mount = buildInboundAttachmentsMount(dataDir);

    expect(mount).toEqual({
      hostPath: path.join(dataDir, 'attachments'),
      containerPath: '/workspace/attachments',
      readonly: true,
    });
    expect(fs.statSync(mount.hostPath).isDirectory()).toBe(true);
  });
});

describe('buildHubMount (nano-pvt-hub)', () => {
  it('mounts the shared document hub read-write where the skill publishes', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hub-mount-'));
    const mount = buildHubMount(dataDir);

    // The container skill runs `hub.mjs --root /workspace/hub`, and publishing
    // requires writes, so both the path and readonly:false are load-bearing.
    expect(mount).toEqual({
      hostPath: path.join(dataDir, 'hub'),
      containerPath: '/workspace/hub',
      readonly: false,
    });
    if (!mount) throw new Error('expected a read-write hub mount');
    expect(fs.statSync(mount.hostPath).isDirectory()).toBe(true);
  });

  it('supports a per-group read-only hub for untrusted workers', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hub-readonly-'));

    expect(buildHubMount(dataDir, 'read-only')).toEqual({
      hostPath: path.join(dataDir, 'hub'),
      containerPath: '/workspace/hub',
      readonly: true,
    });
  });

  it('omits the hub entirely when group policy disables access', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hub-none-'));

    expect(buildHubMount(dataDir, 'none')).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'hub'))).toBe(false);
  });

  // The helper above stays green even if the mount is never wired into
  // buildMounts, and buildMounts itself is not hermetically drivable (module
  // level DATA_DIR/GROUPS_DIR + spawn-time side effects). Guard the wiring
  // structurally so deleting the push — e.g. during an upstream merge — fails.
  it('is wired into buildMounts through the per-group hardening policy (structural)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const buildMounts = src.indexOf('function buildMounts');
    const policy = src.indexOf('containerConfig.hardening?.hubAccess');
    const build = src.indexOf('const hubMount = buildHubMount');
    const push = src.indexOf('if (hubMount) mounts.push(hubMount)');
    expect(buildMounts).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(buildMounts);
    expect(build).toBeGreaterThan(policy);
    expect(push).toBeGreaterThan(build);
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });

  it('preflights OneCLI before invoking agent/config setup', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const preflight = src.indexOf('await ensureOneCliGatewayReady()');
    const ensureAgent = src.indexOf('await onecli.ensureAgent');
    const applyConfig = src.indexOf('onecli.applyContainerConfig');
    expect(preflight).toBeGreaterThan(-1);
    expect(ensureAgent).toBeGreaterThan(preflight);
    expect(applyConfig).toBeGreaterThan(preflight);
    expect(src).toContain("onecliWakeCircuit.recordFailure('sdk')");
  });
});

describe('source-backed template runtime (structural)', () => {
  it('mounts template surfaces and fingerprints warm-container inputs', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('templateWorkspaceMounts(groupDir)');
    expect(src).toContain('TEMPLATE_REFERENCE_FILE');
    expect(src).toContain("templateSkillMounts(groupDir, '/home/node/.claude/skills')");
    expect(src).toContain('computeRuntimeFingerprint(process.cwd()');
    expect(src).toContain('runtimeFingerprint');
    expect(src).toContain("'runtime inputs changed'");
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy limit (per-group hardening caps override the global knob)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/const cpuLimit = hardening\?\.caps\?\.cpus \?\? CONTAINER_CPU_LIMIT/);
    expect(src).toMatch(/if \(cpuLimit\) args\.push\('--cpus', cpuLimit\)/);
  });

  it('guards --memory behind a truthy limit (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/const memoryLimit = hardening\?\.caps\?\.memory \?\? CONTAINER_MEMORY_LIMIT/);
    expect(src).toMatch(/if \(memoryLimit\) args\.push\('--memory', memoryLimit\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('loads both knobs from process/.env and still defaults to empty (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toMatch(
      /CONTAINER_CPU_LIMIT[\s\S]*runtimeEnvConfig\.CONTAINER_CPU_LIMIT[\s\S]*envConfig\.CONTAINER_CPU_LIMIT/,
    );
    expect(cfg).toMatch(
      /CONTAINER_MEMORY_LIMIT[\s\S]*runtimeEnvConfig\.CONTAINER_MEMORY_LIMIT[\s\S]*envConfig\.CONTAINER_MEMORY_LIMIT/,
    );
  });
});

describe('global container slot ceiling (structural)', () => {
  it('acquires before spawn and releases from both terminal event paths', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const acquire = src.indexOf('containerSlots.acquire');
    const spawnCall = src.indexOf('spawn(CONTAINER_RUNTIME_BIN');
    expect(acquire).toBeGreaterThan(-1);
    expect(spawnCall).toBeGreaterThan(acquire);
    expect(src).toMatch(/container\.on\('close',[\s\S]*releaseSlot\(\)/);
    expect(src).toMatch(/container\.on\('error',[\s\S]*releaseSlot\(\)/);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('per-agent image build responsiveness', () => {
  it('warns operators when a stale per-agent image triggers a Docker rebuild', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain(
      "log.warn('Per-agent image is based on an older base image; Docker rebuild required before starting the container'",
    );
  });

  it('awaits an asynchronous Docker build instead of blocking the host event loop', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const buildStart = src.indexOf('export async function buildAgentGroupImage');
    expect(buildStart).toBeGreaterThan(-1);

    const buildBody = src.slice(buildStart);
    expect(src).toMatch(/import \{ ChildProcess, exec, spawn \} from 'child_process'/);
    expect(src).toContain('const execAsync = promisify(exec);');
    expect(buildBody).toContain('await execAsync(');
    expect(buildBody).not.toContain('execSync(');
    expect(buildBody).toContain('timeout: 900_000');
  });
});
