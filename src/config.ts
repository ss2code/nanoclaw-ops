import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { resolveRuntimeProfile } from './runtime-profile.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'LONG_RUNNING_NOTICE_AFTER_MS',
  'LONG_RUNNING_NOTICE_TEXT',
  'MAX_CONCURRENT_CONTAINERS',
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_MEMORY_LIMIT',
  'NANOCLAW_RUNTIME_PROFILE',
]);
// Machine-local profiles must not silently alter deterministic test behavior.
// Tests can still exercise any profile through explicit process env or the
// pure resolveRuntimeProfile helper.
const runtimeEnvConfig =
  process.env.NODE_ENV === 'test'
    ? {}
    : readEnvFile(
        ['MAX_CONCURRENT_CONTAINERS', 'CONTAINER_CPU_LIMIT', 'CONTAINER_MEMORY_LIMIT', 'NANOCLAW_RUNTIME_PROFILE'],
        '.env.runtime',
      );

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
// Local agent-template library. Committed but ships empty (+ README). Resolved
// once at load. Override to another LOCAL path via NANOCLAW_TEMPLATES_DIR; never
// a remote URL, never an ncl flag, never runtime-mutable.
export const TEMPLATES_DIR = process.env.NANOCLAW_TEMPLATES_DIR
  ? path.resolve(process.env.NANOCLAW_TEMPLATES_DIR)
  : path.resolve(PROJECT_ROOT, 'templates');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_CONTAINERS ||
      runtimeEnvConfig.MAX_CONCURRENT_CONTAINERS ||
      envConfig.MAX_CONCURRENT_CONTAINERS ||
      '5',
    10,
  ) || 5,
);
export const LONG_RUNNING_NOTICE_AFTER_MS = Math.max(
  0,
  parseInt(process.env.LONG_RUNNING_NOTICE_AFTER_MS || envConfig.LONG_RUNNING_NOTICE_AFTER_MS || '120000', 10) || 0,
);
export const LONG_RUNNING_NOTICE_TEXT =
  process.env.LONG_RUNNING_NOTICE_TEXT ||
  envConfig.LONG_RUNNING_NOTICE_TEXT ||
  'Still working on this - it is taking longer than usual. I will reply here when done.';
// Per-container resource caps, passed through to `docker run`. Default empty =
// no flag added = today's unbounded behavior (don't OOM existing OSS workloads).
// Operators opt in: CONTAINER_CPU_LIMIT=2, CONTAINER_MEMORY_LIMIT=8g.
export const CONTAINER_CPU_LIMIT =
  process.env.CONTAINER_CPU_LIMIT || runtimeEnvConfig.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || '';
export const CONTAINER_MEMORY_LIMIT =
  process.env.CONTAINER_MEMORY_LIMIT ||
  runtimeEnvConfig.CONTAINER_MEMORY_LIMIT ||
  envConfig.CONTAINER_MEMORY_LIMIT ||
  '';
const runtimeProfile = resolveRuntimeProfile(
  process.env.NANOCLAW_RUNTIME_PROFILE ||
    runtimeEnvConfig.NANOCLAW_RUNTIME_PROFILE ||
    envConfig.NANOCLAW_RUNTIME_PROFILE,
);
export const RUNTIME_PROFILE = runtimeProfile.name;
export const BACKGROUND_WORK_ENABLED = runtimeProfile.backgroundWorkEnabled;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
