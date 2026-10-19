// Tax status history (Steuerstatus): Kleinunternehmerregelung yes/no and Soll-/Istbesteuerung, each valid from a
// date (table tax_status_periods). An entry applies from its validFrom until the day before the next entry. The
// first entry always starts at TAX_STATUS_BEGINNING ("von Beginn an"), so every date has a status; a migrated
// database has exactly that one entry with its former global settings.
//
// Which date asks for the status (see services/tax.ts and docs/architecture.md "Taxes"):
// - Kleinunternehmer for revenue: the document's issue date (the exemption belongs to the supply; a credit note
//   follows its invoice). For expenses (Vorsteuer, EAR cost basis, asset cost): the expense's Belegdatum.
// - Soll/Ist for revenue: the status at the invoice's issue date decides whether it is taxed at issue date or at
//   its payments (credit notes follow their invoice). A change of basis therefore neither drops nor doubles a
//   document (§ 17 Abs. 4 UStG). Expenses: by their Belegdatum. Basis changes are only allowed at the start of a
//   UVA period, so the basis shown on a UVA = the status at the period's first day.
// - New documents, today's views (settings GET, client form hints): the document date or today.

import { formatDate } from "./dates";
import type { VatBasis, VatPeriod } from "./tax-report";

export interface TaxStatus {
  smallBusiness: boolean;
  vatBasis: VatBasis;
}

export interface TaxStatusPeriod extends TaxStatus {
  id: number;
  /** YYYY-MM-DD; TAX_STATUS_BEGINNING for the first entry */
  validFrom: string;
  note: string;
}

/** validFrom of the first entry: applies to every date before the next entry. */
export const TAX_STATUS_BEGINNING = "0001-01-01";

export const DEFAULT_TAX_STATUS: TaxStatus = { smallBusiness: false, vatBasis: "accrual" };

export const VAT_BASIS_SHORT: Record<VatBasis, string> = { accrual: "Soll", cash: "Ist" };

/** Status lookup over a sorted history, loaded once per computation (no query per date). */
export class TaxStatusTimeline {
  readonly periods: readonly TaxStatusPeriod[];

  constructor(periods: readonly TaxStatusPeriod[]) {
    this.periods = [...periods].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  }

  /** Status valid on `date` (YYYY-MM-DD). Dates before the first entry use the first entry. */
  at(date: string): TaxStatus {
    let hit: TaxStatusPeriod | undefined = this.periods[0];
    for (const p of this.periods) {
      if (p.validFrom <= date) hit = p;
      else break;
    }
    return hit ? { smallBusiness: hit.smallBusiness, vatBasis: hit.vatBasis } : DEFAULT_TAX_STATUS;
  }

  smallBusinessAt(date: string): boolean {
    return this.at(date).smallBusiness;
  }

  vatBasisAt(date: string): VatBasis {
    return this.at(date).vatBasis;
  }

  /** Statuses that apply on some day in [from, to]. */
  during(from: string, to: string): TaxStatus[] {
    const out = [this.at(from)];
    for (const p of this.periods) if (p.validFrom > from && p.validFrom <= to) out.push({ smallBusiness: p.smallBusiness, vatBasis: p.vatBasis });
    return out;
  }

  /** Kleinunternehmer on every day of [from, to]. */
  smallBusinessThroughout(from: string, to: string): boolean {
    return this.during(from, to).every((s) => s.smallBusiness);
  }

  /** Kleinunternehmer on at least one day of [from, to]. */
  smallBusinessSometime(from: string, to: string): boolean {
    return this.during(from, to).some((s) => s.smallBusiness);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUARTER_START_MONTHS = new Set(["01", "04", "07", "10"]);

/** First day of a UVA period (month, or quarter for quarterly filers). */
export function isVatPeriodStart(date: string, vatPeriod: VatPeriod): boolean {
  if (!DATE_RE.test(date) || date.slice(8) !== "01") return false;
  return vatPeriod === "monthly" || QUARTER_START_MONTHS.has(date.slice(5, 7));
}

/** "von Beginn an" / "ab 01.01.2026" */
export function formatValidFrom(validFrom: string): string {
  return validFrom === TAX_STATUS_BEGINNING ? "von Beginn an" : `ab ${formatDate(validFrom)}`;
}

/**
 * Problems of a complete history (German, empty = valid): at least one entry, the first one from the beginning,
 * unique dates, and Soll/Ist changes only on the first day of a UVA period (`vatPeriod` from the settings).
 */
export function taxStatusProblems(periods: readonly Pick<TaxStatusPeriod, "validFrom" | "vatBasis">[], vatPeriod: VatPeriod): string[] {
  if (periods.length === 0) return ["Mindestens ein Steuerstatus ist nötig."];
  const sorted = [...periods].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  const problems: string[] = [];
  if (sorted[0]!.validFrom !== TAX_STATUS_BEGINNING) problems.push("Der erste Steuerstatus muss von Beginn an gelten.");
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i]!;
    const prev = sorted[i - 1]!;
    if (p.validFrom === prev.validFrom) problems.push(`Für den ${formatDate(p.validFrom)} gibt es schon einen Eintrag.`);
    else if (p.vatBasis !== prev.vatBasis && !isVatPeriodStart(p.validFrom, vatPeriod)) {
      problems.push(
        `Soll-/Istbesteuerung kann nur mit Beginn eines UVA-Zeitraums wechseln (${vatPeriod === "monthly" ? "Monatserster" : "1.1., 1.4., 1.7. oder 1.10."}), nicht am ${formatDate(p.validFrom)}.`,
      );
    }
  }
  return problems;
}

