import { extname, isAbsolute, relative, resolve } from "node:path";
import { and, asc, between, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import {
  type AccountingExportSettings,
  accountingExportSettingsSchema,
  REVENUE_ACCOUNT_LABELS,
  resolveAccountingExportSettings,
  revenueAccountKey,
} from "../../shared/accounting-export";
import { formatDate } from "../../shared/dates";
import { DOCUMENT_TYPE_LABELS } from "../../shared/documents";
import { categoryLabel, deductibleTaxCents, type ExpenseCategoryKey, getExpenseCategory, VAT_TREATMENT_SHORT_LABELS, type VatTreatment } from "../../shared/expenses";
import { roundHalfAwayFromZero } from "../../shared/money";
import { formatClientNumber } from "../../shared/schemas/client";
import { isEuCountry, TAX_MODE_LABELS, type TaxMode } from "../../shared/tax";
import { calcTotals } from "../../shared/totals";
import type { DbOrTx } from "../db/client";
import { bankMatches, bankTransactions, clients, documentItems, documents, expenseLines, expenses, settings } from "../db/schema";
import { DATA_DIR } from "../lib/paths";
import { csvAmount, csvRate, type ExportRange, listExportDocuments, rangeLabel, toCsv } from "./export";
import { documentPdfFileName, renderDocumentPdfWith } from "./pdf";
import { getSettings } from "./settings";

// Accountant export (Steuerberater): bookings for the BMD NTCS "Buchungsimport" (BMD standard interface for
// third-party systems, "BuErf variabel"), a generic CSV for RZL and others, and a ZIP with all receipts.
// Best effort — the format follows public descriptions of the BMD interface (BMD import guides of simplesoft and
// EDV-Hausleitner, the dvo "BuErf-Import" manual), not a test against BMD itself.
//
// BMD conventions used here:
// - One line per booking: `konto` = Sachkonto (Erlös/Aufwand/Anlage), `gkonto` = Personenkonto (Debitor/Kreditor)
//   or the bank. With a Sachkonto as `konto`, `betrag` is NET and `steuer` the tax amount.
// - Sign = Soll/Haben on `konto`: revenue negative (Haben, buchcode 2), credit notes and expenses positive (Soll,
//   buchcode 1). `steuer` has the sign of `betrag`, except self-assessed tax (reverse charge, ig. Erwerb): opposite.
// - Steuercodes (BMD standard): 1 USt, 2 Vorsteuer, 8/9 ig. Erwerb ohne/mit VSt-Abzug, 18/19 Reverse Charge
//   Drittland ohne/mit VSt, 78/79 sonstige Leistungen EU ohne/mit VSt, 77 EU-Leistungen (ZM), 16 Kleinunternehmer,
//   81 Umsatz nicht steuerbar (Drittland), 34 Einfuhrumsatzsteuer; empty = no tax (also the non-deductible part of
//   input VAT, booked as expense). Confirmed by the dvo BuErf table, domonda and the GLP Steuerberater samples
//   (which also use GU for credit notes); offices can remap codes in BMD, so check the first import.
// - belegnr numeric (max. 9 digits): "RE-2026-0042" → 20260042 (credit notes add a leading 9 when they share the
//   invoice Buchungssymbol); the full number goes to `extbelegnr` (= OP-Nummer) and names the file in `dokument`.
// - Decimal comma, dates TT.MM.JJJJ, ";" separated, Windows-1252 by default (UTF-8 optional), CRLF.
// Credit notes are positive in the DB; here they reduce revenue (Soll on the revenue account).

// ── Settings ─────────────────────────────────────────────────────────────────────

export function getAccountingExportSettings(db: DbOrTx): AccountingExportSettings {
  return resolveAccountingExportSettings(getSettings(db).accountingExport);
}

export function updateAccountingExportSettings(db: DbOrTx, data: AccountingExportSettings): AccountingExportSettings {
  const parsed = accountingExportSettingsSchema.parse(data);
  getSettings(db);
  db.update(settings).set({ accountingExport: parsed }).where(eq(settings.id, 1)).run();
  return getAccountingExportSettings(db);
}

// ── Source data ──────────────────────────────────────────────────────────────────

interface DocRow {
  id: number;
  type: "invoice" | "credit_note";
  number: string;
  issueDate: string;
  taxMode: TaxMode;
  clientNumber: number | null;
  clientName: string;
  clientUid: string;
  clientCountry: string;
  parentNumber: string;
  groups: { rateBp: number; netCents: number; taxCents: number }[];
  /** file name inside belege/ */
  fileName: string;
  pdfPath: string | null;
}

interface ExpenseRow {
  id: number;
  number: string;
  issueDate: string;
  supplierName: string;
  supplierUid: string;
  supplierCountry: string;
  supplierInvoiceNumber: string;
  description: string;
  treatment: VatTreatment;
  lines: { category: string; description: string; rateBp: number; netCents: number; taxCents: number; deductibleCents: number }[];
  /** file name inside belege/, null without receipt */
  fileName: string | null;
  attachmentPath: string | null;
}

interface PaymentRow {
  date: string;
  /** signed: incoming > 0 */
  amountCents: number;
  kind: "document" | "expense";
  number: string;
  party: string;
  clientNumber: number | null;
  counterparty: string;
}

function loadDocs(db: DbOrTx, range: ExportRange): DocRow[] {
  const docs = listExportDocuments(db, range).filter((d) => d.number);
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d.id);
  const items = db.select().from(documentItems).where(inArray(documentItems.documentId, ids)).all();
  const itemsByDoc = new Map<number, typeof items>();
  for (const i of items) itemsByDoc.set(i.documentId, [...(itemsByDoc.get(i.documentId) ?? []), i]);
  const liveClients = new Map(db.select().from(clients).all().map((c) => [c.id, c]));
  const parentIds = [...new Set(docs.map((d) => d.parentId).filter((id): id is number => id != null))];
  const parents = new Map(
    parentIds.length
      ? db.select({ id: documents.id, number: documents.number }).from(documents).where(inArray(documents.id, parentIds)).all().map((p) => [p.id, p.number ?? ""])
      : [],
  );
  return docs.map((d) => {
    const live = liveClients.get(d.clientId);
    const snap = d.clientSnapshot;
    const totals = calcTotals(itemsByDoc.get(d.id) ?? [], d.taxMode);
    return {
      id: d.id,
      type: d.type as "invoice" | "credit_note",
      number: d.number!,
      issueDate: d.issueDate,
      taxMode: d.taxMode,
      clientNumber: snap?.number ?? live?.number ?? null,
      clientName: snap?.name ?? live?.name ?? "",
      clientUid: snap?.uid ?? live?.uid ?? "",
      clientCountry: (snap?.country ?? live?.country ?? "").toUpperCase(),
      parentNumber: d.parentId != null ? (parents.get(d.parentId) ?? "") : "",
      groups: totals.taxGroups.length ? totals.taxGroups : [{ rateBp: 0, netCents: 0, taxCents: 0 }],
      fileName: documentPdfFileName(d),
      pdfPath: d.pdfPath,
    };
  });
}

function loadExpenses(db: DbOrTx, range: ExportRange, smallBusiness: boolean): ExpenseRow[] {
  const rows = db.select().from(expenses).where(between(expenses.issueDate, range.from, range.to)).orderBy(asc(expenses.issueDate), asc(expenses.id)).all();
  if (rows.length === 0) return [];
  const lines = db.select().from(expenseLines).where(inArray(expenseLines.expenseId, rows.map((r) => r.id))).all();
  const byExpense = new Map<number, typeof lines>();
  for (const l of lines) byExpense.set(l.expenseId, [...(byExpense.get(l.expenseId) ?? []), l]);
  const out: ExpenseRow[] = [];
  for (const e of rows) {
    const ls = (byExpense.get(e.id) ?? []).sort((a, b) => a.position - b.position);
    if (ls.length === 0) continue; // incomplete draft receipt
    const treatment = e.vatTreatment as VatTreatment;
    const number = e.number || `ER-${e.id}`;
    out.push({
      id: e.id,
      number,
      issueDate: e.issueDate,
      supplierName: e.supplierName,
      supplierUid: e.supplierUid,
      supplierCountry: e.supplierCountry.toUpperCase(),
      supplierInvoiceNumber: e.supplierInvoiceNumber,
      description: e.description,
      treatment,
      lines: ls.map((l) => {
        const taxCents = treatment === "none" ? 0 : l.taxCents;
        return {
          category: l.category,
          description: l.description,
          rateBp: treatment === "none" ? 0 : l.taxRateBp,
          netCents: l.netCents,
          taxCents,
          // Kleinunternehmer: no Vorsteuer at all
          deductibleCents: treatment === "none" || smallBusiness ? 0 : deductibleTaxCents({ taxCents, deductibleBp: l.deductibleBp }),
        };
      }),
      fileName: e.attachmentPath ? `${safeFileName(number)}${extname(e.attachmentPath).toLowerCase() || ".pdf"}` : null,
      attachmentPath: e.attachmentPath,
    });
  }
  return out;
}

function loadPayments(db: DbOrTx, range: ExportRange): PaymentRow[] {
  const rows = db
    .select({
      date: bankTransactions.bookingDate,
      txAmount: bankTransactions.amountCents,
      counterparty: bankTransactions.counterpartyName,
      amountCents: bankMatches.amountCents,
      documentId: bankMatches.documentId,
      expenseId: bankMatches.expenseId,
    })
    .from(bankMatches)
    .innerJoin(bankTransactions, eq(bankMatches.transactionId, bankTransactions.id))
    .where(between(bankTransactions.bookingDate, range.from, `${range.to}￿`))
    .orderBy(asc(bankTransactions.bookingDate), asc(bankMatches.id))
    .all();
  if (rows.length === 0) return [];
  const docIds = rows.map((r) => r.documentId).filter((id): id is number => id != null);
  const expIds = rows.map((r) => r.expenseId).filter((id): id is number => id != null);
  const docs = new Map(
    docIds.length
      ? db
          .select({ id: documents.id, number: documents.number, snap: documents.clientSnapshot, clientId: documents.clientId })
          .from(documents)
          .where(and(inArray(documents.id, docIds), ne(documents.status, "draft"), isNotNull(documents.number)))
          .all()
          .map((d) => [d.id, d])
      : [],
  );
  const liveClients = new Map(db.select().from(clients).all().map((c) => [c.id, c]));
  const exps = new Map(
    expIds.length ? db.select({ id: expenses.id, number: expenses.number, supplierName: expenses.supplierName }).from(expenses).where(inArray(expenses.id, expIds)).all().map((e) => [e.id, e]) : [],
  );
  const out: PaymentRow[] = [];
  for (const r of rows) {
    const sign = r.txAmount < 0 ? -1 : 1;
    const base = { date: r.date.slice(0, 10), amountCents: sign * r.amountCents, counterparty: r.counterparty };
    if (r.documentId != null) {
      const d = docs.get(r.documentId);
      if (!d) continue;
      const live = liveClients.get(d.clientId);
      out.push({ ...base, kind: "document", number: d.number!, party: d.snap?.name ?? live?.name ?? "", clientNumber: d.snap?.number ?? live?.number ?? null });
    } else if (r.expenseId != null) {
      const e = exps.get(r.expenseId);
      if (!e) continue;
      out.push({ ...base, kind: "expense", number: e.number || `ER-${e.id}`, party: e.supplierName, clientNumber: null });
    }
  }
  return out;
}

// ── BMD bookings ─────────────────────────────────────────────────────────────────

export interface BmdBooking {
  symbol: string;
  konto: string;
  gkonto: string;
  belegnr: string;
  /** "YYYY-MM-DD" */
  belegdatum: string;
  buchcode: 1 | 2;
  /** percent (20, 13, 10, 0) or null when no tax applies */
  prozent: number | null;
  steuercode: string;
  /** signed: Soll > 0, Haben < 0 on `konto` */
  betragCents: number;
  steuerCents: number;
  text: string;
  extbelegnr: string;
  uid: string;
  dokument: string;
}

export const BMD_COLUMNS = [
  "satzart",
  "konto",
  "gkonto",
  "belegnr",
  "belegdatum",
  "buchsymbol",
  "buchcode",
  "prozent",
  "steuercode",
  "betrag",
  "steuer",
  "text",
  "extbelegnr",
  "uidnr",
  "gegenbuchkz",
  "verbuchkz",
  "dokument",
] as const;

/** "RE-2026-0042" → "20260042"; longer digit runs keep the last 9 digits (BMD's limit). */
export function bmdBelegnr(number: string, prefix9 = false): string {
  const digits = number.replace(/\D/g, "").replace(/^0+/, "");
  const n = prefix9 ? `9${digits.slice(-8)}` : digits.slice(-9);
  return n || "0";
}

function debtorAccount(s: AccountingExportSettings, clientNumber: number | null): string {
  if (!s.debtorPerClient || clientNumber == null) return s.debtorAccount;
  return String(Number(s.debtorAccount) + clientNumber);
}

const REVENUE_STEUERCODE: Record<TaxMode, string> = {
  AT_DOMESTIC: "1",
  EU_REVERSE_CHARGE: "77",
  THIRD_COUNTRY: "81",
  SMALL_BUSINESS: "16",
};

/** Text for BMD: no separators, quotes or line breaks (BMD's CSV reader doesn't unquote), max. 60 characters. */
export function bmdText(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/[;"\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 60)
    .trim();
}

function pct(rateBp: number): number {
  return rateBp / 100;
}

/** Split `value` in the ratio part/total (rounded half away from zero). */
function share(value: number, part: number, total: number): number {
  return total === 0 ? 0 : roundHalfAwayFromZero((value * part) / total);
}

export function documentBookings(d: DocRow, s: AccountingExportSettings): BmdBooking[] {
  const credit = d.type === "credit_note";
  const symbol = credit ? s.symbols.creditNote : s.symbols.invoice;
  const sign = credit ? 1 : -1; // revenue on Haben, credit notes reduce it (Soll)
  const steuercode = REVENUE_STEUERCODE[d.taxMode] ?? "";
  return d.groups.map((g) => ({
    symbol,
    konto: s.revenueAccounts[revenueAccountKey(d.taxMode, g.rateBp)],
    gkonto: debtorAccount(s, d.clientNumber),
    belegnr: bmdBelegnr(d.number, credit && s.symbols.creditNote === s.symbols.invoice),
    belegdatum: d.issueDate,
    buchcode: credit ? 1 : 2,
    prozent: d.taxMode === "AT_DOMESTIC" ? pct(g.rateBp) : 0,
    steuercode: d.taxMode === "AT_DOMESTIC" && g.rateBp === 0 ? "" : steuercode,
    betragCents: sign * g.netCents,
    steuerCents: sign * g.taxCents,
    text: bmdText(credit ? `Gutschrift${d.parentNumber ? ` zu ${d.parentNumber}` : ""}` : "", d.clientName),
    extbelegnr: d.number,
    uid: d.clientUid.replace(/\s/g, "").toUpperCase(),
    dokument: d.fileName,
  }));
}

/** Steuercodes for self-assessed tax: [with Vorsteuer, without]. */
function selfAssessedCodes(e: ExpenseRow): [string, string] {
  if (e.treatment === "ig_acquisition") return ["9", "8"];
  return e.supplierCountry !== "AT" && isEuCountry(e.supplierCountry) ? ["79", "78"] : ["19", "18"];
}

export function expenseBookings(e: ExpenseRow, s: AccountingExportSettings): BmdBooking[] {
  const base = {
    symbol: s.symbols.expense,
    gkonto: s.creditorAccount,
    belegnr: bmdBelegnr(e.number),
    belegdatum: e.issueDate,
    buchcode: 1 as const,
    extbelegnr: e.number,
    uid: e.supplierUid.replace(/\s/g, "").toUpperCase(),
    dokument: e.fileName ?? "",
  };
  const out: BmdBooking[] = [];
  for (const l of e.lines) {
    const konto = s.expenseAccounts[l.category as ExpenseCategoryKey] ?? s.expenseAccounts.sonstiges;
    const text = bmdText(e.supplierName, l.description || e.description || categoryLabel(l.category));
    const line = (betragCents: number, steuerCents: number, steuercode: string, prozent: number | null) =>
      out.push({ ...base, konto, text, betragCents, steuerCents, steuercode, prozent });

    switch (e.treatment) {
      case "domestic":
      case "import": {
        const code = e.treatment === "import" ? "34" : "2";
        if (l.taxCents === 0) line(l.netCents, 0, code, pct(l.rateBp));
        else if (l.deductibleCents === l.taxCents) line(l.netCents, l.taxCents, code, pct(l.rateBp));
        else {
          // Partly deductible: the deductible share with Vorsteuer, the rest (net + non-deductible tax) as expense.
          const net = share(l.netCents, l.deductibleCents, l.taxCents);
          if (l.deductibleCents) line(net, l.deductibleCents, code, pct(l.rateBp));
          line(l.netCents - net + l.taxCents - l.deductibleCents, 0, "", null);
        }
        break;
      }
      case "reverse_charge":
      case "ig_acquisition": {
        // Tax owed and (as far as deductible) Vorsteuer at once; steuer with the opposite sign of betrag.
        const [withVst, withoutVst] = selfAssessedCodes(e);
        if (l.deductibleCents === l.taxCents) line(l.netCents, -l.taxCents, withVst, pct(l.rateBp));
        else if (l.deductibleCents === 0) line(l.netCents, -l.taxCents, withoutVst, pct(l.rateBp));
        else {
          const net = share(l.netCents, l.deductibleCents, l.taxCents);
          line(net, -l.deductibleCents, withVst, pct(l.rateBp));
          line(l.netCents - net, -(l.taxCents - l.deductibleCents), withoutVst, pct(l.rateBp));
        }
        break;
      }
      case "none":
        line(l.netCents, 0, "", null);
        break;
    }
  }
  return out;
}

export function paymentBookings(p: PaymentRow, s: AccountingExportSettings): BmdBooking {
  return {
    symbol: s.symbols.bank,
    konto: s.bankAccount,
    gkonto: p.kind === "document" ? debtorAccount(s, p.clientNumber) : s.creditorAccount,
    belegnr: bmdBelegnr(p.date),
    belegdatum: p.date,
    buchcode: p.amountCents >= 0 ? 1 : 2,
    prozent: null,
    steuercode: "",
    betragCents: p.amountCents,
    steuerCents: 0,
    text: bmdText(p.amountCents >= 0 ? "Zahlung" : "Zahlung an", p.party || p.counterparty, p.number),
    // OP-Nummer: clears the open item of the invoice / receipt
    extbelegnr: p.number,
    uid: "",
    dokument: "",
  };
}

function bmdDate(iso: string): string {
  return formatDate(iso); // TT.MM.JJJJ
}

export function bmdRow(b: BmdBooking): string[] {
  return [
    "0",
    b.konto,
    b.gkonto,
    b.belegnr,
    bmdDate(b.belegdatum),
    b.symbol,
    String(b.buchcode),
    b.prozent == null ? "" : String(b.prozent).replace(".", ","),
    b.steuercode,
    csvAmount(b.betragCents),
    b.steuerCents === 0 && b.prozent == null ? "" : csvAmount(b.steuerCents),
    b.text,
    b.extbelegnr,
    b.uid,
    "E",
    "A",
    b.dokument,
  ];
}

// ── Windows-1252 ─────────────────────────────────────────────────────────────────

const CP1252_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b,
  "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99,
  "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** Encode as Windows-1252; characters outside it become "?". */
export function encodeCp1252(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  let n = 0;
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[n++] = c;
    else out[n++] = CP1252_EXTRA[ch] ?? 0x3f;
  }
  return out.slice(0, n);
}

// ── Exports ──────────────────────────────────────────────────────────────────────

export interface AccountingExportOptions {
  /** also export bank payments (BK) that clear the open items */
  payments: boolean;
}

interface Loaded {
  settings: AccountingExportSettings;
  docs: DocRow[];
  expenses: ExpenseRow[];
  payments: PaymentRow[];
}

function load(db: DbOrTx, range: ExportRange, options: AccountingExportOptions): Loaded {
  const s = getSettings(db);
  return {
    settings: resolveAccountingExportSettings(s.accountingExport),
    docs: loadDocs(db, range),
    expenses: loadExpenses(db, range, s.smallBusiness),
    payments: options.payments ? loadPayments(db, range) : [],
  };
}

function bookingsOf(l: Loaded): BmdBooking[] {
  return [
    ...l.docs.flatMap((d) => documentBookings(d, l.settings)),
    ...l.expenses.flatMap((e) => expenseBookings(e, l.settings)),
    ...l.payments.map((p) => paymentBookings(p, l.settings)),
  ];
}

/** BMD CSV as text (header + rows, ";" separated, CRLF; no BOM). Encode with bmdCsvBytes. */
export function bmdCsvText(bookings: BmdBooking[]): string {
  return [BMD_COLUMNS.join(";"), ...bookings.map((b) => bmdRow(b).join(";"))].join("\r\n") + "\r\n";
}

function bmdBytes(text: string, encoding: AccountingExportSettings["encoding"]): Uint8Array {
  return encoding === "utf-8" ? new TextEncoder().encode(`﻿${text}`) : encodeCp1252(text);
}

export function bmdCsv(db: DbOrTx, range: ExportRange, options: AccountingExportOptions): Uint8Array {
  const l = load(db, range, options);
  return bmdBytes(bmdCsvText(bookingsOf(l)), l.settings.encoding);
}

export const GENERIC_COLUMNS = [
  "Art",
  "Belegnr",
  "Belegdatum",
  "Partner",
  "Kundennr",
  "Land",
  "UID",
  "Steuerfall",
  "Kategorie",
  "Steuersatz",
  "Netto",
  "Steuer",
  "Brutto",
  "Vorsteuer abziehbar",
  "Bezugsbeleg",
  "Lieferanten-Rechnungsnr",
  "Datei",
] as const;

/**
 * Generic CSV (RZL and others, no account numbers): one row per document and tax rate resp. per expense line,
 * plus payments. Revenue positive, credit notes negative; expenses positive in their own rows ("Ausgabe").
 * Excel-friendly like the other exports (UTF-8 with BOM, ";", decimal comma).
 */
function genericRows(l: Loaded): string[][] {
  const rows: string[][] = [];
  for (const d of l.docs) {
    const sign = d.type === "credit_note" ? -1 : 1;
    for (const g of d.groups) {
      rows.push([
        DOCUMENT_TYPE_LABELS[d.type],
        d.number,
        formatDate(d.issueDate),
        d.clientName,
        d.clientNumber ? formatClientNumber(d.clientNumber) : "",
        d.clientCountry,
        d.clientUid,
        TAX_MODE_LABELS[d.taxMode] ?? d.taxMode,
        REVENUE_ACCOUNT_LABELS[revenueAccountKey(d.taxMode, g.rateBp)],
        csvRate(g.rateBp),
        csvAmount(sign * g.netCents),
        csvAmount(sign * g.taxCents),
        csvAmount(sign * (g.netCents + g.taxCents)),
        "",
        d.parentNumber,
        "",
        `belege/${d.fileName}`,
      ]);
    }
  }
  for (const e of l.expenses) {
    const selfAssessed = e.treatment === "reverse_charge" || e.treatment === "ig_acquisition";
    for (const line of e.lines) {
      rows.push([
        "Ausgabe",
        e.number,
        formatDate(e.issueDate),
        e.supplierName,
        "",
        e.supplierCountry,
        e.supplierUid,
        VAT_TREATMENT_SHORT_LABELS[e.treatment] ?? e.treatment,
        getExpenseCategory(line.category)?.label ?? line.category,
        csvRate(line.rateBp),
        csvAmount(line.netCents),
        csvAmount(line.taxCents),
        // payable to the supplier: self-assessed tax isn't part of it
        csvAmount(line.netCents + (selfAssessed ? 0 : line.taxCents)),
        csvAmount(line.deductibleCents),
        "",
        e.supplierInvoiceNumber,
        e.fileName ? `belege/${e.fileName}` : "",
      ]);
    }
  }
  for (const p of l.payments) {
    rows.push([
      p.amountCents >= 0 ? "Zahlungseingang" : "Zahlungsausgang",
      p.number,
      formatDate(p.date),
      p.party || p.counterparty,
      p.clientNumber ? formatClientNumber(p.clientNumber) : "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      csvAmount(p.amountCents),
      "",
      "",
      "",
      "",
    ]);
  }
  return rows;
}

export function genericCsv(db: DbOrTx, range: ExportRange, options: AccountingExportOptions): string {
  return toCsv(GENERIC_COLUMNS, genericRows(load(db, range, options)));
}

// ── Summary ──────────────────────────────────────────────────────────────────────

export interface AccountingExportSummary {
  label: string;
  invoices: number;
  creditNotes: number;
  expenses: number;
  payments: number;
  bookings: number;
  /** expenses without an attached receipt */
  missingReceipts: string[];
  warnings: string[];
}

export function accountingExportSummary(db: DbOrTx, range: ExportRange, options: AccountingExportOptions): AccountingExportSummary {
  const l = load(db, range, options);
  const warnings: string[] = [];
  const incomplete = db
    .select({ id: expenses.id })
    .from(expenses)
    .where(between(expenses.issueDate, range.from, range.to))
    .all()
    .filter((e) => !l.expenses.some((x) => x.id === e.id)).length;
  if (incomplete) warnings.push(`${incomplete} unvollständige ${incomplete === 1 ? "Ausgabe" : "Ausgaben"} (ohne Positionen) nicht enthalten.`);
  for (const d of l.docs) {
    if (d.taxMode === "EU_REVERSE_CHARGE" && !d.clientUid.trim()) warnings.push(`${d.number}: Reverse Charge ohne UID des Kunden.`);
  }
  if (l.settings.debtorPerClient && l.docs.some((d) => d.clientNumber == null)) warnings.push("Belege ohne Kundennummer werden auf das Debitoren-Sammelkonto gebucht.");
  return {
    label: rangeLabel(range),
    invoices: l.docs.filter((d) => d.type === "invoice").length,
    creditNotes: l.docs.filter((d) => d.type === "credit_note").length,
    expenses: l.expenses.length,
    payments: l.payments.length,
    bookings: bookingsOf(l).length,
    missingReceipts: l.expenses.filter((e) => !e.fileName).map((e) => e.number),
    warnings,
  };
}

// ── ZIP (streamed) ───────────────────────────────────────────────────────────────

const README = `nesev – Export für die Steuerberatung

Inhalt:
  buchungen-bmd.csv   Buchungen im BMD-Importformat (BMD NTCS „Buchungsimport“, Standardschnittstelle
                      für Fremdsysteme): Ausgangsrechnungen (AR), Gutschriften, Eingangsrechnungen (ER)
                      und optional Bankzahlungen (BK). Konto = Erlös-/Aufwandskonto, Gegenkonto =
                      Personenkonto, Betrag netto, Steuer getrennt, Dezimalkomma, Datum TT.MM.JJJJ.
  belege.csv          Dieselben Belege ohne Kontonummern (z.B. für RZL oder Excel), UTF-8.
  belege/             PDFs der Rechnungen/Gutschriften und die Belege der Ausgaben, benannt nach der
                      Belegnummer (Spalte „extbelegnr“ bzw. „Belegnr“, Spalte „dokument“ in der BMD-Datei).

Hinweise:
  - Das BMD-Format ist nach öffentlichen Beschreibungen der BMD-Schnittstelle umgesetzt und nicht gegen
    BMD selbst getestet. Bitte den ersten Import gemeinsam mit der Steuerberatung prüfen
    (Kontenplan, Personenkonten, Steuercodes, Buchungssymbole).
  - Kontonummern und Buchungssymbole sind in nesev unter „Export → Steuerberatung“ einstellbar.
  - Gutschriften stehen als Erlösminderung im Soll (positiver Betrag), Erlöse im Haben (negativ).
  - Anlagegüter werden auf das Anlagenkonto gebucht; die AfA ist nicht enthalten.
  - Keine Steuerberatung: alle Werte vor der Übernahme prüfen.
`;

/** Bytes of a receipt/PDF path under data/, or null when missing or outside data/. */
async function dataFile(path: string | null): Promise<Uint8Array | null> {
  if (!path) return null;
  const abs = resolve(DATA_DIR, path);
  const rel = relative(DATA_DIR, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  const file = Bun.file(abs);
  return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
}

function safeFileName(s: string): string {
  return s.replace(/[^\w.\-]+/g, "_");
}

/**
 * ZIP stream: buchungen-bmd.csv, belege.csv, LIESMICH.txt and belege/<Belegnr>.<ext>. Files are added one by one,
 * so memory stays at about one receipt at a time. Missing invoice PDFs are rendered on the fly.
 */
export function accountingZipStream(
  db: DbOrTx,
  range: ExportRange,
  options: AccountingExportOptions,
  deps: { render?: (id: number) => Promise<Uint8Array>; readFile?: (path: string | null) => Promise<Uint8Array | null> } = {},
): ReadableStream<Uint8Array> {
  const render = deps.render ?? ((id: number) => renderDocumentPdfWith(db, id));
  const readFile = deps.readFile ?? dataFile;
  const l = load(db, range, options);
  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) return controller.error(err);
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      const add = (name: string, bytes: Uint8Array, compress: boolean) => {
        const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
        zip.add(entry);
        entry.push(bytes, true);
      };
      try {
        add("LIESMICH.txt", new TextEncoder().encode(README), true);
        add("buchungen-bmd.csv", bmdBytes(bmdCsvText(bookingsOf(l)), l.settings.encoding), true);
        add("belege.csv", new TextEncoder().encode(toCsv(GENERIC_COLUMNS, genericRows(l))), true);
        for (const d of l.docs) {
          const bytes = (await readFile(d.pdfPath)) ?? (await render(d.id));
          add(`belege/${d.fileName}`, bytes, false);
        }
        for (const e of l.expenses) {
          if (!e.fileName) continue;
          const bytes = await readFile(e.attachmentPath);
          if (bytes) add(`belege/${e.fileName}`, bytes, false);
        }
        zip.end();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      zip?.terminate();
    },
  });
}

export const accountingFileNames = {
  bmd: (range: ExportRange) => `buchungen-bmd-${rangeLabel(range)}.csv`,
  generic: (range: ExportRange) => `belege-steuerberatung-${rangeLabel(range)}.csv`,
  zip: (range: ExportRange) => `steuerberatung-${rangeLabel(range)}.zip`,
};
