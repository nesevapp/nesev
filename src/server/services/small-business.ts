import { and, asc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { runDatesUntil } from "../../shared/recurring";
import { type SmallBusinessLimit, SMALL_BUSINESS_TOLERANCE_CENTS, smallBusinessLimit } from "../../shared/small-business";
import type { DbOrTx } from "../db/client";
import { documents, recurringInvoices } from "../db/schema";

// Kleinunternehmer limit check (rules in src/shared/small-business.ts).
// Turnover = gross of non-draft invoices − gross of non-draft credit notes (positive amounts), by issueDate.
// Projection (current year only) adds draft invoices dated in the year and every future run of active
// recurring invoices until 31.12. (like the forecast, which projects runs from nextRunDate).

/** Signed gross turnover rows of a year, oldest first. */
function turnoverRows(db: DbOrTx, year: number) {
  return db
    .select({
      issueDate: documents.issueDate,
      cents: sql<number>`case when ${documents.type} = 'credit_note' then -${documents.grossCents} else ${documents.grossCents} end`,
    })
    .from(documents)
    .where(
      and(
        inArray(documents.type, ["invoice", "credit_note"]),
        ne(documents.status, "draft"),
        gte(documents.issueDate, `${year}-01-01`),
        lt(documents.issueDate, `${year + 1}-01-01`),
      ),
    )
    .orderBy(asc(documents.issueDate), asc(documents.id))
    .all();
}

export function getSmallBusinessLimit(db: DbOrTx, year: number, today: string): SmallBusinessLimit {
  let turnoverCents = 0;
  let exceededOn: string | null = null;
  for (const r of turnoverRows(db, year)) {
    turnoverCents += r.cents;
    if (!exceededOn && turnoverCents > SMALL_BUSINESS_TOLERANCE_CENTS) exceededOn = r.issueDate;
  }
  const previousYearCents = turnoverRows(db, year - 1).reduce((s, r) => s + r.cents, 0);

  let projectedCents = turnoverCents;
  if (year === Number(today.slice(0, 4))) {
    const yearEnd = `${year}-12-31`;
    projectedCents += db
      .select({ cents: sql<number>`coalesce(sum(${documents.grossCents}), 0)` })
      .from(documents)
      .where(
        and(
          eq(documents.type, "invoice"),
          eq(documents.status, "draft"),
          gte(documents.issueDate, `${year}-01-01`),
          lt(documents.issueDate, `${year + 1}-01-01`),
        ),
      )
      .get()!.cents;
    const recurring = db.select().from(recurringInvoices).where(eq(recurringInvoices.active, true)).all();
    for (const r of recurring) {
      // runs already due are generated on the next scheduler tick, so they count too
      const runs = runDatesUntil(r, r.nextRunDate, yearEnd).filter((d) => d >= `${year}-01-01`);
      projectedCents += runs.length * r.grossCents;
    }
  }

  return smallBusinessLimit({ year, turnoverCents, projectedCents, previousYearCents, exceededOn });
}
