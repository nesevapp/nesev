import { describe, expect, test } from "bun:test";
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
import { updateSettings } from "./settings";
import { computeEar, computeUva, computeZm, earCsv, uvaCsv, uvaValues } from "./tax";

const Q1 = parsePeriod("2026-Q1")!;
const Q2 = parsePeriod("2026-Q2")!;

interface Line {
  net: number;
  rate?: number;
}

function setup(settings: Parameters<typeof updateSettings>[1] = {}) {
  const db = createTestDb();
  if (Object.keys(settings).length) updateSettings(db, settings);
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

    updateSettings(db, { vatBasis: "cash" });
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

  test("Kleinunternehmer: expenses gross", () => {
    const { db, expense } = setup({ smallBusiness: true });
    expense("domestic", [{ net: 10000 }], { paidAt: "2026-02-01" });
    const r = computeEar(db, 2026);
    expect(r.gross).toBe(true);
    expect(r.expensesCents).toBe(12000);
  });
});
