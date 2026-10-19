import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { parsePeriod } from "../../shared/tax-report";
import { TAX_STATUS_BEGINNING, TaxStatusTimeline, isVatPeriodStart, taxStatusProblems } from "../../shared/tax-status";
import { calcTotals } from "../../shared/totals";
import { createTestDb, type Db } from "../db/client";
import { bankAccounts, bankMatches, bankTransactions, clients, documentItems, documents, expenseLines, expenses, type NewDocument, settings, taxStatusPeriods } from "../db/schema";
import { MIGRATIONS_DIR } from "../lib/paths";
import { getDashboard } from "./dashboard";
import { createDocument, documentDefaults, finalizeWarnings } from "./documents";
import { vatEntries } from "./forecast";
import { getSettings, settingsTaxStatusConflict, updateSettings } from "./settings";
import { computeEar, computeUva, uvaValues } from "./tax";
import {
  createTaxStatusPeriod,
  deleteTaxStatusPeriod,
  listTaxStatusPeriods,
  loadTaxStatus,
  setTaxStatus,
  taxStatusAt,
  updateTaxStatusPeriod,
} from "./tax-status";

const period = (key: string) => parsePeriod(key)!;
const uva = (db: Db, key: string) => uvaValues(computeUva(db, period(key)));

function setup() {
  const db = createTestDb();
  const at = db.insert(clients).values({ number: 1, name: "Wien GmbH", country: "AT" }).returning().get();
  const account = db.insert(bankAccounts).values({ name: "Giro" }).returning().get();
  let seq = 0;
  const doc = (net: number, over: Partial<NewDocument> = {}) => {
    const taxMode = over.taxMode ?? "AT_DOMESTIC";
    const items = [{ position: 0, quantity: 1000, unitPriceCents: net, taxRateBp: 2000 }];
    const t = calcTotals(items, taxMode);
    const row = db
      .insert(documents)
      .values({ type: "invoice", status: "final", number: `RE-${++seq}`, clientId: at.id, issueDate: "2026-02-10", taxMode, netCents: t.netCents, taxCents: t.taxCents, grossCents: t.grossCents, ...over })
      .returning()
      .get();
    db.insert(documentItems).values(items.map((i) => ({ ...i, documentId: row.id }))).run();
    return row;
  };
  /** domestic expense, 20 %, fully deductible */
  const expense = (net: number, issueDate: string, over: Partial<typeof expenses.$inferInsert> = {}) => {
    const row = db.insert(expenses).values({ number: `ER-${++seq}`, supplierName: "Lieferant", issueDate, vatTreatment: "domestic", ...over }).returning().get();
    db.insert(expenseLines).values({ expenseId: row.id, position: 0, category: "software_abos", netCents: net, taxRateBp: 2000, taxCents: net / 5, deductibleBp: 10000 }).run();
    return row;
  };
  const pay = (target: { documentId?: number; expenseId?: number }, date: string, amountCents: number) => {
    const tx = db.insert(bankTransactions).values({ accountId: account.id, bookingDate: date, amountCents, importHash: `h${++seq}`, status: "matched" }).returning().get();
    db.insert(bankMatches).values({ transactionId: tx.id, amountCents, ...target }).run();
  };
  return { db, at, doc, expense, pay };
}

describe("TaxStatusTimeline", () => {
  const t = new TaxStatusTimeline([
    { id: 2, validFrom: "2026-01-01", smallBusiness: false, vatBasis: "accrual", note: "" },
    { id: 1, validFrom: TAX_STATUS_BEGINNING, smallBusiness: true, vatBasis: "cash", note: "" },
  ]);
  test("status per date, sorted, the first entry covers everything before", () => {
    expect(t.at("1999-05-01")).toEqual({ smallBusiness: true, vatBasis: "cash" });
    expect(t.at("2025-12-31")).toEqual({ smallBusiness: true, vatBasis: "cash" });
    expect(t.at("2026-01-01")).toEqual({ smallBusiness: false, vatBasis: "accrual" });
    expect(t.smallBusinessThroughout("2025-10-01", "2025-12-31")).toBe(true);
    expect(t.smallBusinessThroughout("2025-12-01", "2026-01-31")).toBe(false);
    expect(t.smallBusinessSometime("2025-12-01", "2026-01-31")).toBe(true);
    expect(t.smallBusinessSometime("2026-01-01", "2026-12-31")).toBe(false);
  });
  test("history checks", () => {
    expect(isVatPeriodStart("2026-04-01", "quarterly")).toBe(true);
    expect(isVatPeriodStart("2026-05-01", "quarterly")).toBe(false);
    expect(isVatPeriodStart("2026-05-01", "monthly")).toBe(true);
    expect(isVatPeriodStart("2026-05-02", "monthly")).toBe(false);
    expect(taxStatusProblems([], "monthly")).toEqual(["Mindestens ein Steuerstatus ist nötig."]);
    expect(taxStatusProblems([{ validFrom: "2026-01-01", vatBasis: "cash" }], "monthly")[0]).toContain("von Beginn an");
    const base = { validFrom: TAX_STATUS_BEGINNING, vatBasis: "cash" as const };
    expect(taxStatusProblems([base, { validFrom: "2026-05-01", vatBasis: "accrual" }], "quarterly")[0]).toContain("UVA-Zeitraums");
    expect(taxStatusProblems([base, { validFrom: "2026-05-01", vatBasis: "accrual" }], "monthly")).toEqual([]);
    // Kleinunternehmer may change on any day as long as the basis stays
    expect(taxStatusProblems([base, { validFrom: "2026-05-17", vatBasis: "cash" }], "quarterly")).toEqual([]);
    expect(taxStatusProblems([base, { validFrom: "2026-05-17", vatBasis: "cash" }, { validFrom: "2026-05-17", vatBasis: "cash" }], "quarterly")[0]).toContain("schon einen Eintrag");
  });
});

describe("migration carry-over", () => {
  test("a fresh database starts with one entry: settings defaults, from the beginning", () => {
    const db = createTestDb();
    expect(listTaxStatusPeriods(db)).toEqual([{ id: 1, validFrom: TAX_STATUS_BEGINNING, smallBusiness: false, vatBasis: "accrual", note: "" }]);
  });

  test("an existing settings row is carried over as the first entry", () => {
    const db = createTestDb();
    // state before migration 0012: a settings row with the old global flags and no history yet
    db.delete(taxStatusPeriods).run();
    db.insert(settings).values({ id: 1, smallBusiness: true, vatBasis: "cash" }).run();
    const migration = readFileSync(join(MIGRATIONS_DIR, "0012_tax_status_periods.sql"), "utf8").split("--> statement-breakpoint");
    db.run(sql.raw(migration.at(-1)!));
    expect(listTaxStatusPeriods(db).map(({ id: _id, ...p }) => p)).toEqual([{ validFrom: TAX_STATUS_BEGINNING, smallBusiness: true, vatBasis: "cash", note: "" }]);
    expect(getSettings(db)).toMatchObject({ smallBusiness: true, vatBasis: "cash" });
  });

  test("one entry gives the same figures as the former global setting", () => {
    const { db, doc, expense } = setup();
    doc(100000, { issueDate: "2026-02-10", taxMode: "SMALL_BUSINESS" });
    expense(10000, "2026-02-20", { paidAt: "2026-02-21" });
    setTaxStatus(db, { smallBusiness: true });
    expect(uva(db, "2026-Q1")["060"]).toBeUndefined(); // no Vorsteuer
    expect(uva(db, "2026-Q1")["016"]).toEqual({ amount: 100000, tax: null });
    expect(computeUva(db, period("2026-Q1")).smallBusiness).toBe(true);
    expect(computeEar(db, 2026)).toMatchObject({ gross: true, mixed: false, expensesCents: 12000 });
    setTaxStatus(db, { smallBusiness: false });
    expect(uva(db, "2026-Q1")["060"]).toEqual({ amount: 2000, tax: null });
    expect(computeEar(db, 2026)).toMatchObject({ gross: false, mixed: false, expensesCents: 10000 });
  });
});

describe("Kleinunternehmer 2025 → regular from 2026", () => {
  test("2025 figures stay unchanged, 2026 gets Vorsteuer", () => {
    const { db, doc, expense, pay } = setup();
    setTaxStatus(db, { smallBusiness: true, vatBasis: "accrual" });
    doc(300000, { issueDate: "2025-11-10", taxMode: "SMALL_BUSINESS", status: "paid", paidAt: "2025-11-20" });
    const e25 = expense(50000, "2025-12-05");
    pay({ expenseId: e25.id }, "2025-12-06", 60000);
    const before = { uva: computeUva(db, period("2025-Q4")), ear: computeEar(db, 2025) };
    expect(before.ear).toMatchObject({ gross: true, incomeCents: 300000, expensesCents: 60000 });

    createTaxStatusPeriod(db, { validFrom: "2026-01-01", smallBusiness: false, vatBasis: "accrual", note: "Grenze 2025 überschritten" });
    doc(100000, { issueDate: "2026-01-15", status: "paid", paidAt: "2026-01-30" });
    const e26 = expense(20000, "2026-02-01");
    pay({ expenseId: e26.id }, "2026-02-02", 24000);

    expect(computeUva(db, period("2025-Q4"))).toEqual(before.uva);
    expect(computeEar(db, 2025)).toEqual(before.ear);
    const q1 = computeUva(db, period("2026-Q1"));
    expect(q1.smallBusiness).toBe(false);
    expect(uvaValues(q1)["022"]).toEqual({ amount: 100000, tax: 20000 });
    expect(uvaValues(q1)["060"]).toEqual({ amount: 4000, tax: null });
    expect(q1.resultCents).toBe(16000);
    expect(computeEar(db, 2026)).toMatchObject({ gross: false, mixed: false, incomeCents: 100000, expensesCents: 20000 });
    // settings show the status valid today; the figures above don't depend on it
    expect(getSettings(db).smallBusiness).toBe(taxStatusAt(db).smallBusiness);
  });
});

describe("Soll/Ist change at a year start", () => {
  test("Ist → Soll: an Ist invoice paid after the change counts at its payment, new ones at issue date", () => {
    const { db, doc, pay } = setup();
    updateSettings(db, { vatPeriod: "monthly" });
    setTaxStatus(db, { vatBasis: "cash" });
    createTaxStatusPeriod(db, { validFrom: "2026-01-01", smallBusiness: false, vatBasis: "accrual", note: "" });
    const old = doc(100000, { issueDate: "2025-12-10" });
    pay({ documentId: old.id }, "2026-01-15", 120000);
    doc(50000, { issueDate: "2026-01-20" }); // unpaid, Soll
    expect(uva(db, "2025-12")["022"]).toBeUndefined();
    expect(uva(db, "2026-01")["022"]).toEqual({ amount: 150000, tax: 30000 });
    expect(computeUva(db, period("2025-12")).basis).toBe("cash");
    expect(computeUva(db, period("2026-01")).basis).toBe("accrual");
  });

  test("Soll → Ist: a Soll invoice paid after the change is not counted twice", () => {
    const { db, doc, pay } = setup();
    updateSettings(db, { vatPeriod: "monthly" });
    createTaxStatusPeriod(db, { validFrom: "2026-01-01", smallBusiness: false, vatBasis: "cash", note: "" });
    const old = doc(100000, { issueDate: "2025-12-10" });
    pay({ documentId: old.id }, "2026-01-15", 120000);
    const neu = doc(50000, { issueDate: "2026-01-20" });
    pay({ documentId: neu.id }, "2026-02-03", 60000);
    expect(uva(db, "2025-12")["022"]).toEqual({ amount: 100000, tax: 20000 });
    expect(uva(db, "2026-01")["022"]).toBeUndefined();
    expect(uva(db, "2026-02")["022"]).toEqual({ amount: 50000, tax: 10000 });
  });
});

describe("Kleinunternehmer lost mid-year", () => {
  test("splits by document date", () => {
    const { db, doc, expense, pay } = setup();
    setTaxStatus(db, { smallBusiness: true });
    // tolerance exceeded with an invoice dated 10.07.: the exemption ends with it
    createTaxStatusPeriod(db, { validFrom: "2026-07-10", smallBusiness: false, vatBasis: "accrual", note: "" });
    doc(100000, { issueDate: "2026-07-05", taxMode: "SMALL_BUSINESS", status: "paid", paidAt: "2026-07-06" });
    doc(100000, { issueDate: "2026-07-10", status: "paid", paidAt: "2026-07-20" });
    const before = expense(10000, "2026-07-05");
    const after = expense(10000, "2026-07-15");
    pay({ expenseId: before.id }, "2026-07-05", 12000);
    pay({ expenseId: after.id }, "2026-07-16", 12000);

    const q3 = computeUva(db, period("2026-Q3"));
    expect(q3.smallBusiness).toBe(false);
    expect(computeUva(db, period("2026-Q2")).smallBusiness).toBe(true);
    const v = uvaValues(q3);
    expect(v["016"]).toEqual({ amount: 100000, tax: null });
    expect(v["022"]).toEqual({ amount: 100000, tax: 20000 });
    expect(v["060"]).toEqual({ amount: 2000, tax: null }); // only the expense after the change
    const ear = computeEar(db, 2026);
    expect(ear).toMatchObject({ gross: false, mixed: true, incomeCents: 200000 });
    expect(ear.expensesCents).toBe(12000 + 10000); // gross before, net after
  });

  test("forecast skips UVA periods that are Kleinunternehmer throughout", () => {
    const { db } = setup();
    updateSettings(db, { vatPeriod: "monthly" });
    setTaxStatus(db, { smallBusiness: true });
    createTaxStatusPeriod(db, { validFrom: "2026-11-01", smallBusiness: false, vatBasis: "accrual", note: "" });
    const entry = { taxCents: 2000, direction: "in", expectedDate: "2026-11-10", issueDate: "2026-11-10", source: "recurring" } as Parameters<typeof vatEntries>[1][number];
    const october = { ...entry, expectedDate: "2026-10-25", issueDate: "2026-10-25" };
    const out = vatEntries(db, [entry, october], "monthly", loadTaxStatus(db), "2026-10-20", "2027-02-28");
    expect(out.map((e) => [e.vatPeriod, e.grossCents])).toEqual([["2026-11", 2000]]);
  });

  test("dashboard: card for the year, hint when the limit ends the status but the history doesn't", () => {
    const { db, doc } = setup();
    setTaxStatus(db, { smallBusiness: true });
    doc(6_100_000, { issueDate: "2026-06-30", taxMode: "SMALL_BUSINESS" });
    expect(getDashboard(db, 2026, "2026-10-01").smallBusiness?.statusEndsOn).toBe("2026-06-30");
    createTaxStatusPeriod(db, { validFrom: "2026-06-30", smallBusiness: false, vatBasis: "accrual", note: "" });
    expect(getDashboard(db, 2026, "2026-10-01").smallBusiness?.statusEndsOn).toBeNull();
    expect(getDashboard(db, 2027, "2027-01-10").smallBusiness).toBeNull(); // regular all year
  });
});

describe("API rules", () => {
  test("create/update/delete validation", () => {
    const db = createTestDb();
    const [first] = listTaxStatusPeriods(db);
    expect(() => createTaxStatusPeriod(db, { validFrom: TAX_STATUS_BEGINNING, smallBusiness: true, vatBasis: "accrual", note: "" })).toThrow("Datum");
    // quarterly (default): Soll/Ist only on 1.1./1.4./1.7./1.10.
    expect(() => createTaxStatusPeriod(db, { validFrom: "2026-05-01", smallBusiness: false, vatBasis: "cash", note: "" })).toThrow("UVA-Zeitraums");
    let list = createTaxStatusPeriod(db, { validFrom: "2026-07-01", smallBusiness: false, vatBasis: "cash", note: "" });
    expect(list.map((p) => p.validFrom)).toEqual([TAX_STATUS_BEGINNING, "2026-07-01"]);
    expect(() => createTaxStatusPeriod(db, { validFrom: "2026-07-01", smallBusiness: true, vatBasis: "cash", note: "" })).toThrow("schon einen Eintrag");
    const second = list[1]!;
    expect(() => updateTaxStatusPeriod(db, second.id, { ...second, validFrom: "2026-08-01" })).toThrow("UVA-Zeitraums");
    list = updateTaxStatusPeriod(db, second.id, { ...second, validFrom: "2026-10-01" });
    expect(list[1]!.validFrom).toBe("2026-10-01");
    // the first entry keeps "von Beginn an" and can't be deleted
    list = updateTaxStatusPeriod(db, first!.id, { ...first!, validFrom: "2020-01-01", smallBusiness: true });
    expect(list[0]).toMatchObject({ validFrom: TAX_STATUS_BEGINNING, smallBusiness: true });
    expect(() => deleteTaxStatusPeriod(db, first!.id)).toThrow("nicht gelöscht");
    expect(() => deleteTaxStatusPeriod(db, 999)).toThrow("nicht gefunden");
    expect(deleteTaxStatusPeriod(db, second.id)).toHaveLength(1);
  });

  test("PUT /api/settings: smallBusiness / vatBasis only unchanged", () => {
    const db = createTestDb();
    expect(settingsTaxStatusConflict(db, {})).toBeNull();
    expect(settingsTaxStatusConflict(db, { smallBusiness: false, vatBasis: "accrual" })).toBeNull();
    expect(settingsTaxStatusConflict(db, { smallBusiness: true })).toContain("Steuerstatus");
    expect(settingsTaxStatusConflict(db, { vatBasis: "cash" })).toContain("Steuerstatus");
  });
});

describe("new documents by date", () => {
  test("documentDefaults and finalizeWarnings use the status at the document date", () => {
    const { db, at } = setup();
    setTaxStatus(db, { smallBusiness: true });
    createTaxStatusPeriod(db, { validFrom: "2026-01-01", smallBusiness: false, vatBasis: "accrual", note: "" });
    expect(documentDefaults(db, "invoice", at.id, "2025-12-20")).toMatchObject({ taxMode: "SMALL_BUSINESS", smallBusiness: true });
    expect(documentDefaults(db, "invoice", at.id, "2026-01-02")).toMatchObject({ taxMode: "AT_DOMESTIC", smallBusiness: false });
    expect(documentDefaults(db, "offer", undefined, "2025-06-01").taxMode).toBe("SMALL_BUSINESS");

    const item = { title: "Beratung", description: "", quantity: 1000, unit: "Std.", unitPriceCents: 10000, taxRateBp: 2000, discountBp: 0 };
    const created = createDocument(db, { type: "invoice", clientId: at.id, issueDate: "2025-12-20", items: [item] });
    expect(created.taxMode).toBe("SMALL_BUSINESS");
    expect(finalizeWarnings(db, created.id)).toEqual([]);
    // a Kleinunternehmer draft dated after the change, e.g. from a recurring invoice
    const late = createDocument(db, { type: "invoice", clientId: at.id, issueDate: "2026-02-01", taxMode: "SMALL_BUSINESS", items: [item] });
    expect(finalizeWarnings(db, late.id)).toEqual([expect.stringContaining("Kleinunternehmerregelung nicht")]);
    const vat = createDocument(db, { type: "invoice", clientId: at.id, issueDate: "2025-12-01", taxMode: "AT_DOMESTIC", items: [item] });
    expect(finalizeWarnings(db, vat.id)).toEqual([expect.stringContaining("§ 11 Abs. 12")]);
  });
});
