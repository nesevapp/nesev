import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, type Db } from "../db/client";
import { clients, documents, expenseLines, expenses, type NewDocument } from "../db/schema";
import { createAsset } from "./assets";
import { getDashboard } from "./dashboard";
import { updateSettings } from "./settings";
import { computeEar } from "./tax";
import { setTaxStatus } from "./tax-status";

const TODAY = "2026-06-15";

function setup() {
  const db = createTestDb();
  const client = db.insert(clients).values({ number: 1, name: "Muster GmbH" }).returning().get();
  let seq = 0;
  const add = (over: Partial<NewDocument> & Pick<NewDocument, "type">) =>
    db
      .insert(documents)
      .values({
        clientId: client.id,
        status: "final",
        number: over.status === "draft" ? null : `X-${++seq}`,
        issueDate: "2026-03-10",
        taxMode: "AT_DOMESTIC",
        netCents: 10000,
        taxCents: 2000,
        grossCents: 12000,
        ...over,
      })
      .returning()
      .get();
  return { db, client, add };
}

describe("getDashboard", () => {
  test("revenue subtracts credit notes and ignores drafts and offers", () => {
    const { db, add } = setup();
    add({ type: "invoice", issueDate: "2026-01-05", netCents: 100000 });
    add({ type: "invoice", status: "paid", issueDate: "2026-01-20", netCents: 50000 });
    add({ type: "invoice", status: "sent", issueDate: "2026-03-01", netCents: 30000 });
    add({ type: "credit_note", issueDate: "2026-01-25", netCents: 20000 });
    add({ type: "invoice", status: "draft", issueDate: "2026-01-10", netCents: 999999 });
    add({ type: "credit_note", status: "draft", issueDate: "2026-01-10", netCents: 999999 });
    add({ type: "offer", status: "accepted", issueDate: "2026-01-10", netCents: 999999 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.monthly).toHaveLength(12);
    expect(d.monthly[0]!.cents).toBe(130000);
    expect(d.monthly[2]!.cents).toBe(30000);
    expect(d.kpis.revenue.cents).toBe(160000);
  });

  test("year boundaries bucket by issueDate; previous year is returned for comparison", () => {
    const { db, add } = setup();
    add({ type: "invoice", issueDate: "2025-12-31", netCents: 7000 });
    add({ type: "invoice", issueDate: "2026-01-01", netCents: 11000 });
    add({ type: "invoice", issueDate: "2026-12-31", netCents: 13000 });
    add({ type: "invoice", issueDate: "2027-01-01", netCents: 17000 });
    add({ type: "invoice", issueDate: "2024-12-31", netCents: 19000 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.kpis.revenue).toEqual({ cents: 24000, previousCents: 7000 });
    expect(d.monthly[0]).toMatchObject({ month: 0, cents: 11000, previousCents: 0 });
    expect(d.monthly[11]).toMatchObject({ month: 11, cents: 13000, previousCents: 7000 });
    expect(d.years).toEqual([2027, 2026, 2025, 2024]);
  });

  test("open and overdue invoices", () => {
    const { db, add } = setup();
    const old = add({ type: "invoice", status: "sent", dueDate: "2026-05-01", grossCents: 1000 });
    const older = add({ type: "invoice", status: "final", dueDate: "2026-04-01", grossCents: 2000 });
    add({ type: "invoice", status: "final", dueDate: TODAY, grossCents: 4000 }); // due today: not overdue
    add({ type: "invoice", status: "sent", dueDate: null, grossCents: 8000 }); // no due date: not overdue
    add({ type: "invoice", status: "paid", dueDate: "2026-01-01", paidAt: "2026-02-01", grossCents: 16000 });
    add({ type: "invoice", status: "draft", dueDate: "2026-01-01", grossCents: 32000 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.kpis.openInvoices).toEqual({ count: 4, cents: 15000 });
    expect(d.kpis.overdue).toEqual({ count: 2, cents: 3000 });
    expect(d.overdue.map((r) => r.id)).toEqual([older.id, old.id]);
    expect(d.overdue[0]!.daysOverdue).toBe(75);
    expect(d.overdue[0]!.clientName).toBe("Muster GmbH");
  });

  test("paid in year uses paidAt, gross", () => {
    const { db, add } = setup();
    add({ type: "invoice", status: "paid", issueDate: "2025-12-01", paidAt: "2026-01-03", grossCents: 5000 });
    add({ type: "invoice", status: "paid", issueDate: "2026-12-01", paidAt: "2027-01-03", grossCents: 7000 });
    add({ type: "invoice", status: "paid", issueDate: "2026-02-01", paidAt: "2026-02-10", grossCents: 9000 });

    expect(getDashboard(db, 2026, TODAY).kpis.paid).toEqual({ count: 2, cents: 14000 });
  });

  test("open offers are final/sent only, soonest expiry first", () => {
    const { db, add } = setup();
    const a = add({ type: "offer", status: "sent", validUntil: "2026-07-01", grossCents: 100 });
    const b = add({ type: "offer", status: "final", validUntil: "2026-06-20", grossCents: 200 });
    add({ type: "offer", status: "accepted", grossCents: 400 });
    add({ type: "offer", status: "declined", grossCents: 800 });
    add({ type: "offer", status: "draft", grossCents: 1600 });

    const d = getDashboard(db, 2026, TODAY);
    expect(d.kpis.openOffers).toEqual({ count: 2, cents: 300 });
    expect(d.openOffers.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  test("client name prefers the finalized snapshot", () => {
    const { db, add, client } = setup();
    add({
      type: "invoice",
      clientSnapshot: { name: "Alter Name GmbH" } as NewDocument["clientSnapshot"],
    });
    db.update(clients).set({ name: "Neuer Name GmbH" }).where(eq(clients.id, client.id)).run();
    add({ type: "invoice", status: "draft" });
    const names = getDashboard(db, 2026, TODAY).recent.map((r) => r.clientName).sort();
    expect(names).toEqual(["Alter Name GmbH", "Neuer Name GmbH"]);
  });

  test("setup flags for a fresh install", () => {
    const db = createTestDb();
    const d = getDashboard(db, 2026, TODAY);
    expect(d.setup).toEqual({ hasClients: false, hasDocuments: false, companyMissing: true });
    expect(d.kpis.revenue.cents).toBe(0);
    expect(d.years).toEqual([2026]);

    updateSettings(db, { companyName: "Firma", street: "Gasse 1", city: "Wien" });
    expect(getDashboard(db, 2026, TODAY).setup.companyMissing).toBe(false);
  });
  test("expenses: net per month by issueDate with previous year; years include expense-only years", () => {
    const { db, add } = setup();
    add({ type: "invoice", issueDate: "2026-02-10", netCents: 50000 });
    const exp = (issueDate: string, netCents: number) => {
      const e = db.insert(expenses).values({ supplierName: "Lieferant", issueDate, netCents, taxCents: 0, grossCents: netCents }).returning().get();
      if (netCents) db.insert(expenseLines).values({ expenseId: e.id, position: 0, category: "buero", netCents, taxRateBp: 0, taxCents: 0 }).run();
    };
    exp("2026-02-03", 12000);
    exp("2026-02-28", 3000);
    exp("2026-11-30", 7000);
    exp("2025-02-15", 4000);
    exp("2024-06-01", 1000);
    exp("2026-05-01", 0); // incomplete draft without lines

    const d = getDashboard(db, 2026, TODAY);
    expect(d.kpis.expenses).toEqual({ cents: 22000, previousCents: 4000, receiptsCents: 22000, afaCents: 0 });
    expect(d.monthly[1]).toMatchObject({ cents: 50000, expenseCents: 15000, previousExpenseCents: 4000 });
    expect(d.monthly[10]!.expenseCents).toBe(7000);
    expect(d.years).toContain(2024);
  });
  test("expenses: cost basis like the EAR – non-deductible VAT counts, Kleinunternehmer count all VAT", () => {
    const { db } = setup();
    const e = db
      .insert(expenses)
      .values({ supplierName: "Autohaus", issueDate: "2026-04-10", netCents: 30000, taxCents: 6000, grossCents: 36000 })
      .returning()
      .get();
    db.insert(expenseLines)
      .values([
        // KFZ: Vorsteuer not deductible → net + tax is cost
        { expenseId: e.id, position: 0, category: "kfz", netCents: 10000, taxRateBp: 2000, taxCents: 2000, deductibleBp: 0 },
        // half deductible → net + half the tax
        { expenseId: e.id, position: 1, category: "kfz", netCents: 10000, taxRateBp: 2000, taxCents: 2000, deductibleBp: 5000 },
        // fully deductible → net only
        { expenseId: e.id, position: 2, category: "buero", netCents: 10000, taxRateBp: 2000, taxCents: 2000 },
      ])
      .run();
    // reverse charge: the self-assessed tax is deductible again → net only
    const rc = db
      .insert(expenses)
      .values({ supplierName: "EU Ltd", issueDate: "2026-04-11", vatTreatment: "reverse_charge", netCents: 5000, taxCents: 1000, grossCents: 5000 })
      .returning()
      .get();
    db.insert(expenseLines).values({ expenseId: rc.id, position: 0, category: "buero", netCents: 5000, taxRateBp: 2000, taxCents: 1000 }).run();

    expect(getDashboard(db, 2026, TODAY).monthly[3]!.expenseCents).toBe(12000 + 11000 + 10000 + 5000);
    // Kleinunternehmer: no Vorsteuer at all, every VAT amount is cost (as in the EAR)
    setTaxStatus(db, { smallBusiness: true });
    expect(getDashboard(db, 2026, TODAY).monthly[3]!.expenseCents).toBe(12000 + 12000 + 12000 + 6000);
    // paid in the same month → the EAR shows the same amount
    db.update(expenses).set({ paidAt: "2026-04-20" }).run();
    expect(computeEar(db, 2026).monthly[3]!.expensesCents).toBe(42000);
    setTaxStatus(db, { smallBusiness: false });
    expect(computeEar(db, 2026).monthly[3]!.expensesCents).toBe(getDashboard(db, 2026, TODAY).monthly[3]!.expenseCents);
  });
  test("expenses: anlagen lines replaced by the AfA spread evenly over the year", () => {
    const { db } = setup();
    const e = db.insert(expenses).values({ supplierName: "Apple", issueDate: "2026-09-10", netCents: 250000, taxCents: 50000, grossCents: 300000 }).returning().get();
    db.insert(expenseLines)
      .values([
        { expenseId: e.id, position: 0, category: "anlagen", netCents: 240000, taxRateBp: 2000, taxCents: 48000 },
        { expenseId: e.id, position: 1, category: "buero", netCents: 10000, taxRateBp: 2000, taxCents: 2000 },
      ])
      .run();
    createAsset(db, { name: "MacBook", expenseId: e.id, acquisitionDate: "2026-09-10", inServiceDate: "2026-09-15", costCents: 240000, usefulLifeYears: 3 });

    const d = getDashboard(db, 2026, "2026-12-31");
    expect(d.kpis.expenses).toEqual({ cents: 10000 + 40000, previousCents: 0, receiptsCents: 10000, afaCents: 40000 });
    expect(d.monthly[0]!.expenseCents).toBe(3333);
    expect(d.monthly[8]).toMatchObject({ expenseCents: 10000 + 3333, afaCents: 3333, previousAfaCents: 0 });
    expect(d.monthly[11]!.expenseCents).toBe(40000 - 3333 * 11);
    expect(d.monthly.reduce((s, m) => s + m.afaCents, 0)).toBe(d.kpis.expenses.afaCents);
    const d27 = getDashboard(db, 2027, "2027-12-31");
    expect(d27.kpis.expenses).toEqual({ cents: 80000, previousCents: 50000, receiptsCents: 0, afaCents: 80000 });
    expect(d27.monthly[0]).toMatchObject({ afaCents: 6666, previousAfaCents: 3333, previousExpenseCents: 3333 });
  });
  test("expenses: current year counts the AfA only up to the current month (like revenue to date)", () => {
    const { db } = setup();
    createAsset(db, { name: "MacBook", acquisitionDate: "2026-03-16", inServiceDate: "2026-03-16", costCents: 430000, usefulLifeYears: 3 });
    const d = getDashboard(db, 2026, "2026-10-19");
    // 4.300 € / 3 = 1.433,33 €/year → 119,44 €/month, Jan–Oct
    expect(d.kpis.expenses).toEqual({ cents: 11944 * 10, previousCents: 0, receiptsCents: 0, afaCents: 11944 * 10 });
    expect(d.monthly[9]).toMatchObject({ expenseCents: 11944, afaCents: 11944 });
    expect(d.monthly[10]).toMatchObject({ expenseCents: 0, afaCents: 0 });
    // a past year keeps its full AfA
    expect(getDashboard(db, 2027, "2028-02-01").kpis.expenses.previousCents).toBe(143333);
  });
});
