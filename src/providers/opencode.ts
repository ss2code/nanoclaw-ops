/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. XAI's
 * SuperGrok OAuth credential is group-scoped, so XAI-backed groups use a
 * group-persistent directory instead; this keeps the refreshable credential
 * available when NanoClaw creates a new session for the same group. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * OpenCode routing vars (provider/model selection + upstream base URL). These
 * are NOT secrets — the real API key lives in the OneCLI vault — so we source
 * them from `.env` as a fallback to process.env. The host intentionally does
 * not load `.env` into process.env (secret hygiene, see env.ts), and under
 * launchd process.env carries none of these, so the .env fallback is what
 * actually makes per-group opencode config work in a deployed service.
 */
const OPENCODE_ROUTING_VARS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
] as const;

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const configuredModel = ctx.configuredModel?.trim();
  const configuredProvider = configuredModel?.includes('/')
    ? configuredModel.split('/', 1)[0].toLowerCase()
    : undefined;
  const opencodeDir =
    configuredProvider === 'xai'
      ? path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, 'opencode-xdg')
      : path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const envFallback = readEnvFile([...OPENCODE_ROUTING_VARS]);
  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };

  // A group model may carry its upstream provider as the first path segment
  // (for example, `xai/grok-4.6` or `openrouter/deepseek/...`). Prefer that
  // group-local routing over the process-wide env so different OpenCode
  // groups can use different upstreams in the same NanoClaw host.
  if (configuredModel) {
    const provider = configuredProvider || ctx.hostEnv.OPENCODE_PROVIDER || envFallback.OPENCODE_PROVIDER;
    if (provider) env.OPENCODE_PROVIDER = provider;
    // OpenCode's top-level model setting is a canonical provider/model id. Keep
    // the prefix so native providers such as XAI resolve the model against the
    // same provider whose OAuth state is mounted below.
    env.OPENCODE_MODEL = configuredModel;
  }
  // Provider/model routing + provider-specific upstream base URL. process.env wins (explicit
  // export / dev shell); .env is the fallback that makes this work under the
  // launchd service. ANTHROPIC_BASE_URL is a fork-local addition — the
  // container provider reads it as the baseURL for non-anthropic providers
  // (e.g. OpenRouter), but native XAI OAuth must use OpenCode's own endpoint.
  // Scoped to opencode groups only (this contribution is provider-keyed).
  for (const key of OPENCODE_ROUTING_VARS) {
    if (
      configuredModel &&
      (key === 'OPENCODE_PROVIDER' || key === 'OPENCODE_MODEL' || key === 'OPENCODE_SMALL_MODEL')
    ) {
      continue;
    }
    const value = ctx.hostEnv[key] || envFallback[key];
    if (value) env[key] = value;
  }

  // The global base URL is normally the OpenRouter endpoint. Never let it
  // override OpenCode's native XAI OAuth transport for a Grok group.
  const effectiveProvider = (
    configuredProvider ||
    ctx.hostEnv.OPENCODE_PROVIDER ||
    envFallback.OPENCODE_PROVIDER
  )?.toLowerCase();
  if (effectiveProvider === 'xai') delete env.ANTHROPIC_BASE_URL;

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
