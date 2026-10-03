/**
 * Small host-side entry point for knowledge-graph tutor lifecycle operations.
 *
 * The tutor template is source-backed at runtime, so edits are picked up on
 * the next wake. "refresh" is only an optional immediate restart for a live
 * session; there is no watcher or copy step to keep in sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseTutorConfig, type KnowledgeGraphTutorConfig } from './admin.js';

const ROOT = process.cwd();
const CONFIG_ROOT = path.join(ROOT, 'data', 'knowledge-graph-tutor-console', 'configs');
const GROUPS_ROOT = path.join(ROOT, 'groups');
const NCL = path.join(ROOT, 'bin', 'ncl');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ADMIN = path.join(ROOT, 'templates', 'education', 'knowledge-graph-tutor', 'host', 'admin.ts');

function usage(): void {
  console.log('usage: tutor-deploy <apply <config.json> | refresh [--group <id>] | status|ingest|delete ...>');
}

function configFiles(groupId?: string): string[] {
  if (groupId) return [path.join(CONFIG_ROOT, groupId + '.json')];
  if (!fs.existsSync(CONFIG_ROOT)) return [];
  return fs
    .readdirSync(CONFIG_ROOT)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => path.join(CONFIG_ROOT, file));
}

function loadConfig(file: string): KnowledgeGraphTutorConfig | null {
  try {
    const parsed = parseTutorConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.config) {
      console.error('[tutor-deploy] skipping ' + path.basename(file) + ': ' + parsed.errors.join('; '));
      return null;
    }
    return parsed.config;
  } catch (error) {
    console.error(
      '[tutor-deploy] skipping ' +
        path.basename(file) +
        ': ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

function existingTutor(config: KnowledgeGraphTutorConfig): boolean {
  return fs.existsSync(path.join(GROUPS_ROOT, config.folder, 'tutor-app', 'instance.json'));
}

function refreshOne(config: KnowledgeGraphTutorConfig): void {
  if (!existingTutor(config)) {
    console.log('[tutor-deploy] ' + config.id + ': not instantiated; leaving it untouched');
    return;
  }
  execFileSync(
    NCL,
    ['groups', 'restart', '--id', config.id, '--message', 'Tutor refresh: reload source-backed template and runtime'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  console.log('[tutor-deploy] ' + config.id + ': group restarted; current template source will be mounted');
}

function refresh(groupId?: string): void {
  const files = configFiles(groupId);
  if (!files.length) {
    console.log('[tutor-deploy] no tutor configs found');
    return;
  }
  for (const file of files) {
    const config = loadConfig(file);
    if (config) refreshOne(config);
  }
}

function runAdmin(args: string[]): void {
  execFileSync(process.execPath, [TSX, ADMIN, ...args], { cwd: ROOT, stdio: 'inherit' });
}

function apply(configFile: string): void {
  const config = loadConfig(configFile);
  if (!config) throw new Error('invalid tutor config: ' + configFile);
  runAdmin(['apply', configFile]);
  console.log(
    '[tutor-deploy] ' + config.id + ': applied; source-backed runtime changes are picked up on the next wake',
  );
}

const [command, ...args] = process.argv.slice(2);
if (command === 'apply') {
  if (!args[0]) throw new Error('apply requires a config file');
  apply(path.resolve(ROOT, args[0]));
} else if (command === 'status' || command === 'ingest' || command === 'delete') {
  runAdmin([command, ...args]);
} else if (command === 'refresh') {
  const groupIndex = args.indexOf('--group');
  const groupId = groupIndex >= 0 ? args[groupIndex + 1] : undefined;
  if (groupIndex >= 0 && !groupId) throw new Error('--group requires an id');
  refresh(groupId);
} else {
  usage();
  process.exit(command ? 64 : 0);
}
