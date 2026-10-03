/**
 * NanoClaw Ops Center entry point.
 * Run: pnpm exec tsx ops-center/index.ts   (or via launchd: com.nanoclaw.opscenter)
 */
import { loadConfig, PATHS } from './config.js';
import { openOpsDb, addEvent } from './opsdb.js';
import { Collector } from './collector.js';
import { createDockerWatchdog } from './docker-watchdog.js';
import { startServer } from './server.js';

const cfg = loadConfig();
const opsDb = openOpsDb(PATHS.opsDb);
const collector = new Collector(cfg, opsDb);

addEvent(opsDb, {
  ts: new Date().toISOString(),
  group_id: 'host',
  kind: 'opscenter_start',
  severity: 'info',
  detail: `port ${cfg.port}`,
});

// Docker watchdog — the host crash-loops if Docker is down (it hard-requires the
// container runtime at startup and exits FATAL otherwise). Ops Center has no
// Docker dependency, so it survives that and can bring Docker back. Runs once at
// startup and on every sample tick; idempotent no-op when Docker is already up.
const ensureDocker = createDockerWatchdog();
try {
  ensureDocker(opsDb);
} catch (e) {
  console.error('[ops-center] docker watchdog (startup) failed:', e);
}

// Sample lane (60s) — also drives hourly maintenance + nightly backup.
const sampleTimer = setInterval(() => {
  try {
    ensureDocker(opsDb);
  } catch (e) {
    console.error('[ops-center] docker watchdog failed:', e);
  }
  collector.sampleTick().catch((e) => console.error('[ops-center] sample tick failed:', e));
}, cfg.sampleTickMs);
collector.sampleTick().catch((e) => console.error('[ops-center] initial tick failed:', e));

const server = await startServer(cfg, opsDb, collector);

function shutdown() {
  clearInterval(sampleTimer);
  server.close();
  opsDb.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
