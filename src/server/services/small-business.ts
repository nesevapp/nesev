import { and, asc, eq, gte, inArray, lt, ne, notInArray, type SQL, sql } from "drizzle-orm";
import { coveredPeriod, runDatesUntil } from "../../shared/recurring";
import type { TaxMode } from "../../shared/tax";
import { type SmallBusinessLimit, SMALL_BUSINESS_TOLERANCE_CENTS, smallBusinessLimit } from "../../shared/small-business";
import type { DbOrTx } from "../db/client";
import { documents, recurringInvoices } from "../db/schema";
import { invoicePaymentStates } from "./bank";

// Kleinunternehmer limit check (rules in src/shared/small-business.ts).
// Turnover = gross of non-draft invoices − gross of non-draft credit notes (positive amounts), counted by the
// time of supply (Leistungszeitpunkt): end of the service period, else its start, else the invoice date. This
// holds for Ist- and Sollbesteuerung alike (payment dates don't matter for the limit), so settings.vatBasis is
// not used. Credit notes subtract by their own date (issue date) – the reduction happens when it's granted.
// Only turnover taxable in Austria counts (§ 6 Abs. 1 Z 27 UStG: "Umsätze nach § 1 Abs. 1 Z 1 und 2"): EU
// reverse-charge and third-country invoices (place of supply abroad, see the UVA in services/tax.ts) and their
// credit notes (which carry the invoice's tax mode) are left out, in the projection too. Caveat: a third-country
// export of goods (Ausfuhrlieferung, § 6 Abs. 1 Z 1) would count, but this app treats THIRD_COUNTRY as services.
// "Received" = the part of those invoices already paid: gross − credit notes for invoices marked paid, else
// the bank allocations (services/bank.ts invoicePaymentStates), capped at what is due.
// Projection (current year only) adds draft invoices whose service date is in the year and every future run
// of active recurring invoices until 31.12. (like the forecast, which projects runs from nextRunDate).

/** Leistungszeitpunkt of an invoice; credit notes use their issue date. */
const supplyDate = sql<string>`case when ${documents.type} = 'credit_note' then ${documents.issueDate}
  else coalesce(${documents.servicePeriodEnd}, ${documents.servicePeriodStart}, ${documents.issueDate}) end`;

const inYear = (year: number): SQL => and(gte(supplyDate, `${year}-01-01`), lt(supplyDate, `${year + 1}-01-01`))!;

/** Tax modes whose place of supply is abroad: not taxable in Austria, so not part of the limit. */
const FOREIGN_MODES: TaxMode[] = ["EU_REVERSE_CHARGE", "THIRD_COUNTRY"];
const domestic = notInArray(documents.taxMode, FOREIGN_MODES);

/** Signed gross turnover rows of a year, oldest first. */
function turnoverRows(db: DbOrTx, year: number) {
  return db
    .select({
      id: documents.id,
      type: documents.type,
      status: documents.status,
      grossCents: documents.grossCents,
      date: supplyDate,
      cents: sql<number>`case when ${documents.type} = 'credit_note' then -${documents.grossCents} else ${documents.grossCents} end`,
    })
    .from(documents)
    .where(and(inArray(documents.type, ["invoice", "credit_note"]), ne(documents.status, "draft"), domestic, inYear(year)))
    .orderBy(asc(supplyDate), asc(documents.id))
    .all();
}

export function getSmallBusinessLimit(db: DbOrTx, year: number, today: string): SmallBusinessLimit {
  const rows = turnoverRows(db, year);
  let turnoverCents = 0;
  let exceededOn: string | null = null;
  for (const r of rows) {
    turnoverCents += r.cents;
    if (!exceededOn && turnoverCents > SMALL_BUSINESS_TOLERANCE_CENTS) exceededOn = r.date;
  }
  const previousYearCents = turnoverRows(db, year - 1).reduce((s, r) => s + r.cents, 0);

  const invoices = rows.filter((r) => r.type === "invoice");
  const states = invoicePaymentStates(db, invoices);
  const receivedCents = invoices.reduce((s, r) => {
    const st = states.get(r.id)!;
    const received = r.status === "paid" ? st.dueCents : Math.min(st.paidCents, st.dueCents);
    return s + Math.max(0, received);
  }, 0);

  let projectedCents = turnoverCents;
  if (year === Number(today.slice(0, 4))) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    projectedCents += db
      .select({ cents: sql<number>`coalesce(sum(${documents.grossCents}), 0)` })
      .from(documents)
      .where(and(eq(documents.type, "invoice"), eq(documents.status, "draft"), domestic, inYear(year)))
      .get()!.cents;
    const recurring = db.select().from(recurringInvoices).where(eq(recurringInvoices.active, true)).all();
    for (const r of recurring) {
      if (FOREIGN_MODES.includes(r.taxMode)) continue;
      // runs already due are generated on the next scheduler tick, so they count too; with a service period
      // the run counts by the end of the period it covers (a December run may belong to next year)
      const runs = runDatesUntil(r, r.nextRunDate, yearEnd)
        .map((d) => (r.setServicePeriod ? coveredPeriod(d, r.startDate, r).end : d))
        .filter((d) => d >= yearStart && d <= yearEnd);
      projectedCents += runs.length * r.grossCents;
    }
  }

  return smallBusinessLimit({ year, turnoverCents, receivedCents, projectedCents, previousYearCents, exceededOn });
}
