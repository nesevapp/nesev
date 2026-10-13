import { and, eq, sql } from "drizzle-orm";
import { formatDocumentNumber, type NumberedType } from "../../shared/documents";
import type { DbOrTx } from "../db/client";
import { numberSequences } from "../db/schema";

/**
 * Atomically increments and returns the next number for (type, year), e.g. "RE-2026-0001".
 * Gapless only if called inside the same transaction that finalizes the document —
 * if that transaction rolls back, the increment rolls back too:
 *
 *   db.transaction((tx) => {
 *     const { number } = nextNumber(tx, "invoice", 2026);
 *     tx.update(documents).set({ number, status: "final", ... }).where(...).run();
 *   });
 */
export function nextNumber(db: DbOrTx, type: NumberedType, year: number): { seq: number; number: string } {
  const row = db
    .insert(numberSequences)
    .values({ type, year, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [numberSequences.type, numberSequences.year],
      set: { lastNumber: sql`${numberSequences.lastNumber} + 1` },
    })
    .returning({ seq: numberSequences.lastNumber })
    .get();
  return { seq: row.seq, number: formatDocumentNumber(type, year, row.seq) };
}

/** The number that nextNumber() would assign, without consuming it (for previews). */
export function peekNextNumber(db: DbOrTx, type: NumberedType, year: number): string {
  const row = db
    .select({ last: numberSequences.lastNumber })
    .from(numberSequences)
    .where(and(eq(numberSequences.type, type), eq(numberSequences.year, year)))
    .get();
  return formatDocumentNumber(type, year, (row?.last ?? 0) + 1);
}
