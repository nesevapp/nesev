import { describe, expect, test } from "bun:test";
import type { RecurringCreate } from "../../shared/schemas/recurring";
import { createTestDb, type Db } from "../db/client";
import type { RecurringExpenseCreate } from "../../shared/schemas/recurring-expense";
import { clients, documentItems, documents, expenseLines, expenses, type NewClient, type NewDocument, type NewExpense } from "../db/schema";
import { buildForecast, paymentDelays, updateForecastSettings } from "./forecast";
import { createRecurringExpense, updateRecurringExpense } from "./recurring-expenses";
import { createRecurring } from "./recurring";
import { updateSettings } from "./settings";

const TODAY = "2026-10-13";
let clientNo = 0;

function addClient(db: Db, over: Partial<NewClient> = {}) {
  return db
    .insert(clients)
    .values({ number: ++clientNo, name: `Kunde ${clientNo}`, country: "AT", ...over })
    .returning()
    .get();
}

let docNo = 0;
function addInvoice(db: Db, over: Partial<NewDocument> & { clientId: number }) {
  return db
    .insert(documents)
    .values({
      type: "invoice",
      status: "final",
      number: `RE-T-${++docNo}`,
      issueDate: "2026-09-01",
      dueDate: "2026-09-15",
      taxMode: "AT_DOMESTIC",
      netCents: 10000,
      taxCents: 2000,
      grossCents: 12000,
      ...over,
    })
    .returning()
    .get();
}

function setup() {
  const db = createTestDb();
  updateSettings(db, { paymentTermsDays: 14 });
  return db;
}

// inflow tests: outflows (incl. VAT estimates) off so the sums stay readable
const base = { months: 3, includeDrafts: false, includeOffers: false, offerProbability: 50, includeOutflows: false, today: TODAY };

describe("payment delays", () => {
  test("averages paidAt − dueDate per client with a global fallback", () => {
    const db = setup();
    const late = addClient(db);
    const punctual = addClient(db);
    addInvoice(db, { clientId: late.id, status: "paid", dueDate: "2026-05-01", paidAt: "2026-05-11" });
    addInvoice(db, { clientId: late.id, status: "paid", dueDate: "2026-06-01", paidAt: "2026-06-03" });
    addInvoice(db, { clientId: punctual.id, status: "paid", dueDate: "2026-06-10", paidAt: "2026-06-07" });
    const { byClient, global } = paymentDelays(db);
    expect(byClient.get(late.id)).toEqual({ days: 6, basis: "client", samples: 2 });
    expect(byClient.get(punctual.id)).toEqual({ days: -3, basis: "client", samples: 1 });
    expect(global).toEqual({ days: 3, basis: "global", samples: 3 });
  });

  test("no history → 0 days", () => {
    expect(paymentDelays(setup()).global).toEqual({ days: 0, basis: "none", samples: 0 });
  });
});

describe("open invoices", () => {
  test("expected = due date + client delay; overdue lands in the overdue bucket at today", () => {
    const db = setup();
    const late = addClient(db);
    addInvoice(db, { clientId: late.id, status: "paid", dueDate: "2026-05-01", paidAt: "2026-05-11" });
    const open = addInvoice(db, { clientId: late.id, dueDate: "2026-10-20" });
    const overdue = addInvoice(db, { clientId: late.id, dueDate: "2026-10-01", grossCents: 5000, taxCents: 0 });
    addInvoice(db, { clientId: late.id, status: "draft", number: null, dueDate: "2026-10-25" });

    const f = buildForecast(db, base);
    const byDoc = new Map(f.entries.map((e) => [e.documentId, e]));
    expect(f.entries).toHaveLength(2); // draft excluded by default
    expect(byDoc.get(open.id)!.expectedDate).toBe("2026-10-30");
    expect(byDoc.get(open.id)!.overdue).toBe(false);
    expect(byDoc.get(overdue.id)!.overdue).toBe(true);
    expect(byDoc.get(overdue.id)!.expectedDate).toBe(TODAY);
    expect(byDoc.get(overdue.id)!.daysOverdue).toBe(12);

    expect(f.overdueBucket.inCents).toBe(5000);
    expect(f.kpis.overdue).toBe(5000);
    expect(f.monthly.map((m) => m.key)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(f.monthly[0]!.inBySource.invoice).toBe(12000); // overdue not double counted
    expect(f.monthly[0]!.cumulativeCents).toBe(17000);
    expect(f.kpis.total).toBe(17000);
    expect(f.kpis.tax).toBe(2000);

    expect(buildForecast(db, { ...base, includeDrafts: true }).entries.some((e) => e.source === "draft")).toBe(true);
  });

  test("credit notes reduce the open amount", () => {
    const db = setup();
    const c = addClient(db);
    const inv = addInvoice(db, { clientId: c.id, dueDate: "2026-11-01" });
    db.insert(documents)
      .values({ type: "credit_note", status: "final", clientId: c.id, issueDate: "2026-10-01", taxMode: "AT_DOMESTIC", parentId: inv.id, grossCents: 12000, taxCents: 2000, netCents: 10000 })
      .run();
    expect(buildForecast(db, base).entries).toHaveLength(0);
  });
});

describe("recurring projection", () => {
  const rec = (clientId: number, over: Partial<RecurringCreate> = {}): RecurringCreate => ({
    name: "Wartung",
    clientId,
    active: true,
    intervalUnit: "month",
    intervalCount: 1,
    startDate: "2026-10-31",
    endDate: null,
    setServicePeriod: true,
    autoFinalize: false,
    taxMode: "AT_DOMESTIC",
    title: "",
    introText: "",
    closingText: "",
    templateId: null,
    items: [{ title: "Wartung", description: "", quantity: 1000, unit: "", unitPriceCents: 10000, taxRateBp: 2000, discountBp: 0 }],
    ...over,
  });

  test("projects every run whose payment falls inside the horizon, respecting endDate and active", () => {
    const db = setup();
    const c = addClient(db, { paymentTermsDays: 10 });
    createRecurring(db, rec(c.id));
    createRecurring(db, rec(c.id, { name: "Ende", endDate: "2026-11-15" }));
    createRecurring(db, rec(c.id, { name: "Aus", active: false }));
    createRecurring(db, rec(c.id, { name: "Quartal", intervalCount: 3, startDate: "2026-10-15" }));

    const f = buildForecast(db, base); // horizon until 2026-12-31
    const wartung = f.entries.filter((e) => e.label === "Wartung");
    // runs 31.10. and 30.11. pay on 10.11./10.12.; the 31.12. run pays in January
    expect(wartung.map((e) => e.expectedDate)).toEqual(["2026-11-10", "2026-12-10"]);
    expect(wartung[0]!.grossCents).toBe(12000);
    expect(wartung[0]!.taxCents).toBe(2000);
    expect(f.entries.filter((e) => e.label === "Ende")).toHaveLength(1);
    expect(f.entries.filter((e) => e.label === "Aus")).toHaveLength(0);
    expect(f.entries.filter((e) => e.label === "Quartal").map((e) => e.issueDate)).toEqual(["2026-10-15"]);
    expect(f.kpis.recurring).toBe(4 * 12000);

    const f12 = buildForecast(db, { ...base, months: 12 });
    expect(f12.entries.filter((e) => e.label === "Quartal")).toHaveLength(4);
  });
});

describe("offers", () => {
  test("weighted by probability, off by default, expired/declined excluded", () => {
    const db = setup();
    const c = addClient(db);
    const offer = (over: Partial<NewDocument>) =>
      db.insert(documents)
        .values({ type: "offer", status: "sent", clientId: c.id, issueDate: "2026-10-01", validUntil: "2026-10-31", taxMode: "AT_DOMESTIC", netCents: 100000, taxCents: 20000, grossCents: 120000, ...over })
        .run();
    offer({});
    offer({ validUntil: "2026-10-01" });
    offer({ status: "declined" });

    expect(buildForecast(db, base).entries).toHaveLength(0);
    const f = buildForecast(db, { ...base, includeOffers: true, offerProbability: 25 });
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]!.grossCents).toBe(30000);
    expect(f.entries[0]!.taxCents).toBe(5000);
    expect(f.entries[0]!.fullGrossCents).toBe(120000);
    expect(f.entries[0]!.expectedDate).toBe("2026-10-27");
  });
});

// ── Outflows ────────────────────────────────────────────────────────────────────

const out = { ...base, includeOutflows: true };

const fixed = (over: Partial<RecurringExpenseCreate> = {}): RecurringExpenseCreate => ({
  name: "Miete",
  supplierName: "Vermieter GmbH",
  category: "miete",
  active: true,
  intervalUnit: "month",
  intervalCount: 1,
  startDate: "2026-01-31",
  endDate: null,
  grossCents: 60000,
  taxCents: 10000,
  notes: "",
  ...over,
});

let expNo = 0;
function addExpense(db: Db, over: Partial<NewExpense> = {}, lines = [{ netCents: 10000, taxCents: 2000 }]) {
  const e = db
    .insert(expenses)
    .values({
      number: `ER-T-${++expNo}`,
      supplierName: "Lieferant",
      issueDate: "2026-10-01",
      dueDate: "2026-10-30",
      netCents: lines.reduce((s, l) => s + l.netCents, 0),
      taxCents: lines.reduce((s, l) => s + l.taxCents, 0),
      grossCents: lines.reduce((s, l) => s + l.netCents + l.taxCents, 0),
      ...over,
    })
    .returning()
    .get();
  lines.forEach((l, i) => db.insert(expenseLines).values({ expenseId: e.id, position: i, category: "sonstiges", taxRateBp: 2000, ...l }).run());
  return e;
}

/** Finalized invoice with one line (computeUva derives its totals from the items). */
function addInvoiceWithItem(db: Db, over: Partial<NewDocument> & { clientId: number }, netCents = 100000) {
  const doc = addInvoice(db, { netCents, taxCents: netCents / 5, grossCents: netCents * 1.2, ...over });
  db.insert(documentItems).values({ documentId: doc.id, position: 0, title: "Leistung", quantity: 1000, unitPriceCents: netCents, taxRateBp: 2000 }).run();
  return doc;
}

describe("Fixkosten", () => {
  test("every payment in the horizon, anchored to the start day, respecting end date and active", () => {
    const db = setup();
    updateSettings(db, { smallBusiness: true }); // no VAT rows in this test
    createRecurringExpense(db, fixed({ endDate: "2026-12-15" }));
    createRecurringExpense(db, fixed({ name: "SVS", supplierName: "", category: "svs", intervalCount: 3, startDate: "2026-02-15", grossCents: 120000, taxCents: 0 }));
    createRecurringExpense(db, fixed({ name: "Aus", active: false }));

    const f = buildForecast(db, out);
    const miete = f.entries.filter((e) => e.label === "Miete");
    expect(miete.map((e) => e.expectedDate)).toEqual(["2026-10-31", "2026-11-30"]); // 31.12. is after the end date
    expect(miete[0]).toMatchObject({ source: "fixed_cost", direction: "out", grossCents: 60000, taxCents: 10000, partyName: "Vermieter GmbH" });
    const svs = f.entries.filter((e) => e.label === "SVS");
    expect(svs.map((e) => e.expectedDate)).toEqual(["2026-11-15"]);
    expect(svs[0]!.partyName).toBe("SVS");
    expect(f.entries.some((e) => e.label === "Aus")).toBe(false);
    expect(f.kpis.fixedCosts).toBe(240000);
    expect(f.kpis.outTotal).toBe(240000);
    expect(f.monthly[1]!.outCents).toBe(180000);
    expect(f.monthly[1]!.outBySource.fixed_cost).toBe(180000);

    expect(buildForecast(db, { ...out, includeOutflows: false }).entries).toHaveLength(0);
  });
});

describe("unpaid expenses", () => {
  test("open expenses on their due date (fallback issue date + 14), overdue at today, drafts and paid ones skipped", () => {
    const db = setup();
    updateSettings(db, { smallBusiness: true });
    const future = addExpense(db);
    const overdue = addExpense(db, { dueDate: "2026-10-01" });
    const noDue = addExpense(db, { issueDate: "2026-10-10", dueDate: null });
    addExpense(db, { paidAt: "2026-10-05" });
    addExpense(db, {}, []); // incomplete draft
    const rc = addExpense(db, { vatTreatment: "reverse_charge", grossCents: 10000 });

    const f = buildForecast(db, out);
    const byId = new Map(f.entries.map((e) => [e.expenseId, e]));
    expect(f.entries).toHaveLength(4);
    expect(byId.get(future.id)).toMatchObject({ source: "expense", direction: "out", expectedDate: "2026-10-30", overdue: false, grossCents: 12000, taxCents: 2000 });
    expect(byId.get(overdue.id)).toMatchObject({ expectedDate: TODAY, overdue: true, daysOverdue: 12 });
    expect(byId.get(noDue.id)!.expectedDate).toBe("2026-10-24");
    // self-assessed VAT is not paid to the supplier and nets out in the UVA
    expect(byId.get(rc.id)).toMatchObject({ grossCents: 10000, taxCents: 0 });
    expect(f.overdueBucket.outCents).toBe(12000);
    expect(f.kpis.outOverdue).toBe(12000);
    expect(f.monthly[0]!.outCents).toBe(12000 * 2 + 10000);
  });
});

describe("VAT payments", () => {
  test("quarterly: ended period from the UVA, due 15th of the 2nd month after (next working day); future period estimated, refund = inflow", () => {
    const db = setup();
    const c = addClient(db);
    addInvoiceWithItem(db, { clientId: c.id, issueDate: "2026-09-10", status: "paid", paidAt: "2026-09-20", dueDate: "2026-09-24" });
    createRecurringExpense(db, fixed({ startDate: "2026-10-20" }));

    const f = buildForecast(db, { ...out, months: 6 }); // until 2027-03-31
    const vat = f.entries.filter((e) => e.source === "vat");
    expect(vat.map((e) => [e.vatPeriod, e.expectedDate, e.direction, e.grossCents, e.estimated])).toEqual([
      ["2026-Q3", "2026-11-16", "out", 20000, false], // 15.11.2026 is a Sunday
      ["2026-Q4", "2027-02-15", "in", 30000, true], // 3 × 100 € input VAT from the rent, no revenue
    ]);
    expect(vat[0]!.label).toContain("USt-Zahllast");
    expect(vat[1]!.label).toContain("USt-Gutschrift");
  });

  test("monthly + accrual: projected recurring runs add output VAT by invoice date; overdue UVA periods are not included", () => {
    const db = setup();
    updateSettings(db, { vatPeriod: "monthly" });
    const c = addClient(db, { paymentTermsDays: 30 });
    addInvoiceWithItem(db, { clientId: c.id, issueDate: "2026-07-10", status: "paid", paidAt: "2026-07-20", dueDate: "2026-07-24" });
    addInvoiceWithItem(db, { clientId: c.id, issueDate: "2026-08-10", status: "paid", paidAt: "2026-08-20", dueDate: "2026-08-24" });
    addInvoiceWithItem(db, { clientId: c.id, issueDate: "2026-09-10", status: "paid", paidAt: "2026-09-20", dueDate: "2026-09-24" }, 50000);
    createRecurring(db, {
      name: "Wartung",
      clientId: c.id,
      active: true,
      intervalUnit: "month",
      intervalCount: 1,
      startDate: "2026-10-20",
      endDate: null,
      setServicePeriod: false,
      autoFinalize: false,
      taxMode: "AT_DOMESTIC",
      title: "",
      introText: "",
      closingText: "",
      templateId: null,
      items: [{ title: "Wartung", description: "", quantity: 1000, unit: "", unitPriceCents: 50000, taxRateBp: 2000, discountBp: 0 }],
    });
    const rent = createRecurringExpense(db, fixed({ startDate: "2026-10-20" }));

    const vatRows = () =>
      buildForecast(db, out) // until 2026-12-31
        .entries.filter((e) => e.source === "vat")
        .map((e) => [e.vatPeriod, e.expectedDate, e.direction, e.grossCents, e.estimated]);
    // July was due 15.9. (past); Aug due 15.10.; Sep due 16.11.; Oct due 15.12.: run 20.10. (+100 €) − rent (−100 €) = 0 → no row
    expect(vatRows()).toEqual([
      ["2026-08", "2026-10-15", "out", 20000, false],
      ["2026-09", "2026-11-16", "out", 10000, false],
    ]);

    // without the rent the October run's VAT is owed
    updateRecurringExpense(db, rent.id, { active: false });
    expect(vatRows()[2]).toEqual(["2026-10", "2026-12-15", "out", 10000, true]);
  });

  test("cash basis: open invoices count in the period of their expected payment", () => {
    const db = setup();
    updateSettings(db, { vatPeriod: "monthly", vatBasis: "cash" });
    const c = addClient(db);
    addInvoiceWithItem(db, { clientId: c.id, issueDate: "2026-10-01", dueDate: "2026-11-05" });
    const f = buildForecast(db, { ...out, months: 6 });
    const vat = f.entries.filter((e) => e.source === "vat");
    expect(vat.map((e) => [e.vatPeriod, e.expectedDate, e.direction, e.grossCents, e.estimated])).toEqual([["2026-11", "2027-01-15", "out", 20000, true]]);
  });

  test("Kleinunternehmer: no VAT rows", () => {
    const db = setup();
    updateSettings(db, { smallBusiness: true });
    const c = addClient(db);
    addInvoiceWithItem(db, { clientId: c.id, issueDate: "2026-09-10", status: "paid", paidAt: "2026-09-20", dueDate: "2026-09-24" });
    expect(buildForecast(db, out).entries.filter((e) => e.source === "vat")).toHaveLength(0);
  });
});

describe("income tax prepayment", () => {
  test("quarterly on 15.2./15.5./15.8./15.11., moved to the next working day", () => {
    const db = setup();
    updateSettings(db, { smallBusiness: true });
    updateForecastSettings(db, { cashBalanceCents: null, cashBalanceDate: null, incomeTaxPrepaymentCents: 250000 });
    const f = buildForecast(db, { ...out, months: 12 }); // until 2027-09-30
    const est = f.entries.filter((e) => e.source === "income_tax");
    expect(est.map((e) => e.expectedDate)).toEqual(["2026-11-16", "2027-02-15", "2027-05-18", "2027-08-16"]); // 17.5.2027 is Pfingstmontag
    expect(est.every((e) => e.direction === "out" && e.grossCents === 250000)).toBe(true);
  });
});

describe("balance projection", () => {
  test("start balance + inflows − outflows; entries before the balance date ignored; lowest point flagged", () => {
    const db = setup();
    updateSettings(db, { smallBusiness: true });
    const c = addClient(db);
    addInvoice(db, { clientId: c.id, dueDate: "2026-11-05", grossCents: 300000, taxCents: 0 });
    addInvoice(db, { clientId: c.id, dueDate: "2026-10-01", grossCents: 5000, taxCents: 0 }); // overdue → today
    createRecurringExpense(db, fixed({ startDate: "2026-10-20", endDate: "2026-11-30" })); // 20.10., 20.11.
    addExpense(db, { dueDate: "2026-10-25" }, [{ netCents: 100000, taxCents: 0 }]);

    expect(buildForecast(db, out).balance).toBeNull();
    expect(buildForecast(db, out).monthly[0]!.balanceCents).toBeNull();

    updateForecastSettings(db, { cashBalanceCents: 100000, cashBalanceDate: "2026-10-10", incomeTaxPrepaymentCents: 0 });
    const f = buildForecast(db, out);
    // 13.10. +50 → 1.050; 20.10. −600 → 450; 25.10. −1.000 → −550; 5.11. +3.000 → 2.450; 20.11. −600 → 1.850
    expect(f.monthly.map((m) => m.balanceCents)).toEqual([-55000, 185000, 185000]);
    expect(f.monthly.map((m) => m.minBalanceCents)).toEqual([-55000, -55000, 185000]);
    expect(f.kpis.endBalance).toBe(185000);
    expect(f.kpis.lowestBalance).toEqual({ cents: -55000, date: "2026-10-25" });
    expect(f.monthly[0]!.netCents).toBe(-160000);
    expect(f.overdueBucket.netCents).toBe(5000);
    expect(f.kpis.netTotal).toBe(305000 - 220000);

    // a balance taken after the first rent already contains it
    updateForecastSettings(db, { cashBalanceCents: 100000, cashBalanceDate: "2026-10-21", incomeTaxPrepaymentCents: 0 });
    const g = buildForecast(db, out);
    expect(g.kpis.endBalance).toBe(100000 - 100000 + 300000 - 60000);
    expect(g.kpis.lowestBalance).toEqual({ cents: 0, date: "2026-10-25" });
  });
});
