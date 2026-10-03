import {
  createApp,
  getApp,
  listApps,
  projectAppDestinations,
  resolveSupervisorAgentGroupId,
  retireApp,
  unprojectAppDestinations,
  updateApp,
} from '../../db/apps.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'app',
  plural: 'apps',
  table: 'apps',
  description:
    'App catalog entry — stable @handle and semantic routing metadata for Jeeves-style supervision. App writes also project the derived agent-to-agent destinations when kind=agent.',
  idColumn: 'handle',
  columns: [
    {
      name: 'handle',
      type: 'string',
      description:
        'Stable @address without the @ prefix. Kebab-case, globally unique, immutable. Reserved: jeeves, ops.',
      required: true,
    },
    { name: 'name', type: 'string', description: 'Human display name.', required: true, updatable: true },
    { name: 'kind', type: 'string', description: 'agent or service.', enum: ['agent', 'service'], required: true },
    { name: 'type', type: 'string', description: 'App family, e.g. trip-companion, toolkit, infra.', required: true },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'Agent group this handle addresses when kind=agent. Null for service entries.',
    },
    { name: 'purpose', type: 'string', description: 'Routing blurb: when Jeeves should use this app.', required: true },
    {
      name: 'read_source',
      type: 'string',
      description: 'Read path Jeeves should use before delegating.',
      enum: ['ops-center:/trips', 'ops-center', 'a2a', 'none'],
      default: 'a2a',
    },
    {
      name: 'visibility',
      type: 'string',
      description: 'private or shared. Shared apps should prefer summarized disclosure by default.',
      enum: ['private', 'shared'],
      default: 'private',
    },
    { name: 'status', type: 'string', description: 'active or retired.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'updated_at', type: 'string', description: 'Auto-set.' },
    { name: 'retired_at', type: 'string', description: 'Set on retire.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List app catalog entries. Optional filters: --kind, --type, --visibility, --status.',
      handler: async (args) =>
        listApps({
          kind: args.kind as never,
          type: args.type as never,
          visibility: args.visibility as never,
          status: args.status as never,
        }),
    },
    get: {
      access: 'open',
      description: 'Resolve an app by handle. Use `ncl apps get goa-trip` or `ncl apps get --handle @goa-trip`.',
      handler: async (args) => {
        const handle = (args.id || args.handle) as string | undefined;
        if (!handle) throw new Error('handle is required');
        const app = getApp(handle);
        if (!app) throw new Error(`app not found: ${handle}`);
        return app;
      },
    },
    create: {
      access: 'approval',
      description:
        'Create an app catalog entry. For kind=agent, also wires Jeeves -> app using the handle and app -> Jeeves using `jeeves`. Optional: --supervisor-agent-group-id.',
      handler: async (args) => {
        const app = createApp({
          handle: args.handle as string,
          name: args.name as string,
          kind: args.kind as 'agent' | 'service',
          type: args.type as string,
          agent_group_id: (args.agent_group_id as string | undefined) ?? null,
          purpose: args.purpose as string,
          read_source: args.read_source as never,
          visibility: args.visibility as never,
        });
        const supervisorAgentGroupId =
          app.kind === 'agent'
            ? resolveSupervisorAgentGroupId(args.supervisor_agent_group_id as string | undefined)
            : null;
        try {
          if (supervisorAgentGroupId) await projectAppDestinations(app, supervisorAgentGroupId);
        } catch (error) {
          retireApp(app.handle);
          throw error;
        }
        return { app, projected: app.kind === 'agent', supervisor_agent_group_id: supervisorAgentGroupId };
      },
    },
    update: {
      access: 'approval',
      description:
        'Update app metadata. Use positional handle or --handle; allowed fields: --name, --type, --agent-group-id, --purpose, --read-source, --visibility.',
      handler: async (args) => {
        const handle = (args.id || args.handle) as string | undefined;
        if (!handle) throw new Error('handle is required');
        const existing = getApp(handle);
        if (!existing) throw new Error(`app not found: ${handle}`);
        const supervisorAgentGroupId =
          existing.kind === 'agent'
            ? resolveSupervisorAgentGroupId(args.supervisor_agent_group_id as string | undefined)
            : null;
        const { before, after } = updateApp(handle, {
          name: args.name as string | undefined,
          type: args.type as string | undefined,
          agent_group_id: args.agent_group_id as string | undefined,
          purpose: args.purpose as string | undefined,
          read_source: args.read_source as never,
          visibility: args.visibility as never,
        });
        if (supervisorAgentGroupId) {
          await unprojectAppDestinations(before, supervisorAgentGroupId);
          try {
            await projectAppDestinations(after, supervisorAgentGroupId);
          } catch (error) {
            updateApp(after.handle, {
              name: before.name,
              type: before.type,
              agent_group_id: before.agent_group_id,
              purpose: before.purpose,
              read_source: before.read_source,
              visibility: before.visibility,
            });
            await projectAppDestinations(before, supervisorAgentGroupId);
            throw error;
          }
        }
        return { before, after, projected: after.kind === 'agent', supervisor_agent_group_id: supervisorAgentGroupId };
      },
    },
    retire: {
      access: 'approval',
      description:
        'Soft-retire an app handle and remove its derived a2a destinations. Use positional handle or --handle.',
      handler: async (args) => {
        const handle = (args.id || args.handle) as string | undefined;
        if (!handle) throw new Error('handle is required');
        const before = getApp(handle);
        if (!before) throw new Error(`app not found: ${handle}`);
        const supervisorAgentGroupId =
          before.kind === 'agent'
            ? resolveSupervisorAgentGroupId(args.supervisor_agent_group_id as string | undefined)
            : null;
        if (supervisorAgentGroupId) await unprojectAppDestinations(before, supervisorAgentGroupId);
        const app = retireApp(handle);
        return { retired: app, supervisor_agent_group_id: supervisorAgentGroupId };
      },
    },
  },
});
