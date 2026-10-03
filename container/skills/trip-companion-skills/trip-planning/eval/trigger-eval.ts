#!/usr/bin/env bun
// Gate 6 (design §21): does trip-planning's SKILL.md description fire on planning
// messages and stay silent on small-talk and on finance (which belongs to
// trip-finance)? ~20 should-fire + ~20 should-not, judged by the model.
// Pass bar: ≥90% correct overall, ZERO false fires on small-talk.
//
// Usage: bun eval/trigger-eval.ts [--model haiku] [--batch 5]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOULD_FIRE: string[] = [
  "let's plan a trip to Goa",
  'suggest 3 destinations for a relaxed long weekend, ~25k each',
  '@trip show the plan',
  'where are we on planning?',
  "what's still open to decide?",
  "what's day 3 look like?",
  'find us a boutique beach stay under 6000 a night',
  'add a sunset cruise to day 3',
  'plan the meals for day 2, we are ovo-veg',
  'how do we get from Goa to Gokarna?',
  'my flight is from Bangalore, Maya takes the train from Pune',
  'is the museum reachable before it closes at 5?',
  'are we over budget?',
  'propose dates and lock them by tonight unless someone objects',
  'what events are on that weekend worth catching?',
  'download the plan',
  'is that hotel walkable from the beach?',
  "let's vote on Goa vs Gokarna vs Pondicherry",
  'we want most-visited highlights, not off-beat',
  'mark the plan ready if everything is in',
];

const SHOULD_NOT_FIRE: string[] = [
  'I paid 4500 for lunch, split by families',
  'balance?',
  'I sent Raj 2000 just now',
  'who owes whom right now?',
  'split the dinner bill 3 ways',
  'record that I paid 250 for the cab',
  'the beach was amazing today 🏖️',
  'happy birthday Diya!! 🎂',
  "what's the wifi password at the hotel?",
  'lol that was hilarious 😂',
  'anyone seen my sunglasses?',
  'my phone is at 12%, dying — see you at the shack',
  'did you guys watch the match? 3-1!',
  'good morning all ☀️',
  "I'm running a bit late, start without me",
  'thanks everyone, that was fun!',
  'the room number is 304',
  'weather app says rain at 5pm',
  'can someone pass me the sunscreen',
  'happy to be here finally 🎉',
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const MODEL = arg('model', 'haiku');
const BATCH = Number(arg('batch', '5'));

function skillDescription(): string {
  const md = readFileSync(join(import.meta.dir, '..', 'SKILL.md'), 'utf8');
  const m = md.match(/^description:\s*([\s\S]*?)\n[a-z-]*:|^description:\s*([\s\S]*?)\n---/m);
  if (!m) throw new Error('could not parse description from SKILL.md frontmatter');
  return (m[1] ?? m[2]).trim();
}

interface Case {
  id: number;
  message: string;
  expected: boolean;
}

async function judgeBatch(desc: string, cases: Case[]): Promise<Map<number, boolean>> {
  const list = cases.map((c) => `${c.id}. ${c.message}`).join('\n');
  const prompt = `You are an agent runtime deciding whether to invoke a skill for incoming trip-group-chat messages.

Skill description:
"""${desc}"""

For each numbered message, decide whether THIS skill should be invoked. Judge each message independently, strictly by the description.

Messages:
${list}

Reply with ONLY a JSON array, no fences: [{"id": <n>, "trigger": true|false}, ...]`;

  const proc = Bun.spawn(['claude', '-p', prompt, '--model', MODEL, '--output-format', 'json', '--max-turns', '2'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 120_000);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timeout);
  const text: string = JSON.parse(out).result ?? '';
  const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? '[]') as { id: number; trigger: boolean }[];
  return new Map(arr.map((x) => [x.id, x.trigger]));
}

async function main(): Promise<void> {
  const desc = skillDescription();
  const cases: Case[] = [
    ...SHOULD_FIRE.map((m, i) => ({ id: i + 1, message: m, expected: true })),
    ...SHOULD_NOT_FIRE.map((m, i) => ({ id: 100 + i + 1, message: m, expected: false })),
  ];
  const shuffled = [...cases].sort((a, b) => ((a.id * 2654435761) % 97) - ((b.id * 2654435761) % 97));
  const batches: Case[][] = [];
  for (let i = 0; i < shuffled.length; i += BATCH) batches.push(shuffled.slice(i, i + BATCH));
  console.log(`judging ${cases.length} messages in ${batches.length} batches with model "${MODEL}"\n`);

  const verdicts = new Map<number, boolean>();
  const results = await Promise.all(batches.map((b) => judgeBatch(desc, b)));
  for (const m of results) for (const [id, v] of m) verdicts.set(id, v);

  let correct = 0;
  const falseFires: Case[] = [];
  const misses: Case[] = [];
  for (const c of cases) {
    const got = verdicts.get(c.id);
    if (got === c.expected) correct++;
    else if (c.expected) misses.push(c);
    else falseFires.push(c);
  }

  console.log('── Gate 6 report (trip-planning) ──');
  console.log(`correct: ${correct}/${cases.length} (${((100 * correct) / cases.length).toFixed(1)}%, bar ≥90%)`);
  console.log(`false fires on should-not (incl. finance & small-talk): ${falseFires.length} (bar: ZERO on small-talk)`);
  for (const c of falseFires) console.log(`  ✗ fired on: "${c.message}"`);
  for (const c of misses) console.log(`  ✗ missed:   "${c.message}"`);

  writeFileSync(
    join(import.meta.dir, 'trigger-report.json'),
    JSON.stringify({ model: MODEL, ranAt: new Date().toISOString(), correct, total: cases.length, falseFires, misses }, null, 2),
  );

  const pass = correct / cases.length >= 0.9 && falseFires.length === 0;
  console.log(pass ? '\nGATE 6: PASS' : '\nGATE 6: FAIL');
  process.exit(pass ? 0 : 1);
}

main();
