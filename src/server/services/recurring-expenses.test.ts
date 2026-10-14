import { describe, expect, test } from "bun:test";
import { containedTaxCents, monthlyEquivalentCents, nextPaymentDate, paymentDatesBetween } from "../../shared/recurring-expenses";
import { recurringExpenseCreateSchema, recurringExpenseUpdateSchema } from "../../shared/schemas/recurring-expense";
import type { RecurringExpenseCreate } from "../../shared/schemas/recurring-expense";
import { createTestDb } from "../db/client";
import {
  createRecurringExpense,
  deleteRecurringExpense,
  getRecurringExpense,
  listRecurringExpenses,
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
