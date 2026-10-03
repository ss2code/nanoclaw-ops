import { randomUUID } from 'crypto';

import type { McpServerConfig } from '../../container-config.js';
import { isSupportedCodexModelId } from '../../codex-models.js';
import { CONTAINER_IMAGE } from '../../config.js';
import { rebuildBaseImage } from '../../container-image.js';
import { buildAgentGroupImage, killContainer, wakeContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { runOrResumeAgentGroup, stopOrPauseAgentGroup } from '../../group-lifecycle.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { clearProviderContinuations } from '../../session-continuations.js';
import { openOutboundDbRw, writeSessionMessage } from '../../session-manager.js';
import {
  getContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../../db/container-configs.js';
import { readModelCatalog } from '../../model-catalog.js';
import { attachAgentGroupFromTemplate, detachAgentGroupTemplate } from '../../templates/attach-agent.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import type { AgentGroup, ContainerConfigRow } from '../../types.js';
import { registerResource } from '../crud.js';

/** Deserialize JSON columns for display. */
function presentConfig(row: ContainerConfigRow): Record<string, unknown> {
  return {
    agent_group_id: row.agent_group_id,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    image_tag: row.image_tag,
    assistant_name: row.assistant_name,
    max_messages_per_prompt: row.max_messages_per_prompt,
    skills: JSON.parse(row.skills),
    mcp_servers: JSON.parse(row.mcp_servers),
    packages_apt: JSON.parse(row.packages_apt),
    packages_npm: JSON.parse(row.packages_npm),
    additional_mounts: JSON.parse(row.additional_mounts),
    cli_scope: row.cli_scope,
    hardening: row.hardening ? JSON.parse(row.hardening) : null,
    model_tiers: row.model_tiers ? JSON.parse(row.model_tiers) : null,
    updated_at: row.updated_at,
  };
}

type TierProvider = 'openrouter' | 'xai' | 'codex';

function modelProvider(model: string | null | undefined): string | null {
  const slash = model?.indexOf('/') ?? -1;
  return slash > 0 ? model!.slice(0, slash).toLowerCase() : null;
}

/** Return a native provider when all three tier ids clearly use one. */
function homogeneousTierProvider(raw: string | null | undefined): TierProvider | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ids = ['high', 'medium', 'low'].map((tier) => parsed[tier]);
    if (ids.every((id) => typeof id === 'string' && /^xai\//i.test(id))) return 'xai';
    if (ids.every((id) => typeof id === 'string' && /^openrouter\//i.test(id))) return 'openrouter';
  } catch {
    /* Shape validation below reports malformed JSON. */
  }
  return null;
}

function inferOpenCodeTierProvider(
  model: string | null | undefined,
  rawTiers: string,
  storedTiers: string | null | undefined,
): TierProvider {
  const configured = modelProvider(model);
  if (configured === 'xai') return 'xai';
  if (configured === 'openrouter') return 'openrouter';
  return homogeneousTierProvider(rawTiers) ?? homogeneousTierProvider(storedTiers) ?? 'openrouter';
}

/**
 * Validate a --model-tiers JSON payload. OpenRouter-backed groups validate
 * against the cached OpenRouter catalog; native XAI groups use canonical
 * `xai/<model>` ids and must not consult that unrelated catalog. Codex groups
 * use an explicit ChatGPT-account allowlist because a syntactically plausible
 * native model id may still be rejected by Codex. Other provider-native groups
 * retain shape validation without catalog validation.
 */
function parseModelTiers(raw: string, { provider }: { provider?: TierProvider } = {}): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--model-tiers must be a JSON object (or "none" to clear)');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--model-tiers must be a JSON object (or "none" to clear)');
  }
  const t = parsed as Record<string, unknown>;
  for (const tier of ['high', 'medium', 'low'] as const) {
    if (typeof t[tier] !== 'string' || !(t[tier] as string).trim()) {
      throw new Error(`--model-tiers: "${tier}" must be a model id (e.g. "openrouter/minimax/minimax-m3")`);
    }
  }
  if (!['high', 'medium', 'low'].includes(t.default as string)) {
    throw new Error('--model-tiers: "default" must be one of: high, medium, low');
  }
  if (provider === 'xai') {
    for (const tier of ['high', 'medium', 'low'] as const) {
      const id = t[tier] as string;
      if (!/^xai\/\S+$/i.test(id)) {
        throw new Error(`--model-tiers: "${id}" must be a native xAI model id starting with "xai/".`);
      }
    }
    return t;
  }

  if (provider === 'codex') {
    for (const tier of ['high', 'medium', 'low'] as const) {
      const id = t[tier] as string;
      if (!isSupportedCodexModelId(id)) {
        throw new Error(`--model-tiers: "${id}" is not a supported Codex model id.`);
      }
    }
    return t;
  }

  // Validate OpenRouter ids against the cached catalog when available
  // (non-fatal if the catalog hasn't been fetched yet — don't block config on
  // a cold cache).
  const catalog = provider === 'openrouter' ? readModelCatalog() : null;
  if (catalog) {
    const known = new Set(catalog.models.map((m) => m.id));
    for (const tier of ['high', 'medium', 'low'] as const) {
      const id = t[tier] as string;
      if (!known.has(id)) {
        throw new Error(
          `--model-tiers: "${id}" is not in the OpenRouter catalog. Run \`ncl groups models\` to list valid ids.`,
        );
      }
    }
  }
  return t;
}

/** Validate a --hardening JSON payload. Throws with a usable message. */
function parseHardening(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--hardening must be a JSON object (or "none" to disable)');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('--hardening must be a JSON object (or "none" to disable)');
  }
  const h = parsed as Record<string, unknown>;
  const known = new Set(['egress', 'allowHosts', 'caps', 'scrub', 'hubAccess']);
  for (const key of Object.keys(h)) {
    if (!known.has(key))
      throw new Error(`--hardening: unknown key "${key}" (expected egress, allowHosts, caps, scrub, hubAccess)`);
  }
  if (h.allowHosts !== undefined) {
    if (!Array.isArray(h.allowHosts) || h.allowHosts.some((x) => typeof x !== 'string' || !x.trim())) {
      throw new Error('--hardening: allowHosts must be an array of non-empty host strings');
    }
  }
  if (h.egress && !(h.allowHosts as string[] | undefined)?.length) {
    throw new Error(
      '--hardening: egress=true requires a non-empty allowHosts (fail-closed — nothing would be reachable)',
    );
  }
  if (h.hubAccess !== undefined && !['read-write', 'read-only', 'none'].includes(h.hubAccess as string)) {
    throw new Error('--hardening: hubAccess must be one of: read-write, read-only, none');
  }
  return h;
}

async function rebuildImageForGroup(agentGroupId: string): Promise<void> {
  const config = getContainerConfig(agentGroupId);
  if (!config) throw new Error('Container config not found');

  const aptPackages = JSON.parse(config.packages_apt) as unknown[];
  const npmPackages = JSON.parse(config.packages_npm) as unknown[];
  if (aptPackages.length > 0 || npmPackages.length > 0) {
    await buildAgentGroupImage(agentGroupId);
    return;
  }

  await rebuildBaseImage(process.cwd(), CONTAINER_IMAGE, CONTAINER_RUNTIME_BIN);
}

registerResource({
  name: 'group',
  plural: 'groups',
  table: 'agent_groups',
  description:
    'Agent group — a logical agent identity. Each group has its own workspace folder (CLAUDE.md, skills, container config), conversation history, and container image. Multiple messaging groups can be wired to one agent group.',
  idColumn: 'id',
  scopeField: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Display name shown in logs, help output, and channel adapters. Does not need to be unique.',
      required: true,
      updatable: true,
    },
    {
      name: 'folder',
      type: 'string',
      description:
        'Directory name under groups/ on the host. Must be unique. Contains CLAUDE.md, skills/, and container.json. Cannot be changed after creation.',
      required: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `create` and `delete` are intentionally not in `operations` — create needs
  // a `--template` branch (below); the generic single-table DELETE violates FK
  // constraints (see #2525). Both are provided as `customOperations`.
  operations: { list: 'open', get: 'open', update: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Create an agent group. With --template <ref>, stamp from a local template under templates/ ' +
        '(MCP servers + instructions + skills); else insert a bare row (--name, --folder).',
      handler: async (args) => {
        if (args.template) {
          return createAgentFromTemplate(String(args.template), {
            name: args.name ? String(args.name) : undefined,
          });
        }
        const name = args.name ? String(args.name) : '';
        const folder = args.folder ? String(args.folder) : '';
        if (!name) throw new Error('--name is required');
        if (!folder) throw new Error('--folder is required');
        const group: AgentGroup = {
          id: randomUUID(),
          name,
          folder,
          agent_provider: null,
          created_at: new Date().toISOString(),
        };
        createAgentGroup(group);
        return group;
      },
    },
    'template attach': {
      access: 'approval',
      description:
        'Attach or restamp a local template on an existing group. Use --id <group-id> --template <ref>; add --dry-run for a conflict-aware diff. Existing private files, memory, sessions, config, mounts, schedules, and destinations are preserved.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const ref = args.template as string;
        if (!ref) throw new Error('--template is required');
        return attachAgentGroupFromTemplate(id, ref, { dryRun: Boolean(args.dry_run) });
      },
    },
    'template detach': {
      access: 'approval',
      description:
        'Detach the current template overlay from a group without deleting the group or its data. Add --dry-run to inspect the rollback diff; locally modified template-owned artifacts cause a conflict.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        return detachAgentGroupTemplate(id, { dryRun: Boolean(args.dry_run) });
      },
    },
    delete: {
      access: 'approval',
      description:
        'Delete an agent group and its dependent rows (sessions, destinations, approvals, role grants, ' +
        'memberships, channel wirings). FK-ordered cascade in a single transaction. ' +
        'Use --id <group-id>. Out of scope: killing running containers, on-disk cleanup of groups/<folder>/ and data/v2-sessions/<group-id>/.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        // Verify the group exists before doing anything — preserves the
        // genericDelete behaviour of throwing "not found" for unknown IDs.
        const exists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(id);
        if (!exists) throw new Error(`group not found: ${id}`);

        const hasAgentDestinations = hasTable(db, 'agent_destinations');
        const hasPendingApprovals = hasTable(db, 'pending_approvals');

        // FK-ordered cascade. Single sync transaction — better-sqlite3 rolls
        // back the whole thing if any statement throws (e.g. an FK constraint
        // we missed), so the central DB stays consistent. The `removed` counts
        // are sourced from each DELETE's `changes` so they describe exactly
        // what the transaction did, not a separate pre-flight snapshot.
        const cascade = db.transaction((groupId: string) => {
          const counts = {
            sessions: 0,
            pending_questions: 0,
            pending_approvals: 0,
            agent_destinations_owned: 0,
            agent_destinations_pointing: 0,
            pending_sender_approvals: 0,
            pending_channel_approvals: 0,
            messaging_group_agents: 0,
            agent_group_members: 0,
            user_roles: 0,
            container_configs: 0,
          };

          if (hasAgentDestinations) {
            counts.agent_destinations_owned = db
              .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?')
              .run(groupId).changes;
            counts.agent_destinations_pointing = db
              .prepare('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?')
              .run('agent', groupId).changes;
          }
          counts.pending_questions = db
            .prepare(
              'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
            )
            .run(groupId).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = db
              .prepare(
                'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
              )
              .run(groupId, groupId).changes;
          }
          counts.sessions = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(groupId).changes;
          counts.pending_sender_approvals = db
            .prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.pending_channel_approvals = db
            .prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.messaging_group_agents = db
            .prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.agent_group_members = db
            .prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?')
            .run(groupId).changes;
          counts.user_roles = db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(groupId).changes;
          // migration-014 has ON DELETE CASCADE on container_configs.agent_group_id;
          // the explicit delete here mirrors the other tables and surfaces the count.
          counts.container_configs = db
            .prepare('DELETE FROM container_configs WHERE agent_group_id = ?')
            .run(groupId).changes;
          db.prepare('DELETE FROM agent_groups WHERE id = ?').run(groupId);
          return counts;
        });
        const removed = cascade(id);

        return { deleted: id, removed };
      },
    },
    restart: {
      access: 'approval',
      description:
        'Restart containers for a group. Use --id <group-id> [--rebuild] [--fresh] [--message <text>]. ' +
        'From inside a container, --id is auto-filled and only the calling session is restarted. ' +
        '--rebuild rebuilds the per-group package image when packages are configured, or the shared default image otherwise. ' +
        '--fresh clears the persisted provider continuation after the old container exits, then starts a new context. ' +
        '--message sets an on-wake instruction for the fresh container to act on when it starts — ' +
        'use this when you need to continue after the restart (e.g. verify a new tool works, notify the user). ' +
        'Without --message, the container stops and only starts again on the next user message.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        if (args.rebuild) {
          await rebuildImageForGroup(id);
        }
        const message = args.message as string | undefined;
        // Keep the old `--message /clear` spelling working, but route it
        // through the host-side continuation reset rather than injecting a
        // control message that the runner would classify as self-addressed.
        const fresh = Boolean(args.fresh) || message?.trim().toLowerCase() === '/clear';

        // From an agent: scope to the calling session only
        if (ctx.caller === 'agent') {
          if (message && !fresh) {
            writeSessionMessage(id, ctx.sessionId, {
              id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              platformId: id,
              channelType: 'agent',
              threadId: null,
              content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
              onWake: 1,
            });
          }
          killContainer(
            ctx.sessionId,
            'restarted via ncl',
            fresh || message
              ? () => {
                  if (fresh) {
                    const db = openOutboundDbRw(id, ctx.sessionId);
                    try {
                      clearProviderContinuations(db);
                    } finally {
                      db.close();
                    }
                  }
                  const s = getSession(ctx.sessionId);
                  if (s) wakeContainer(s);
                }
              : undefined,
          );
          return { restarted: 1, rebuilt: !!args.rebuild };
        }

        // From the host: restart all running containers in the group
        const count = restartAgentGroupContainers(id, 'restarted via ncl', fresh ? undefined : message, fresh);
        return { restarted: count, rebuilt: !!args.rebuild };
      },
    },
    run: {
      access: 'approval',
      description:
        'Run an agent group or resume it from stopped/error state. Use --id <group-id>. Queued work is woken through the host lifecycle gate.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        return runOrResumeAgentGroup(id, ctx.caller === 'host' ? 'ops-center' : 'agent');
      },
    },
    resume: {
      access: 'approval',
      description:
        'Resume a paused or stopped agent group. Use --id <group-id>. Queued work is woken through the host lifecycle gate.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        return runOrResumeAgentGroup(id, ctx.caller === 'host' ? 'ops-center' : 'agent');
      },
    },
    stop: {
      access: 'approval',
      description:
        'Stop currently running containers for an agent group while allowing future user messages and scheduled work to wake it. Use --id <group-id>.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        return stopOrPauseAgentGroup(id, 'stopped', ctx.caller === 'host' ? 'ops-center' : 'agent');
      },
    },
    pause: {
      access: 'approval',
      description:
        'Persistently pause an agent group and stop its containers. Automatic, scheduled, and message wakes remain suppressed until resume. Use --id <group-id>.',
      handler: async (args, ctx) => {
        const id = (args.id as string) || (ctx.caller === 'agent' ? ctx.agentGroupId : undefined);
        if (!id) throw new Error('--id is required');
        return stopOrPauseAgentGroup(id, 'paused', ctx.caller === 'host' ? 'ops-center' : 'agent');
      },
    },
    'config get': {
      access: 'open',
      description: 'Show the container config for a group. Use --id <group-id>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        return presentConfig(row);
      },
    },
    models: {
      access: 'open',
      description:
        'List tool-capable OpenRouter models from the cached catalog, sorted by Intelligence Index (desc). ' +
        'Shows input/output cost per 1M tokens. Use these ids in --model-tiers. Optional --limit <n> (default 40).',
      handler: async (args) => {
        const catalog = readModelCatalog();
        if (!catalog) {
          throw new Error('Model catalog not cached yet — the host refreshes it on startup and every 12h.');
        }
        const limit = args.limit ? Number(args.limit) : 40;
        const sorted = [...catalog.models].sort((a, b) => (b.intelligenceIndex ?? -1) - (a.intelligenceIndex ?? -1));
        return {
          fetchedAt: new Date(catalog.fetchedAt).toISOString(),
          count: catalog.models.length,
          models: sorted.slice(0, limit).map((m) => ({
            id: m.id,
            name: m.name,
            intelligenceIndex: m.intelligenceIndex,
            inputCostPer1M: m.promptCost,
            outputCostPer1M: m.completionCost,
          })),
        };
      },
    },
    'config update': {
      access: 'approval',
      description:
        'Update container config scalar fields. Changes are saved but do NOT take effect until you run `ncl groups restart`. ' +
        'Use --id <group-id> and any of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, ' +
        '--hardening <json|none> (isolation hardening profile, e.g. \'{"egress":true,"allowHosts":["openrouter.ai"],"scrub":true,"hubAccess":"read-only"}\'; "none" disables), ' +
        '--model-tiers <json|none> (provider-native high/med/low models, e.g. OpenRouter `openrouter/...` or XAI `xai/...`; "none" clears).',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const updates: Partial<
          Pick<
            ContainerConfigRow,
            'provider' | 'model' | 'effort' | 'image_tag' | 'assistant_name' | 'max_messages_per_prompt' | 'cli_scope'
          >
        > = {};
        if (args.provider !== undefined) updates.provider = args.provider as string;
        const modelWasProvided = args.model !== undefined;
        if (modelWasProvided) {
          const rawModel = String(args.model);
          updates.model = rawModel === 'none' || rawModel === 'null' ? null : rawModel;
        }
        if (args.effort !== undefined) updates.effort = args.effort as string;
        if (args.image_tag !== undefined) updates.image_tag = args.image_tag as string;
        if (args.assistant_name !== undefined) updates.assistant_name = args.assistant_name as string;
        if (args.max_messages_per_prompt !== undefined)
          updates.max_messages_per_prompt = Number(args.max_messages_per_prompt);
        if (args['cli-scope'] !== undefined || args.cli_scope !== undefined) {
          const scope = (args['cli-scope'] ?? args.cli_scope) as string;
          if (!['disabled', 'group', 'global'].includes(scope)) {
            throw new Error('--cli-scope must be one of: disabled, group, global');
          }
          updates.cli_scope = scope;
        }

        let hardeningUpdate: { value: unknown } | undefined;
        if (args.hardening !== undefined) {
          const raw = args.hardening as string;
          if (raw === 'none' || raw === 'null') {
            hardeningUpdate = { value: null };
          } else {
            hardeningUpdate = { value: parseHardening(raw) };
          }
        }

        let tiersUpdate: { value: unknown } | undefined;
        const rawTiers = args['model-tiers'] ?? args.model_tiers;
        const effectiveProvider = updates.provider ?? row.provider ?? 'claude';
        const effectiveModel = modelWasProvided ? updates.model : row.model;
        if (
          effectiveProvider === 'codex' &&
          typeof effectiveModel === 'string' &&
          !isSupportedCodexModelId(effectiveModel)
        ) {
          throw new Error(`--model: "${effectiveModel}" is not a supported Codex model id.`);
        }
        if (rawTiers !== undefined) {
          const raw = rawTiers as string;
          const configuredModel = modelWasProvided ? updates.model : row.model;
          const tierProvider =
            effectiveProvider === 'opencode'
              ? inferOpenCodeTierProvider(configuredModel, raw, row.model_tiers)
              : effectiveProvider === 'codex'
                ? 'codex'
                : undefined;
          tiersUpdate =
            raw === 'none' || raw === 'null'
              ? { value: null }
              : { value: parseModelTiers(raw, { provider: tierProvider }) };
        }

        // Once tier routing is active, the scalar model is only a stale
        // fallback and must not survive a provider/model switch. An explicit
        // --model still wins so provider profiles can carry a canonical
        // default alongside their tier map.
        if (tiersUpdate && tiersUpdate.value !== null && !modelWasProvided) updates.model = null;

        if (Object.keys(updates).length === 0 && !hardeningUpdate && !tiersUpdate) {
          throw new Error(
            'Nothing to update — provide at least one of: --provider, --model, --effort, --image-tag, --assistant-name, --max-messages-per-prompt, --cli-scope, --hardening, --model-tiers',
          );
        }

        if (Object.keys(updates).length > 0) updateContainerConfigScalars(id, updates);
        if (hardeningUpdate) updateContainerConfigJson(id, 'hardening', hardeningUpdate.value);
        if (tiersUpdate) updateContainerConfigJson(id, 'model_tiers', tiersUpdate.value);

        const updated = getContainerConfig(id)!;
        return presentConfig(updated);
      },
    },
    'config add-mcp-server': {
      access: 'approval',
      description:
        'Add an MCP server to a group. Requires `ncl groups restart` to take effect. ' +
        'Use --id <group-id> --name <server-name> --command <cmd> [--args <json-array>] [--env <json-object>].',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const command = args.command as string;
        if (!command) throw new Error('--command is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        servers[name] = {
          command,
          args: args.args ? (JSON.parse(args.args as string) as string[]) : [],
          env: args.env ? (JSON.parse(args.env as string) as Record<string, string>) : {},
        };
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { added: name, servers };
      },
    },
    'config remove-mcp-server': {
      access: 'approval',
      description:
        'Remove an MCP server from a group. Requires `ncl groups restart` to take effect. Use --id <group-id> --name <server-name>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const servers = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
        if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
        delete servers[name];
        updateContainerConfigJson(id, 'mcp_servers', servers);

        return { removed: name };
      },
    },
    'config add-package': {
      access: 'approval',
      description:
        'Add a package to a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          if (!existing.includes(apt)) {
            existing.push(apt);
            updateContainerConfigJson(id, 'packages_apt', existing);
          }
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          if (!existing.includes(npm)) {
            existing.push(npm);
            updateContainerConfigJson(id, 'packages_npm', existing);
          }
        }

        return {
          added: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for packages to take effect. Use install_packages from the agent or rebuild manually.',
        };
      },
    },
    'config remove-package': {
      access: 'approval',
      description:
        'Remove a package from a group. Requires `ncl groups restart --rebuild` to take effect. Use --id <group-id> and --apt <pkg> or --npm <pkg>.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const apt = args.apt as string | undefined;
        const npm = args.npm as string | undefined;
        if (!apt && !npm) throw new Error('Provide --apt <pkg> or --npm <pkg>');

        if (apt) {
          const existing = JSON.parse(row.packages_apt) as string[];
          const filtered = existing.filter((p) => p !== apt);
          updateContainerConfigJson(id, 'packages_apt', filtered);
        }
        if (npm) {
          const existing = JSON.parse(row.packages_npm) as string[];
          const filtered = existing.filter((p) => p !== npm);
          updateContainerConfigJson(id, 'packages_npm', filtered);
        }

        return {
          removed: { apt: apt || null, npm: npm || null },
          note: 'Image rebuild required for package changes to take effect.',
        };
      },
    },
    'config set-skills': {
      access: 'approval',
      description:
        'Set which skills are enabled for a group. Requires `ncl groups restart` to take effect (skills re-materialize at container spawn). ' +
        'Use --id <group-id> --skills all (every shared skill, dynamic) OR --skills <json-array> (explicit, e.g. \'["trip-core","trip-finance"]\').',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);

        const raw = args.skills as string | undefined;
        if (raw === undefined) throw new Error('--skills is required: "all" or a JSON array of skill names');

        let value: string[] | 'all';
        if (raw === 'all') {
          value = 'all';
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new Error('--skills must be "all" or a JSON array, e.g. \'["trip-core"]\'');
          }
          if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
            throw new Error('--skills must be "all" or a JSON array of strings');
          }
          value = [...new Set(parsed as string[])];
        }

        updateContainerConfigJson(id, 'skills', value);
        return presentConfig(getContainerConfig(id)!);
      },
    },
  },
});
