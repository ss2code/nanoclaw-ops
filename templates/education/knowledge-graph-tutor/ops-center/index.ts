import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTutorConsoleServer } from './server.js';
import { TutorConsoleService } from './service.js';
import { renderTutorFoundryEmbed } from './ops-center.js';

export function createTemplateOpsCenterApp(context: { root: string; templateRoot: string; contribution: { id: string } }) {
  const service = new TutorConsoleService(context.root, undefined, context.templateRoot);
  const assetsDir = path.join(context.templateRoot, 'ops-center', 'public');
  const apiPrefix = `/api/${context.contribution.id}`;
  return {
    renderEmbedded: (actionToken: string) => renderTutorFoundryEmbed(assetsDir, actionToken, apiPrefix),
    handleApi: (method: string, pathname: string, body: Record<string, unknown> = {}) =>
      import('./ops-center.js').then(({ dispatchTutorFoundryRequest }) => dispatchTutorFoundryRequest(service, method, pathname, body, apiPrefix)),
  };
}

const appDir = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const root = path.resolve(appDir, '../../../..');
  const port = Number(process.env.TUTOR_CONSOLE_PORT || 10335);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('TUTOR_CONSOLE_PORT must be between 1024 and 65535');
  process.chdir(root);
  const service = new TutorConsoleService(root, undefined, path.resolve(appDir, '..'));
  const server = createTutorConsoleServer(service, {
    assetsDir: path.join(appDir, 'public'),
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Tutor Foundry listening on http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
