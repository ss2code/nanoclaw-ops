import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const serverSource = () => fs.readFileSync(path.join(process.cwd(), 'ops-center', 'server.ts'), 'utf8');
const uiSource = () => fs.readFileSync(path.join(process.cwd(), 'ops-center', 'ui.ts'), 'utf8');

describe('Ops Center machine panel wiring', () => {
  it('keeps the machine status APIs behind the shared host gate', () => {
    const source = serverSource();
    expect(source).toContain("if (!hostAllowed(req, cfg))");
    expect(source).toContain("url.pathname === '/api/system/status'");
    expect(source).toContain("url.pathname === '/api/system/tunnel-ping'");
    expect(source).toContain('machineStatus({ listener, mission:');
    expect(source).toContain('recordClientContact(Date.now())');
  });

  it('renders the machine panel and hydrates it from the status API', () => {
    const source = serverSource();
    const ui = uiSource();
    expect(source).toContain('${machineCard()}');
    expect(source).toContain('${machinePanelScript()}');
    expect(ui).toContain('export function machineCard()');
    expect(ui).toContain("fetch('/api/system/status'");
    expect(ui).toContain("fetch('/api/system/tunnel-ping'");
    expect(ui).toContain('sys-cpu-top');
    expect(ui).toContain('sys-memory-pressure');
    expect(ui).toContain('sys-runtime-lag');
    expect(ui).toContain('sys-mission');
    expect(ui).toContain('m.queueDepth');
  });

  it('retains exact named-host and Origin allowlisting for Tailscale frontends', () => {
    const source = serverSource();
    expect(source).toContain('export function hostAllowed');
    expect(source).toContain('export function originAllowed');
    expect(source).toContain('trustedHosts');
    expect(source).toContain('never a wildcard');
  });

  it('keeps machine labels generic so the panel follows the actual server host', () => {
    const ui = uiSource();
    expect(ui).toContain('id="sys-host-label"');
    expect(ui).toContain('Remote access · <b>browser ⇄ server</b>');
    expect(ui).toContain('Server-side signal only');
  });

  it('keeps the OneCLI header link on the current local or remote frontend', () => {
    const ui = uiSource();
    expect(ui).toContain('id="onecli-link"');
    expect(ui).toContain('const page=new URL(window.location.href)');
    expect(ui).toContain('target.hostname=page.hostname');
    expect(ui).toContain("target.port='10254'");
    expect(ui).toContain('last outbound delivery — this is not the current time');
  });
});
