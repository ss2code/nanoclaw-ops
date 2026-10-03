#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import {
  NetlifyApi,
  contentSample,
  createNetlifyBundle,
  defaultOutDir,
  ensureDeployState,
  generatePassphrase,
  getDeployState,
  manifest,
  readDocVersion,
  readSummary,
  requiredFileContent,
  setDeployState,
  verifyEncryptedUrl,
} from './netlify';

interface Args { positional: string[]; flags: Record<string, string | boolean> }
function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
const str = (f: Args['flags'], k: string) => typeof f[k] === 'string' ? f[k] as string : undefined;
const need = (f: Args['flags'], k: string) => { const v = str(f, k); if (!v) throw new Error(`--${k} is required`); return v; };
const truthy = (f: Args['flags'], k: string) => f[k] === true || f[k] === 'true' || f[k] === '1';

// Publishing to production is the only credit-metered action here. Netlify bills 15
// credits per production deployment, and the Free plan is a hard 300/month cap with no
// recharge — 20 publishes exhaust a month and pause the project. Draft deploys (the
// default) and the preview URLs they serve are unmetered and unlimited.
//
// So the three paths that go live — `deploy --production`, `publish`, `rollback` — demand
// explicit confirmation, exactly the way `set-password` does: an agent working through a
// deploy sequence must never spend the user's credits implicitly.
const PRODUCTION_CREDIT_COST = 15;
const FREE_PLAN_MONTHLY_CREDITS = 300;

function assertCreditsConfirmed(flags: Args['flags'], action: string): void {
  if (truthy(flags, 'confirm-credits')) return;
  throw new Error(
    `${action} makes a production deployment, which costs ${PRODUCTION_CREDIT_COST} Netlify credits ` +
      `(Free plan: ${FREE_PLAN_MONTHLY_CREDITS}/month, hard cap — the project pauses once they run out). ` +
      `Tell the user the cost, get an explicit go-ahead, then re-run with --confirm-credits. ` +
      `Draft deploys — plain \`deploy\` with no --production — are free and unlimited; prefer them.`,
  );
}

function creditsSpentNotice(): string {
  return `⚠ Production publish — ${PRODUCTION_CREDIT_COST} Netlify credits spent (Free plan: ${FREE_PLAN_MONTHLY_CREDITS}/month).`;
}

const HELP = `artifact-deploy — generic artifact deployment

Global: --dir <workspace> (default /workspace/agent) --json --at <iso>

  netlify setup --site <name> [--state-db <db>]
  netlify set-password (--set <passphrase> | --generate) [--state-db <db>]   (operator-only; a deploy must never run this)
  netlify bundle --input <file.html> --slug <slug> [--out <dir>] [--password <passphrase>] [--state-db <db>]
  netlify deploy --input <file.html> --slug <slug> --site-id <id> [--production --confirm-credits] [--password <passphrase>] [--state-db <db>]
  netlify publish --site-id <id> --deploy <id> --confirm-credits [--state-db <db>]
  netlify status [--state-db <db>]
  netlify history --site-id <id>
  netlify rollback --site-id <id> --deploy <id> --confirm-credits [--state-db <db>]
  netlify teardown --site-id <id>

Credits: production publishes (--production, publish, rollback) cost ${PRODUCTION_CREDIT_COST} credits each and
require --confirm-credits after the user has been told the cost. Draft deploys — the
default — are free and unlimited, and serve a working preview URL.
`;

function stateDb(flags: Args['flags']) {
  const dbPath = str(flags, 'state-db');
  return dbPath ? ensureDeployState(dbPath) : null;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [provider, verb] = positional;
  const dir = str(flags, 'dir') ?? '/workspace/agent';
  const at = str(flags, 'at') ?? new Date().toISOString();
  const json = flags.json === true;
  if (!provider || provider === 'help') { console.log(HELP); return; }
  if (provider !== 'netlify') throw new Error(`unknown provider "${provider}"`);
  const db = stateDb(flags);
  const api = new NetlifyApi();

  switch (verb) {
    case 'setup': {
      const site = await api.createSite(need(flags, 'site'));
      if (db) { setDeployState(db, 'netlify.site', site, at); db.close(); }
      console.log(json ? JSON.stringify(site) : `Netlify site ready: ${site.ssl_url ?? site.url ?? site.id}`);
      break;
    }
    case 'set-password': {
      // Explicit intent is required: --set <passphrase> or --generate. A bare
      // set-password errors rather than silently inventing a password, so a deploy
      // (or an agent following a deploy sequence) can never set one implicitly.
      const chosen = str(flags, 'set');
      const generate = truthy(flags, 'generate');
      if (!chosen && !generate) {
        throw new Error('set-password requires --set <passphrase> or --generate; it never sets a password implicitly (a deploy must not run set-password)');
      }
      const passphrase = chosen ?? generatePassphrase(str(flags, 'seed'));
      if (db) { setDeployState(db, 'netlify.passphrase', passphrase, at); db.close(); }
      console.log(json ? JSON.stringify({ password: passphrase }) : `Page passphrase (shown once): ${passphrase}`);
      break;
    }
    case 'bundle': {
      const input = need(flags, 'input');
      const slug = need(flags, 'slug');
      if (!existsSync(input)) throw new Error(`${input} not found`);
      const state = db ? getDeployState(db) : {};
      const passphrase = str(flags, 'password') ?? (state['netlify.passphrase'] as string | undefined);
      const outDir = str(flags, 'out') ?? defaultOutDir(dir, slug);
      mkdirSync(outDir, { recursive: true });
      const bundle = createNetlifyBundle({ input, outDir, slug, version: readDocVersion(input), summary: readSummary(input), passphrase, updatedAt: at });
      if (db) { setDeployState(db, 'netlify.last_bundle', { outDir, version: bundle.version, protected: bundle.protected }, at); db.close(); }
      console.log(json ? JSON.stringify(bundle) : `Netlify bundle ready: ${outDir} (${bundle.files.length} files${bundle.protected ? ', encrypted' : ''})`);
      break;
    }
    case 'deploy': {
      const input = need(flags, 'input');
      const slug = need(flags, 'slug');
      const siteId = need(flags, 'site-id');
      const production = truthy(flags, 'production');
      // Gate before any bundling or network call, so an unconfirmed production deploy
      // costs nothing and leaves no half-built state behind.
      if (production) assertCreditsConfirmed(flags, 'deploy --production');
      const state = db ? getDeployState(db) : {};
      const passphrase = str(flags, 'password') ?? (state['netlify.passphrase'] as string | undefined);
      const outDir = str(flags, 'out') ?? defaultOutDir(dir, slug);
      const bundle = createNetlifyBundle({ input, outDir, slug, version: readDocVersion(input), summary: readSummary(input), passphrase, updatedAt: at });
      const title = `${slug} v${bundle.version}`;
      const dep = await api.createDeploy(siteId, manifest(bundle.files), title, { production });
      // Netlify's digest deploy returns `required` as a list of SHA1 digests (not paths).
      // Map each required digest back to the bundle file that has it and upload by path.
      const required = new Set<string>(dep.required ?? []);
      if (required.size) {
        const pathByDigest = new Map(bundle.files.map((f) => [f.sha1, f.path] as const));
        for (const digest of required) {
          const filePath = pathByDigest.get(digest);
          if (filePath) await api.uploadDeployFile(dep.id, `/${filePath}`, requiredFileContent(outDir, filePath));
        }
      }
      const live = { deploy_id: dep.id, url: dep.deploy_ssl_url ?? dep.ssl_url ?? dep.deploy_url ?? dep.url, version: bundle.version, deployed_at: at, production, protected: bundle.protected };
      // Encrypted deploys serve a decryptor page (HTTP 200); verify the plaintext never shipped.
      const protection = bundle.protected && live.url ? await verifyEncryptedUrl(live.url, contentSample(readFileSync(input, 'utf8'))) : undefined;
      if (db) { setDeployState(db, 'netlify.last_deploy', live, at); db.close(); }
      const credits = production ? PRODUCTION_CREDIT_COST : 0;
      console.log(json
        ? JSON.stringify({ ...live, protection, credits_spent: credits })
        : `${production ? 'Published' : 'Draft deployed'} ${bundle.protected ? '(encrypted) ' : ''}${slug} v${bundle.version}: ${live.url}`
          + (production ? `\n${creditsSpentNotice()}` : ''));
      break;
    }
    case 'publish': {
      assertCreditsConfirmed(flags, 'publish');
      const published = await api.publishDeploy(need(flags, 'site-id'), need(flags, 'deploy'));
      const live = { deploy_id: published.id ?? need(flags, 'deploy'), url: published.ssl_url ?? published.deploy_ssl_url ?? published.url ?? published.deploy_url, published_at: at, production: true };
      if (db) { setDeployState(db, 'netlify.last_publish', live, at); db.close(); }
      console.log(json
        ? JSON.stringify({ ...live, credits_spent: PRODUCTION_CREDIT_COST })
        : `Published deploy ${live.deploy_id}: ${live.url ?? ''}\n${creditsSpentNotice()}`);
      break;
    }
    case 'status': {
      const state = db ? getDeployState(db) : {};
      if (db) db.close();
      console.log(json ? JSON.stringify(state) : JSON.stringify(state, null, 2));
      break;
    }
    case 'history': {
      const rows = await api.listDeploys(need(flags, 'site-id'));
      const slim = rows.slice(0, 10).map((r) => ({ id: r.id, state: r.state, url: r.ssl_url ?? r.url, created_at: r.created_at, title: r.title }));
      console.log(json ? JSON.stringify(slim) : slim.map((r) => `${r.id}  ${r.state}  ${r.created_at ?? ''}  ${r.url ?? ''}  ${r.title ?? ''}`).join('\n'));
      break;
    }
    case 'rollback': {
      // Rollback goes through the same restore endpoint as publish: it makes the chosen
      // deploy the live production one, so it bills like any other production publish.
      assertCreditsConfirmed(flags, 'rollback');
      const restored = await api.restore(need(flags, 'site-id'), need(flags, 'deploy'));
      if (db) { setDeployState(db, 'netlify.last_rollback', { deploy_id: need(flags, 'deploy'), at }, at); db.close(); }
      console.log(json
        ? JSON.stringify({ ...restored, credits_spent: PRODUCTION_CREDIT_COST })
        : `Rolled back to deploy ${need(flags, 'deploy')}\n${creditsSpentNotice()}`);
      break;
    }
    case 'teardown': {
      await api.deleteSite(need(flags, 'site-id'));
      console.log(json ? JSON.stringify({ deleted: need(flags, 'site-id') }) : `Deleted Netlify site ${need(flags, 'site-id')}`);
      break;
    }
    default:
      throw new Error(`unknown netlify command "${verb}"`);
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
