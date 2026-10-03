import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import nanoclawPiMcpExtension from './pi-mcp-extension.js';
import type { PiExtensionApi } from './pi-mcp-bridge.js';

const tempDirs: string[] = [];
const priorConfig = process.env.NANOCLAW_PI_MCP_CONFIG;
const priorObservabilityDir = process.env.NANOCLAW_PI_OBSERVABILITY_DIR;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (priorConfig === undefined) delete process.env.NANOCLAW_PI_MCP_CONFIG;
  else process.env.NANOCLAW_PI_MCP_CONFIG = priorConfig;
  if (priorObservabilityDir === undefined) delete process.env.NANOCLAW_PI_OBSERVABILITY_DIR;
  else process.env.NANOCLAW_PI_OBSERVABILITY_DIR = priorObservabilityDir;
});

describe('Pi MCP extension lifecycle', () => {
  it('defers action APIs until session_start and initializes only once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pi-extension-'));
    tempDirs.push(root);
    process.env.NANOCLAW_PI_MCP_CONFIG = '{}';
    process.env.NANOCLAW_PI_OBSERVABILITY_DIR = root;

    let runtimeReady = false;
    let actionCalls = 0;
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const assertReady = () => {
      if (!runtimeReady) throw new Error('Extension runtime not initialized');
      actionCalls += 1;
    };
    const pi: PiExtensionApi = {
      registerTool() {},
      getActiveTools() {
        assertReady();
        return ['read'];
      },
      setActiveTools() {
        assertReady();
      },
      appendEntry() {
        assertReady();
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    };

    await nanoclawPiMcpExtension(pi);

    expect(actionCalls).toBe(0);
    expect(handlers.has('session_start')).toBe(true);
    expect(fs.existsSync(path.join(root, 'mcp-health.json'))).toBe(false);

    runtimeReady = true;
    await handlers.get('session_start')?.();
    const callsAfterFirstStart = actionCalls;
    await handlers.get('session_start')?.();

    expect(callsAfterFirstStart).toBeGreaterThan(0);
    expect(actionCalls).toBe(callsAfterFirstStart);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'mcp-health.json'), 'utf8')).status).toBe('ready');
  });
});
