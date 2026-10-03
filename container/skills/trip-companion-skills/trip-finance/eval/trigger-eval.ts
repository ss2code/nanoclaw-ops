#!/usr/bin/env bun
// Trigger eval (design §10 Gate 3): does the SKILL.md description fire on the
// right messages? ~20 should-fire + ~20 should-not, judged by the model that
// will run the trip. Pass bar: ≥90% correct overall, ZERO false fires on
// small-talk. Run after any SKILL.md description edit.
//
// Usage: bun trigger-eval.ts [--model sonnet] [--batch 5]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOULD_FIRE: string[] = [
  'I paid 4500 for lunch, split by families',
  '@trip hotel was 12000, Raj paid',
  'balance?',
  'settle up please',
  'I sent Raj 2000 just now',
  "fix #14 — Raj wasn't in it",
  "delete expense 9, it's a duplicate",
  '<sent a Paytm payment-success screenshot, captioned "@trip">',
  '<sent a photo of a restaurant bill, captioned "@trip split this">',
  'add Tara to the trip, she joined today',
  "the driver shouldn't be included in splits",
  'make the default split by family from now on',
  'who owes whom right now?',
  'petrol 2000, I paid, split equally',
  'count USD at 84 and give me one combined total',
  'how does the finance thing work?',
  'kitna hua ab tak? show balance',
  'scuba was 9900, only adults, 50-30-20 between the families',
  'Meera paid for groceries, 1200',
  'log 250 cab from the airport',
];

const SHOULD_NOT_FIRE: string[] = [
  'what time is dinner tonight?',
  'the beach was amazing today 🏖️',
  'can someone book the taxi for tomorrow morning?',
  'Raj you coming to the pool?',
  'weather app says rain at 5pm',
  '<shared 12 photos from the beach>',
  'happy birthday Diya!! 🎂',
  "what's the wifi password at the hotel?",
  'the room number is 304',
  "let's leave at 9:30 then",
  'anyone seen my sunglasses?',
  'this restaurant has 4.5 stars, should we go?',
  'flight lands at 14:20',
  'lol that was hilarious 😂',
  'my phone is at 12%, dying — see you at the shack',
  'temperature hit 38 degrees today',
  'Google says the fort entry is free on Sundays',
  'did you guys watch the match? 3-1!',
  'send me the maps link for the fort',
  "I'm tired, heading back to the room",
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const MODEL = arg('model', 'sonnet');
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

For each numbered message, decide whether this skill should be invoked. Judge each message independently, strictly by the description.

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
  // shuffle deterministically so batches mix both classes (no class-block bias)
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
    if (got === c.expected) {
      correct++;
    } else if (c.expected) {
      misses.push(c);
    } else {
      falseFires.push(c);
    }
  }

  console.log('── Gate 3 report ──');
  console.log(`correct: ${correct}/${cases.length} (${((100 * correct) / cases.length).toFixed(1)}%, bar ≥90%)`);
  console.log(`false fires on small-talk: ${falseFires.length} (bar: ZERO)`);
  for (const c of falseFires) console.log(`  ✗ fired on: "${c.message}"`);
  for (const c of misses) console.log(`  ✗ missed:   "${c.message}"`);

  writeFileSync(
    join(import.meta.dir, 'trigger-report.json'),
    JSON.stringify({ model: MODEL, ranAt: new Date().toISOString(), correct, total: cases.length, falseFires, misses }, null, 2),
  );

  const pass = correct / cases.length >= 0.9 && falseFires.length === 0;
  console.log(pass ? '\nGATE 3: PASS' : '\nGATE 3: FAIL');
  process.exit(pass ? 0 : 1);
}

main();
