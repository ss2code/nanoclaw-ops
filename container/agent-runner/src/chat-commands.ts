/**
 * Fleet-wide chat command palette.
 *
 * This module is deliberately provider-neutral and self-contained. It turns
 * short user-facing commands into one of four outcomes:
 *   - respond locally (help/status/listing; no model turn),
 *   - rewrite into an explicit agent request,
 *   - delegate through an existing ACL-backed agent destination, or
 *   - pass through to the provider's native command handling.
 *
 * Enabled skills are discovered from the current container's skills directory,
 * so help never advertises a skill that the group did not select.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DestinationEntry } from './destinations.js';
import type { ModelTier, ModelTiers } from './providers/types.js';

export interface EnabledSkill {
  name: string;
  description: string;
  userInvocable: boolean;
}

export interface ChatCommandContext {
  assistantName?: string;
  providerName: string;
  configuredModel?: string;
  modelTiers?: ModelTiers;
  enabledSkills: EnabledSkill[];
  destinations: DestinationEntry[];
  hasContinuation: boolean;
}

export type ChatCommandResult =
  | { action: 'pass' }
  | { action: 'rewrite'; text: string }
  | { action: 'respond'; text: string }
  | { action: 'delegate'; destination: DestinationEntry; text: string; acknowledgement: string };

const MODEL_ALIASES: Record<string, ModelTier | 'default'> = {
  hi: 'high',
  high: 'high',
  mid: 'medium',
  med: 'medium',
  medium: 'medium',
  lo: 'low',
  low: 'low',
  default: 'default',
  auto: 'default',
};

const TASK_VERBS: Record<string, string> = {
  sync: 'task_sync',
  list: 'task_list',
  add: 'task_add',
  move: 'task_move',
  done: 'task_done',
  remove: 'task_remove',
};

function cleanFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSkillFile(name: string, file: string): EnabledSkill {
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { name, description: 'Enabled skill.', userInvocable: false };
  }
  const header = content.startsWith('---') ? content.split('---', 3)[1] ?? '' : '';
  const declaredName = header.match(/^name:\s*(.+)$/m)?.[1];
  const description = header.match(/^description:\s*(.+)$/m)?.[1];
  return {
    name: declaredName ? cleanFrontmatterValue(declaredName) : name,
    description: description ? cleanFrontmatterValue(description) : 'Enabled skill.',
    userInvocable: true,
  };
}

/** Discover only the skill roots actually mounted for this container. */
export function discoverEnabledSkills(
  skillsDir = process.env.NANOCLAW_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills'),
): EnabledSkill[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }

  const skills: EnabledSkill[] = [];
  for (const entry of entries.sort()) {
    const root = path.join(skillsDir, entry);
    const skillFile = path.join(root, 'SKILL.md');
    const instructionsFile = path.join(root, 'instructions.md');
    if (fs.existsSync(skillFile)) {
      skills.push(parseSkillFile(entry, skillFile));
    } else if (fs.existsSync(instructionsFile)) {
      // Instruction-only roots are enabled capabilities but are not exposed as
      // direct /<skill> invocations. They can still unlock aliases such as
      // /recall and /remember for the memory capability.
      skills.push({ name: entry, description: 'Enabled container capability.', userInvocable: false });
    }
  }
  return skills;
}

export function extractChatText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return content;
  }
}

export function replaceChatText(content: string, text: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, text });
    }
  } catch {
    // Plain text stays plain text.
  }
  return text;
}

function agentDestinations(ctx: ChatCommandContext): DestinationEntry[] {
  return ctx.destinations.filter((d) => d.type === 'agent');
}

function displayModelTiers(ctx: ChatCommandContext): string[] {
  const tiers =
    ctx.modelTiers ??
    (ctx.providerName === 'claude'
      ? ({ high: 'opus', medium: 'sonnet', low: 'haiku', default: 'medium' } satisfies ModelTiers)
      : undefined);
  if (!tiers) return ['Model tiers: not configured for this provider.'];
  return [
    `Model tiers: high=${tiers.high} · medium=${tiers.medium} · low=${tiers.low}`,
    `Default tier: ${tiers.default} (${tiers[tiers.default]})`,
  ];
}

function skillMap(ctx: ChatCommandContext): Map<string, EnabledSkill> {
  return new Map(ctx.enabledSkills.map((skill) => [skill.name.toLowerCase(), skill]));
}

function invocableSkills(ctx: ChatCommandContext): EnabledSkill[] {
  return ctx.enabledSkills.filter((skill) => skill.userInvocable);
}

function formatSkills(ctx: ChatCommandContext): string {
  const skills = invocableSkills(ctx);
  if (skills.length === 0) {
    return [
      'No user-invocable skills are enabled in this container.',
      '',
      'Run forms when skills are enabled:',
      '  /<skill-name> [arguments]',
      '  /skill <skill-name> [arguments]',
      '  /run <skill-name> [arguments]',
    ].join('\n');
  }
  return [
    `Enabled skills (${skills.length}):`,
    ...skills.map((skill) => `  /${skill.name} — ${skill.description}`),
    '',
    'Run any enabled skill in one of three ways:',
    '  /<skill-name> [arguments]',
    '  /skill <skill-name> [arguments]',
    '  /run <skill-name> [arguments]',
    '',
    'Examples:',
    '  /memory-review --since 48h',
    '  /skill memory-audit health',
    '  /run daily-update',
  ].join('\n');
}

function formatAgents(ctx: ChatCommandContext): string {
  const agents = agentDestinations(ctx);
  if (agents.length === 0) return 'No agent destinations are configured for this container.';
  return [
    `Addressable agents (${agents.length}):`,
    ...agents.map((agent) => {
      const label = agent.displayName && agent.displayName !== agent.name ? ` — ${agent.displayName}` : '';
      return `  @${agent.name}${label}`;
    }),
    '',
    'Usage: @agent-name [/model hi|mid|low] [/<skill>] <task>',
  ].join('\n');
}

function formatTasksHelp(): string {
  return [
    'Tasks commands:',
    '  /tasks list [@handle|all]',
    '  /tasks add <title> [| notes] [| due <date>] [| @handle]',
    '  /tasks move <title> | <backlog|inprog|waiting|done>',
    '  /tasks done <title>',
    '  /tasks remove <title>   (confirmation required)',
    '  /tasks sync',
    '',
    'The current group follows its configured task policy: the owner agent acts directly; client agents send the canonical /task_* request to their `jeeves` destination and relay the result.',
  ].join('\n');
}

function formatStatus(ctx: ChatCommandContext): string {
  const skills = invocableSkills(ctx);
  const agents = agentDestinations(ctx);
  return [
    `Agent: ${ctx.assistantName || 'unnamed'}`,
    `Provider: ${ctx.providerName}`,
    `Configured model: ${ctx.configuredModel || 'provider default'}`,
    ...displayModelTiers(ctx),
    `Session continuation: ${ctx.hasContinuation ? 'active' : 'fresh'}`,
    `Enabled user-invocable skills: ${skills.length}${skills.length ? ` (${skills.map((s) => s.name).join(', ')})` : ''}`,
    `Addressable agents: ${agents.length}${agents.length ? ` (${agents.map((d) => `@${d.name}`).join(', ')})` : ''}`,
  ].join('\n');
}

function formatHelp(ctx: ChatCommandContext, topic = ''): string {
  const normalized = topic.trim().toLowerCase();
  if (normalized === 'skills' || normalized === 'skill' || normalized === 'run') return formatSkills(ctx);
  if (normalized === 'tasks' || normalized === 'task') return formatTasksHelp();
  if (normalized === 'model') {
    return [
      'Model command:',
      '  /model hi|mid|low <task>      choose a deterministic tier for one turn',
      '  /model default <task>         use the group default for one turn',
      '  /model show                   display tier mappings',
      '',
      ...displayModelTiers(ctx),
    ].join('\n');
  }
  if (normalized === 'agents' || normalized === 'agent') return formatAgents(ctx);
  const requestedSkill = skillMap(ctx).get(normalized.replace(/^\//, ''));
  if (requestedSkill?.userInvocable) {
    return [
      `/${requestedSkill.name} — ${requestedSkill.description}`,
      '',
      `Run: /${requestedSkill.name} [arguments]`,
      `Or:  /skill ${requestedSkill.name} [arguments]`,
      `Or:  /run ${requestedSkill.name} [arguments]`,
    ].join('\n');
  }

  const lines = [
    'NanoClaw command palette',
    '',
    'Discovery:',
    '  /cmd-help [model|skills|tasks|agents|<skill-name>]',
    '  /skills        enabled skills and all invocation forms',
    '  /agents        addressable agent destinations',
    '  /status        provider, model tiers, skills, destinations',
    '',
    'Execution:',
    '  /model hi|mid|low|default <task>',
    '  @agent-name [/model tier] [/<skill>] <task>',
    '',
    'Consultations:',
    '  /consult help                 compare distinct container models',
    '  /consult ask <question>       get a second opinion',
    '  /consult more <question>      follow up on your selected topic',
    '  /consult topics               list topics; /consult done to finish',
    '',
  ];
  if (skillMap(ctx).has('memory')) {
    lines.push('Memory:', '  /recall <query>', '  /remember <durable fact>', '');
  }
  lines.push('Tasks:', '  /tasks [list|add|move|done|remove|sync]', '');
  const skills = invocableSkills(ctx);
  if (skills.length > 0) {
    lines.push(
      `Enabled skills (${skills.length}):`,
      ...skills.map((skill) => `  /${skill.name} [arguments]`),
      '',
      'Skill alternatives: /skill <name> … or /run <name> …',
    );
  } else {
    lines.push('Enabled skills: none user-invocable in this container.');
  }
  return lines.join('\n');
}

function skillRequest(skill: EnabledSkill, args: string): string {
  const detail = args.trim() || 'Run the skill using its default workflow.';
  return [
    `Invoke the enabled \`${skill.name}\` skill for this request.`,
    `User arguments: ${detail}`,
    'Follow that skill faithfully and report its result to the requesting destination.',
  ].join('\n');
}

function memoryRequest(verb: 'recall' | 'remember', args: string): string {
  if (verb === 'recall') {
    return [
      'Use the enabled memory capability for an explicit recall.',
      `Recall query: ${args.trim()}`,
      'Return the relevant persisted memories with enough identifiers or provenance to distinguish them.',
    ].join('\n');
  }
  return [
    'Use the enabled memory capability for an explicit remember request.',
    `Durable fact: ${args.trim()}`,
    'Respect the configured owner and approval policy, avoid storing tasks or transient status, and return the persistence receipt.',
  ].join('\n');
}

function tasksRequest(args: string): ChatCommandResult {
  const [verbRaw = '', ...rest] = args.trim().split(/\s+/);
  const verb = verbRaw.toLowerCase();
  if (!verb || verb === 'help' || verb === 'options') return { action: 'respond', text: formatTasksHelp() };
  const canonical = TASK_VERBS[verb];
  if (!canonical) {
    return { action: 'respond', text: `Unknown /tasks option "${verb}".\n\n${formatTasksHelp()}` };
  }
  const command = `/${canonical}${rest.length ? ` ${rest.join(' ')}` : ''}`;
  return {
    action: 'rewrite',
    text: [
      'Handle this fleet task command according to the current group\'s Tasks policy.',
      'If this agent manages the central task board, act directly. Otherwise send the canonical command to the `jeeves` agent destination and relay its response.',
      `Canonical command: ${command}`,
    ].join('\n'),
  };
}

function withTier(result: ChatCommandResult, tier: ModelTier | 'default' | null): ChatCommandResult {
  if (!tier || tier === 'default') return result;
  if (result.action === 'rewrite') return { ...result, text: `${result.text}\n\n[tier:${tier}]` };
  if (result.action === 'pass') return result;
  return result;
}

/** True when a leading @token names an ACL-backed agent destination. */
export function hasAgentAddress(text: string, destinations: DestinationEntry[]): boolean {
  const match = text.trim().match(/^@([a-z0-9][a-z0-9._-]*)(?:\s|$)/i);
  if (!match) return false;
  return destinations.some((d) => d.type === 'agent' && d.name.toLowerCase() === match[1].toLowerCase());
}

export function handleChatCommand(rawText: string, ctx: ChatCommandContext): ChatCommandResult {
  let text = rawText.trim();
  if (!text) return { action: 'pass' };

  // Addressing is intentionally resolved before local commands. The target
  // container receives the untouched remainder and evaluates /model and skill
  // availability against its own provider/config/skill selection.
  const address = text.match(/^@([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]+))?$/i);
  if (address) {
    const name = address[1];
    const destination = agentDestinations(ctx).find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (!destination) {
      // Unknown @tokens may be native platform mentions. Only exact names in
      // this container's agent destination ACL belong to NanoClaw routing.
      return { action: 'pass' };
    }
    const delegatedText = (address[2] ?? '').trim();
    if (!delegatedText) {
      return { action: 'respond', text: `Add a task after @${destination.name}. Example: @${destination.name} /model hi investigate this` };
    }
    return {
      action: 'delegate',
      destination,
      text: delegatedText,
      acknowledgement: `Delegated to @${destination.name}. Its result will return to this conversation.`,
    };
  }

  let tier: ModelTier | 'default' | null = null;
  const model = text.match(/^\/model(?:\s+([^\s]+))?(?:\s+([\s\S]+))?$/i);
  if (model) {
    // Tolerate trailing punctuation on the tier token ("/model low." or
    // "/model hi, …") — users naturally end the selector with . , : ; before
    // the task text, and rejecting it silently costs the whole turn.
    const choice = (model[1] ?? '').toLowerCase().replace(/[^a-z]+$/, '');
    if (!choice || choice === 'show') return { action: 'respond', text: displayModelTiers(ctx).join('\n') };
    tier = MODEL_ALIASES[choice] ?? null;
    if (!tier) {
      return { action: 'respond', text: `Unknown model tier "${choice}". Use hi, mid, low, default, or /model show.` };
    }
    if (tier !== 'default' && ctx.providerName !== 'claude' && !ctx.modelTiers) {
      return { action: 'respond', text: `Model tiers are not configured for provider ${ctx.providerName}. Use /model show.` };
    }
    text = (model[2] ?? '').trim();
    if (!text) {
      return { action: 'respond', text: `Add a task after the tier. Example: /model ${choice} explain this failure` };
    }
  }

  const command = text.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]+))?$/i);
  if (!command) {
    return tier ? { action: 'rewrite', text: tier === 'default' ? text : `${text}\n\n[tier:${tier}]` } : { action: 'pass' };
  }

  const name = command[1].toLowerCase();
  const args = (command[2] ?? '').trim();
  if (name === 'cmd-help') return { action: 'respond', text: formatHelp(ctx, args) };
  if (name === 'skills') return { action: 'respond', text: formatSkills(ctx) };
  if (name === 'agents') return { action: 'respond', text: formatAgents(ctx) };
  if (name === 'status') return { action: 'respond', text: formatStatus(ctx) };
  if (name === 'tasks') return withTier(tasksRequest(args), tier);

  if (name === 'recall' || name === 'remember') {
    if (!skillMap(ctx).has('memory')) {
      return { action: 'respond', text: `/${name} is unavailable because the memory capability is not enabled in this container.` };
    }
    if (!args) return { action: 'respond', text: `Usage: /${name} <${name === 'recall' ? 'query' : 'durable fact'}>` };
    return withTier({ action: 'rewrite', text: memoryRequest(name, args) }, tier);
  }

  if (name === 'skill' || name === 'run') {
    const [requested = '', ...rest] = args.split(/\s+/);
    if (!requested) return { action: 'respond', text: formatSkills(ctx) };
    const skill = skillMap(ctx).get(requested.toLowerCase());
    if (!skill?.userInvocable) {
      return { action: 'respond', text: `Skill "${requested}" is not enabled for user invocation in this container.\n\n${formatSkills(ctx)}` };
    }
    if (skill.name.toLowerCase() === 'consult') {
      return { action: 'respond', text: 'Use /consult ask <question> directly. Follow up with /consult more <question>. See /consult help.' };
    }
    return withTier({ action: 'rewrite', text: skillRequest(skill, rest.join(' ')) }, tier);
  }

  const skill = skillMap(ctx).get(name);
  if (skill?.userInvocable) return withTier({ action: 'rewrite', text: skillRequest(skill, args) }, tier);

  // Preserve native provider commands (/compact, /context, /cost, /files,
  // plugin commands, etc.). NanoClaw's host-side command gate remains the
  // authority for filtered/admin commands.
  return { action: 'pass' };
}
