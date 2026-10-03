#!/usr/bin/env bun
// Gate 5 (design §21): an LLM-as-judge (Sonnet) scores curator output on the
// seven quality criteria. At live-taste time this judges the agent's real plan
// proposals; here it runs a self-test — a known-GOOD sample must pass and a
// planted-BAD sample (broken links, a hallucinated place, no veg option, missing
// slots) must fail — proving the rubric discriminates. Answer quality is the
// thing under test, so this uses Sonnet (not Haiku).
//
// Usage: bun eval/rubric.ts [--model sonnet]
//
// Criteria: (a) valid link present  (b) cost in the right currency
// (c) fits budget + prefs  (d) real place/event (no hallucination)
// (e) ovo-veg option  (f) buffers/travel time shown  (g) every required slot filled

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const MODEL = arg('model', 'sonnet');

const CONTEXT = 'Trip: Goa 2026 · party of 6, ovo-vegetarian · budget ₹25,000pp · currency INR · relaxed + a little adventure.';

const GOOD = `Goa · Day 2 — beaches & a fort
🌅 06:30–07:30 Sunrise at Vagator Beach (walk 10m from stay) — free — https://www.google.com/maps/place/Vagator+Beach,+Goa
🍳 08:00–09:00 Breakfast — included at the stay
🏰 10:00–12:00 Chapora Fort (taxi 25m, +10m buffer) — ₹600 cab round-trip — https://en.wikipedia.org/wiki/Chapora_Fort
🥗 13:00–14:30 Lunch — Thalassa (ovo-veg mains available) (taxi 15m, +10m buffer) — ~₹500pp — https://www.thalassagoa.com
⛵ 17:00–19:00 Sunset cruise on the Mandovi (taxi 20m, +15m buffer) — ₹900pp · book by tomorrow — https://www.goatourism.gov.in/
🍽️ 20:00–22:00 Dinner — Gunpowder (veg thali) (taxi 15m) — ~₹800pp — https://www.zomato.com/goa/gunpowder-assagao
Day total ≈ ₹2,800pp — within the ₹25k pp budget.`;

const BAD = `Goa · Day 2
- Morning: visit the Atlantis Underwater Resort & Casino Goa (a real luxury spot)
- Lunch: steakhouse, great ribs, $40
- Evening: party
(no links, no times, no buffers, no veg options, costs in USD)`;

interface Scores {
  a_link: boolean;
  b_currency: boolean;
  c_budget_prefs: boolean;
  d_real_no_hallucination: boolean;
  e_ovo_veg: boolean;
  f_buffers: boolean;
  g_slots: boolean;
  overall_pass: boolean;
  notes: string;
}

async function judge(sample: string): Promise<Scores> {
  const prompt = `You are a strict travel-plan quality judge. Context: ${CONTEXT}

Score this day-plan proposal on each criterion as true/false:
a_link: every suggested place/activity carries a credible link
b_currency: all costs are in the trip currency (INR / ₹), not another currency
c_budget_prefs: it fits the per-person budget and the stated preferences
d_real_no_hallucination: the places/events are real and plausibly exist (no invented venues)
e_ovo_veg: meals include an ovo-vegetarian option
f_buffers: travel time / buffers between items are shown
g_slots: the day is filled out across its time blocks (not a sparse stub)
overall_pass: true only if a,b,c,d,e,f,g are ALL true

PROPOSAL:
"""${sample}"""

Reply with ONLY a JSON object, no fences: {"a_link":bool,"b_currency":bool,"c_budget_prefs":bool,"d_real_no_hallucination":bool,"e_ovo_veg":bool,"f_buffers":bool,"g_slots":bool,"overall_pass":bool,"notes":"one line"}`;

  const proc = Bun.spawn(['claude', '-p', prompt, '--model', MODEL, '--output-format', 'json', '--max-turns', '2'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 120_000);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timeout);
  const text: string = JSON.parse(out).result ?? '';
  return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Scores;
}

async function main(): Promise<void> {
  console.log(`Gate 5 rubric self-test with model "${MODEL}"\n`);
  const [good, bad] = await Promise.all([judge(GOOD), judge(BAD)]);
  console.log('GOOD sample →', JSON.stringify(good));
  console.log('BAD  sample →', JSON.stringify(bad));
  const pass = good.overall_pass === true && bad.overall_pass === false;
  console.log(`\n── Gate 5: ${pass ? 'PASS' : 'FAIL'} (rubric must pass the good sample and fail the bad one) ──`);
  process.exit(pass ? 0 : 1);
}

main();
