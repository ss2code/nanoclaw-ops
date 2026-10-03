import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TEMPLATES_DIR } from '../src/config.js';
import { parseTemplate, type TemplateOpsCenterContribution } from '../src/templates/parse.js';

export interface TemplateOpsCenterFactoryContext {
  root: string;
  templateRoot: string;
  contribution: TemplateOpsCenterContribution;
}

export interface TemplateOpsCenterApp {
  renderEmbedded(actionToken: string): string;
  handleApi(method: string, pathname: string, body?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
}

export interface TemplateOpsCenterNavigation {
  id: string;
  label: string;
  icon: string;
  path: string;
}

export interface LoadedTemplateOpsCenterApp {
  contribution: TemplateOpsCenterContribution;
  templateRoot: string;
  assetsDir: string;
  app: TemplateOpsCenterApp;
  navigation: TemplateOpsCenterNavigation;
  apiPrefix: string;
}

type TemplateOpsCenterFactory = (context: TemplateOpsCenterFactoryContext) => TemplateOpsCenterApp | Promise<TemplateOpsCenterApp>;

const RESERVED_TEMPLATE_APP_IDS = new Set([
  'overview', 'triage', 'runs', 'chat', 'apps', 'trips', 'knowledge', 'reflect', 'system', 'hub',
  'group', 'logs', 'flows', 'incidents', 'operations', 'trace-file', 'events', 'jeeves',
]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);
}

function templateRoots(base: string): string[] {
  if (!fs.existsSync(base)) return [];
  const roots: string[] = [];
  const visit = (dir: string) => {
    if (fs.existsSync(path.join(dir, 'context', 'instructions.md'))) {
      roots.push(dir);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      visit(path.join(dir, entry.name));
    }
  };
  visit(base);
  return roots.sort();
}

export async function discoverTemplateOpsCenterApps(
  root: string,
  templatesDir = TEMPLATES_DIR,
): Promise<LoadedTemplateOpsCenterApp[]> {
  const loaded: LoadedTemplateOpsCenterApp[] = [];
  const seen = new Set<string>();
  for (const templateRoot of templateRoots(templatesDir)) {
    const template = parseTemplate(templateRoot);
    const contribution = template.opsCenter;
    if (!contribution) continue;
    if (RESERVED_TEMPLATE_APP_IDS.has(contribution.id)) {
      throw new Error(`Ops Center template application id is reserved by the core: ${contribution.id}`);
    }
    if (seen.has(contribution.id)) throw new Error(`Duplicate Ops Center template application id: ${contribution.id}`);
    seen.add(contribution.id);
    const entry = pathToFileURL(path.join(templateRoot, contribution.entry)).href;
    const module = (await import(entry)) as { createTemplateOpsCenterApp?: TemplateOpsCenterFactory };
    if (typeof module.createTemplateOpsCenterApp !== 'function') {
      throw new Error(`Ops Center contribution ${contribution.id} must export createTemplateOpsCenterApp: ${entry}`);
    }
    const app = await module.createTemplateOpsCenterApp({ root, templateRoot, contribution });
    const navigation = { id: contribution.id, label: contribution.label, icon: contribution.icon, path: `/${contribution.id}` };
    loaded.push({
      contribution,
      templateRoot,
      assetsDir: path.join(templateRoot, contribution.assets),
      app,
      navigation,
      apiPrefix: `/api/${contribution.id}`,
    });
  }
  return loaded;
}

export function templateAppFrame(app: LoadedTemplateOpsCenterApp): string {
  const title = escapeHtml(app.contribution.label);
  const src = `${app.navigation.path}/embed`;
  return `<div class="template-app-frame" style="width:100%;height:calc(100vh - 92px);min-height:720px;overflow:hidden;border:1px solid #29323d;border-radius:12px;background:#0c0f13">
  <iframe src="${src}" title="${title}" loading="eager" referrerpolicy="same-origin" style="display:block;width:100%;height:100%;border:0"></iframe>
</div>`;
}

export function findTemplateAppByApi(apps: LoadedTemplateOpsCenterApp[], pathname: string): LoadedTemplateOpsCenterApp | undefined {
  return apps.find((app) => pathname === app.apiPrefix || pathname.startsWith(`${app.apiPrefix}/`));
}

export function findTemplateAppByPage(apps: LoadedTemplateOpsCenterApp[], pathname: string): LoadedTemplateOpsCenterApp | undefined {
  return apps.find((app) => pathname === app.navigation.path || pathname.startsWith(`${app.navigation.path}/`));
}

export function serveTemplateAppAsset(
  app: LoadedTemplateOpsCenterApp,
  pathname: string,
): { file: string; contentType: string } | undefined {
  const prefix = `${app.navigation.path}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const name = pathname.slice(prefix.length);
  if (!app.contribution.assetNames.includes(name)) return undefined;
  const file = path.join(app.assetsDir, name);
  const contentType = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
  return { file, contentType };
}

export function templateAppEmbedPath(app: LoadedTemplateOpsCenterApp, pathname: string): boolean {
  return pathname === `${app.navigation.path}/embed`;
}

export function templateAppNavigation(apps: LoadedTemplateOpsCenterApp[]): TemplateOpsCenterNavigation[] {
  return apps.map(({ navigation }) => navigation);
}
