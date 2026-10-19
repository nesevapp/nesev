// Anlagenverzeichnis / AfA (Absetzung für Abnutzung) — shared by server (EAR, dashboard) and web (live preview).
// A helper modelled on §§ 7, 13 EStG, not tax advice.
//
// - Assets with Anschaffungskosten (net + non-deductible VAT) above GWG_LIMIT_CENTS are depreciated
//   straight-line over the useful life; up to the limit they can be expensed at once (category hardware_gwg).
// - Annual AfA = cost / usefulLifeYears, rounded to the cent. Halbjahres-AfA: in service on or before 30.6.
//   → full annual AfA in the first year, otherwise half (and then one extra calendar year that takes the rest).
// - The last year takes whatever is left, so the AfA always sums to the cost exactly. No year exceeds the
//   remaining book value.
// - Disposal (sold / scrapped): the year of disposal still gets its regular AfA (full-year rule, kept simple),
//   and the remaining book value is written off in that year as well (disposalCents). Nothing after that.
//   Disposal proceeds are revenue; the app only shows them, they are not added to any revenue figure.
// - AfA is booked at year end: the book value at a date only drops for years that ended on or before it.

import { roundHalfAwayFromZero } from "./money";

/** GWG limit (net) since 2023: up to 1.000 € an asset can be expensed in full. */
export const GWG_LIMIT_CENTS = 100000;
export const MIN_USEFUL_LIFE_YEARS = 1;
export const MAX_USEFUL_LIFE_YEARS = 50;

/** Useful-life suggestions shown in the UI ("Vorschlag"); the user can enter anything from 1 to 50 years. */
export const USEFUL_LIFE_SUGGESTIONS = [
  { key: "computer", label: "Computer / Laptop", years: 3 },
  { key: "smartphone", label: "Smartphone / Tablet", years: 3 },
  { key: "software", label: "Software", years: 4 },
  { key: "furniture", label: "Büromöbel", years: 10, hint: "üblich 5–10 Jahre" },
  { key: "machine", label: "Maschinen / Geräte", years: 8, hint: "üblich 5–10 Jahre" },
  { key: "car", label: "PKW", years: 8, hint: "mindestens 8 Jahre (§ 8 Abs. 6 EStG)" },
] as const satisfies readonly { key: string; label: string; years: number; hint?: string }[];

/** PKW / Kombi: § 8 Abs. 6 EStG prescribes at least 8 years. */
export const CAR_MIN_USEFUL_LIFE_YEARS = 8;

export interface AssetInput {
  costCents: number;
  usefulLifeYears: number;
  /** Inbetriebnahme "YYYY-MM-DD" */
  inServiceDate: string;
  disposalDate?: string | null;
}

export interface AfaYear {
  year: number;
  /** book value at 1.1. (or the cost in the first year) */
  startCents: number;
  /** regular AfA of the year */
  afaCents: number;
  /** remaining book value written off on disposal (only in the disposal year) */
  disposalCents: number;
  /** book value at 31.12. */
  endCents: number;
}

const yearOf = (date: string) => Number(date.slice(0, 4));
const monthOf = (date: string) => Number(date.slice(5, 7));

/** In service on or before 30.6. → full AfA in the first year. */
export function isFirstHalf(inServiceDate: string): boolean {
  return monthOf(inServiceDate) <= 6;
}

/** Regular annual AfA (cost / useful life, rounded to the cent). */
export function annualAfaCents(a: Pick<AssetInput, "costCents" | "usefulLifeYears">): number {
  return roundHalfAwayFromZero(a.costCents / Math.max(1, a.usefulLifeYears));
}

/** The full depreciation schedule, one row per calendar year from the year it was put in service. */
export function assetSchedule(a: AssetInput): AfaYear[] {
  const life = Math.max(1, Math.trunc(a.usefulLifeYears));
  if (a.costCents <= 0) return [];
  const annual = annualAfaCents({ costCents: a.costCents, usefulLifeYears: life });
  const firstYear = yearOf(a.inServiceDate);
  const firstHalf = isFirstHalf(a.inServiceDate);
  /** index of the year that takes the rest */
  const lastIndex = firstHalf ? life - 1 : life;
  const disposalYear = a.disposalDate ? Math.max(firstYear, yearOf(a.disposalDate)) : null;

  const rows: AfaYear[] = [];
  let remaining = a.costCents;
  for (let i = 0; i <= lastIndex && remaining > 0; i++) {
    const year = firstYear + i;
    if (disposalYear != null && year > disposalYear) break;
    const planned = i === 0 && !firstHalf ? roundHalfAwayFromZero(annual / 2) : annual;
    const afaCents = i === lastIndex ? remaining : Math.min(planned, remaining);
    const startCents = remaining;
    remaining -= afaCents;
    const disposalCents = year === disposalYear ? remaining : 0;
    remaining -= disposalCents;
    rows.push({ year, startCents, afaCents, disposalCents, endCents: remaining });
  }
  return rows;
}

/** AfA and disposal write-off of one year (zeros outside the schedule). */
export function afaForYear(a: AssetInput, year: number): { afaCents: number; disposalCents: number } {
  const row = assetSchedule(a).find((r) => r.year === year);
  return { afaCents: row?.afaCents ?? 0, disposalCents: row?.disposalCents ?? 0 };
}

/** Book value at 31.12. of `year`: the cost before the first AfA year, 0 once fully depreciated or disposed. */
export function bookValueAtYearEnd(a: AssetInput, year: number): number {
  if (a.costCents <= 0) return 0;
  const rows = assetSchedule(a);
  if (rows.length === 0 || year < rows[0]!.year) return a.costCents;
  const last = [...rows].reverse().find((r) => r.year <= year);
  return last ? last.endCents : a.costCents;
}

/** Book value at a date. AfA is booked at year end, so within a year this is the value at the previous 31.12. */
export function bookValueAt(a: AssetInput, date: string): number {
  const year = yearOf(date);
  return date.slice(5) === "12-31" ? bookValueAtYearEnd(a, year) : bookValueAtYearEnd(a, year - 1);
}

/**
 * AfA of `year` split into the two half-years [Jän–Jun, Jul–Dez], for the Anlagen chart. The regular AfA is split
 * evenly (cent remainder in H2), except in the first year of an asset put in service in H2: its (half-year) AfA
 * falls entirely into H2. A disposal write-off falls into the half of the disposal date. The two halves always
 * add up to afaForYear (afaCents + disposalCents).
 */
export function halfYearAfa(a: AssetInput, year: number): [number, number] {
  const { afaCents, disposalCents } = afaForYear(a, year);
  const h2Only = yearOf(a.inServiceDate) === year && !isFirstHalf(a.inServiceDate);
  const h1 = h2Only ? 0 : Math.trunc(afaCents / 2);
  const out: [number, number] = [h1, afaCents - h1];
  if (disposalCents && a.disposalDate) out[isFirstHalf(a.disposalDate) ? 0 : 1] += disposalCents;
  return out;
}

/**
 * AfA of `year` per month (index 0 = January), consistent with halfYearAfa: each half-year's amount spread evenly
 * over its six months (cent remainder in June / December), so an asset put into service in H2 of its first year
 * starts in July; the disposal write-off goes into the month of disposal.
 */
export function monthlyAfaOf(a: AssetInput, year: number): number[] {
  const [h1, h2] = halfYearAfa({ ...a, disposalDate: null }, year);
  const half = (cents: number) => {
    const m = Math.trunc(cents / 6);
    return [m, m, m, m, m, cents - m * 5];
  };
  const out = [...half(h1), ...half(h2)];
  const { disposalCents } = afaForYear(a, year);
  if (disposalCents && a.disposalDate) out[Number(a.disposalDate.slice(5, 7)) - 1]! += disposalCents;
  return out;
}

/**
 * An annual amount spread evenly over 12 months (index 0 = January); the cent remainder goes to December.
 * Used where AfA is shown per month (dashboard, EAR monthly view).
 */
export function spreadOverMonths(annualCents: number): number[] {
  const monthly = Math.trunc(annualCents / 12);
  const out = Array<number>(12).fill(monthly);
  out[11] = annualCents - monthly * 11;
  return out;
}

/** Display form of an asset number: 1 → "AV-0001". */
export function formatAssetNumber(n: number): string {
  return `AV-${String(n).padStart(4, "0")}`;
}

/** "AV-0012", "av12", "0012" or "12" → 12; anything else → null. */
export function parseAssetNumber(input: string): number | null {
  const m = /^(?:av-?)?0*(\d{1,9})$/i.exec(input.trim());
  return m ? Number(m[1]) : null;
}
