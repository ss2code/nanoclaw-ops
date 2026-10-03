import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { clearProviderContinuations } from './session-continuations.js';

describe('provider continuation state', () => {
  it('clears provider continuations without touching other session state', () => {
    const rows = new Map([
      ['continuation:claude', 'claude-session'],
      ['continuation:opencode', 'opencode-session'],
      ['workflow:last-run', 'run-1'],
    ]);
    const db = {
      prepare(sql: string) {
        expect(sql).toBe("DELETE FROM session_state WHERE key LIKE 'continuation:%'");
        return {
          run() {
            const continuationKeys = [...rows.keys()].filter((key) => key.startsWith('continuation:'));
            for (const key of continuationKeys) rows.delete(key);
            return { changes: continuationKeys.length };
          },
        };
      },
    } as unknown as Database.Database;

    expect(clearProviderContinuations(db)).toBe(2);
    expect([...rows.entries()]).toEqual([['workflow:last-run', 'run-1']]);
  });
});
