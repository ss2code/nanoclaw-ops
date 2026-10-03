import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildOpsCenterSystemdUnit } from './service-unit.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const homeDir = os.homedir();
const nodePath = process.execPath;
const tsxPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const dryRun = process.argv.includes('--dry-run');
const installSlug = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);

function run(command: string, args: string[]): void {
  if (dryRun) {
    console.log([command, ...args].join(' '));
    return;
  }
  execFileSync(command, args, { stdio: 'inherit' });
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function installLinux(): void {
  const unitName = `nanoclaw-ops-${installSlug}.service`;
  const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, unitName);
  const unit = buildOpsCenterSystemdUnit({ repoRoot, nodePath, tsxPath, homeDir });
  if (dryRun) {
    console.log(`# ${unitPath}\n${unit}`);
    return;
  }
  fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(repoRoot, 'logs'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(unitPath, unit, { mode: 0o600 });
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', unitName]);
  try {
    run('loginctl', ['enable-linger']);
  } catch {
    console.warn('warning: loginctl linger could not be enabled; the service may stop after SSH logout');
  }
  run('systemctl', ['--user', 'is-active', unitName]);
  console.log(`loaded ${unitName} — use an SSH/Tailscale tunnel for http://127.0.0.1:10333`);
}

function installMac(): void {
  const label = `com.nanoclaw.opscenter-${installSlug}`;
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  const nodeDir = path.dirname(nodePath);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(tsxPath)}</string><string>${xml(path.join(repoRoot, 'ops-center', 'index.ts'))}</string></array>
<key>WorkingDirectory</key><string>${xml(repoRoot)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:${xml(nodeDir)}</string><key>HOME</key><string>${xml(homeDir)}</string></dict>
<key>StandardOutPath</key><string>${xml(path.join(repoRoot, 'logs', 'opscenter.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(repoRoot, 'logs', 'opscenter.error.log'))}</string>
</dict></plist>\n`;
  if (dryRun) {
    console.log(`# ${plistPath}\n${plist}`);
    return;
  }
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'logs'), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  const uid = String(process.getuid?.() ?? 0);
  try {
    // One-time migration from the pre-slug service name. Leaving it loaded
    // would run two dashboards/watchdogs against the same checkout.
    run('launchctl', ['bootout', `gui/${uid}/com.nanoclaw.opscenter`]);
  } catch {
    // Legacy service is absent or already unloaded.
  }
  try {
    run('launchctl', ['bootout', `gui/${uid}/${label}`]);
  } catch {
    // First install.
  }
  run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  run('launchctl', ['enable', `gui/${uid}/${label}`]);
  run('launchctl', ['print', `gui/${uid}/${label}`]);
  console.log(`loaded ${label} — dashboard on http://127.0.0.1:10333`);
}

if (!fs.existsSync(tsxPath)) throw new Error(`tsx not found at ${tsxPath}; run pnpm install first`);
if (process.platform === 'linux') installLinux();
else if (process.platform === 'darwin') installMac();
else throw new Error(`Unsupported platform: ${process.platform}`);
