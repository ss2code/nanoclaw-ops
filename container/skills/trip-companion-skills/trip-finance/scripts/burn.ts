import type { Database } from 'bun:sqlite';
import { formatMinor } from './money';

const date = (at: string) => at.slice(0, 10);
const daysBetween = (a: string, b: string) => Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export function budgetBurn(db: Database, at: string) {
  const trip = db.query('SELECT start_date,end_date,total_budget,base_currency FROM trip WHERE id=1').get() as any;
  const totals = db.query("SELECT currency,SUM(amount) amount FROM expenses WHERE voided_at IS NULL GROUP BY currency ORDER BY currency").all() as any[];
  const spent = totals.map((r) => ({ currency: r.currency, amountMinor: Number(r.amount), formatted: formatMinor(Number(r.amount), r.currency) }));
  const topRows = db.query(`SELECT e.id,e.description,e.amount,e.currency,m.display_name payerName FROM expenses e JOIN members m ON m.id=e.payer_member_id WHERE e.voided_at IS NULL ORDER BY e.amount DESC,e.id ASC LIMIT 3`).all() as any[];
  const topExpenses = topRows.map((r) => ({ desc: r.description, formatted: formatMinor(r.amount, r.currency), payerName: r.payerName }));
  if (!trip?.start_date || !trip?.end_date) return { reason: 'trip dates are not configured', spent, budget: null, topExpenses };
  const tripDays = daysBetween(trip.start_date, trip.end_date) + 1;
  const rawElapsed = daysBetween(trip.start_date, date(at)) + 1;
  const daysElapsed = Math.max(0, Math.min(tripDays, rawElapsed));
  const baseSpent = totals.find((r) => r.currency === trip.base_currency)?.amount ?? 0;
  const common: any = { tripDays, daysElapsed, timePct: tripDays ? (daysElapsed * 100) / tripDays : 0, spent, topExpenses };
  if (trip.total_budget == null) return { ...common, budget: null };
  const dailyRate = daysElapsed ? baseSpent / daysElapsed : null;
  const projection = dailyRate == null ? null : daysElapsed >= tripDays ? baseSpent : dailyRate * tripDays;
  return { ...common, budget: trip.total_budget, baseSpent, budgetPct: trip.total_budget ? (baseSpent * 100) / trip.total_budget : 0, remaining: trip.total_budget - baseSpent, dailyRate, projection, projectionOver: projection != null && projection > trip.total_budget, foreignSpend: spent.filter((x) => x.currency !== trip.base_currency) };
}
