import { addDays } from "./dates";

// Recurring invoice schedule math — shared by the generator, the forecast and the editor preview.
// Run dates keep the day-of-month of the start date ("anchor"); months without that day clamp to
// their last day (anchor 31: 31 Jan → 28/29 Feb → 31 Mar).

export const INTERVAL_UNITS = ["month", "year"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

export interface Interval {
  intervalUnit: IntervalUnit;
  intervalCount: number;
}

function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** addMonthsAnchored("2026-01-31", 1, 31) → "2026-02-28"; anchor defaults to the date's own day. */
export function addMonthsAnchored(isoDate: string, months: number, anchorDay?: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month1 = (total % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(year, month1));
  return `${year}-${pad(month1)}-${pad(day)}`;
}

function intervalMonths({ intervalUnit, intervalCount }: Interval): number {
  return (intervalUnit === "year" ? 12 : 1) * Math.max(1, intervalCount);
}

/** Next run after `runDate`, keeping the day-of-month of `startDate`. */
export function nextRunAfter(runDate: string, startDate: string, interval: Interval): string {
  return addMonthsAnchored(runDate, intervalMonths(interval), Number(startDate.slice(8, 10)));
}

/** Service period an invoice issued on `runDate` covers: runDate … day before the next run. */
export function coveredPeriod(runDate: string, startDate: string, interval: Interval): { start: string; end: string } {
  return { start: runDate, end: addDays(nextRunAfter(runDate, startDate, interval), -1) };
}

/** Run dates from `from` up to and including `until` (and `endDate`, if set). Capped at `limit`. */
export function runDatesUntil(
  r: Interval & { startDate: string; endDate: string | null },
  from: string,
  until: string,
  limit = 500,
): string[] {
  const out: string[] = [];
  for (let d = from; d <= until && (!r.endDate || d <= r.endDate) && out.length < limit; ) {
    out.push(d);
    d = nextRunAfter(d, r.startDate, r);
  }
  return out;
}

/** "monatlich", "alle 3 Monate", "jährlich", "alle 2 Jahre" */
export function intervalLabel({ intervalUnit, intervalCount }: Interval): string {
  if (intervalUnit === "year") return intervalCount === 1 ? "jährlich" : `alle ${intervalCount} Jahre`;
  if (intervalCount === 1) return "monatlich";
  if (intervalCount === 3) return "vierteljährlich";
  if (intervalCount === 6) return "halbjährlich";
  return `alle ${intervalCount} Monate`;
}

/** Presets offered in the editor; anything else is "Benutzerdefiniert". */
export const INTERVAL_PRESETS: { key: string; label: string; interval: Interval }[] = [
  { key: "1m", label: "Monatlich", interval: { intervalUnit: "month", intervalCount: 1 } },
  { key: "3m", label: "Alle 3 Monate", interval: { intervalUnit: "month", intervalCount: 3 } },
  { key: "6m", label: "Alle 6 Monate", interval: { intervalUnit: "month", intervalCount: 6 } },
  { key: "1y", label: "Jährlich", interval: { intervalUnit: "year", intervalCount: 1 } },
];
