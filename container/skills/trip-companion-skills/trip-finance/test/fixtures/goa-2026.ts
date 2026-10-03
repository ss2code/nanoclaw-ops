// "Goa 2026" synthetic trip — design §8.
// 3 families (4/3/2) + 2 standalones (one joins day 3) + 1 split-excluded driver.
// 36 expenses + 4 settlements + 1 edit + 1 void, INR + USD.
//
// GOLDEN tables below were computed BY HAND (running per-member tallies,
// cross-checked to sum to zero at every checkpoint) before the implementation
// ran — they are independent of the code under test. All amounts are minor
// units (paise / cents).

import type { CustomSpec, SplitRule } from '../../scripts/split';

export const TRIP = {
  name: 'Goa 2026',
  baseCurrency: 'INR',
  startDate: '2026-12-20',
  endDate: '2026-12-27',
  defaultSplitRule: 'equal-all',
};

export const FAMILIES = [
  { key: 'kapoor', name: 'Kapoor' },
  { key: 'mehta', name: 'Mehta' },
  { key: 'iyer', name: 'Iyer' },
];

// Insertion order fixes member ids 1..12.
export const MEMBERS = [
  { id: 1, name: 'Arjun', family: 'kapoor', joined: '2026-12-20' },
  { id: 2, name: 'Diya', family: 'kapoor', joined: '2026-12-20' },
  { id: 3, name: 'Kabir', family: 'kapoor', joined: '2026-12-20' }, // kid
  { id: 4, name: 'Mira', family: 'kapoor', joined: '2026-12-20' }, // kid
  { id: 5, name: 'Raj', family: 'mehta', joined: '2026-12-20' },
  { id: 6, name: 'Meera', family: 'mehta', joined: '2026-12-20' },
  { id: 7, name: 'Rohan', family: 'mehta', joined: '2026-12-20' }, // kid
  { id: 8, name: 'Vik', family: 'iyer', joined: '2026-12-20' },
  { id: 9, name: 'Lakshmi', family: 'iyer', joined: '2026-12-20' },
  { id: 10, name: 'Dev', family: null, joined: '2026-12-20' },
  { id: 11, name: 'Tara', family: null, joined: '2026-12-22' }, // joins day 3
  { id: 12, name: 'Bhola', family: null, joined: '2026-12-20', excluded: true }, // driver
] as const;

const KIDS = [3, 4, 7];

export type TripEvent =
  | {
      label: string;
      type: 'expense';
      at: string;
      desc: string;
      amount: number;
      currency: string;
      payer: number;
      rule: SplitRule;
      custom?: CustomSpec;
      loggedBy?: number;
    }
  | { label: string; type: 'settlement'; at: string; from: number; to: number; amount: number; currency: string }
  | {
      label: string;
      type: 'edit';
      at: string;
      target: string; // label of the expense being edited
      patch: { amountMinor?: number; description?: string };
      actor: number;
    }
  | { label: string; type: 'void'; at: string; target: string; actor: number };

const exp = (
  label: string,
  at: string,
  desc: string,
  amount: number,
  currency: string,
  payer: number,
  rule: SplitRule,
  custom?: CustomSpec,
  loggedBy?: number,
): TripEvent => ({ type: 'expense', label, at, desc, amount, currency, payer, rule, custom, loggedBy });

export const EVENTS: TripEvent[] = [
  // ── Day 1 · 2026-12-20 ── 10 active participants, 4 units
  exp('E1', '2026-12-20T10:00:00', 'Hotel advance', 4_000_000, 'INR', 1, 'equal-all'),
  exp('E2', '2026-12-20T13:00:00', 'Lunch', 480_000, 'INR', 2, 'by-family'),
  exp('E3', '2026-12-20T15:00:00', 'Taxi', 200_000, 'INR', 5, 'equal-all', undefined, 6), // sender ≠ payer
  exp('E4', '2026-12-20T17:00:00', 'Snacks', 55_000, 'INR', 10, 'equal-all'),
  exp('E5', '2026-12-20T20:00:00', 'Beach shack dinner', 600_000, 'INR', 8, 'by-family'),

  // ── Day 2 · 2026-12-21 ──
  exp('E6', '2026-12-21T11:00:00', 'Water sports (adults)', 700_000, 'INR', 1, 'custom', {
    kind: 'exclude',
    memberIds: KIDS,
  }),
  exp('E7', '2026-12-21T13:00:00', 'Groceries', 120_000, 'INR', 6, 'equal-all'),
  exp('E8', '2026-12-21T16:00:00', 'Ice cream (kids treat)', 60_000, 'INR', 10, 'custom', {
    kind: 'explicit',
    shares: { 3: 20_000, 4: 20_000, 7: 20_000 },
  }),
  // by-family with a crumb: Mehta 100000/3 → payer Raj absorbs the +1
  exp('E9', '2026-12-21T18:00:00', 'Fuel', 400_000, 'INR', 5, 'by-family'),
  // ── CHECKPOINT day2 (after E9) ──

  // ── Day 3 · 2026-12-22 ── Tara joins → 11 participants, 5 units
  exp('E10', '2026-12-22T09:00:00', 'Breakfast', 110_000, 'INR', 11, 'equal-all'),
  exp('E11', '2026-12-22T11:00:00', 'Museum (adults)', 220_000, 'INR', 2, 'custom', {
    kind: 'exclude',
    memberIds: KIDS,
  }),
  // USD, equal-all crumb: 20000/11 → payer Dev absorbs +2
  exp('E12', '2026-12-22T14:00:00', 'Parasailing', 20_000, 'USD', 10, 'equal-all'),
  // by-family crumb, payer outside the crumb family: Mehta 110000/3, +1 to members 5 and 6
  exp('E13', '2026-12-22T20:00:00', 'Dinner', 550_000, 'INR', 8, 'by-family'),
  { label: 'E14', type: 'settlement', at: '2026-12-22T21:00:00', from: 2, to: 1, amount: 150_000, currency: 'INR' },

  // ── Day 4 · 2026-12-23 ──
  exp('E15', '2026-12-23T10:00:00', 'Scuba (families only, 5:3:2)', 990_000, 'INR', 1, 'custom', {
    kind: 'ratio-by-unit',
    weights: { f1: 5, f2: 3, f3: 2 },
  }),
  exp('E16', '2026-12-23T13:00:00', 'Lunch', 330_000, 'INR', 5, 'equal-all'),
  exp('E17', '2026-12-23T15:00:00', "Kids' rides (Tara's treat)", 90_000, 'INR', 11, 'custom', {
    kind: 'explicit',
    shares: { 3: 30_000, 4: 30_000, 7: 30_000 },
  }),
  exp('E18', '2026-12-23T17:00:00', 'Fuel', 200_000, 'INR', 10, 'by-family'),
  exp('E19', '2026-12-23T20:00:00', 'Dinner (adults, USD)', 33_000, 'USD', 8, 'custom', {
    kind: 'exclude',
    memberIds: KIDS,
  }),

  // ── Day 5 · 2026-12-24 ──
  exp('E20', '2026-12-24T10:00:00', 'Boat trip', 880_000, 'INR', 6, 'equal-all'),
  exp('E21', '2026-12-24T12:00:00', 'Groceries', 121_000, 'INR', 2, 'equal-all'),
  { label: 'E22', type: 'settlement', at: '2026-12-24T13:00:00', from: 10, to: 1, amount: 500_000, currency: 'INR' },
  exp('E23', '2026-12-24T16:00:00', 'Cafe (adults)', 28_000, 'INR', 11, 'custom', {
    kind: 'exclude',
    memberIds: KIDS,
  }),
  exp('E24', '2026-12-24T18:00:00', 'Souvenirs (treat for Dev & Tara)', 45_000, 'INR', 9, 'custom', {
    kind: 'explicit',
    shares: { 10: 22_500, 11: 22_500 },
  }),
  exp('E25', '2026-12-24T20:00:00', 'Dinner (adults)', 360_000, 'INR', 5, 'custom', {
    kind: 'exclude',
    memberIds: KIDS,
  }),
  // duplicate, voided on day 6; equal-all crumb 150000/11 → payer Vik absorbs +4
  exp('E26', '2026-12-24T21:00:00', 'Taxi (duplicate)', 150_000, 'INR', 8, 'equal-all'),
  // ── CHECKPOINT day5 (after E26, pre-edit/void) ──

  // ── Day 6 · 2026-12-25 ── edit + void exercise the journal
  {
    label: 'EDIT-E25',
    type: 'edit',
    at: '2026-12-25T09:00:00',
    target: 'E25',
    patch: { amountMinor: 400_000, description: 'Dinner (adults, corrected bill)' },
    actor: 2,
  },
  { label: 'VOID-E26', type: 'void', at: '2026-12-25T09:30:00', target: 'E26', actor: 8 },
  exp('E27', '2026-12-25T11:00:00', 'Christmas brunch', 660_000, 'INR', 1, 'equal-all'),
  exp('E28', '2026-12-25T14:00:00', 'Snacks', 100_000, 'INR', 11, 'equal-all'), // crumb 10 → payer Tara absorbs
  exp('E29', '2026-12-25T16:00:00', 'Cab', 250_000, 'INR', 5, 'by-family'), // Mehta crumb +2 → payer Raj
  exp('E30', '2026-12-25T17:00:00', 'Golf (three players)', 15_000, 'USD', 1, 'custom', {
    kind: 'explicit',
    shares: { 1: 5_000, 8: 5_000, 10: 5_000 },
  }),
  exp('E31', '2026-12-25T19:00:00', 'Spa (weighted)', 500_000, 'INR', 9, 'custom', {
    kind: 'ratio-by-member',
    weights: { 2: 1, 6: 1, 9: 2, 11: 1 },
  }),
  { label: 'E32', type: 'settlement', at: '2026-12-25T21:00:00', from: 6, to: 8, amount: 100_000, currency: 'INR' },

  // ── Day 7 · 2026-12-26 ──
  exp('E33', '2026-12-26T13:00:00', 'Fancy dinner', 770_000, 'INR', 8, 'equal-all'),
  exp('E34', '2026-12-26T18:00:00', 'Drinks (subset)', 120_000, 'INR', 10, 'custom', {
    kind: 'exclude',
    memberIds: [...KIDS, 2, 6],
  }),
  exp('E35', '2026-12-26T19:00:00', 'Arcade (kids)', 90_000, 'INR', 2, 'custom', {
    kind: 'explicit',
    shares: { 3: 30_000, 4: 30_000, 7: 30_000 },
  }),
  exp('E36', '2026-12-26T20:00:00', 'Beach club', 440_000, 'INR', 11, 'by-family'), // Mehta crumb +1 → member 5
  exp('E37', '2026-12-26T22:00:00', 'Coffee run', 9_900, 'USD', 10, 'equal-all'),

  // ── Day 8 · 2026-12-27 ──
  exp('E38', '2026-12-27T10:00:00', 'Checkout brunch', 330_000, 'INR', 5, 'equal-all'),
  exp('E39', '2026-12-27T12:00:00', 'Driver tip', 200_000, 'INR', 1, 'equal-all'), // crumb 9 → payer Arjun
  { label: 'E40', type: 'settlement', at: '2026-12-27T14:00:00', from: 9, to: 8, amount: 600_000, currency: 'INR' },
];

// ── Hand-computed golden balances (minor units; positive = is owed) ──

export const GOLDEN_DAY2_INR: Record<number, number> = {
  1: 4_070_000,
  2: -150_000,
  3: -550_000,
  4: -550_000,
  5: -60_834,
  6: -540_833,
  7: -580_833,
  8: -122_500,
  9: -722_500,
  10: -792_500,
};

export const GOLDEN_DAY5_INR: Record<number, number> = {
  1: 4_028_114,
  2: -40_886,
  3: -885_886,
  4: -885_886,
  5: 259_529,
  6: -30_469,
  7: -904_468,
  8: 182_860,
  9: -1_072_136,
  10: -485_636,
  11: -165_136,
};

export const GOLDEN_DAY5_USD: Record<number, number> = {
  1: -5_943,
  2: -5_943,
  3: -1_818,
  4: -1_818,
  5: -5_943,
  6: -5_943,
  7: -1_818,
  8: 27_057,
  9: -5_943,
  10: 14_055,
  11: -5_943,
};

export const GOLDEN_END_INR: Record<number, number> = {
  1: 4_654_970,
  2: -264_021,
  3: -1_124_021,
  4: -1_124_021,
  5: 634_892,
  6: -255_103,
  7: -1_154_102,
  8: -164_771,
  9: -439_771,
  10: -702_271,
  11: -61_781,
};

export const GOLDEN_END_USD: Record<number, number> = {
  1: 3_157,
  2: -6_843,
  3: -2_718,
  4: -2_718,
  5: -6_843,
  6: -6_843,
  7: -2_718,
  8: 21_157,
  9: -6_843,
  10: 18_055,
  11: -6_843,
};

// 1 trip + 3 families + 12 members + 36 expense logs + 4 settlements + 1 edit + 1 void
export const EXPECTED_JOURNAL_ROWS = 58;
