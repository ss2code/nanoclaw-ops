/**
 * Reusable, reversible direct-delegation templates.
 *
 * A template is deliberately declarative: it names a source app/group, the
 * specialist apps/groups it may contact, and the operating policy that goes
 * with those edges. Applying it creates only the exact bidirectional
 * `agent_destinations` rows needed for the template. Revocation removes only
 * rows this template created, so existing Jeeves/manual routes survive.
 */
import fs from 'fs';
import path from 'path';

import { getApp } from '../../db/apps.js';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { normalizeName } from './db/agent-destinations.js';
import { projectDestinationsToGroups } from './destination-projection.js';

export interface AgentReference {
  app_handle?: string;
  agent_group_id?: string;
}

export interface DirectDelegationTarget extends AgentReference {
  source_local_name?: string;
  target_local_name?: string;
}

export interface DelegationPolicyTemplate {
  id: string;
  version: number;
  description: string;
  mode: 'direct';
  source: AgentReference;
  targets: DirectDelegationTarget[];
  /** Human-readable operating policy, retained for audit and Ops Center. */
  policy: Record<string, unknown>;
  /** Message/task shape expected on the route, retained for audit. */
  structure: Record<string, unknown>;
  /** Runtime/ACL switches for this template. */
  configuration: {
    bidirectional: true;
    allow_files?: boolean;
    require_explicit_address?: boolean;
    [key: string]: unknown;
  };
}

interface ResolvedReference {
  agentGroupId: string;
  handle: string;
}

interface PolicyEdge {
  fromGroupId: string;
  fromLocalName: string;
  toGroupId: string;
  toLocalName: string;
}

export interface AppliedDelegationPolicy {
  policyId: string;
  status: 'active';
  created: boolean;
  edges: PolicyEdge[];
}

export interface RevokedDelegationPolicy {
  policyId: string;
  status: 'revoked';
  removedEdges: number;
}

export interface DelegationPolicySummary {
  policy_id: string;
  template_name: string;
  template_version: number;
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
}

export interface DelegationPolicyDetail extends DelegationPolicySummary {
  template: DelegationPolicyTemplate;
  edges: PolicyEdge[];
}

const TEMPLATE_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertReference(ref: unknown, label: string): asserts ref is AgentReference {
  if (!isRecord(ref)) throw new Error(`${label} must be an object`);
  const keys = ['app_handle', 'agent_group_id'].filter((key) => typeof ref[key] === 'string' && ref[key].trim());
  if (keys.length !== 1) throw new Error(`${label} must contain exactly one of app_handle or agent_group_id`);
}

export function validateDelegationTemplate(input: unknown): DelegationPolicyTemplate {
  if (!isRecord(input)) throw new Error('delegation template must be a JSON object');
  const id = input.id;
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) {
    throw new Error('template id must be lowercase kebab-case');
  }
  if (!Number.isInteger(input.version) || Number(input.version) < 1) {
    throw new Error('template version must be a positive integer');
  }
  if (typeof input.description !== 'string' || !input.description.trim()) {
    throw new Error('template description is required');
  }
  if (input.mode !== 'direct') throw new Error('only mode "direct" is supported by this template module');
  assertReference(input.source, 'source');
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error('template targets must contain at least one target');
  }
  if (!isRecord(input.policy)) throw new Error('template policy is required');
  if (!isRecord(input.structure)) throw new Error('template structure is required');
  if (!isRecord(input.configuration) || input.configuration.bidirectional !== true) {
    throw new Error('template configuration.bidirectional must be true');
  }
  if (input.structure.max_hops !== undefined && input.structure.max_hops !== 1) {
    throw new Error('direct delegation templates must use structure.max_hops = 1');
  }

  const sourceNames = new Set<string>();
  const targets = input.targets as unknown[];
  for (const [index, target] of targets.entries()) {
    assertReference(target, `targets[${index}]`);
    const targetObject = target as Record<string, unknown>;
    const sourceLocalName =
      typeof targetObject.source_local_name === 'string' ? targetObject.source_local_name.trim() : '';
    if (sourceLocalName) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(sourceLocalName)) {
        throw new Error(`targets[${index}].source_local_name must be a simple destination name`);
      }
      if (sourceNames.has(sourceLocalName.toLowerCase())) {
        throw new Error(`duplicate source destination name "${sourceLocalName}"`);
      }
      sourceNames.add(sourceLocalName.toLowerCase());
    }
    if (targetObject.target_local_name !== undefined) {
      if (
        typeof targetObject.target_local_name !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]*$/.test(targetObject.target_local_name.trim())
      ) {
        throw new Error(`targets[${index}].target_local_name must be a simple destination name`);
      }
    }
  }

  return input as unknown as DelegationPolicyTemplate;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJson(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJson(value)) ?? '';
}

function resolveReference(ref: AgentReference, label: string): ResolvedReference {
  if (ref.app_handle) {
    const app = getApp(ref.app_handle.trim());
    if (!app || app.status !== 'active') throw new Error(`${label} app not found or inactive: ${ref.app_handle}`);
    if (app.kind !== 'agent' || !app.agent_group_id)
      throw new Error(`${label} must reference an agent app: ${ref.app_handle}`);
    return { agentGroupId: app.agent_group_id, handle: app.handle };
  }
  const group = ref.agent_group_id ? getAgentGroup(ref.agent_group_id.trim()) : undefined;
  if (!group) throw new Error(`${label} agent group not found: ${ref.agent_group_id}`);
  return { agentGroupId: group.id, handle: normalizeName(group.name) };
}

function resolveEdges(template: DelegationPolicyTemplate): PolicyEdge[] {
  const source = resolveReference(template.source, 'source');
  const edges: PolicyEdge[] = [];
  const seen = new Set<string>();
  const localSlots = new Map<string, string>();
  for (const [index, targetInput] of template.targets.entries()) {
    const target = resolveReference(targetInput, `targets[${index}]`);
    if (source.agentGroupId === target.agentGroupId)
      throw new Error(`targets[${index}] cannot point back to the source`);
    const sourceLocalName = targetInput.source_local_name?.trim() || target.handle;
    const targetLocalName = targetInput.target_local_name?.trim() || source.handle;
    const forwardKey = `${source.agentGroupId}\0${sourceLocalName}\0${target.agentGroupId}`;
    const reverseKey = `${target.agentGroupId}\0${targetLocalName}\0${source.agentGroupId}`;
    if (seen.has(forwardKey) || seen.has(reverseKey)) throw new Error(`duplicate route in targets[${index}]`);
    seen.add(forwardKey);
    seen.add(reverseKey);
    const candidateEdges: PolicyEdge[] = [
      {
        fromGroupId: source.agentGroupId,
        fromLocalName: sourceLocalName,
        toGroupId: target.agentGroupId,
        toLocalName: targetLocalName,
      },
      {
        fromGroupId: target.agentGroupId,
        fromLocalName: targetLocalName,
        toGroupId: source.agentGroupId,
        toLocalName: sourceLocalName,
      },
    ];
    for (const edge of candidateEdges) {
      const slot = `${edge.fromGroupId}\0${edge.fromLocalName}`;
      if (localSlots.has(slot)) throw new Error(`duplicate local destination name "${edge.fromLocalName}"`);
      localSlots.set(slot, edge.toGroupId);
    }
    edges.push(...candidateEdges);
  }
  return edges;
}

function rowToSummary(row: Record<string, unknown>): DelegationPolicySummary {
  return {
    policy_id: String(row.policy_id),
    template_name: String(row.template_name),
    template_version: Number(row.template_version),
    status: row.status as 'active' | 'revoked',
    created_at: String(row.created_at),
    revoked_at: row.revoked_at ? String(row.revoked_at) : null,
  };
}

export function loadDelegationTemplate(
  nameOrPath: string,
  templatesDir = path.join(process.cwd(), 'config', 'agent-delegation-templates'),
): DelegationPolicyTemplate {
  const base = path.resolve(templatesDir);
  const requested = nameOrPath.endsWith('.json') ? nameOrPath : `${nameOrPath}.json`;
  const file = path.resolve(base, requested);
  const relative = path.relative(base, file);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('template path must stay inside the template directory');
  let realBase: string;
  let realFile: string;
  try {
    realBase = fs.realpathSync(base);
    realFile = fs.realpathSync(file);
  } catch (err) {
    throw new Error(
      `could not read delegation template ${requested}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const realRelative = path.relative(realBase, realFile);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative))
    throw new Error('template symlink must stay inside the template directory');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(realFile, 'utf8'));
  } catch (err) {
    throw new Error(
      `could not read delegation template ${requested}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateDelegationTemplate(parsed);
}

export async function applyDelegationTemplate(input: unknown): Promise<AppliedDelegationPolicy> {
  const template = validateDelegationTemplate(input);
  const edges = resolveEdges(template);
  const db = getDb();
  const templateJson = canonicalJson(template);
  const existing = db.prepare('SELECT * FROM agent_delegation_policies WHERE policy_id = ?').get(template.id) as
    | Record<string, unknown>
    | undefined;
  if (existing?.status === 'active') {
    if (existing.template_json !== templateJson)
      throw new Error(`policy ${template.id} is already active with a different template`);
    return { policyId: template.id, status: 'active', created: false, edges };
  }

  const affectedGroups = new Set<string>();
  const apply = db.transaction(() => {
    const destinationRows = db.prepare(
      `SELECT target_type, target_id FROM agent_destinations
       WHERE agent_group_id = ? AND local_name = ?`,
    );
    const insertDestination = db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'agent', ?, ?)`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO agent_delegation_policy_edges
       (policy_id, from_group_id, from_local_name, to_group_id, to_local_name, destination_created)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    if (existing) db.prepare('DELETE FROM agent_delegation_policy_edges WHERE policy_id = ?').run(template.id);
    const ownership: Array<{ edge: PolicyEdge; created: boolean }> = [];
    for (const edge of edges) {
      const row = destinationRows.get(edge.fromGroupId, edge.fromLocalName) as
        | { target_type: string; target_id: string }
        | undefined;
      if (row && (row.target_type !== 'agent' || row.target_id !== edge.toGroupId)) {
        throw new Error(
          `destination "${edge.fromLocalName}" already exists for ${edge.fromGroupId} and points elsewhere`,
        );
      }
      ownership.push({ edge, created: !row });
      affectedGroups.add(edge.fromGroupId);
      affectedGroups.add(edge.toGroupId);
    }

    const now = new Date().toISOString();
    if (existing) {
      db.prepare(
        `UPDATE agent_delegation_policies
         SET template_name = ?, template_version = ?, template_json = ?, status = 'active', revoked_at = NULL
         WHERE policy_id = ?`,
      ).run(template.id, template.version, templateJson, template.id);
    } else {
      db.prepare(
        `INSERT INTO agent_delegation_policies
         (policy_id, template_name, template_version, template_json, status, created_at, revoked_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      ).run(template.id, template.id, template.version, templateJson, now);
    }
    for (const { edge, created } of ownership) {
      if (created) insertDestination.run(edge.fromGroupId, edge.fromLocalName, edge.toGroupId, now);
      insertEdge.run(
        template.id,
        edge.fromGroupId,
        edge.fromLocalName,
        edge.toGroupId,
        edge.toLocalName,
        created ? 1 : 0,
      );
    }
  });
  apply();
  await projectDestinationsToGroups(affectedGroups);
  return { policyId: template.id, status: 'active', created: !existing, edges };
}

export async function revokeDelegationPolicy(policyId: string): Promise<RevokedDelegationPolicy> {
  const db = getDb();
  const policy = db.prepare('SELECT * FROM agent_delegation_policies WHERE policy_id = ?').get(policyId) as
    | Record<string, unknown>
    | undefined;
  if (!policy) throw new Error(`delegation policy not found: ${policyId}`);
  if (policy.status === 'revoked') return { policyId, status: 'revoked', removedEdges: 0 };

  const edges = db
    .prepare(
      `SELECT from_group_id, from_local_name, to_group_id, to_local_name, destination_created
     FROM agent_delegation_policy_edges WHERE policy_id = ?`,
    )
    .all(policyId) as Array<{
    from_group_id: string;
    from_local_name: string;
    to_group_id: string;
    to_local_name: string;
    destination_created: number;
  }>;
  const affectedGroups = new Set<string>();
  let removedEdges = 0;
  const revoke = db.transaction(() => {
    const otherOwner = db.prepare(
      `SELECT 1 FROM agent_delegation_policy_edges e
       JOIN agent_delegation_policies p ON p.policy_id = e.policy_id
       WHERE p.status = 'active' AND e.policy_id != ?
         AND e.from_group_id = ? AND e.from_local_name = ? AND e.to_group_id = ?
       LIMIT 1`,
    );
    const removeDestination = db.prepare(
      `DELETE FROM agent_destinations
       WHERE agent_group_id = ? AND local_name = ? AND target_type = 'agent' AND target_id = ?`,
    );
    for (const edge of edges) {
      affectedGroups.add(edge.from_group_id);
      affectedGroups.add(edge.to_group_id);
      if (!edge.destination_created) continue;
      const fromGroupId = edge.from_group_id;
      const fromLocalName = edge.from_local_name;
      const toGroupId = edge.to_group_id;
      if (otherOwner.get(policyId, fromGroupId, fromLocalName, toGroupId)) continue;
      removedEdges += Number(removeDestination.run(fromGroupId, fromLocalName, toGroupId).changes > 0);
    }
    db.prepare("UPDATE agent_delegation_policies SET status = 'revoked', revoked_at = ? WHERE policy_id = ?").run(
      new Date().toISOString(),
      policyId,
    );
  });
  revoke();
  await projectDestinationsToGroups(affectedGroups);
  return { policyId, status: 'revoked', removedEdges };
}

export function listDelegationPolicies(): DelegationPolicySummary[] {
  return getDb()
    .prepare(
      'SELECT policy_id, template_name, template_version, status, created_at, revoked_at FROM agent_delegation_policies ORDER BY created_at DESC',
    )
    .all()
    .map((row) => rowToSummary(row as Record<string, unknown>));
}

export function getDelegationPolicy(policyId: string): DelegationPolicyDetail | undefined {
  const row = getDb().prepare('SELECT * FROM agent_delegation_policies WHERE policy_id = ?').get(policyId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const edges = getDb()
    .prepare(
      `SELECT from_group_id AS fromGroupId, from_local_name AS fromLocalName,
            to_group_id AS toGroupId, to_local_name AS toLocalName
     FROM agent_delegation_policy_edges WHERE policy_id = ? ORDER BY from_group_id, from_local_name`,
    )
    .all(policyId) as PolicyEdge[];
  return { ...rowToSummary(row), template: JSON.parse(String(row.template_json)) as DelegationPolicyTemplate, edges };
}
