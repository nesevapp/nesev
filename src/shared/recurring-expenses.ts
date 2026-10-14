import { EXPENSE_TAX_RATES_BP, netFromGross } from "./expenses";
import type { ExpenseFormValues } from "./schemas/expense";
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

const MONTHS = ["Jän", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

/** Label of a scheduled payment: "2026-11-01" → "Nov 2026". */
export function slotLabel(date: string): string {
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The standard rate whose contained VAT matches (1.200 € / 200 € → 2000); otherwise derived from net. */
export function rateForContainedTax(grossCents: number, taxCents: number): number {
  const bp = EXPENSE_TAX_RATES_BP.find((r) => containedTaxCents(grossCents, r) === taxCents);
  if (bp !== undefined) return bp;
  const net = grossCents - taxCents;
  return net > 0 ? Math.round((taxCents * 10000) / net) : 0;
}

/** Form values for a new expense booking one scheduled Fixkosten payment ("Ausgabe erfassen"). */
export function expenseFromFixedCost(
  r: { name: string; supplierName: string; category: string; grossCents: number; taxCents: number },
  slot: string,
): ExpenseFormValues {
  return {
    supplierName: r.supplierName || r.name,
    supplierUid: "",
    supplierCountry: "AT",
    supplierInvoiceNumber: "",
    issueDate: slot,
    dueDate: slot,
    paidAt: null,
    vatTreatment: "domestic",
    description: `${r.name} ${slotLabel(slot)}`,
    notes: "",
    lines: [
      {
        category: r.category as ExpenseFormValues["lines"][number]["category"],
        description: "",
        netCents: r.grossCents - r.taxCents,
        taxRateBp: rateForContainedTax(r.grossCents, r.taxCents),
        taxCents: r.taxCents,
        deductibleBp: 10000,
      },
    ],
  };
}
