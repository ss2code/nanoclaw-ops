/** Fixture-only browser check. No live NanoClaw requests or model calls.
 * Run: pnpm exec tsx scripts/consult-ui-smoke.ts
 * Requires Chrome (or CONSULT_CHROME pointing to a Chromium executable).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { webQiBody } from '../ops-center/webqi.js';
import { layout } from '../ops-center/ui.js';

const root = {
  id: 'C001',
  tag: 'vendor-choice',
  question: 'Which vendor should we choose?',
  status: 'open',
  protocol: 'quick',
  defaultLens: 'distill',
  questionNodeId: 'C001:Q0',
  nodes: [
    {
      id: 'C001:Q0',
      type: 'question',
      status: 'complete',
      content: 'Which vendor should we choose?',
      hasContent: true,
    },
    {
      id: 'C001:A1',
      type: 'answer',
      status: 'complete',
      questionNodeId: 'C001:Q0',
      label: 'Model A',
      content: 'Original answer <img src=x onerror="window.sourceInjected=true">',
      hasContent: true,
    },
    {
      id: 'C001:S1',
      type: 'synthesis',
      status: 'complete',
      content: 'Choose a reversible pilot. The models disagree about setup effort.',
      hasContent: true,
    },
  ],
  edges: [
    { from: 'C001:Q0', to: 'C001:A1', type: 'answers' },
    { from: 'C001:A1', to: 'C001:S1', type: 'derives' },
  ],
};
const session = {
  id: 'session-fixture',
  groupId: 'fixture-agent',
  conversationName: 'Fixture chat',
  channelType: 'whatsapp',
  platformId: 'fixture-chat',
  store: { activeRootId: root.id, roots: [root] },
  targets: [],
};
const actions: Record<string, unknown>[] = [];
const harness = `<script>
window.addEventListener('DOMContentLoaded', async () => {
 const pause=()=>new Promise(r=>setTimeout(r,30));
 const wait=async f=>{for(let i=0;i<150;i++){if(f())return;await pause()}throw Error('Timed out waiting for UI')};
 const get=id=>document.getElementById(id);
 const assert=(ok,msg)=>{if(!ok)throw Error(msg)};
 try {
 await wait(()=>get('wi-conversation').textContent.includes('Choose a reversible pilot'));
 assert(!get('wi-options').open && !get('wi-details').open,'Advanced panels should be closed');
 assert(!window.sourceInjected,'Source content must be escaped');
 get('wi-question').value='What if the team grows?';get('wi-submit').click();
 await wait(()=>!get('wi-submit').disabled);await pause();
 document.querySelector('[data-explain]').click();await pause();await wait(()=>!get('wi-submit').disabled);
 document.querySelector('[data-branch]').click();get('wi-question').value='Explore the other option';get('wi-submit').click();await pause();await wait(()=>!get('wi-submit').disabled);
 get('wi-cancel-branch').click();get('wi-preset').value='verify';get('wi-preset').dispatchEvent(new Event('change'));get('wi-question').value='Check this reasoning';get('wi-submit').click();await pause();await wait(()=>!get('wi-submit').disabled);
 get('wi-new-root').click();get('wi-question').value='A new topic';get('wi-submit').click();await pause();await wait(()=>!get('wi-submit').disabled);
 assert(get('wi-title').textContent==='Get a second opinion','New topic must clear old answer');
 assert(document.documentElement.scrollWidth<=window.innerWidth,'Page must not overflow horizontally');
 const marker=document.createElement('pre');marker.id='smoke-result';marker.textContent='PASS';document.body.append(marker);
 }catch(e){const marker=document.createElement('pre');marker.id='smoke-result';marker.textContent='FAIL: '+e.message;document.body.append(marker)}
});
</script>`;
const page = layout('Consult fixture', '/chat', webQiBody(), [], 'fixture-token')
  .replace('</body>', harness + '</body>')
  .replace(/<link[^>]+https:\/\/fonts[^>]+>/g, '');
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url?.startsWith('/api/webqi/bootstrap'))
    return res.end(JSON.stringify({ groups: [{ id: 'fixture-agent', name: 'Fixture agent', sessions: [session] }] }));
  if (req.url?.startsWith('/api/webqi/graph?')) return res.end(JSON.stringify({ ok: true, root }));
  if (req.url?.startsWith('/api/webqi/activity'))
    return res.end(JSON.stringify({ ok: true, status: 'idle', messages: [] }));
  if (req.url === '/api/webqi/action') {
    let body = '';
    for await (const chunk of req) body += chunk;
    actions.push(JSON.parse(body));
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.url?.startsWith('/api/')) return res.end('{}');
  res.setHeader('content-type', 'text/html');
  res.end(page);
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-ui-chrome-'));
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  for (const width of [1200, 390]) {
    actions.length = 0;
    const args = [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-component-update',
      `--user-data-dir=${profile}`,
      `--window-size=${width},1000`,
      '--virtual-time-budget=12000',
      '--dump-dom',
      `http://127.0.0.1:${address.port}/chat/webqi`,
    ];
    const chrome = spawn(
      process.env.CONSULT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args,
    );
    let output = '';
    let errors = '';
    chrome.stdout.on('data', (c) => {
      output += c;
      if (output.includes('id="smoke-result">')) chrome.kill('SIGTERM');
    });
    chrome.stderr.on('data', (c) => (errors += c));
    const timeout = setTimeout(() => chrome.kill('SIGKILL'), 30000);
    const code = await new Promise<number | null>((resolve, reject) => {
      chrome.on('error', reject);
      chrome.on('exit', resolve);
    });
    clearTimeout(timeout);
    if (!output.includes('id="smoke-result">PASS'))
      throw new Error(
        output.match(/id="smoke-result">([^<]+)/)?.[1] || errors.slice(-1500) || 'Browser did not finish',
      );
    const [follow, explain, branch, check, start] = actions;
    if (
      actions.length !== 5 ||
      follow.action !== 'continue' ||
      follow.ref !== 'C001' ||
      explain.action !== 'reprocess' ||
      explain.lens !== 'contrast' ||
      branch.action !== 'branch' ||
      branch.ref !== 'C001:S1' ||
      check.protocol !== 'verify' ||
      check.lens !== 'critique' ||
      start.action !== 'new' ||
      start.rootId !== null ||
      actions.some((a) => a.sessionId !== 'session-fixture')
    )
      throw new Error('Unexpected routed actions: ' + JSON.stringify(actions));
    console.log(
      `PASS ${width}px: whole-topic follow-up, stored-answer explanation, node branch, preset, new topic, source escaping, and no horizontal overflow`,
    );
  }
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
