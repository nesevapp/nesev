// Kleinunternehmerregelung (§ 6 Abs. 1 Z 27 UStG), rules since 1.1.2025:
// - Exempt if the turnover of the previous calendar year did not exceed € 55.000 and that of the current year
//   does not exceed it. The limit is a gross amount (Bruttoumsatz).
// - Tolerance: exceeding the limit by at most 10 % (≤ € 60.500) in the current year keeps the exemption until
//   the end of that year; next year it no longer applies (the previous year is then over the limit).
// - Above € 60.500 the exemption ends at once: the invoice that crosses the line already carries VAT.
// - The turnover counts by the time of supply (Leistungszeitpunkt), also for Istbesteuerung: the date the
//   money comes in doesn't matter (VwGH; BFG RV/5100868/2012; see PLAN.md for sources).
// Turnover here = gross of finalized invoices − finalized credit notes taxable in Austria (no EU reverse charge /
// third country), by service date (see services/small-business.ts).
// A planning aid only; certain turnover (e.g. Hilfsgeschäfte, some exempt sales) doesn't count towards the limit.

export const SMALL_BUSINESS_LIMIT_CENTS = 5_500_000;
/** limit + 10 % tolerance */
export const SMALL_BUSINESS_TOLERANCE_CENTS = 6_050_000;
/** share of the limit from which the dashboard warns */
export const SMALL_BUSINESS_WARN_RATIO = 0.8;

/**
 * ok: below 80 % · warn: ≥ 80 % of the limit · tolerance: over € 55.000 but ≤ € 60.500 (exempt this year, not
 * next year) · exceeded: over € 60.500 (exemption ended with the invoice that crossed it).
 */
export type SmallBusinessLevel = "ok" | "warn" | "tolerance" | "exceeded";

export function smallBusinessLevel(cents: number): SmallBusinessLevel {
  if (cents > SMALL_BUSINESS_TOLERANCE_CENTS) return "exceeded";
  if (cents > SMALL_BUSINESS_LIMIT_CENTS) return "tolerance";
  if (cents >= SMALL_BUSINESS_LIMIT_CENTS * SMALL_BUSINESS_WARN_RATIO) return "warn";
  return "ok";
}

export interface SmallBusinessLimit {
  year: number;
  limitCents: number;
  toleranceCents: number;
  /** gross turnover of `year` so far, by service date */
  turnoverCents: number;
  /** part of turnoverCents already paid (for comparison only; doesn't affect the limit) */
  receivedCents: number;
  /** turnover + projected runs of active recurring invoices until 31.12. (current year only, else = turnover) */
  projectedCents: number;
  /** gross turnover of the previous year */
  previousYearCents: number;
  level: SmallBusinessLevel;
  projectedLevel: SmallBusinessLevel;
  /** previous year over the limit: the exemption doesn't apply in `year` at all */
  previousYearExceeded: boolean;
  /** service date of the invoice that took the turnover over € 60.500, if any */
  exceededOn: string | null;
  /** the exemption ends on this date by the limit (exceededOn, or 1.1. when the previous year was over it), but the
   *  Steuerstatus history still says Kleinunternehmer then: a hint to add an entry (set by the dashboard) */
  statusEndsOn: string | null;
}

export function smallBusinessLimit(args: {
  year: number;
  turnoverCents: number;
  receivedCents: number;
  projectedCents: number;
  previousYearCents: number;
  exceededOn: string | null;
}): SmallBusinessLimit {
  return {
    ...args,
    limitCents: SMALL_BUSINESS_LIMIT_CENTS,
    toleranceCents: SMALL_BUSINESS_TOLERANCE_CENTS,
    level: smallBusinessLevel(args.turnoverCents),
    projectedLevel: smallBusinessLevel(args.projectedCents),
    previousYearExceeded: args.previousYearCents > SMALL_BUSINESS_LIMIT_CENTS,
    statusEndsOn: null,
  };
}
