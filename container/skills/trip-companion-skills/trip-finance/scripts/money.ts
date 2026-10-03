// Money is ALWAYS an integer count of the currency's minor unit (paise, cents).
// No floats touch ledger math anywhere in this skill.

export const MINOR_UNIT_DIGITS: Record<string, number> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2, THB: 2, LKR: 2, NPR: 2,
  JPY: 0, KRW: 0, VND: 0,
};

export function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency.toUpperCase()] ?? 2;
}

export const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥',
};

export function assertMinor(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${what} must be an integer amount of minor units, got ${n}`);
  }
}

/** Parse a human amount string ("4500", "4,500.50") into minor units without float error. */
export function toMinor(major: string, currency: string): number {
  const digits = minorUnitDigits(currency);
  const cleaned = String(major).replace(/[,\s]/g, '');
  const m = cleaned.match(/^(-?)(\d+)(?:\.(\d*))?$/);
  if (!m) throw new Error(`cannot parse amount "${major}"`);
  const [, sign, whole, fracRaw = ''] = m;
  if (fracRaw.length > digits) {
    throw new Error(`amount "${major}" has more decimals than ${currency} allows (${digits})`);
  }
  const frac = fracRaw.padEnd(digits, '0');
  const minor = Number(whole) * 10 ** digits + (digits > 0 ? Number(frac || '0') : 0);
  const signed = sign === '-' ? -minor : minor;
  assertMinor(signed, `amount "${major}"`);
  return signed;
}

export function formatMinor(amount: number, currency: string): string {
  assertMinor(amount, 'amount');
  const digits = minorUnitDigits(currency);
  const sym = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (digits === 0) return `${sign}${sym}${abs.toLocaleString('en-IN')}`;
  const base = 10 ** digits;
  const whole = Math.floor(abs / base);
  const frac = String(abs % base).padStart(digits, '0');
  return `${sign}${sym}${whole.toLocaleString('en-IN')}.${frac}`;
}
