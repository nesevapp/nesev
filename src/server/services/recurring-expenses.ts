import { asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { todayIso } from "../../shared/dates";
import { monthlyEquivalentCents, nextPaymentDate } from "../../shared/recurring-expenses";
import type { RecurringExpenseCreate, RecurringExpenseUpdate } from "../../shared/schemas/recurring-expense";
import type { DbOrTx } from "../db/client";
import { type RecurringExpense, recurringExpenses } from "../db/schema";

// Fixkosten: recurring outgoing payments (SVS, rent, subscriptions). Only the forecast uses them; nothing is
// booked automatically.

export type RecurringExpenseRow = RecurringExpense & {
  /** next payment on or after today; null once ended */
  nextPaymentDate: string | null;
  /** average per month */
  monthlyCents: number;
  ended: boolean;
};

const notFound = () => new HTTPException(404, { message: "Fixkosten-Eintrag nicht gefunden" });

function toRow(r: RecurringExpense, today: string): RecurringExpenseRow {
  const next = nextPaymentDate(r, today);
  return { ...r, nextPaymentDate: next, monthlyCents: monthlyEquivalentCents(r), ended: next === null };
}

export function listRecurringExpenses(db: DbOrTx, today = todayIso()): RecurringExpenseRow[] {
  return db
    .select()
    .from(recurringExpenses)
    .orderBy(asc(recurringExpenses.name), asc(recurringExpenses.id))
    .all()
    .map((r) => toRow(r, today));
}

export function getRecurringExpense(db: DbOrTx, id: number, today = todayIso()): RecurringExpenseRow {
  const row = db.select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).get();
  if (!row) throw notFound();
  return toRow(row, today);
}

export function createRecurringExpense(db: DbOrTx, input: RecurringExpenseCreate): RecurringExpenseRow {
  const row = db.insert(recurringExpenses).values(input).returning().get();
  return toRow(row, todayIso());
}

export function updateRecurringExpense(db: DbOrTx, id: number, patch: RecurringExpenseUpdate): RecurringExpenseRow {
  const current = getRecurringExpense(db, id);
  const merged = { ...current, ...patch };
  // the partial schema can only check pairs it received; re-check against the stored values
  if (merged.endDate && merged.endDate < merged.startDate) throw new HTTPException(422, { message: "Ende liegt vor dem Start" });
  if (merged.taxCents >= merged.grossCents) throw new HTTPException(422, { message: "USt. muss kleiner als der Betrag sein" });
  const row = db
    .update(recurringExpenses)
    .set(patch)
    .where(eq(recurringExpenses.id, id))
    .returning()
    .get();
  return toRow(row!, todayIso());
}

export function deleteRecurringExpense(db: DbOrTx, id: number): void {
  getRecurringExpense(db, id);
  db.delete(recurringExpenses).where(eq(recurringExpenses.id, id)).run();
}
