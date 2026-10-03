#!/usr/bin/env node
import { PATHS } from './config.js';
import { openOpsDb } from './opsdb.js';
import { RuntimePowerController } from './runtime-power.js';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  const db = openOpsDb(PATHS.opsDb);
  const power = new RuntimePowerController(db);
  try {
    if (command === 'status') {
      const state = await power.snapshot();
      console.log(`desired:     ${state.desiredState}`);
      console.log(`host:        ${state.host.running ? `running (pid ${state.host.pid})` : 'stopped'}`);
      console.log(`docker:      ${state.docker.daemonUp ? 'running' : 'stopped'}`);
      console.log(
        `onecli:      ${state.onecli.up ? `healthy (${state.onecli.url})` : `unreachable (${state.onecli.url})`}`,
      );
      console.log(`ops-center:  ${state.opsCenter.running ? `running (pid ${state.opsCenter.pid})` : 'stopped'}`);
      console.log(`wake-cycler: ${state.wakeCyclerPaused ? 'paused' : 'enabled'}`);
      return;
    }
    if (command === 'start') {
      const result = await power.startRuntime({ includeOpsCenter: true });
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === 'stop') {
      const result = await power.stopRuntime();
      console.log(result.message);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (command === 'hard-off') {
      const result = await power.prepareHardOff();
      console.log(result.message);
      if (result.ok) await power.stopOpsCenter();
      else process.exitCode = 1;
      return;
    }
    console.error('usage: nanoclaw-power start|stop|hard-off|status');
    process.exitCode = 2;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`nanoclaw-power: ${(error as Error).message}`);
  process.exitCode = 1;
});
