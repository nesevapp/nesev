import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { addDays, todayIso } from "../../shared/dates";
import { monthlyEquivalentCents, nextPaymentDate, paymentDatesBetween } from "../../shared/recurring-expenses";
import type { RecurringExpenseCreate, RecurringExpenseLink, RecurringExpenseUpdate } from "../../shared/schemas/recurring-expense";
import type { DbOrTx } from "../db/client";
import { expenseLines, expenses, type RecurringExpense, recurringExpensePayments, recurringExpenses } from "../db/schema";
import { normalizeSupplierName } from "./receipt-parse";

// Fixkosten: recurring outgoing payments (SVS, rent, subscriptions). Only the forecast uses them; nothing is
// booked automatically.

export type RecurringExpenseRow = RecurringExpense & {
  /** next payment on or after today; null once ended */
  nextPaymentDate: string | null;
  /** average per month */
  monthlyCents: number;
  ended: boolean;
  /** past payments of the last 90 days without a linked expense */
  missingCount: number;
};

/** Window for `missingCount` (older gaps are likely from before nesev was used). */
const MISSING_WINDOW_DAYS = 90;

const notFound = () => new HTTPException(404, { message: "Fixkosten-Eintrag nicht gefunden" });

function toRow(r: RecurringExpense, today: string, linked: Set<string>): RecurringExpenseRow {
  const next = nextPaymentDate(r, today);
  const missingCount = paymentDatesBetween(r, addDays(today, -MISSING_WINDOW_DAYS), addDays(today, -1)).filter(
    (d) => !linked.has(`${r.id}:${d}`),
  ).length;
  return { ...r, nextPaymentDate: next, monthlyCents: monthlyEquivalentCents(r), ended: next === null, missingCount };
}

export function listRecurringExpenses(db: DbOrTx, today = todayIso()): RecurringExpenseRow[] {
  const linked = linkedSlotKeys(db);
  return db
    .select()
    .from(recurringExpenses)
    .orderBy(asc(recurringExpenses.name), asc(recurringExpenses.id))
    .all()
    .map((r) => toRow(r, today, linked));
}

export function getRecurringExpense(db: DbOrTx, id: number, today = todayIso()): RecurringExpenseRow {
  const row = db.select().from(recurringExpenses).where(eq(recurringExpenses.id, id)).get();
  if (!row) throw notFound();
  return toRow(row, today, linkedSlotKeys(db));
}

export function createRecurringExpense(db: DbOrTx, input: RecurringExpenseCreate): RecurringExpenseRow {
  const row = db.insert(recurringExpenses).values(input).returning().get();
  return toRow(row, todayIso(), linkedSlotKeys(db));
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
  return toRow(row!, todayIso(), linkedSlotKeys(db));
}

export function deleteRecurringExpense(db: DbOrTx, id: number): void {
  getRecurringExpense(db, id);
  db.delete(recurringExpenses).where(eq(recurringExpenses.id, id)).run();
}

// ── Payments: link booked expenses to scheduled Fixkosten payments ────────────────
// A linked slot is not projected by the forecast any more; the expense itself counts (unpaid → outflow).

export type SlotStatus = "linked" | "open" | "missing";

export interface LinkedExpense {
  id: number;
  number: string | null;
  supplierName: string;
  issueDate: string;
  grossCents: number;
  paidAt: string | null;
}

export interface ScheduleSlot {
  date: string;
  /** linked; open = today or later without expense; missing = past without expense ("überfällig, ohne Beleg") */
  status: SlotStatus;
  expense: LinkedExpense | null;
}

export interface ExpenseLinkInfo {
  recurringExpenseId: number;
  name: string;
  scheduledDate: string;
}

export interface SlotSuggestion {
  recurringExpenseId: number;
  name: string;
  supplierName: string;
  scheduledDate: string;
  grossCents: number;
  /** higher = better */
  score: number;
}

export interface ExpenseCandidate extends LinkedExpense {
  /** meets the matching rules (supplier/category, amount ± 5 %, date ± 10 days) */
  match: boolean;
  score: number;
}

/** Amount tolerance (share of the Fixkosten amount) and date window for suggestions. */
export const MATCH_AMOUNT_SHARE = 0.05;
export const MATCH_DAYS = 10;

const expenseFields = {
  id: expenses.id,
  number: expenses.number,
  supplierName: expenses.supplierName,
  issueDate: expenses.issueDate,
  dueDate: expenses.dueDate,
  grossCents: expenses.grossCents,
  paidAt: expenses.paidAt,
};
type ExpenseFacts = LinkedExpense & { dueDate: string | null; categories: string[] };

function dayDiff(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y1!, m1! - 1, d1!) - Date.UTC(y2!, m2! - 1, d2!)) / 86_400_000);
}

function sameSupplier(r: RecurringExpense, supplierName: string): boolean {
  const s = normalizeSupplierName(supplierName);
  if (s.length < 3) return false;
  return [r.supplierName, r.name].some((n) => {
    const x = normalizeSupplierName(n);
    return x.length >= 3 && (x === s || x.includes(s) || s.includes(x));
  });
}

/** Score of an expense for one slot; null when it doesn't meet the rules. */
function matchScore(r: RecurringExpense, slot: string, e: ExpenseFacts): number | null {
  const supplier = sameSupplier(r, e.supplierName);
  const category = e.categories.includes(r.category);
  if (!supplier && !category) return null;
  const amountDiff = Math.abs(e.grossCents - r.grossCents);
  if (amountDiff > r.grossCents * MATCH_AMOUNT_SHARE) return null;
  const days = Math.min(...[e.issueDate, e.dueDate, e.paidAt?.slice(0, 10)].filter((d): d is string => !!d).map((d) => Math.abs(dayDiff(d, slot))));
  if (days > MATCH_DAYS) return null;
  // supplier counts most, then closeness in amount and date
  return (supplier ? 100 : 0) + (category ? 30 : 0) + 20 * (1 - amountDiff / Math.max(1, r.grossCents * MATCH_AMOUNT_SHARE)) + (MATCH_DAYS - days);
}

function expenseFacts(db: DbOrTx, ids?: number[]): ExpenseFacts[] {
  if (ids && ids.length === 0) return [];
  const rows = db.select(expenseFields).from(expenses).where(ids ? inArray(expenses.id, ids) : undefined).all();
  const lines = db
    .select({ expenseId: expenseLines.expenseId, category: expenseLines.category })
    .from(expenseLines)
    .where(ids ? inArray(expenseLines.expenseId, ids) : undefined)
    .all();
  const cats = new Map<number, string[]>();
  for (const l of lines) cats.set(l.expenseId, [...(cats.get(l.expenseId) ?? []), l.category]);
  // incomplete drafts (no lines) can't be matched
  return rows.filter((r) => cats.has(r.id)).map((r) => ({ ...r, categories: cats.get(r.id)! }));
}

const toLinked = ({ id, number, supplierName, issueDate, grossCents, paidAt }: LinkedExpense): LinkedExpense => ({
  id,
  number,
  supplierName,
  issueDate,
  grossCents,
  paidAt,
});

/** Linked slots: "recurringExpenseId:date" (used by the forecast). */
export function linkedSlotKeys(db: DbOrTx): Set<string> {
  return new Set(
    db
      .select({ r: recurringExpensePayments.recurringExpenseId, d: recurringExpensePayments.scheduledDate })
      .from(recurringExpensePayments)
      .all()
      .map((l) => `${l.r}:${l.d}`),
  );
}

/** Past (last `past`) and upcoming (next `future`) payment slots, plus any linked slot outside that window. */
export function getSchedule(db: DbOrTx, id: number, today = todayIso(), past = 12, future = 6): { item: RecurringExpenseRow; slots: ScheduleSlot[] } {
  const item = getRecurringExpense(db, id, today);
  const dates = paymentDatesBetween(item, item.startDate, addDays(today, -1), 10_000).slice(-past);
  dates.push(...paymentDatesBetween(item, today, "9999-12-31", future));
  const links = db.select().from(recurringExpensePayments).where(eq(recurringExpensePayments.recurringExpenseId, id)).all();
  const byDate = new Map(links.map((l) => [l.scheduledDate, l.expenseId]));
  const facts = new Map(expenseFacts(db, links.map((l) => l.expenseId)).map((e) => [e.id, e]));
  // expenses without lines are not in `facts`; load them plainly
  const missingIds = links.map((l) => l.expenseId).filter((eid) => !facts.has(eid));
  const plain = missingIds.length ? db.select(expenseFields).from(expenses).where(inArray(expenses.id, missingIds)).all() : [];
  for (const p of plain) facts.set(p.id, { ...p, categories: [] });
  const all = [...new Set([...dates, ...byDate.keys()])].sort();
  const slots = all.map((date): ScheduleSlot => {
    const eid = byDate.get(date);
    const e = eid !== undefined ? facts.get(eid) : undefined;
    if (e) return { date, status: "linked", expense: toLinked(e) };
    return { date, status: date < today ? "missing" : "open", expense: null };
  });
  return { item, slots };
}

export function getExpenseLink(db: DbOrTx, expenseId: number): ExpenseLinkInfo | null {
  const row = db
    .select({ recurringExpenseId: recurringExpensePayments.recurringExpenseId, name: recurringExpenses.name, scheduledDate: recurringExpensePayments.scheduledDate })
    .from(recurringExpensePayments)
    .innerJoin(recurringExpenses, eq(recurringExpensePayments.recurringExpenseId, recurringExpenses.id))
    .where(eq(recurringExpensePayments.expenseId, expenseId))
    .get();
  return row ?? null;
}

/** Link an expense to a scheduled payment. An existing link of the expense is moved; a taken slot is a 409. */
export function linkExpense(db: DbOrTx, input: RecurringExpenseLink): ExpenseLinkInfo {
  const r = getRecurringExpense(db, input.recurringExpenseId);
  if (!db.select({ id: expenses.id }).from(expenses).where(eq(expenses.id, input.expenseId)).get()) {
    throw new HTTPException(404, { message: "Ausgabe nicht gefunden" });
  }
  if (paymentDatesBetween(r, input.scheduledDate, input.scheduledDate).length === 0) {
    throw new HTTPException(422, { message: "Kein geplanter Zahlungstermin an diesem Datum" });
  }
  const taken = db
    .select({ expenseId: recurringExpensePayments.expenseId, number: expenses.number })
    .from(recurringExpensePayments)
    .innerJoin(expenses, eq(recurringExpensePayments.expenseId, expenses.id))
    .where(and(eq(recurringExpensePayments.recurringExpenseId, r.id), eq(recurringExpensePayments.scheduledDate, input.scheduledDate)))
    .get();
  if (taken && taken.expenseId !== input.expenseId) {
    throw new HTTPException(409, { message: `Termin ist bereits mit ${taken.number ?? "einer Ausgabe"} verknüpft` });
  }
  db.transaction((tx) => {
    tx.delete(recurringExpensePayments).where(eq(recurringExpensePayments.expenseId, input.expenseId)).run();
    tx.insert(recurringExpensePayments).values(input).run();
  });
  return getExpenseLink(db, input.expenseId)!;
}

export function unlinkExpense(db: DbOrTx, expenseId: number): void {
  db.delete(recurringExpensePayments).where(eq(recurringExpensePayments.expenseId, expenseId)).run();
}

/** Free slots of active Fixkosten an expense fits (supplier or category, amount ± 5 %, date ± 10 days), best first. */
export function suggestSlots(db: DbOrTx, expenseId: number): SlotSuggestion[] {
  const e = expenseFacts(db, [expenseId])[0];
  if (!e) return [];
  const linked = linkedSlotKeys(db);
  const refDates = [e.issueDate, e.dueDate, e.paidAt?.slice(0, 10)].filter((d): d is string => !!d).sort();
  const from = addDays(refDates[0]!, -MATCH_DAYS);
  const until = addDays(refDates.at(-1)!, MATCH_DAYS);
  const out: SlotSuggestion[] = [];
  for (const r of db.select().from(recurringExpenses).where(eq(recurringExpenses.active, true)).all()) {
    for (const slot of paymentDatesBetween(r, from, until)) {
      if (linked.has(`${r.id}:${slot}`)) continue;
      const score = matchScore(r, slot, e);
      if (score !== null) out.push({ recurringExpenseId: r.id, name: r.name, supplierName: r.supplierName, scheduledDate: slot, grossCents: r.grossCents, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Unlinked expenses around a slot (± 60 days) for the picker; matching ones first. */
export function candidateExpenses(db: DbOrTx, id: number, slot: string): ExpenseCandidate[] {
  const r = getRecurringExpense(db, id);
  const linkedIds = new Set(db.select({ id: recurringExpensePayments.expenseId }).from(recurringExpensePayments).all().map((l) => l.id));
  const from = addDays(slot, -60);
  const until = addDays(slot, 60);
  return expenseFacts(db)
    .filter((e) => !linkedIds.has(e.id) && e.issueDate >= from && e.issueDate <= until)
    .map((e) => {
      const score = matchScore(r, slot, e);
      return { ...toLinked(e), match: score !== null, score: score ?? -Math.abs(dayDiff(e.issueDate, slot)) };
    })
    .sort((a, b) => b.score - a.score);
}
