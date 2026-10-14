import { describe, expect, test } from "bun:test";
import { containedTaxCents, monthlyEquivalentCents, nextPaymentDate, paymentDatesBetween } from "../../shared/recurring-expenses";
import { recurringExpenseCreateSchema, recurringExpenseUpdateSchema } from "../../shared/schemas/recurring-expense";
import type { RecurringExpenseCreate } from "../../shared/schemas/recurring-expense";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "../db/client";
import { expenseLines, expenses, type NewExpense, recurringExpensePayments } from "../db/schema";
import {
  candidateExpenses,
  createRecurringExpense,
  deleteRecurringExpense,
  getExpenseLink,
  getRecurringExpense,
  getSchedule,
  linkExpense,
  listRecurringExpenses,
  suggestSlots,
  unlinkExpense,
  updateRecurringExpense,
} from "./recurring-expenses";

const input = (over: Partial<RecurringExpenseCreate> = {}): RecurringExpenseCreate => ({
  name: "Adobe",
  supplierName: "Adobe Systems",
  category: "software_abos",
  active: true,
  intervalUnit: "month",
  intervalCount: 1,
  startDate: "2026-01-31",
  endDate: null,
  grossCents: 6600,
  taxCents: 1100,
  notes: "",
  ...over,
});

describe("schedule helpers", () => {
  const monthly = { intervalUnit: "month" as const, intervalCount: 1, startDate: "2026-01-31", endDate: null };

  test("payment dates keep the start day (clamped in short months) and respect the end date", () => {
    expect(paymentDatesBetween(monthly, "2026-02-01", "2026-05-31")).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    expect(paymentDatesBetween({ ...monthly, endDate: "2026-04-15" }, "2026-02-01", "2026-12-31")).toEqual(["2026-02-28", "2026-03-31"]);
    // quarterly from 15.2.
    expect(paymentDatesBetween({ ...monthly, intervalCount: 3, startDate: "2026-02-15" }, "2026-01-01", "2026-12-31")).toEqual([
      "2026-02-15",
      "2026-05-15",
      "2026-08-15",
      "2026-11-15",
    ]);
  });

  test("next payment on or after today, null once ended", () => {
    expect(nextPaymentDate(monthly, "2026-10-13")).toBe("2026-10-31");
    expect(nextPaymentDate(monthly, "2026-10-31")).toBe("2026-10-31");
    expect(nextPaymentDate({ ...monthly, startDate: "2027-03-01" }, "2026-10-13")).toBe("2027-03-01");
    expect(nextPaymentDate({ ...monthly, endDate: "2026-10-30" }, "2026-10-13")).toBeNull();
  });

  test("monthly equivalent and contained VAT", () => {
    expect(monthlyEquivalentCents({ intervalUnit: "month", intervalCount: 3, grossCents: 120000 })).toBe(40000);
    expect(monthlyEquivalentCents({ intervalUnit: "year", intervalCount: 1, grossCents: 120000 })).toBe(10000);
    expect(containedTaxCents(60000, 2000)).toBe(10000);
    expect(containedTaxCents(6600, 2000)).toBe(1100);
    expect(containedTaxCents(1000, 0)).toBe(0);
  });
});

describe("Fixkosten CRUD", () => {
  test("create, list with next payment and monthly amount, update, delete", () => {
    const db = createTestDb();
    const a = createRecurringExpense(db, input());
    createRecurringExpense(db, input({ name: "Altvertrag", endDate: "2026-03-31" }));
    const list = listRecurringExpenses(db, "2026-10-13");
    expect(list.map((r) => r.name)).toEqual(["Adobe", "Altvertrag"]);
    expect(list[0]).toMatchObject({ nextPaymentDate: "2026-10-31", monthlyCents: 6600, ended: false });
    expect(list[1]).toMatchObject({ nextPaymentDate: null, ended: true });

    const u = updateRecurringExpense(db, a.id, { active: false, grossCents: 7200, taxCents: 1200 });
    expect(u).toMatchObject({ active: false, grossCents: 7200, name: "Adobe" });

    // checks against the stored values when only one side of a pair is sent
    expect(() => updateRecurringExpense(db, a.id, { endDate: "2025-12-31" })).toThrow("Ende liegt vor dem Start");
    expect(() => updateRecurringExpense(db, a.id, { taxCents: 7200 })).toThrow("USt. muss kleiner");

    deleteRecurringExpense(db, a.id);
    expect(() => getRecurringExpense(db, a.id)).toThrow("nicht gefunden");
  });

  test("schema validation", () => {
    expect(recurringExpenseCreateSchema.safeParse(input()).success).toBe(true);
    expect(recurringExpenseCreateSchema.safeParse(input({ name: " " })).success).toBe(false);
    expect(recurringExpenseCreateSchema.safeParse(input({ grossCents: 0 })).success).toBe(false);
    expect(recurringExpenseCreateSchema.safeParse(input({ endDate: "2025-01-01" })).success).toBe(false);
    expect(recurringExpenseCreateSchema.safeParse(input({ category: "gibtsnicht" as "software_abos" })).success).toBe(false);
    expect(recurringExpenseUpdateSchema.safeParse({ active: false }).data).toEqual({ active: false });
  });
});

// ── Links to expenses ───────────────────────────────────────────────────────────

let expNo = 0;
function addExpense(db: Db, over: Partial<NewExpense> = {}, category = "miete", grossCents = 60000) {
  const e = db
    .insert(expenses)
    .values({ number: `ER-T-${++expNo}`, supplierName: "Immo Huber KG", issueDate: "2026-11-02", grossCents, netCents: grossCents - 10000, taxCents: 10000, ...over })
    .returning()
    .get();
  db.insert(expenseLines).values({ expenseId: e.id, position: 0, category, netCents: grossCents - 10000, taxRateBp: 2000, taxCents: 10000 }).run();
  return e;
}

const rent = (over: Partial<RecurringExpenseCreate> = {}) =>
  input({ name: "Miete", supplierName: "Immo Huber GmbH", category: "miete", startDate: "2026-01-01", grossCents: 60000, taxCents: 10000, ...over });

describe("Fixkosten payments", () => {
  test("suggestions: supplier (normalized) or category, amount ± 5 %, date ± 10 days, best first, free slots only", () => {
    const db = createTestDb();
    const miete = createRecurringExpense(db, rent());
    const lager = createRecurringExpense(db, rent({ name: "Lager", supplierName: "Lagerhaus", grossCents: 61000 }));
    createRecurringExpense(db, rent({ name: "Pausiert", active: false }));
    const e = addExpense(db);

    const s = suggestSlots(db, e.id);
    // Miete: supplier + category; Lager: category only (61.000 within 5 %)
    expect(s.map((x) => [x.name, x.scheduledDate])).toEqual([
      ["Miete", "2026-11-01"],
      ["Lager", "2026-11-01"],
    ]);
    expect(s[0]!.score).toBeGreaterThan(s[1]!.score);

    expect(suggestSlots(db, addExpense(db, { issueDate: "2026-11-20" }).id)).toHaveLength(0); // 19 days off
    expect(suggestSlots(db, addExpense(db, {}, "miete", 70000).id)).toHaveLength(0); // amount off
    expect(suggestSlots(db, addExpense(db, { supplierName: "Fremd" }, "buero").id)).toHaveLength(0); // nothing in common
    // a supplier match alone is enough (other category)
    expect(suggestSlots(db, addExpense(db, {}, "buero").id).map((x) => x.name)).toEqual(["Miete"]);

    linkExpense(db, { recurringExpenseId: miete.id, expenseId: e.id, scheduledDate: "2026-11-01" });
    const other = addExpense(db);
    expect(suggestSlots(db, other.id).map((x) => x.name)).toEqual(["Lager"]); // Miete Nov is taken
    expect(lager.id).toBeGreaterThan(0);
  });

  test("link, move, conflict, unlink; schedule shows linked / missing / open", () => {
    const db = createTestDb();
    const miete = createRecurringExpense(db, rent());
    const a = addExpense(db);
    const b = addExpense(db);

    expect(() => linkExpense(db, { recurringExpenseId: miete.id, expenseId: a.id, scheduledDate: "2026-11-02" })).toThrow("Kein geplanter");
    expect(linkExpense(db, { recurringExpenseId: miete.id, expenseId: a.id, scheduledDate: "2026-11-01" })).toEqual({
      recurringExpenseId: miete.id,
      name: "Miete",
      scheduledDate: "2026-11-01",
    });
    expect(() => linkExpense(db, { recurringExpenseId: miete.id, expenseId: b.id, scheduledDate: "2026-11-01" })).toThrow("bereits mit ER-T-");
    // moving the same expense to another slot replaces its link
    linkExpense(db, { recurringExpenseId: miete.id, expenseId: a.id, scheduledDate: "2026-10-01" });
    expect(getExpenseLink(db, a.id)!.scheduledDate).toBe("2026-10-01");

    const { slots } = getSchedule(db, miete.id, "2026-10-14", 3, 2);
    expect(slots.map((x) => [x.date, x.status, x.expense?.number ?? null])).toEqual([
      ["2026-08-01", "missing", null],
      ["2026-09-01", "missing", null],
      ["2026-10-01", "linked", a.number],
      ["2026-11-01", "open", null],
      ["2026-12-01", "open", null],
    ]);
    expect(listRecurringExpenses(db, "2026-10-14")[0]!.missingCount).toBe(2); // Aug, Sep (Jul is > 90 days ago)

    unlinkExpense(db, a.id);
    expect(getExpenseLink(db, a.id)).toBeNull();
  });

  test("picker candidates: unlinked expenses around the slot, matching ones first", () => {
    const db = createTestDb();
    const miete = createRecurringExpense(db, rent());
    const match = addExpense(db);
    const near = addExpense(db, { supplierName: "Büro Shop" }, "buero", 4000);
    addExpense(db, { issueDate: "2026-06-01" }); // too far away
    const linked = addExpense(db, { issueDate: "2026-10-01" });
    linkExpense(db, { recurringExpenseId: miete.id, expenseId: linked.id, scheduledDate: "2026-10-01" });
    const c = candidateExpenses(db, miete.id, "2026-11-01");
    expect(c.map((x) => [x.id, x.match])).toEqual([
      [match.id, true],
      [near.id, false],
    ]);
  });

  test("deleting the expense or the Fixkosten removes the link (cascade)", () => {
    const db = createTestDb();
    const miete = createRecurringExpense(db, rent());
    const a = addExpense(db);
    linkExpense(db, { recurringExpenseId: miete.id, expenseId: a.id, scheduledDate: "2026-11-01" });
    db.delete(expenses).where(eq(expenses.id, a.id)).run();
    expect(db.select().from(recurringExpensePayments).all()).toHaveLength(0);

    const b = addExpense(db);
    linkExpense(db, { recurringExpenseId: miete.id, expenseId: b.id, scheduledDate: "2026-11-01" });
    deleteRecurringExpense(db, miete.id);
    expect(db.select().from(recurringExpensePayments).all()).toHaveLength(0);
    expect(db.select().from(expenses).where(eq(expenses.id, b.id)).get()).toBeDefined();
  });
});
