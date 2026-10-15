import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { DEFAULT_ACCOUNTING_EXPORT_SETTINGS, resolveAccountingExportSettings } from "../../shared/accounting-export";
import { calcTotals } from "../../shared/totals";
import { createTestDb } from "../db/client";
import { bankAccounts, bankMatches, bankTransactions, clients, documentItems, documents, expenseLines, expenses, type NewDocument } from "../db/schema";
import {
  accountingExportSummary,
  accountingZipStream,
  bmdBelegnr,
  bmdCsv,
  bmdCsvText,
  bmdText,
  encodeCp1252,
  genericCsv,
  getAccountingExportSettings,
  updateAccountingExportSettings,
} from "./export-accounting";
import { updateSettings } from "./settings";

const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const NO_PAYMENTS = { payments: false };

function setup() {
  const db = createTestDb();
  const at = db.insert(clients).values({ number: 7, name: "Wien; GmbH", country: "AT" }).returning().get();
  const de = db.insert(clients).values({ number: 8, name: "Berlin GmbH", country: "DE", uid: "DE123456789" }).returning().get();
  const account = db.insert(bankAccounts).values({ name: "Giro" }).returning().get();
  let seq = 0;
  const doc = (lines: { net: number; rate?: number }[], over: Partial<NewDocument> = {}) => {
    const taxMode = over.taxMode ?? "AT_DOMESTIC";
    const items = lines.map((l, i) => ({ position: i, quantity: 1000, unitPriceCents: l.net, taxRateBp: l.rate ?? 2000 }));
    const t = calcTotals(items, taxMode);
    const row = db
      .insert(documents)
      .values({ type: "invoice", status: "final", number: `RE-2026-${String(++seq).padStart(4, "0")}`, clientId: at.id, issueDate: "2026-09-10", taxMode, netCents: t.netCents, taxCents: t.taxCents, grossCents: t.grossCents, ...over })
      .returning()
      .get();
    db.insert(documentItems).values(items.map((i) => ({ ...i, documentId: row.id }))).run();
    return row;
  };
  const expense = (
    vatTreatment: string,
    lines: { net: number; rate?: number; tax?: number; deductibleBp?: number; category?: string; description?: string }[],
    over: Partial<typeof expenses.$inferInsert> = {},
  ) => {
    const row = db
      .insert(expenses)
      .values({ number: `ER-2026-${String(++seq).padStart(4, "0")}`, supplierName: "Lieferant", issueDate: "2026-09-15", vatTreatment, ...over })
      .returning()
      .get();
    db.insert(expenseLines)
      .values(
        lines.map((l, i) => {
          const rate = l.rate ?? 2000;
          return {
            expenseId: row.id,
            position: i,
            category: l.category ?? "buero",
            description: l.description ?? "",
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
      .values({ accountId: account.id, bookingDate: date, amountCents, counterpartyName: "Bank-Partner", importHash: `h${++seq}`, status: "matched" })
      .returning()
      .get();
    db.insert(bankMatches).values({ transactionId: tx.id, amountCents: Math.abs(amountCents), ...target }).run();
  };
  return { db, at, de, doc, expense, pay };
}

/** BMD CSV → rows as objects keyed by header (UTF-8 for easy assertions). */
function bmdRows(db: ReturnType<typeof setup>["db"], payments = false) {
  updateAccountingExportSettings(db, { ...getAccountingExportSettings(db), encoding: "utf-8" });
  const text = new TextDecoder().decode(bmdCsv(db, RANGE, { payments })).replace(/^﻿/, "");
  const [header, ...lines] = text.trimEnd().split("\r\n");
  const cols = header!.split(";");
  return lines.map((l) => Object.fromEntries(l.split(";").map((v, i) => [cols[i]!, v])));
}

describe("settings", () => {
  test("null → defaults; partial and invalid values fall back per field", () => {
    expect(resolveAccountingExportSettings(null)).toEqual(DEFAULT_ACCOUNTING_EXPORT_SETTINGS);
    const s = resolveAccountingExportSettings({ revenueAccounts: { AT_2000: "4001", AT_1000: "abc" }, debtorPerClient: true, symbols: { invoice: "ar" }, unknown: 1 });
    expect(s.revenueAccounts.AT_2000).toBe("4001");
    expect(s.revenueAccounts.AT_1000).toBe("4010");
    expect(s.debtorPerClient).toBe(true);
    expect(s.symbols.invoice).toBe("AR");
    expect(s.expenseAccounts.buero).toBe("7600");
  });

  test("update round-trips through settings.accountingExport", () => {
    const db = createTestDb();
    const next = { ...DEFAULT_ACCOUNTING_EXPORT_SETTINGS, bankAccount: "2810", expenseAccounts: { ...DEFAULT_ACCOUNTING_EXPORT_SETTINGS.expenseAccounts, buero: "7601" } };
    updateAccountingExportSettings(db, next);
    expect(getAccountingExportSettings(db)).toEqual(next);
    expect(() => updateAccountingExportSettings(db, { ...next, bankAccount: "28 00" })).toThrow();
  });
});

describe("BMD helpers", () => {
  test("belegnr is numeric, max 9 digits", () => {
    expect(bmdBelegnr("RE-2026-0042")).toBe("20260042");
    expect(bmdBelegnr("GS-2026-0003", true)).toBe("920260003");
    expect(bmdBelegnr("X-123456789012")).toBe("456789012");
  });

  test("text drops separators and quotes, max 60 characters", () => {
    expect(bmdText('Muster; "Test"\nGmbH', "Hosting")).toBe("Muster Test GmbH Hosting");
    expect(bmdText("x".repeat(80))).toHaveLength(60);
  });

  test("Windows-1252 encoding incl. umlauts and €", () => {
    expect([...encodeCp1252("Bürö € –")]).toEqual([0x42, 0xfc, 0x72, 0xf6, 0x20, 0x80, 0x20, 0x96]);
    expect([...encodeCp1252("😀")]).toEqual([0x3f]);
  });
});

describe("BMD bookings", () => {
  test("invoice: one Haben line per rate on the revenue account, net and tax negative", () => {
    const { db, doc } = setup();
    doc([{ net: 100000 }, { net: 33333, rate: 1000 }]);
    const rows = bmdRows(db);
    expect(rows).toEqual([
      expect.objectContaining({ satzart: "0", konto: "4000", gkonto: "20000", belegnr: "20260001", belegdatum: "10.09.2026", buchsymbol: "AR", buchcode: "2", prozent: "20", steuercode: "1", betrag: "-1000,00", steuer: "-200,00", extbelegnr: "RE-2026-0001", dokument: "RE-2026-0001.pdf", gegenbuchkz: "E", verbuchkz: "A" }),
      expect.objectContaining({ konto: "4010", prozent: "10", steuercode: "1", betrag: "-333,33", steuer: "-33,33" }),
    ]);
    expect(rows[0]!.text).toBe("Wien GmbH");
  });

  test("credit note: Soll (positive) on the revenue account, own belegnr", () => {
    const { db, doc } = setup();
    const inv = doc([{ net: 10000 }], { issueDate: "2026-08-01" });
    doc([{ net: 2500 }], { type: "credit_note", number: "GS-2026-0001", parentId: inv.id });
    const [row] = bmdRows(db);
    expect(row).toMatchObject({ konto: "4000", buchsymbol: "GU", buchcode: "1", betrag: "25,00", steuer: "5,00", belegnr: "20260001", extbelegnr: "GS-2026-0001" });
    // sharing the invoice symbol: leading 9 keeps the number unique in the Belegkreis
    updateAccountingExportSettings(db, { ...getAccountingExportSettings(db), symbols: { ...DEFAULT_ACCOUNTING_EXPORT_SETTINGS.symbols, creditNote: "AR" } });
    expect(bmdRows(db)[0]).toMatchObject({ buchsymbol: "AR", belegnr: "920260001" });
    expect(row!.text).toBe("Gutschrift zu RE-2026-0001 Wien GmbH");
  });

  test("EU reverse charge, third country, Kleinunternehmer and per-client debtors", () => {
    const { db, doc, de } = setup();
    updateAccountingExportSettings(db, { ...getAccountingExportSettings(db), debtorPerClient: true, debtorAccount: "20000" });
    doc([{ net: 50000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE" });
    doc([{ net: 1000 }], { taxMode: "THIRD_COUNTRY" });
    doc([{ net: 2000 }], { taxMode: "SMALL_BUSINESS" });
    const rows = bmdRows(db);
    expect(rows[0]).toMatchObject({ konto: "4111", gkonto: "20008", steuercode: "77", prozent: "0", betrag: "-500,00", steuer: "0,00", uidnr: "DE123456789" });
    expect(rows[1]).toMatchObject({ konto: "4210", gkonto: "20007", steuercode: "81", betrag: "-10,00" });
    expect(rows[2]).toMatchObject({ konto: "4062", steuercode: "16", betrag: "-20,00" });
  });

  test("expenses: Vorsteuer, category accounts, partial and no deduction, ohne USt", () => {
    const { db, expense } = setup();
    expense("domestic", [{ net: 10000, description: "Papier" }, { net: 5000, category: "telefon_internet" }]);
    expense("domestic", [{ net: 10000, category: "kfz", deductibleBp: 0 }]);
    expense("domestic", [{ net: 10001, category: "bewirtung", deductibleBp: 5000 }]);
    expense("none", [{ net: 3000, rate: 0, category: "versicherung" }]);
    const rows = bmdRows(db);
    expect(rows.map((r) => [r.konto, r.gkonto, r.buchsymbol, r.buchcode, r.steuercode, r.prozent, r.betrag, r.steuer])).toEqual([
      ["7600", "33000", "ER", "1", "2", "20", "100,00", "20,00"],
      ["7380", "33000", "ER", "1", "2", "20", "50,00", "10,00"],
      ["7335", "33000", "ER", "1", "", "", "120,00", ""], // KFZ: gross as expense
      ["7660", "33000", "ER", "1", "2", "20", "50,01", "10,00"], // 50 % deductible (net share rounded)
      ["7660", "33000", "ER", "1", "", "", "60,00", ""], // rest net + non-deductible tax
      ["7700", "33000", "ER", "1", "", "", "30,00", ""],
    ]);
    expect(rows[0]!.text).toBe("Lieferant Papier");
    // the supplier's total (net + Vorsteuer) adds up to the gross amount
    const sum = (r: (typeof rows)[number]) => Number(r.betrag!.replace(",", ".")) + Number((r.steuer || "0").replace(",", "."));
    expect(Math.round((sum(rows[3]!) + sum(rows[4]!)) * 100)).toBe(10001 + 2000);
  });

  test("self-assessed tax: steuer opposite to betrag, EU vs. third country vs. ig. Erwerb", () => {
    const { db, expense } = setup();
    expense("reverse_charge", [{ net: 10000, category: "software_abos" }], { supplierCountry: "IE" });
    expense("reverse_charge", [{ net: 5000, category: "software_abos" }], { supplierCountry: "US" });
    expense("ig_acquisition", [{ net: 20000, category: "wareneinkauf" }], { supplierCountry: "DE" });
    expense("reverse_charge", [{ net: 1000, category: "kfz", deductibleBp: 0 }], { supplierCountry: "DE" });
    const rows = bmdRows(db);
    expect(rows.map((r) => [r.konto, r.steuercode, r.betrag, r.steuer])).toEqual([
      ["7840", "79", "100,00", "-20,00"],
      ["7840", "19", "50,00", "-10,00"],
      ["5000", "9", "200,00", "-40,00"],
      ["7335", "78", "10,00", "-2,00"],
    ]);
  });

  test("Kleinunternehmer: no Vorsteuer on expenses", () => {
    const { db, expense } = setup();
    updateSettings(db, { smallBusiness: true });
    expense("domestic", [{ net: 10000 }]);
    expect(bmdRows(db)[0]).toMatchObject({ steuercode: "", betrag: "120,00", steuer: "" });
  });

  test("anlagen lines go to the asset account (capitalized, no AfA)", () => {
    const { db, expense } = setup();
    expense("domestic", [{ net: 150000, category: "anlagen" }]);
    expect(bmdRows(db)[0]).toMatchObject({ konto: "0620", betrag: "1500,00", steuer: "300,00", steuercode: "2" });
  });

  test("bank payments (optional): BK on the bank account, OP-Nummer in extbelegnr", () => {
    const { db, doc, expense, pay } = setup();
    const inv = doc([{ net: 10000 }]);
    const exp = expense("domestic", [{ net: 5000 }]);
    pay({ documentId: inv.id }, "2026-09-20", 12000);
    pay({ expenseId: exp.id }, "2026-09-21T00:00:00", -6000);
    pay({ documentId: inv.id }, "2026-10-01", 1); // outside the range
    expect(bmdRows(db).length).toBe(2);
    const rows = bmdRows(db, true).slice(2);
    expect(rows).toEqual([
      expect.objectContaining({ konto: "2800", gkonto: "20000", buchsymbol: "BK", buchcode: "1", betrag: "120,00", steuer: "", steuercode: "", extbelegnr: "RE-2026-0001", belegdatum: "20.09.2026" }),
      expect.objectContaining({ konto: "2800", gkonto: "33000", buchcode: "2", betrag: "-60,00", extbelegnr: "ER-2026-0002" }),
    ]);
  });

  test("drafts and expenses outside the range are excluded", () => {
    const { db, doc, expense } = setup();
    doc([{ net: 100 }], { status: "draft", number: null });
    doc([{ net: 100 }], { issueDate: "2026-10-01" });
    expense("domestic", [{ net: 100 }], { issueDate: "2026-08-31" });
    expect(bmdRows(db)).toEqual([]);
  });

  test("default encoding is Windows-1252 without BOM, CRLF", () => {
    const { db, expense } = setup();
    expense("domestic", [{ net: 100, description: "Bürobedarf" }], { supplierName: "Müller & Söhne" });
    const bytes = bmdCsv(db, RANGE, NO_PAYMENTS);
    expect(bytes[0]).toBe("s".charCodeAt(0));
    expect(new TextDecoder("windows-1252").decode(bytes)).toContain("Müller & Söhne Bürobedarf");
    expect(bytes.includes(0xc3)).toBe(false); // no UTF-8 sequences
    expect(new TextDecoder("windows-1252").decode(bytes)).toContain("\r\n0;");
  });

  test("bmdCsvText header", () => {
    expect(bmdCsvText([]).split("\r\n")[0]).toBe(
      "satzart;konto;gkonto;belegnr;belegdatum;buchsymbol;buchcode;prozent;steuercode;betrag;steuer;text;extbelegnr;uidnr;gegenbuchkz;verbuchkz;dokument",
    );
  });
});

describe("generic CSV", () => {
  test("rows per rate / expense line, credit notes negative, file names", () => {
    const { db, doc, expense } = setup();
    const inv = doc([{ net: 10000 }]);
    doc([{ net: 2500 }], { type: "credit_note", number: "GS-2026-0001", parentId: inv.id });
    expense("reverse_charge", [{ net: 1000, category: "software_abos" }], { supplierCountry: "IE", attachmentPath: "receipts/2026/x.PDF", supplierInvoiceNumber: "INV-9" });
    const lines = genericCsv(db, RANGE, NO_PAYMENTS).replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toStartWith("Art;Belegnr;Belegdatum;Partner;Kundennr;Land;UID;Steuerfall;Kategorie;Steuersatz;Netto;Steuer;Brutto");
    // same date: ordered by number
    expect(lines[1]).toBe('Gutschrift;GS-2026-0001;10.09.2026;"Wien; GmbH";K-0007;AT;;Inland (AT);Inland 20 %;20;-25,00;-5,00;-30,00;;RE-2026-0001;;belege/GS-2026-0001.pdf');
    expect(lines[2]).toBe('Rechnung;RE-2026-0001;10.09.2026;"Wien; GmbH";K-0007;AT;;Inland (AT);Inland 20 %;20;100,00;20,00;120,00;;;;belege/RE-2026-0001.pdf');
    expect(lines[3]).toBe("Ausgabe;ER-2026-0003;15.09.2026;Lieferant;;IE;;Reverse Charge;Software & Abos;20;10,00;2,00;10,00;2,00;;INV-9;belege/ER-2026-0003.pdf");
  });
});

describe("summary and ZIP", () => {
  test("summary counts and missing receipts", () => {
    const { db, doc, expense } = setup();
    doc([{ net: 100 }]);
    expense("domestic", [{ net: 100 }]);
    expense("domestic", [{ net: 100 }], { attachmentPath: "receipts/a.pdf" });
    db.insert(expenses).values({ supplierName: "", issueDate: "2026-09-02" }).run(); // incomplete
    const s = accountingExportSummary(db, RANGE, NO_PAYMENTS);
    expect(s).toMatchObject({ label: "2026-09", invoices: 1, creditNotes: 0, expenses: 2, payments: 0, bookings: 3, missingReceipts: ["ER-2026-0002"] });
    expect(s.warnings[0]).toContain("1 unvollständige Ausgabe");
  });

  test("streamed ZIP: CSVs, README and receipts named by Belegnr", async () => {
    const { db, doc, expense } = setup();
    doc([{ net: 100 }]);
    expense("domestic", [{ net: 100 }], { attachmentPath: "receipts/2026/foto.JPG" });
    expense("domestic", [{ net: 100 }], { attachmentPath: "receipts/missing.pdf" });
    const files: Record<string, Uint8Array> = { "receipts/2026/foto.JPG": new Uint8Array([1, 2, 3]) };
    const stream = accountingZipStream(db, RANGE, NO_PAYMENTS, {
      render: async () => new TextEncoder().encode("%PDF-fake"),
      readFile: async (p) => (p ? (files[p] ?? null) : null),
    });
    const zip = unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));
    expect(Object.keys(zip).sort()).toEqual(["LIESMICH.txt", "belege.csv", "belege/ER-2026-0002.jpg", "belege/RE-2026-0001.pdf", "buchungen-bmd.csv"]);
    expect(new TextDecoder().decode(zip["belege/RE-2026-0001.pdf"])).toBe("%PDF-fake");
    expect([...zip["belege/ER-2026-0002.jpg"]!]).toEqual([1, 2, 3]);
    expect(new TextDecoder("windows-1252").decode(zip["buchungen-bmd.csv"])).toContain("ER-2026-0002;;E;A;ER-2026-0002.jpg");
  });
});
