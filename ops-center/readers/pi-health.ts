import fs from 'node:fs';
import path from 'node:path';

export interface PiServerHealth {
  status: 'ready' | 'error';
  toolCount: number;
  calls: number;
  errors: number;
  lastLatencyMs: number | null;
  lastCallAt: string | null;
  error?: string;
}

export interface PiRuntimeHealth {
  status: 'ready' | 'degraded' | 'error';
  updatedAt: string;
  sessionId: string;
  catalogTools: number;
  activeTools: number;
  servers: Record<string, PiServerHealth>;
  recentEventCount: number;
  lastEvent: { ts: string; type: string } | null;
}

function boundedTail(file: string, bytes = 64 * 1024): string {
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function readPiRuntimeHealth(sessionsRoot: string, groupId: string): PiRuntimeHealth | null {
  const groupRoot = path.join(sessionsRoot, groupId);
  let sessions: string[];
  try {
    sessions = fs.readdirSync(groupRoot).filter((name) => !name.startsWith('.'));
  } catch {
    return null;
  }
  const candidates: PiRuntimeHealth[] = [];
  for (const sessionId of sessions) {
    const obs = path.join(groupRoot, sessionId, 'pi-observability');
    const healthFile = path.join(obs, 'mcp-health.json');
    try {
      if (fs.statSync(healthFile).size > 256 * 1024) continue;
      const raw = JSON.parse(fs.readFileSync(healthFile, 'utf8')) as Record<string, any>;
      if (raw.provider !== 'pi' || !['ready', 'degraded', 'error'].includes(raw.status)) continue;
      const servers: Record<string, PiServerHealth> = {};
      for (const [name, value] of Object.entries(raw.servers ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(name) || !value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>;
        servers[name] = {
          status: item.status === 'ready' ? 'ready' : 'error',
          toolCount: safeNumber(item.toolCount), calls: safeNumber(item.calls), errors: safeNumber(item.errors),
          lastLatencyMs: typeof item.lastLatencyMs === 'number' ? item.lastLatencyMs : null,
          lastCallAt: typeof item.lastCallAt === 'string' ? item.lastCallAt : null,
          ...(typeof item.error === 'string' ? { error: item.error.slice(0, 500) } : {}),
        };
      }
      let recentEventCount = 0;
      let lastEvent: PiRuntimeHealth['lastEvent'] = null;
      const eventsFile = path.join(obs, 'events.jsonl');
      if (fs.existsSync(eventsFile)) {
        const lines = boundedTail(eventsFile).split('\n').filter(Boolean).slice(-100);
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.provider !== 'pi' || typeof event.type !== 'string' || typeof event.ts !== 'string') continue;
            recentEventCount += 1;
            lastEvent = { ts: event.ts, type: event.type };
          } catch {
            // A crash may leave the final JSONL record partial; ignore it.
          }
        }
      }
      candidates.push({
        status: raw.status,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        sessionId,
        catalogTools: safeNumber(raw.catalogTools), activeTools: safeNumber(raw.activeTools), servers,
        recentEventCount, lastEvent,
      });
    } catch {
      // Health is best-effort; corrupt or concurrently replaced files vanish from the view.
    }
  }
  return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}
