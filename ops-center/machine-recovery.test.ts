import { afterEach, describe, expect, it } from 'vitest';

import { startRecovery } from './machine-recovery.js';

const previousScript = process.env.NANOCLAW_RECOVERY_SCRIPT;

afterEach(() => {
  if (previousScript === undefined) delete process.env.NANOCLAW_RECOVERY_SCRIPT;
  else process.env.NANOCLAW_RECOVERY_SCRIPT = previousScript;
});

describe('optional host recovery', () => {
  it('does not launch a recovery process unless a local script is configured', () => {
    delete process.env.NANOCLAW_RECOVERY_SCRIPT;

    expect(startRecovery('recover')).toEqual({
      ok: false,
      message: 'Optional host recovery is not configured for this installation.',
    });
  });

  it('rejects a configured script outside the repository root', () => {
    process.env.NANOCLAW_RECOVERY_SCRIPT = '/tmp/recovery.sh';

    expect(startRecovery('postcheck')).toEqual({
      ok: false,
      message: 'Optional host recovery is not configured for this installation.',
    });
  });
});
