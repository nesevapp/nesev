import { netFromGross } from "./expenses";
import { type Interval, nextRunAfter, runDatesUntil } from "./recurring";

// Fixkosten schedule helpers — shared by the forecast, the list and the editor preview. Payment dates keep the
// day of month of the start date (same anchoring as recurring invoices, see ./recurring.ts).

type Schedule = Interval & { startDate: string; endDate: string | null };

/** Payment dates in [from, until] (and up to endDate). */
export function paymentDatesBetween(r: Schedule, from: string, until: string, limit = 500): string[] {
  let d = r.startDate;
  // skip past payments; bounded so a far-away `from` can't loop forever
  for (let i = 0; d < from && i < 10_000; i++) d = nextRunAfter(d, r.startDate, r);
  return runDatesUntil(r, d, until, limit);
}

/** First payment on or after `today`; null once the end date has passed. */
export function nextPaymentDate(r: Schedule, today: string): string | null {
  return paymentDatesBetween(r, today, "9999-12-31", 1)[0] ?? null;
}

/** Average amount per month (yearly 1.200 € → 100 €, quarterly 300 € → 100 €). */
export function monthlyEquivalentCents(r: Interval & { grossCents: number }): number {
  const months = (r.intervalUnit === "year" ? 12 : 1) * Math.max(1, r.intervalCount);
  return Math.round(r.grossCents / months);
}

/** Rate helper: VAT contained in a gross amount (1.200 € @ 20 % → 200 €). */
export function containedTaxCents(grossCents: number, rateBp: number): number {
  return netFromGross(grossCents, rateBp).taxCents;
}
