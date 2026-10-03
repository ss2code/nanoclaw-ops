/**
 * Red-alert DMs via the Telegram Bot API — deliberately independent of the
 * NanoClaw host (it must work precisely when the host is down). Edge-triggered:
 * alert on red transition, recovery note on clear, per-condition cooldown.
 */
import type Database from 'better-sqlite3';
import { addEvent, getMeta, setMeta } from './opsdb.js';
import { readEnvKey, type OpsConfig } from './config.js';

export interface AlertCondition {
  key: string;
  red: boolean;
  message: string;
}

interface CondState {
  red: boolean;
  lastSentMs: number;
}

export class Alerter {
  private state = new Map<string, CondState>();

  constructor(
    private cfg: OpsConfig,
    private opsDb: Database.Database,
    private send: (text: string) => Promise<boolean> = (t) => sendTelegram(this.cfg, t),
  ) {
    try {
      const saved = getMeta(this.opsDb, 'alert_state');
      if (saved) this.state = new Map(Object.entries(JSON.parse(saved)) as [string, CondState][]);
    } catch {
      this.state = new Map();
    }
  }

  /** Evaluate conditions; fire alerts on red edges, recovery notes on green edges. */
  async evaluate(conditions: AlertCondition[], nowMs: number): Promise<void> {
    if (!this.cfg.alerts.enabled) return;
    for (const c of conditions) {
      const prev = this.state.get(c.key) ?? { red: false, lastSentMs: 0 };
      if (c.red && !prev.red) {
        if (nowMs - prev.lastSentMs >= this.cfg.alerts.cooldownMs) {
          const ok = await this.send(`🔴 NanoClaw alert — ${c.message}`);
          if (ok) prev.lastSentMs = nowMs;
          addEvent(this.opsDb, {
            ts: new Date(nowMs).toISOString(),
            group_id: 'host',
            kind: 'alert_sent',
            severity: 'error',
            detail: c.message,
          });
        }
      } else if (!c.red && prev.red) {
        await this.send(`🟢 NanoClaw recovered — ${c.key}`);
      }
      prev.red = c.red;
      this.state.set(c.key, prev);
    }
    setMeta(this.opsDb, 'alert_state', JSON.stringify(Object.fromEntries(this.state)));
  }
}

export async function sendTelegram(cfg: OpsConfig, text: string): Promise<boolean> {
  const token = readEnvKey('TELEGRAM_BOT_TOKEN');
  if (!token || !cfg.alerts.telegramChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.alerts.telegramChatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
