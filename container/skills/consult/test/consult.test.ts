import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  captureProcessed,
  decorateConsultResponse,
  handleRuntime,
  readIndex,
  resolveRoot,
  type ConsultIdentity,
  type RuntimeInput,
  type RuntimeResult,
} from '../scripts/consult.mjs';

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'fleet.json'), 'utf8'),
) as {
  source: ConsultIdentity;
  destinations: RuntimeInput['context']['destinations'];
  identities: Record<string, ConsultIdentity>;
  answers: Record<string, string>;
};

let stateDir: string;
const T0 = '2026-08-23T10:00:00.000Z';

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-consult-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function input(
  text: string,
  overrides: Partial<RuntimeInput> = {},
  content: Record<string, unknown> = { text },
): RuntimeInput {
  return {
    stateDir,
    now: T0,
    message: {
      id: `m-${Math.random().toString(36).slice(2)}`,
      kind: 'chat',
      text,
      content,
      channelType: 'whatsapp',
      platformId: 'family-chat',
      threadId: null,
    },
    context: {
      ...fixture.source,
      destinations: fixture.destinations,
    },
    ...overrides,
  };
}

function expectHandled(result: RuntimeResult): RuntimeResult & { action: 'handled' } {
  expect(result.action).toBe('handled');
  return result as RuntimeResult & { action: 'handled' };
}

function refreshRoster(): void {
  const refresh = expectHandled(handleRuntime(input('/consult roster --refresh')));
  expect(refresh.outgoing).toHaveLength(2);
  for (const probe of refresh.outgoing) {
    const targetName = probe.destinationName!;
    const targetIdentity = fixture.identities[targetName];
    const target = expectHandled(
      handleRuntime(
        input(
          probe.content.text,
          {
            stateDir: fs.mkdtempSync(path.join(os.tmpdir(), `nanoclaw-consult-${targetName}-`)),
            context: { ...targetIdentity, destinations: [] },
            message: {
              id: `probe-${targetName}`,
              kind: 'chat',
              text: probe.content.text,
              content: probe.content,
              channelType: 'agent',
              platformId: fixture.source.agentGroupId,
              threadId: null,
            },
          },
          probe.content,
        ),
      ),
    );
    expect(target.outgoing).toHaveLength(1);
    const reply = target.outgoing[0];
    expectHandled(
      handleRuntime(
        input(reply.content.text, {
          message: {
            id: `roster-${targetName}`,
            kind: 'chat',
            text: reply.content.text,
            content: reply.content,
            channelType: 'agent',
            platformId: targetIdentity.agentGroupId,
            threadId: null,
          },
        }, reply.content),
      ),
    );
  }
}

function completeSingleTargetTurn(request: RuntimeResult['outgoing'][number], answer: string): RuntimeResult {
  const targetName = request.destinationName!;
  const targetIdentity = fixture.identities[targetName];
  const responseContent = decorateConsultResponse({
    requestContent: request.content,
    responseContent: { text: answer },
    identity: targetIdentity,
    now: T0,
  });
  const response = handleRuntime(
    input(
      answer,
      {
        message: {
          id: `response-${Math.random().toString(36).slice(2)}`,
          kind: 'chat',
          text: answer,
          content: responseContent,
          channelType: 'agent',
          platformId: targetIdentity.agentGroupId,
          threadId: null,
        },
      },
      responseContent,
    ),
  );
  expect(response.action).toBe('rewrite');
  captureProcessed({
    stateDir,
    capture: response.capture!,
    text: `Processed context for ${request.content.consult?.questionNodeId}.`,
    identity: fixture.source,
    now: T0,
  });
  return response;
}

describe('strictly local ownership', () => {
  it('keeps roots, profile, roster, and counters isolated by state directory', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-consult-other-'));
    try {
      handleRuntime(input('/consult profile set defaultProtocol deep'));
      handleRuntime(input('/consult roster --refresh'));
      const otherResult = handleRuntime(input('/consult profile show', { stateDir: other }));

      expect(readIndex(stateDir).profile.defaultProtocol).toBe('deep');
      expect(readIndex(stateDir).roster.refreshId).toBeTruthy();
      expect(readIndex(other).profile.defaultProtocol).toBe('quick');
      expect(readIndex(other).roster.refreshId).toBeNull();
      expect(otherResult.responses[0].text).toContain('defaultProtocol: quick');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('roster discovery and default-model discipline', () => {
  it('refreshes through runtime-only probes, caches for 24 hours, and refreshes on demand', () => {
    const first = expectHandled(handleRuntime(input('/consult quick --tag switch-atlas Should Atlas change models?')));
    expect(first.outgoing.every((out) => out.content.consult?.kind === 'roster-probe')).toBe(true);

    refreshRoster();
    const cached = expectHandled(
      handleRuntime(input('/consult quick --tag cached-question Is this cache still fresh?', { now: '2026-08-24T09:59:59.000Z' })),
    );
    expect(cached.outgoing.some((out) => out.content.consult?.kind === 'roster-probe')).toBe(false);

    const forced = expectHandled(
      handleRuntime(input('/consult roster --refresh', { now: '2026-08-24T09:59:59.000Z' })),
    );
    expect(forced.outgoing).toHaveLength(2);
  });

  it('deduplicates by effective model and never switches a target model unless the slash command explicitly asks', () => {
    refreshRoster();
    const result = expectHandled(
      handleRuntime(input('/consult quick --tag atlas-switch Should Atlas move back to Sonnet?')),
    );

    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0].destinationName).toBe('errand-runner');
    expect(result.outgoing[0].content.consult?.modelMode).toBe('default');
    expect(result.outgoing[0].content.text).toContain('Use this container\'s configured default model exactly as-is');
    expect(result.outgoing[0].content.text).not.toMatch(/^\/model\s/);
  });

  it('honors a per-target tier only when declared inside /consult', () => {
    refreshRoster();
    const result = expectHandled(
      handleRuntime(
        input('/consult quick --to errand-runner --tier errand-runner=low Should Atlas move back to Sonnet?'),
      ),
    );
    expect(result.outgoing[0].content.text).toMatch(/^\/model low\s/);
    expect(result.outgoing[0].content.consult?.requestedTier).toBe('low');

    const duplicateDefaultButDistinctOverride = expectHandled(
      handleRuntime(input('/consult quick --to atlas --tier atlas=high Should the high-tier Atlas review this?')),
    );
    expect(duplicateDefaultButDistinctOverride.outgoing).toHaveLength(1);
    expect(duplicateDefaultButDistinctOverride.outgoing[0].destinationName).toBe('atlas');
    expect(duplicateDefaultButDistinctOverride.outgoing[0].content.text).toMatch(/^\/model high\s/);
  });
});

describe('fixture-only answer lifecycle', () => {
  it('captures the exact remote answer before local synthesis and stores the processed answer separately', () => {
    refreshRoster();
    const started = expectHandled(
      handleRuntime(input('/consult quick --tag migration-plan How should I change Atlas safely?')),
    );
    const request = started.outgoing[0];

    const targetRewrite = handleRuntime(
      input(request.content.text, {
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-consult-target-')),
        context: { ...fixture.identities['errand-runner'], destinations: [] },
        message: {
          id: 'target-request',
          kind: 'chat',
          text: request.content.text,
          content: request.content,
          channelType: 'agent',
          platformId: fixture.source.agentGroupId,
          threadId: null,
        },
      }, request.content),
    );
    expect(targetRewrite.action).toBe('rewrite');

    const raw = fixture.answers['errand-runner'];
    const responseContent = decorateConsultResponse({
      requestContent: targetRewrite.rewrittenContent!,
      responseContent: { text: raw },
      identity: fixture.identities['errand-runner'],
      now: T0,
    });
    const sourceResult = handleRuntime(
      input(raw, {
        message: {
          id: 'source-response',
          kind: 'chat',
          text: raw,
          content: responseContent,
          channelType: 'agent',
          platformId: 'errand-runner',
          threadId: null,
        },
      }, responseContent),
    );
    expect(sourceResult.action).toBe('rewrite');
    expect(sourceResult.rewrittenText).toContain('Distilled synthesis');
    expect(sourceResult.rewriteRouting).toEqual({
      platformId: 'family-chat',
      channelType: 'whatsapp',
      threadId: null,
    });

    const processed = 'Recommendation: switch Atlas in one reversible step, then verify and retain rollback.';
    captureProcessed({
      stateDir,
      capture: sourceResult.capture!,
      text: processed,
      identity: fixture.source,
      now: T0,
    });

    const root = resolveRoot(stateDir, 'migration-plan');
    const answerNode = root.graph.nodes.find((node) => node.type === 'answer')!;
    const synthesisNode = root.graph.nodes.find((node) => node.type === 'synthesis')!;
    expect(fs.readFileSync(path.join(root.dir, answerNode.contentPath!), 'utf8')).toBe(raw);
    expect(fs.readFileSync(path.join(root.dir, synthesisNode.contentPath!), 'utf8')).toBe(processed);
    expect(answerNode.responseReceipt?.configuredModel).toBe('deepseek/deepseek-v4-flash');
  });
});

describe('protocols, lenses, anchoring, and graph views', () => {
  it('accepts every start protocol with fixture-only planning', () => {
    refreshRoster();
    for (const protocol of ['quick', 'deep', 'verify', 'decide', 'explore', 'debate', 'redteam', 'forecast']) {
      const result = handleRuntime(input(`/consult ${protocol} --tag ${protocol}-root Evaluate option ${protocol}`));
      expect(result.action).toBe('handled');
      expect(result.responses[0].text).toContain(protocol);
    }
  });

  it('accepts every processing lens and creates typed derived nodes', () => {
    refreshRoster();
    const start = expectHandled(handleRuntime(input('/consult quick --tag lenses Compare the options')));
    const rootId = start.rootId!;
    for (const lens of ['distill', 'critique', 'counsel', 'steelman', 'extend', 'contrast', 'referee']) {
      const result = handleRuntime(input(`/consult lens ${rootId} ${lens}`));
      expect(result.action).toBe('rewrite');
      expect(result.rewrittenText).toContain(`Lens: ${lens}`);
      captureProcessed({ stateDir, capture: result.capture!, text: `${lens} fixture result`, identity: fixture.source, now: T0 });
    }
    const root = resolveRoot(stateDir, rootId);
    expect(root.graph.nodes.filter((node) => node.type !== 'question').map((node) => node.lens)).toEqual(
      expect.arrayContaining(['distill', 'critique', 'counsel', 'steelman', 'extend', 'contrast', 'referee']),
    );
  });

  it('accepts every lens as a top-level new-consultation shortcut using the default protocol', () => {
    refreshRoster();
    expectHandled(handleRuntime(input('/consult profile set defaultProtocol deep')));
    for (const lens of ['distill', 'critique', 'counsel', 'steelman', 'extend', 'contrast', 'referee']) {
      const result = expectHandled(
        handleRuntime(input(`/consult ${lens} --tag ${lens}-shortcut Evaluate option ${lens}`)),
      );
      expect(resolveRoot(stateDir, result.rootId).root).toMatchObject({ protocol: 'deep', defaultLens: lens });

      const root = resolveRoot(stateDir, result.rootId!);
      expect(root.root.protocol).toBe('deep');
      expect(root.root.defaultLens).toBe(lens);
    }
  });

  it('normalizes a mobile Unicode dash before a start option', () => {
    refreshRoster();
    const result = expectHandled(
      handleRuntime(input('/consult distill —tag sh-pain Could sleeping on a hard bed cause this pain?')),
    );

    const root = resolveRoot(stateDir, result.rootId!);
    const question = root.graph.nodes.find((node) => node.type === 'question')!;
    expect(root.root.tag).toBe('sh-pain');
    expect(fs.readFileSync(path.join(root.dir, question.contentPath!), 'utf8')).toBe(
      'Could sleeping on a hard bed cause this pain?',
    );
  });

  it('uses the active root when /consult lens is given only a lens name', () => {
    refreshRoster();
    const start = expectHandled(handleRuntime(input('/consult quick --tag active-lens Compare the options')));
    const result = handleRuntime(input('/consult lens steelman'));

    expect(result.action).toBe('rewrite');
    expect(result.rootId).toBe(start.rootId);
    expect(result.rewrittenText).toContain('Lens: steelman');
  });

  it('makes an explicitly continued root active for subsequent shorthand commands', () => {
    refreshRoster();
    const first = expectHandled(handleRuntime(input('/consult quick --tag first-context First question')));
    expectHandled(handleRuntime(input('/consult quick --tag second-context Second question')));

    expectHandled(handleRuntime(input(`/consult continue ${first.rootId} Return to the first topic`)));
    expect(readIndex(stateDir).activeRootId).toBe(first.rootId);
  });

  it('treats a tag as a root reference when selecting sources for a lens', () => {
    refreshRoster();
    expectHandled(handleRuntime(input('/consult quick --tag tag-sources Compare tagged options')));
    const result = handleRuntime(input('/consult lens tag-sources critique'));

    expect(result.action).toBe('rewrite');
    expect(result.rewrittenText).toContain('Compare tagged options');
    expect(result.rewrittenText).toContain('C001:Q0');
  });

  it('applies a continuation lens to that question instead of reusing the root lens', () => {
    refreshRoster();
    expectHandled(handleRuntime(input('/consult quick --tag follow-up-lens Compare the options')));
    const continued = expectHandled(
      handleRuntime(input('/consult continue follow-up-lens --lens counsel What should we do next?')),
    );
    const request = continued.outgoing[0];
    const responseContent = decorateConsultResponse({
      requestContent: request.content,
      responseContent: { text: 'Fixture follow-up advice.' },
      identity: fixture.identities['errand-runner'],
      now: T0,
    });
    const processed = handleRuntime(
      input('Fixture follow-up advice.', {
        message: {
          id: 'follow-up-lens-response',
          kind: 'chat',
          text: 'Fixture follow-up advice.',
          content: responseContent,
          channelType: 'agent',
          platformId: 'errand-runner',
          threadId: null,
        },
      }, responseContent),
    );

    expect(processed.action).toBe('rewrite');
    expect(processed.rewrittenText).toContain('Lens: counsel');
  });

  it('injects graph-backed prior turns and the protocol/lens preamble into old continuations', () => {
    refreshRoster();
    const started = expectHandled(
      handleRuntime(
        input(
          '/consult quick --tag sh-pain I have left upper-arm muscular pain after sleeping on a hard bed as a side sleeper. What could explain it?',
        ),
      ),
    );
    completeSingleTargetTurn(started.outgoing[0], 'The hard bed and side sleeping could irritate the shoulder muscles.');

    // Reproduce a pre-snapshot root: its exact text files exist, but the old
    // graph only has paths and edges. The next continuation must both use the
    // files as a compatibility fallback and upgrade graph.json atomically.
    const legacyBundle = resolveRoot(stateDir, 'sh-pain');
    const legacyGraph = JSON.parse(fs.readFileSync(path.join(legacyBundle.dir, 'graph.json'), 'utf8')) as {
      nodes: Record<string, unknown>[];
      root?: unknown;
    };
    for (const node of legacyGraph.nodes) delete node.content;
    delete legacyGraph.root;
    fs.writeFileSync(path.join(legacyBundle.dir, 'graph.json'), JSON.stringify(legacyGraph), 'utf8');

    const oilTurn = expectHandled(
      handleRuntime(
        input('/consult continue sh-pain --protocol explore --lens extend Does Ksheerabala oil and massage help?'),
      ),
    );
    expect(oilTurn.outgoing[0].content.text).toContain('left upper-arm muscular pain');
    expect(oilTurn.outgoing[0].content.text).toContain('Protocol: explore — Find implications, alternatives, and missing ideas.');
    expect(oilTurn.outgoing[0].content.text).toContain('Post-response lens: extend — Extended analysis');
    expect(oilTurn.outgoing[0].content.text).toContain('The requesting agent applies the lens after collecting independent replies.');
    const oilProcessed = completeSingleTargetTurn(oilTurn.outgoing[0], 'Gentle warm-oil massage may help comfort, but it is not a diagnosis or cure.');
    expect(oilProcessed.rewrittenText).toContain('Protocol: explore — Find implications, alternatives, and missing ideas.');
    expect(oilProcessed.rewrittenText).toContain('Lens: extend');

    const exerciseTurn = expectHandled(
      handleRuntime(
        input('/consult continue sh-pain Give me simple exercises that could help recovery.'),
      ),
    );
    const prompt = exerciseTurn.outgoing[0].content.text;
    expect(prompt).toContain('left upper-arm muscular pain');
    expect(prompt).toContain('Does Ksheerabala oil and massage help?');
    expect(prompt).toContain('Processed context for C001:Q1.');
    expect(prompt).toContain('Question:\nGive me simple exercises that could help recovery.');
    expect(exerciseTurn.outgoing[0].content.consult?.contextNodeIds).toEqual(
      expect.arrayContaining(['C001:Q0', 'C001:S1', 'C001:Q1', 'C001:R1']),
    );
    const snapshot = JSON.parse(fs.readFileSync(path.join(resolveRoot(stateDir, 'sh-pain').dir, 'graph.json'), 'utf8')) as {
      root: { id: string; tag: string };
      nodes: { id: string; content: string | null; contextNodeIds?: string[] }[];
    };
    expect(snapshot.root).toEqual(expect.objectContaining({ id: 'C001', tag: 'sh-pain' }));
    expect(snapshot.nodes.every((node) => Object.prototype.hasOwnProperty.call(node, 'content'))).toBe(true);
    expect(snapshot.nodes.find((node) => node.id === 'C001:Q0')?.content).toContain('left upper-arm muscular pain');
    expect(snapshot.nodes.find((node) => node.id === 'C001:Q1')?.content).toContain('Ksheerabala oil');
    expect(snapshot.nodes.find((node) => node.id === 'C001:R1')?.content).toBe('Processed context for C001:Q1.');
    expect(snapshot.nodes.find((node) => node.id === 'C001:Q2')?.contextNodeIds).toEqual(
      expect.arrayContaining(['C001:Q0', 'C001:S1', 'C001:Q1', 'C001:R1']),
    );
  });

  it('rejects start-only --tag on continuation instead of silently ignoring it', () => {
    refreshRoster();
    expectHandled(handleRuntime(input('/consult quick --tag stable-tag Compare the options')));
    const result = expectHandled(
      handleRuntime(input('/consult continue stable-tag --tag replacement Follow up question')),
    );

    expect(result.responses[0].text).toContain('--tag is only valid when starting a new consultation');
    expect(resolveRoot(stateDir, 'stable-tag').root.tag).toBe('stable-tag');
  });

  it('continues from a root or any node and renders compact, graph, full, source, and raw views', () => {
    refreshRoster();
    const start = expectHandled(handleRuntime(input('/consult quick --tag graph-demo Root question')));
    const rootId = start.rootId!;
    const root = resolveRoot(stateDir, rootId);
    const q0 = root.graph.nodes.find((node) => node.type === 'question')!.id;

    const fromRoot = handleRuntime(input(`/consult continue ${rootId} Follow up from root`));
    const fromNode = handleRuntime(input('/consult continue graph-demo:Q0 Follow up from Q0'));
    const branch = handleRuntime(input(`/consult branch ${q0} Alternative branch`));
    expect([fromRoot.action, fromNode.action, branch.action]).toEqual(['handled', 'handled', 'handled']);

    for (const view of ['compact', 'graph', 'full', 'sources']) {
      const shown = expectHandled(handleRuntime(input(`/consult show ${rootId} --view ${view}`)));
      expect(shown.responses[0].text).toContain(rootId);
    }
    const raw = expectHandled(handleRuntime(input(`/consult raw ${q0}`)));
    expect(raw.responses[0].text).toContain('Root question');
    const rawByTag = expectHandled(handleRuntime(input('/consult raw graph-demo:Q0')));
    expect(rawByTag.responses[0].text).toContain('Root question');
  });
});

describe('bounded lifecycle', () => {
  it('keeps only three recent open roots and supports close, delete, restore, and automatic pruning', () => {
    refreshRoster();
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      ids.push(expectHandled(handleRuntime(input(`/consult quick --tag root-${i} Question ${i}`))).rootId!);
    }
    expect(readIndex(stateDir).recentOpen).toHaveLength(3);
    expect(resolveRoot(stateDir, ids[0]).root.status).toBe('closed');

    expectHandled(handleRuntime(input(`/consult close ${ids[1]}`)));
    expect(resolveRoot(stateDir, ids[1]).root.status).toBe('closed');
    expectHandled(handleRuntime(input(`/consult delete ${ids[1]}`)));
    expect(readIndex(stateDir).trash.map((entry) => entry.rootId)).toContain(ids[1]);
    expectHandled(handleRuntime(input(`/consult restore ${ids[1]}`)));
    expect(resolveRoot(stateDir, ids[1]).root.status).toBe('closed');

    handleRuntime(input('/consult profile set closedLimit 1'));
    handleRuntime(input('/consult profile set trashLimit 1'));
    handleRuntime(input(`/consult close ${ids[2]}`));
    handleRuntime(input(`/consult close ${ids[3]}`));
    const index = readIndex(stateDir);
    expect(index.closed).toHaveLength(1);
    expect(index.trash.length).toBeLessThanOrEqual(1);
  });
});

describe('invocation boundary and help', () => {
  it('starts and continues without a tag, keeping the completed topic context', () => {
    refreshRoster();
    const start = expectHandled(handleRuntime(input('/consult ask Which vendor should we choose?')));
    completeSingleTargetTurn(start.outgoing[0], 'Choose the simpler vendor.');
    const more = expectHandled(handleRuntime(input('/consult more What if the team grows?')));
    expect(more.rootId).toBe(start.rootId);
    expect(more.outgoing[0].content.text).toContain('Which vendor should we choose?');
    expect(more.outgoing[0].content.text).toContain('What if the team grows?');
    expect(more.responses[0].text).toContain('Continuing');
    expect(resolveRoot(stateDir, start.rootId).root.title).toBe('Which vendor should we choose?');
  });

  it('keeps numbered topic choices stable and clears selection when done', () => {
    refreshRoster();
    const first = expectHandled(handleRuntime(input('/consult ask First topic')));
    handleRuntime(input('/consult topics'));
    handleRuntime(input('/consult ask Second topic'));
    expect(expectHandled(handleRuntime(input('/consult use 1'))).rootId).toBe(first.rootId);
    handleRuntime(input('/consult done'));
    const more = expectHandled(handleRuntime(input('/consult more Do not guess another topic')));
    expect(more.outgoing).toHaveLength(0);
    expect(more.responses[0].text).toContain('No selected topic');
    expect(readIndex(stateDir).activeRootId).toBeNull();
  });

  it('isolates shorthand topic selection between participants in a group chat', () => {
    refreshRoster();
    const from = (sender: string, text: string) => input(text, {}, { text, sender, isGroup: true });
    const alice = expectHandled(handleRuntime(from('alice', '/consult ask Alice topic')));
    const bob = expectHandled(handleRuntime(from('bob', '/consult ask Bob topic')));
    expect(expectHandled(handleRuntime(from('alice', '/consult more Alice follow-up'))).rootId).toBe(alice.rootId);
    expect(expectHandled(handleRuntime(from('bob', '/consult sources'))).rootId).toBe(bob.rootId);
    expect(expectHandled(handleRuntime(from('charlie', '/consult more No topic yet'))).outgoing).toHaveLength(0);
    handleRuntime(from('alice', '/consult done'));
    expect(expectHandled(handleRuntime(from('bob', '/consult more Still Bob'))).rootId).toBe(bob.rootId);
  });

  it('gives one short getting-started message and rejects incomplete shortcuts', () => {
    const help = expectHandled(handleRuntime(input('/consult help')));
    expect(help.responses).toHaveLength(1);
    expect(help.responses[0].text.length).toBeLessThan(1800);
    for (const command of ['ask', 'more', 'topics', 'sources', 'done']) expect(help.responses[0].text).toContain('/consult ' + command);
    for (const command of ['/consult more', '/consult use 1', '/consult done unexpected']) {
      expect(expectHandled(handleRuntime(input(command))).outgoing).toHaveLength(0);
    }
  });

  it('passes natural language and non-consult commands untouched', () => {
    expect(handleRuntime(input('Please consult Atlas about this')).action).toBe('pass');
    expect(handleRuntime(input('/status')).action).toBe('pass');
  });

  it('provides detailed topic help and examples without an LLM turn', () => {
    for (const topic of ['start', 'references', 'protocols', 'lenses', 'models', 'continue', 'inspect', 'lifecycle', 'examples']) {
      const result = expectHandled(handleRuntime(input(`/consult help ${topic}`)));
      expect(result.responses.map((part) => part.text).join('\n')).toContain('/consult');
    }
  });

  it('explains tags, active roots, and the three distinct lens forms in help all', () => {
    const text = expectHandled(handleRuntime(input('/consult help all'))).responses
      .map((part) => part.text)
      .join('\n');

    expect(text).toContain('--tag is used only when starting');
    expect(text).toContain('REF = ROOT, TAG, or NODE');
    expect(text).toContain('uses the active root');
    expect(text).toContain('--lens LENS');
    expect(text).toContain('/consult LENS [--tag TAG]');
    expect(text).toContain('/consult lens [REF] LENS');
    expect(text).toContain('/consult distill --tag health-question');
    expect(text).toContain('Unicode mobile dash');
    expect(text).toContain('does not contact external agents');
    expect(text).toContain('/consult ask [--tag TAG]');
    expect(text).toContain('/consult raw NODE');
    expect(text).toContain('Starting, explicitly continuing, /consult use, and reopening select the topic');
    expect(text).toContain('Even when a topic is active, continue and branch require REF');
  });
});
