import {
  applyDelegationTemplate,
  getDelegationPolicy,
  listDelegationPolicies,
  loadDelegationTemplate,
  revokeDelegationPolicy,
} from '../../modules/agent-to-agent/delegation-policies.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'delegation policy',
  plural: 'delegation-policies',
  table: 'agent_delegation_policies',
  description:
    'Reusable direct agent-delegation policy. Applying a template creates only its exact bidirectional ACL edges; revoking removes only edges created by that template.',
  idColumn: 'policy_id',
  columns: [
    { name: 'policy_id', type: 'string', description: 'Stable template/policy id.' },
    {
      name: 'template_name',
      type: 'string',
      description: 'Template name loaded from config/agent-delegation-templates.',
    },
    { name: 'template_version', type: 'number', description: 'Template version applied.' },
    { name: 'status', type: 'string', description: 'active or revoked.', enum: ['active', 'revoked'] },
    { name: 'created_at', type: 'string', description: 'When the policy was first applied.' },
    { name: 'revoked_at', type: 'string', description: 'When the policy was revoked, if applicable.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List applied delegation policies.',
      handler: async () => listDelegationPolicies(),
    },
    get: {
      access: 'open',
      description: 'Show a policy, its template, and the exact directed edges it manages. Use positional policy id.',
      handler: async (args) => {
        const policyId = (args.id || args.policy_id) as string | undefined;
        if (!policyId) throw new Error('policy id is required');
        const policy = getDelegationPolicy(policyId);
        if (!policy) throw new Error(`delegation policy not found: ${policyId}`);
        return policy;
      },
    },
    apply: {
      access: 'approval',
      description:
        'Apply a template from config/agent-delegation-templates. Use --template <name-or-json-file>. Applying the same active template is idempotent.',
      handler: async (args) => {
        const templateName = args.template as string | undefined;
        if (!templateName) throw new Error('--template is required');
        return applyDelegationTemplate(loadDelegationTemplate(templateName));
      },
    },
    revoke: {
      access: 'approval',
      description: 'Revoke an applied template by policy id. Existing unrelated/manual destinations are preserved.',
      handler: async (args) => {
        const policyId = (args.id || args.policy_id) as string | undefined;
        if (!policyId) throw new Error('policy id is required');
        return revokeDelegationPolicy(policyId);
      },
    },
  },
});
