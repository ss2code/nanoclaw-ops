import fs from 'node:fs';
import path from 'node:path';
import type { TutorConsoleApi } from './service.js';

export const TUTOR_FOUNDRY_API_PREFIX = '/api/tutor-foundry';

function safeTutorId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(value)) throw new Error('invalid tutor application id');
  return value;
}

export function renderTutorFoundryEmbed(assetsDir: string, actionToken: string, apiPrefix = TUTOR_FOUNDRY_API_PREFIX): string {
  const template = fs.readFileSync(path.join(assetsDir, 'index.html'), 'utf8');
  return template
    .replace('__ACTION_TOKEN__', actionToken)
    .replace('content="/api" data-tutor-api-base', `content="${apiPrefix}" data-tutor-api-base`)
    .replace('content="x-tutor-action-token" data-tutor-action-header', 'content="x-ops-action-token" data-tutor-action-header')
    .replace('<body>', '<body class="embedded">');
}

export function tutorFoundryFrameBody(): string {
  return `<div class="tutor-foundry-frame" style="width:100%;height:calc(100vh - 92px);min-height:720px;overflow:hidden;border:1px solid #29323d;border-radius:12px;background:#0c0f13">
  <iframe src="/tutor-foundry/embed" title="Tutor Foundry" loading="eager" referrerpolicy="same-origin" style="display:block;width:100%;height:100%;border:0"></iframe>
</div>`;
}

export async function dispatchTutorFoundryRequest(
  api: TutorConsoleApi,
  method: string,
  pathname: string,
  body: Record<string, unknown> = {},
  apiPrefix = TUTOR_FOUNDRY_API_PREFIX,
): Promise<Record<string, unknown> | undefined> {
  if (!pathname.startsWith(`${apiPrefix}/`)) return undefined;
  const route = pathname.slice(apiPrefix.length);

  if (method === 'GET' && route === '/bootstrap') return api.bootstrap();
  if (method === 'GET' && route === '/status') return api.listStatus();
  const pairingMatch = route.match(/^\/pairings\/(\d{4})$/);
  if (method === 'GET' && pairingMatch) return api.pairingStatus(pairingMatch[1]);

  if (method === 'POST' && route === '/draft') return api.saveDraft(body.draft as never);
  if (method === 'POST' && route === '/pairings') {
    const slot = typeof body.slot === 'string' ? body.slot : undefined;
    return api.startPairing(body.draft as never, body.role === 'student' ? 'student' : 'tutor', slot);
  }
  if (method === 'POST' && route === '/instantiate') return api.instantiate(body.draft as never);

  const actionMatch = route.match(/^\/instances\/([^/]+)\/action$/);
  if (method === 'POST' && actionMatch) {
    return api.classAction(safeTutorId(actionMatch[1]), String(body.action ?? ''));
  }
  const cleanupMatch = route.match(/^\/instances\/([^/]+)\/cleanup$/);
  if (method === 'POST' && cleanupMatch) {
    return api.cleanup(safeTutorId(cleanupMatch[1]), body.purge === true, String(body.confirmation ?? ''));
  }
  return undefined;
}
