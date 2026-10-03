export type RuntimeProfileName = 'production' | 'development';

export interface RuntimeProfile {
  name: RuntimeProfileName;
  backgroundWorkEnabled: boolean;
}

/**
 * Production owns scheduled/retry sweeps and recurrence. A development clone
 * still accepts direct CLI/Telegram traffic, but cannot independently fan out
 * copied production schedules.
 */
export function resolveRuntimeProfile(value: string | undefined): RuntimeProfile {
  const normalized = (value || 'production').trim().toLowerCase();
  if (normalized === 'production') return { name: 'production', backgroundWorkEnabled: true };
  if (normalized === 'development') return { name: 'development', backgroundWorkEnabled: false };
  throw new Error(`Invalid NANOCLAW_RUNTIME_PROFILE=${JSON.stringify(value)}; expected "production" or "development"`);
}
