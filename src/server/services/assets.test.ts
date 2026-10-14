import { describe, expect, test } from "bun:test";
import { createTestDb } from "../db/client";
import { expenseLines, expenses } from "../db/schema";
import {
  afaEntries,
  assetLinks,
  assetPrefillFromExpense,
  assetRegister,
  assetsCsv,
  createAsset,
  deleteAsset,
  disposeAsset,
  expensesWithoutAsset,
  monthlyAfa,
  undoDisposal,
  updateAsset,
} from "./assets";
import { updateSettings } from "./settings";

const laptop = { name: "MacBook Pro", acquisitionDate: "2026-09-10", inServiceDate: "2026-09-15", costCents: 240000, usefulLifeYears: 3 };

function setup() {
  const db = createTestDb();
  const expense = (lines: { net: number; tax: number; category?: string; deductibleBp?: number; description?: string }[], over: Partial<typeof expenses.$inferInsert> = {}) => {
    const row = db
      .insert(expenses)
      .values({ number: "ER-2026-0001", supplierName: "Apple", issueDate: "2026-09-10", vatTreatment: "domestic", description: "Laptop", ...over })
      .returning()
      .get();
    db.insert(expenseLines)
      .values(
        lines.map((l, i) => ({
          expenseId: row.id,
          position: i,
          category: l.category ?? "anlagen",
          description: l.description ?? "",
          netCents: l.net,
          taxRateBp: 2000,
          taxCents: l.tax,
          deductibleBp: l.deductibleBp ?? 10000,
        })),
      )
      .run();
    return row;
  };
  return { db, expense };
}

describe("assets service", () => {
  test("create numbers AV-0001, AV-0002; explicit numbers must be free", () => {
    const { db } = setup();
    expect(createAsset(db, laptop).number).toBe(1);
    expect(createAsset(db, { ...laptop, name: "Monitor" }).number).toBe(2);
    expect(() => createAsset(db, { ...laptop, number: 2 })).toThrow("AV-0002");
    const a = createAsset(db, { ...laptop, number: 10 });
    expect(a.schedule.map((r) => r.afaCents)).toEqual([40000, 80000, 80000, 40000]);
    expect(a.gwg).toBe(false);
  });

  test("date order is checked on create, update and disposal", () => {
    const { db } = setup();
    expect(() => createAsset(db, { ...laptop, inServiceDate: "2026-09-01" })).toThrow("Inbetriebnahme");
    const a = createAsset(db, laptop);
    expect(() => updateAsset(db, a.id, { acquisitionDate: "2026-10-01" })).toThrow("Inbetriebnahme");
    expect(() => disposeAsset(db, a.id, { disposalDate: "2026-09-01", disposalProceedsCents: 0 })).toThrow("Ausscheiden");
    expect(updateAsset(db, a.id, { usefulLifeYears: 4 }).schedule).toHaveLength(5);
  });

  test("prefill from an expense: anlagen lines only, cost = net + non-deductible tax, minus linked assets", () => {
    const { db, expense } = setup();
    const e = expense([
      { net: 240000, tax: 48000, description: "MacBook Pro 14" },
      { net: 100000, tax: 20000, deductibleBp: 5000, description: "Monitor" },
      { net: 5000, tax: 1000, category: "buero" },
    ]);
    const p = assetPrefillFromExpense(db, e.id);
    expect(p).toMatchObject({ name: "MacBook Pro 14, Monitor", acquisitionDate: "2026-09-10", totalCostCents: 240000 + 110000, costCents: 350000 });
    createAsset(db, { ...laptop, expenseId: e.id });
    expect(assetPrefillFromExpense(db, e.id)).toMatchObject({ linkedCostCents: 240000, costCents: 110000 });
    expect(assetLinks(db)).toEqual([expect.objectContaining({ number: 1, expenseId: e.id })]);

    updateSettings(db, { smallBusiness: true });
    expect(assetPrefillFromExpense(db, e.id).totalCostCents).toBe(288000 + 120000);

    const other = expense([{ net: 1000, tax: 200, category: "buero" }], { number: "ER-2026-0002" });
    expect(() => assetPrefillFromExpense(db, other.id)).toThrow("Anlagegüter");
  });

  test("expensesWithoutAsset lists expenses with anlagen lines and no linked asset", () => {
    const { db, expense } = setup();
    const e = expense([{ net: 240000, tax: 48000 }]);
    expense([{ net: 1000, tax: 200, category: "buero" }], { number: "ER-2026-0002" });
    expect(expensesWithoutAsset(db, "2026-01-01", "2026-12-31")).toEqual([{ id: e.id, number: "ER-2026-0001", supplierName: "Apple", netCents: 240000 }]);
    expect(expensesWithoutAsset(db, "2025-01-01", "2025-12-31")).toEqual([]);
    createAsset(db, { ...laptop, expenseId: e.id });
    expect(expensesWithoutAsset(db, "2026-01-01", "2026-12-31")).toEqual([]);
  });

  test("register per year: AfA, accumulated and book values; disposal and earlier/later assets", () => {
    const { db } = setup();
    const a = createAsset(db, laptop);
    createAsset(db, { ...laptop, name: "Kamera", inServiceDate: "2027-02-01", acquisitionDate: "2027-02-01", costCents: 120000 });
    const r26 = assetRegister(db, 2026, "2026-10-14");
    expect(r26.rows.map((r) => [r.name, r.startCents, r.afaCents, r.endCents])).toEqual([["MacBook Pro", 240000, 40000, 200000]]);
    expect(r26.hiddenCount).toBe(1);
    expect(r26.years).toEqual([2026]);

    disposeAsset(db, a.id, { disposalDate: "2027-04-30", disposalProceedsCents: 150000 });
    const r27 = assetRegister(db, 2027, "2026-10-14");
    const mac = r27.rows.find((r) => r.name === "MacBook Pro")!;
    expect(mac).toMatchObject({ startCents: 200000, afaCents: 80000, disposalCents: 120000, endCents: 0, accumulatedCents: 240000, disposedThisYear: true });
    expect(r27.totals).toMatchObject({ afaCents: 80000 + 40000, disposalCents: 120000, proceedsCents: 150000 });
    expect(assetsCsv(r27)).toContain("AV-0001;MacBook Pro");
    expect(assetRegister(db, 2028, "2026-10-14").rows.map((r) => r.name)).toEqual(["Kamera"]);

    const entries = afaEntries(db, 2027);
    const months = monthlyAfa(entries);
    expect(months.reduce((s, x) => s + x, 0)).toBe(80000 + 40000 + 120000);
    expect(months[3]! - months[0]!).toBe(120000); // write-off in April

    undoDisposal(db, a.id);
    expect(assetRegister(db, 2027, "2026-10-14").totals.disposalCents).toBe(0);
    deleteAsset(db, a.id);
    expect(assetRegister(db, 2026, "2026-10-14").rows).toEqual([]);
  });
});
