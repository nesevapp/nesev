import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { parsePeriod, uvaDueDate, zmDueDate } from "../../shared/tax-report";
import { calcTotals } from "../../shared/totals";
import { createTestDb, type Db } from "../db/client";
import {
  bankAccounts,
  bankMatches,
  bankTransactions,
  clients,
  documentItems,
  documents,
  expenseLines,
  expenses,
  type NewDocument,
} from "../db/schema";
import { createAsset } from "./assets";
import { createCreditNote, createDocument, finalizeDocument, getDocument } from "./documents";
import { computeEar, computeUva, computeZm, earCsv, revenueEvents, uvaCsv, uvaValues } from "./tax";
import { uvaXmlErrors } from "./tax-xml";
import { setTaxStatus } from "./tax-status";
import { seedSeller } from "./test-seller";

const Q1 = parsePeriod("2026-Q1")!;
const Q2 = parsePeriod("2026-Q2")!;

interface Line {
  net: number;
  rate?: number;
}

function setup(status: Parameters<typeof setTaxStatus>[1] = {}) {
  const db = createTestDb();
  seedSeller(db);
  if (Object.keys(status).length) setTaxStatus(db, status);
  const at = db.insert(clients).values({ number: 1, name: "Wien GmbH", country: "AT" }).returning().get();
  const de = db.insert(clients).values({ number: 2, name: "Berlin GmbH", country: "DE", uid: "DE123456789" }).returning().get();
  const ch = db.insert(clients).values({ number: 3, name: "Zürich AG", country: "CH" }).returning().get();
  const account = db.insert(bankAccounts).values({ name: "Giro" }).returning().get();
  let seq = 0;

  const doc = (lines: Line[], over: Partial<NewDocument> = {}) => {
    const taxMode = over.taxMode ?? "AT_DOMESTIC";
    const items = lines.map((l, i) => ({ position: i, quantity: 1000, unitPriceCents: l.net, taxRateBp: l.rate ?? 2000 }));
    const t = calcTotals(items, taxMode);
    const client = over.clientId ?? at.id;
    const row = db
      .insert(documents)
      .values({
        type: "invoice",
        status: "final",
        number: `RE-${++seq}`,
        clientId: client,
        issueDate: "2026-02-10",
        taxMode,
        netCents: t.netCents,
        taxCents: t.taxCents,
        grossCents: t.grossCents,
        ...over,
      })
      .returning()
      .get();
    db.insert(documentItems).values(items.map((i) => ({ ...i, documentId: row.id }))).run();
    return row;
  };

  const expense = (
    vatTreatment: string,
    lines: { net: number; rate?: number; tax?: number; deductibleBp?: number; category?: string }[],
    over: Partial<typeof expenses.$inferInsert> = {},
  ) => {
    const row = db
      .insert(expenses)
      .values({ number: `ER-${++seq}`, supplierName: "Lieferant", issueDate: "2026-02-15", vatTreatment, ...over })
      .returning()
      .get();
    db.insert(expenseLines)
      .values(
        lines.map((l, i) => {
          const rate = l.rate ?? 2000;
          return {
            expenseId: row.id,
            position: i,
            category: l.category ?? "software_abos",
            netCents: l.net,
            taxRateBp: rate,
            taxCents: l.tax ?? Math.round((l.net * rate) / 10000),
            deductibleBp: l.deductibleBp ?? 10000,
          };
        }),
      )
      .run();
    return row;
  };

  const pay = (target: { documentId?: number; expenseId?: number }, date: string, amountCents: number) => {
    const tx = db
      .insert(bankTransactions)
      .values({ accountId: account.id, bookingDate: date, amountCents, importHash: `h${++seq}`, status: "matched" })
      .returning()
      .get();
    db.insert(bankMatches).values({ transactionId: tx.id, amountCents, ...target }).run();
  };

  return { db, at, de, ch, doc, expense, pay };
}

const v = (db: Db, period = Q1, opts = {}) => uvaValues(computeUva(db, period, opts));

describe("UVA Kennzahlen", () => {
  test("domestic 20/10/13 % invoices map to 022/029/006 and 000", () => {
    const { db, doc } = setup();
    doc([{ net: 100000, rate: 2000 }, { net: 50000, rate: 1000 }]);
    doc([{ net: 20000, rate: 1300 }], { issueDate: "2026-03-31" });
    doc([{ net: 99999 }], { issueDate: "2026-04-01" }); // next quarter
    doc([{ net: 77777 }], { status: "draft", number: null }); // drafts excluded

    const r = v(db);
    expect(r["000"]).toEqual({ amount: 170000, tax: null });
    expect(r["022"]).toEqual({ amount: 100000, tax: 20000 });
    expect(r["029"]).toEqual({ amount: 50000, tax: 5000 });
    expect(r["006"]).toEqual({ amount: 20000, tax: 2600 });
    expect(r["095"]).toEqual({ amount: 27600, tax: null });
  });

  test("credit notes are subtracted", () => {
    const { db, doc } = setup();
    const inv = doc([{ net: 100000 }]);
    doc([{ net: 30000 }], { type: "credit_note", number: "GS-1", parentId: inv.id, issueDate: "2026-03-01" });
    const r = v(db);
    expect(r["000"]!.amount).toBe(70000);
    expect(r["022"]).toEqual({ amount: 70000, tax: 14000 });
    expect(r["095"]!.amount).toBe(14000);
  });

  test("credit note exceeding revenue: base 0, tax corrected via 090", () => {
    const { db, doc } = setup();
    const inv = doc([{ net: 10000 }], { issueDate: "2025-12-01" });
    doc([{ net: 10000 }], { type: "credit_note", number: "GS-1", parentId: inv.id });
    const r = computeUva(db, Q1);
    const vals = uvaValues(r);
    expect(vals["022"]).toBeUndefined();
    expect(vals["090"]!.amount).toBe(-2000);
    expect(r.resultCents).toBe(-2000);
    expect(r.warnings.some((w) => w.includes("KZ 022"))).toBe(true);
  });

  test("negative rate KZ next to a positive one: 0 entered, KZ 000 adjusted so the U30 sums still match", () => {
    const { db, doc, expense } = setup();
    doc([{ net: 50000 }]); // 20 %
    const old = doc([{ net: 30000, rate: 1000 }], { issueDate: "2025-11-01" });
    doc([{ net: 20000, rate: 1000 }], { type: "credit_note", number: "GS-1", parentId: old.id }); // 10 %, Q1
    const r = computeUva(db, Q1);
    const vals = uvaValues(r);
    expect(vals["000"]!.amount).toBe(50000);
    expect(vals["022"]).toEqual({ amount: 50000, tax: 10000 });
    expect(vals["029"]).toBeUndefined();
    expect(vals["090"]!.amount).toBe(-2000);
    expect(r.resultCents).toBe(8000);
    expect(r.warnings.some((w) => w.includes("KZ 029") && w.includes("KZ 000"))).toBe(true);
    const FASTNR = { ok: true as const, fastnr: "123456789" };
    expect(uvaXmlErrors(r, FASTNR, "2026-10-19")).toEqual([]);

    // ig. acquisitions: a supplier credit (negative 10 % line) moves out of KZ 070 as well
    expense("ig_acquisition", [{ net: 40000 }], { supplierCountry: "DE" });
    expense("ig_acquisition", [{ net: -10000, rate: 1000 }], { supplierCountry: "DE" });
    const r2 = computeUva(db, Q1);
    const v2 = uvaValues(r2);
    expect(v2["070"]!.amount).toBe(40000);
    expect(v2["072"]).toEqual({ amount: 40000, tax: 8000 });
    expect(v2["073"]).toBeUndefined();
    expect(v2["090"]!.amount).toBe(-2000 - 1000);
    expect(v2["065"]!.amount).toBe(8000 - 1000); // Vorsteuer nets within the KZ
    expect(uvaXmlErrors(r2, FASTNR, "2026-10-19")).toEqual([]);
  });

  test("EU reverse charge and Swiss invoices are not taxable in AT (info only, ZM for EU)", () => {
    const { db, doc, de, ch } = setup();
    doc([{ net: 500000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE" });
    doc([{ net: 300000 }], { clientId: ch.id, taxMode: "THIRD_COUNTRY" });
    const r = computeUva(db, Q1);
    expect(uvaValues(r)).toEqual({});
    expect(r.info.find((i) => i.key === "eu_services")!.netCents).toBe(500000);
    expect(r.info.find((i) => i.key === "third_country")!.netCents).toBe(300000);
    expect(r.empty).toBe(false);

    // Optional: some advisors list EU services in 000 and 021.
    const alt = v(db, Q1, { euServicesIn021: true });
    expect(alt["000"]!.amount).toBe(500000);
    expect(alt["021"]!.amount).toBe(500000);
  });

  test("accrual vs cash basis: paid in the following period", () => {
    const { db, doc, pay } = setup();
    const inv = doc([{ net: 100000 }], { issueDate: "2026-03-20", status: "paid", paidAt: "2026-04-05" });
    expect(v(db, Q1)["022"]!.amount).toBe(100000);
    expect(v(db, Q2)["022"]).toBeUndefined();

    setTaxStatus(db, { vatBasis: "cash" });
    expect(v(db, Q1)["022"]).toBeUndefined();
    expect(v(db, Q2)["022"]).toEqual({ amount: 100000, tax: 20000 });

    // partial bank payment in Q1, rest marked paid in Q2
    pay({ documentId: inv.id }, "2026-03-25", 60000);
    expect(v(db, Q1)["022"]).toEqual({ amount: 50000, tax: 10000 });
    expect(v(db, Q2)["022"]).toEqual({ amount: 50000, tax: 10000 });
  });

  test("cash basis: unpaid invoice does not count; short payment absorbs the credit note", () => {
    const { db, doc, pay } = setup({ vatBasis: "cash" });
    doc([{ net: 50000 }]); // unpaid
    const inv = doc([{ net: 100000 }], { status: "paid", paidAt: "2026-03-10" });
    doc([{ net: 20000 }], { type: "credit_note", number: "GS-9", parentId: inv.id, issueDate: "2026-03-01" });
    pay({ documentId: inv.id }, "2026-03-10", 96000); // 120000 − 24000
    const r = v(db);
    expect(r["022"]).toEqual({ amount: 80000, tax: 16000 });
  });

  test("cash basis: absorbed credit note reduces its own rate, not the invoice mix", () => {
    const { db, doc, pay } = setup({ vatBasis: "cash" });
    const inv = doc([{ net: 100000 }, { net: 50000, rate: 1000 }], { status: "paid", paidAt: "2026-03-10" });
    doc([{ net: 20000 }], { type: "credit_note", number: "GS-1", parentId: inv.id, issueDate: "2026-03-01" });
    pay({ documentId: inv.id }, "2026-02-10", 100000); // partial
    // rest (175000 − 100000 − 24000) counted at paidAt by the "paid" status
    const r = v(db);
    expect(r["022"]).toEqual({ amount: 80000, tax: 16000 });
    expect(r["029"]).toEqual({ amount: 50000, tax: 5000 });
  });

  test("cash basis: a credit note dated after the hand-marked payment is not absorbed into it", () => {
    const { db, doc, pay } = setup({ vatBasis: "cash" });
    const inv = doc([{ net: 100000 }], { issueDate: "2026-02-10", status: "paid", paidAt: "2026-03-10" });
    const cn = doc([{ net: 20000 }], { type: "credit_note", number: "GS-1", parentId: inv.id, issueDate: "2026-06-05" });
    const march = parsePeriod("2026-03")!;
    const june = parsePeriod("2026-06")!;
    expect(v(db, march)["022"]).toEqual({ amount: 100000, tax: 20000 });
    expect(v(db, march)["000"]!.amount).toBe(100000);
    // June: the credit note on its own (base 0, tax corrected via 090)
    expect(v(db, june)["090"]!.amount).toBe(-4000);
    expect(computeUva(db, june).resultCents).toBe(-4000);

    // with a refund booked on the bank, it counts at the refund date instead
    pay({ documentId: cn.id }, "2026-07-02", 24000);
    expect(v(db, june)["090"]).toBeUndefined();
    expect(v(db, parsePeriod("2026-07")!)["090"]!.amount).toBe(-4000);
    expect(v(db, march)["022"]!.amount).toBe(100000);

    // a credit note dated up to the payment is still absorbed by it (the payment was smaller)
    const inv2 = doc([{ net: 50000 }], { issueDate: "2026-02-10", status: "paid", paidAt: "2026-03-20" });
    doc([{ net: 10000 }], { type: "credit_note", number: "GS-2", parentId: inv2.id, issueDate: "2026-03-20" });
    expect(v(db, march)["022"]!.amount).toBe(100000 + 40000);
  });

  test("EAR: a credit note in the next year doesn't reduce this year's hand-marked payment", () => {
    const { db, doc } = setup();
    const inv = doc([{ net: 100000 }], { issueDate: "2026-11-10", status: "paid", paidAt: "2026-12-10" });
    doc([{ net: 20000 }], { type: "credit_note", number: "GS-1", parentId: inv.id, issueDate: "2027-01-15" });
    expect(computeEar(db, 2026).incomeCents).toBe(100000);
    expect(computeEar(db, 2026).unpaid).toEqual([]);
    expect(computeEar(db, 2027).incomeCents).toBe(-20000);
  });

  test("cash basis: an invoice settled by a full credit note is no cash receipt", () => {
    const { db, at, pay } = setup({ vatBasis: "cash" });
    const item = { title: "Leistung", description: "", quantity: 1000, unit: "", unitPriceCents: 100000, taxRateBp: 2000, discountBp: 0 };
    const inv = finalizeDocument(db, createDocument(db, { type: "invoice", clientId: at.id, issueDate: "2026-02-10", items: [item] }).id);
    const cn = createCreditNote(db, inv.id);
    db.update(documents).set({ issueDate: "2026-03-05" }).where(eq(documents.id, cn.id)).run();
    finalizeDocument(db, cn.id);
    // settled (status paid via the credit note), but no money came in
    expect(getDocument(db, inv.id)).toMatchObject({ status: "paid", paidAt: "2026-03-05" });
    expect(revenueEvents(db, "cash")).toEqual([]);
    const r = v(db);
    expect(r["022"]).toBeUndefined();
    expect(r["000"]).toBeUndefined();
    expect(computeEar(db, 2026).incomeCents).toBe(0);

    // half credited, the rest paid by bank: only the bank payment is a cash receipt
    const inv2 = finalizeDocument(db, createDocument(db, { type: "invoice", clientId: at.id, issueDate: "2026-02-10", items: [item] }).id);
    pay({ documentId: inv2.id }, "2026-03-20", 60000);
    const cn2 = createCreditNote(db, inv2.id);
    db.update(documentItems).set({ unitPriceCents: 50000 }).where(eq(documentItems.documentId, cn2.id)).run();
    db.update(documents).set({ issueDate: "2026-03-15" }).where(eq(documents.id, cn2.id)).run();
    finalizeDocument(db, cn2.id); // recomputes totals → 60000 gross
    // paidAt = the later of the bank payment and the credit note
    expect(getDocument(db, inv2.id)).toMatchObject({ status: "paid", paidAt: "2026-03-20" });
    expect(v(db)["022"]).toEqual({ amount: 50000, tax: 10000 });
    expect(computeEar(db, 2026).incomeCents).toBe(50000);
  });

  test("reverse charge expense → 057 / 066, domestic → 060, deductible share", () => {
    const { db, expense } = setup();
    expense("reverse_charge", [{ net: 10000 }], { supplierCountry: "IE" });
    expense("domestic", [{ net: 50000, deductibleBp: 5000 }, { net: 10000, rate: 1000 }]);
    expense("none", [{ net: 9999, rate: 0 }]);
    const r = v(db);
    expect(r["057"]).toEqual({ amount: 2000, tax: null });
    expect(r["066"]!.amount).toBe(2000);
    expect(r["060"]!.amount).toBe(5000 + 1000);
    expect(r["095"]!.amount).toBe(2000 - 2000 - 6000);
  });

  test("ig acquisition → 070 / 072 / 065", () => {
    const { db, expense } = setup();
    expense("ig_acquisition", [{ net: 40000 }, { net: 10000, rate: 1000, deductibleBp: 0 }], { supplierCountry: "DE" });
    const r = v(db);
    expect(r["070"]!.amount).toBe(50000);
    expect(r["072"]).toEqual({ amount: 40000, tax: 8000 });
    expect(r["073"]).toEqual({ amount: 10000, tax: 1000 });
    expect(r["065"]!.amount).toBe(8000);
    expect(r["095"]!.amount).toBe(1000);
  });

  test("import EUSt → 061; cash basis defers domestic Vorsteuer to payment but not reverse charge", () => {
    const { db, expense, pay } = setup({ vatBasis: "cash" });
    expense("import", [{ net: 10000 }]);
    const dom = expense("domestic", [{ net: 10000 }]);
    expense("reverse_charge", [{ net: 10000 }]);
    let r = v(db);
    expect(r["061"]!.amount).toBe(2000);
    expect(r["060"]).toBeUndefined();
    expect(r["057"]!.amount).toBe(2000);
    pay({ expenseId: dom.id }, "2026-05-02", 12000);
    r = v(db, Q2);
    expect(r["060"]!.amount).toBe(2000);
  });

  test("empty period; incomplete expenses (no lines) are excluded with a warning", () => {
    const { db } = setup();
    db.insert(expenses).values({ supplierName: "", issueDate: "2026-02-01" }).run();
    const r = computeUva(db, Q1);
    expect(r.empty).toBe(true);
    expect(r.warnings).toEqual(["1 unvollständige Ausgabe (ohne Positionen) in diesem Zeitraum nicht berücksichtigt."]);
    expect(r.resultCents).toBe(0);
    expect(r.dueDate).toBe("2026-05-15");
    expect(uvaCsv(r).startsWith("﻿Kennzahl;Bezeichnung;Betrag;Steuer")).toBe(true);
  });
});

describe("due dates", () => {
  test("15th of the second following month, shifted past weekends/holidays", () => {
    expect(uvaDueDate(parsePeriod("2026-01")!)).toBe("2026-03-16"); // 15.3.2026 is a Sunday
    expect(uvaDueDate(parsePeriod("2026-Q2")!)).toBe("2026-08-17"); // 15.8. holiday (Sat) → Mon 17.8.
    expect(uvaDueDate(parsePeriod("2026-Q4")!)).toBe("2027-02-15");
    expect(zmDueDate(parsePeriod("2026-Q1")!)).toBe("2026-04-30");
  });
});

describe("ZM", () => {
  test("sums EU reverse-charge invoices per UID, credit notes subtracted", () => {
    const { db, doc, de } = setup();
    const a = doc([{ net: 100000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE", clientSnapshot: { uid: "DE 123 456 789", name: "Berlin GmbH", country: "DE" } as never });
    doc([{ net: 50000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE" });
    doc([{ net: 10000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE", type: "credit_note", number: "GS-1", parentId: a.id });
    doc([{ net: 70000 }]); // domestic: not in ZM
    const r = computeZm(db, Q1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ uid: "DE123456789", amountCents: 140000, services: true, triangular: false });
    expect(r.dueDate).toBe("2026-04-30");
  });
});

describe("EAR", () => {
  test("cash basis by payment date, net expenses by category, unpaid excluded", () => {
    const { db, doc, expense, pay } = setup({ vatBasis: "accrual" });
    doc([{ net: 100000 }], { issueDate: "2025-12-20", status: "paid", paidAt: "2026-01-10" }); // income 2026
    doc([{ net: 50000 }], { issueDate: "2026-12-20" }); // unpaid
    const inv = doc([{ net: 20000 }], { issueDate: "2026-03-01" });
    pay({ documentId: inv.id }, "2026-03-15", 12000); // half paid
    expense("domestic", [{ net: 10000, category: "software_abos" }, { net: 20000, category: "kfz", deductibleBp: 0 }], { paidAt: "2026-02-01" });
    expense("domestic", [{ net: 99999 }], { issueDate: "2026-11-01" }); // unpaid

    const r = computeEar(db, 2026);
    expect(r.incomeCents).toBe(100000 + 10000);
    expect(r.expensesCents).toBe(10000 + 24000); // KFZ: VAT not deductible → expense
    expect(r.profitCents).toBe(76000);
    expect(r.monthly[0]!.incomeCents).toBe(100000);
    expect(r.monthly[2]!.incomeCents).toBe(10000);
    expect(r.groups.map((g) => g.group).sort()).toEqual(["Betrieb", "Reise & Fahrzeug"]);
    expect(r.e1a.find((e) => e.kz === "9170")!.amountCents).toBe(24000);
    expect(r.unpaid.map((u) => [u.kind, u.openCents])).toEqual([
      ["document", 12000],
      ["expense", 119999],
      ["document", 60000],
    ]);
    expect(earCsv(r)).toContain("Gewinn / Verlust;;;;760,00");
  });

  test("anlagen lines are capitalized: AfA from the Anlagenverzeichnis under KZ 9130, UVA unchanged", () => {
    const { db, expense } = setup();
    const e = expense("domestic", [{ net: 240000, category: "anlagen" }, { net: 10000, category: "buero" }], { issueDate: "2026-09-10", paidAt: "2026-09-12" });
    let r = computeEar(db, 2026);
    expect(r.expensesCents).toBe(10000); // the laptop is no expense
    expect(r.warnings.some((w) => w.includes("im Anlagenverzeichnis anlegen"))).toBe(true);
    expect(r.e1a.find((x) => x.kz === "9130")).toBeUndefined();

    createAsset(db, { name: "MacBook", expenseId: e.id, acquisitionDate: "2026-09-10", inServiceDate: "2026-09-15", costCents: 240000, usefulLifeYears: 3 });
    r = computeEar(db, 2026);
    expect(r.expensesCents).toBe(10000 + 40000); // half-year AfA
    expect(r.e1a.find((x) => x.kz === "9130")!.amountCents).toBe(40000);
    const afa = r.groups.find((g) => g.group === "Anlagen")!.categories.find((c) => c.key === "afa")!;
    expect(afa.assets).toEqual([{ id: 1, number: "AV-0001", name: "MacBook", amountCents: 40000, note: "" }]);
    expect(r.warnings.some((w) => w.includes("Anlagenverzeichnis"))).toBe(false);
    expect(r.monthly.reduce((s, m) => s + m.expensesCents, 0)).toBe(r.expensesCents);
    expect(earCsv(r)).toContain("AV-0001;MacBook");
    expect(computeEar(db, 2027).expensesCents).toBe(80000);

    // input VAT on the asset stays deductible at once
    expect(v(db, parsePeriod("2026-Q3")!)["060"]!.amount).toBe(48000 + 2000);
  });

  test("GWG lines above the limit: expensed as booked, but with a warning (net; gross for Kleinunternehmer)", () => {
    const { db, expense } = setup();
    expense("domestic", [{ net: 150000, category: "hardware_gwg" }], { paidAt: "2026-03-01" });
    expense("domestic", [{ net: 100000, category: "hardware_gwg" }], { paidAt: "2026-03-01" }); // exactly the limit
    let r = computeEar(db, 2026);
    expect(r.expensesCents).toBe(250000);
    const gwg = r.warnings.filter((w) => w.includes("GWG-Grenze"));
    expect(gwg).toHaveLength(1);
    expect(gwg[0]).toStartWith("ER-");
    expect(computeEar(db, 2027).warnings.some((w) => w.includes("GWG-Grenze"))).toBe(false); // paid in 2026

    setTaxStatus(db, { smallBusiness: true });
    r = computeEar(db, 2026);
    expect(r.warnings.filter((w) => w.includes("GWG-Grenze"))).toHaveLength(2); // 1.200,00 gross
  });

  test("open at year end: refunds on credit notes booked by 31.12. count, later ones don't", () => {
    const { db, doc, pay } = setup();
    const inv = doc([{ net: 100000 }], { issueDate: "2026-10-01" });
    const cn = doc([{ net: 20000 }], { type: "credit_note", number: "GS-1", parentId: inv.id, issueDate: "2026-10-15" });
    pay({ documentId: inv.id }, "2026-11-02", 96000); // 1.200 − 240
    expect(computeEar(db, 2026).unpaid).toEqual([]);
    pay({ documentId: cn.id }, "2027-01-05", 24000); // refunded again (by mistake) next year
    expect(computeEar(db, 2026).unpaid).toEqual([]);
    pay({ documentId: cn.id }, "2026-12-20", 24000); // … and in December: the client owes 240 at year end
    expect(computeEar(db, 2026).unpaid.map((u) => [u.number, u.openCents])).toEqual([[inv.number ?? "", 24000]]);
  });

  test("Kleinunternehmer: expenses gross", () => {
    const { db, expense } = setup({ smallBusiness: true });
    expense("domestic", [{ net: 10000 }], { paidAt: "2026-02-01" });
    const r = computeEar(db, 2026);
    expect(r.gross).toBe(true);
    expect(r.expensesCents).toBe(12000);
  });
});
