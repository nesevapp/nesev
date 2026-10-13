import { isAbsolute, relative, resolve } from "node:path";
import { and, asc, between, inArray, ne } from "drizzle-orm";
import { zipSync, type Zippable } from "fflate";
import { formatDate } from "../../shared/dates";
import { DOCUMENT_TYPE_LABELS } from "../../shared/documents";
import { formatClientNumber } from "../../shared/schemas/client";
import { TAX_MODE_LABELS, type TaxMode } from "../../shared/tax";
import { calcTotals } from "../../shared/totals";
import type { DbOrTx } from "../db/client";
import { clients, documentItems, documents, type Document } from "../db/schema";
import { DATA_DIR } from "../lib/paths";
import { documentPdfFileName, renderDocumentPdfWith } from "./pdf";

// CSV for the accountant, tuned for Excel with Austrian locale:
// UTF-8 with BOM, ";" separator, CRLF line endings, decimal comma without thousands separator,
// dates as DD.MM.YYYY. Credit notes are exported with negative amounts.
//
// One row per document AND tax rate: a document with 20 % and 10 % lines yields two rows that share
// all document columns and carry the net/tax/gross of that rate group (calcTotals().taxGroups, the
// same calculation as UI and PDF). Summing a document's rows gives its totals.

export interface ExportRange {
  /** "YYYY-MM-DD", inclusive */
  from: string;
  /** "YYYY-MM-DD", inclusive */
  to: string;
}

const BOM = "﻿";
const SEP = ";";
const EOL = "\r\n";

export const DOCUMENT_CSV_COLUMNS = [
  "Belegnr",
  "Typ",
  "Datum",
  "Leistungszeitraum",
  "Kunde",
  "Kundennr",
  "Land",
  "UID Kunde",
  "Steuermodus",
  "Netto",
  "USt-Satz",
  "USt",
  "Brutto",
  "Fällig",
  "Bezahlt am",
  "Bezugsbeleg",
] as const;

export const CLIENT_CSV_COLUMNS = [
  "Kundennr",
  "Typ",
  "Name",
  "Ansprechperson",
  "Straße",
  "Adresszusatz",
  "PLZ",
  "Ort",
  "Land",
  "UID",
  "E-Mail",
  "Telefon",
  "Zahlungsziel (Tage)",
  "Steuermodus",
  "Notizen",
  "Archiviert am",
] as const;

// ── Formatting ─────────────────────────────────────────────────────────────────

/** 123456 → "1234,56", -5 → "-0,05" (no thousands separator, so Excel parses it as a number). */
export function csvAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** 2000 → "20", 550 → "5,5" */
export function csvRate(bp: number): string {
  return String(bp / 100).replace(".", ",");
}

function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(header: readonly string[], rows: string[][]): string {
  return BOM + [header, ...rows].map((r) => r.map(csvField).join(SEP)).join(EOL) + EOL;
}

function servicePeriod(start: string | null, end: string | null): string {
  if (start && end && start !== end) return `${formatDate(start)} – ${formatDate(end)}`;
  return formatDate(start ?? end);
}

// ── Documents ──────────────────────────────────────────────────────────────────

/** Finalized (non-draft) invoices and credit notes with an issue date in the range, oldest first. */
export function listExportDocuments(db: DbOrTx, range: ExportRange): Document[] {
  return db
    .select()
    .from(documents)
    .where(
      and(
        inArray(documents.type, ["invoice", "credit_note"]),
        ne(documents.status, "draft"),
        between(documents.issueDate, range.from, range.to),
      ),
    )
    .orderBy(asc(documents.issueDate), asc(documents.number))
    .all();
}

export function documentCsvRows(db: DbOrTx, docs: Document[]): string[][] {
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d.id);
  const items = db.select().from(documentItems).where(inArray(documentItems.documentId, ids)).all();
  const itemsByDoc = new Map<number, typeof items>();
  for (const i of items) itemsByDoc.set(i.documentId, [...(itemsByDoc.get(i.documentId) ?? []), i]);

  const liveClients = new Map(db.select().from(clients).all().map((c) => [c.id, c]));
  const parentIds = [...new Set(docs.map((d) => d.parentId).filter((id): id is number => id != null))];
  const parentNumbers = new Map(
    parentIds.length
      ? db
          .select({ id: documents.id, number: documents.number })
          .from(documents)
          .where(inArray(documents.id, parentIds))
          .all()
          .map((p) => [p.id, p.number ?? ""])
      : [],
  );

  const rows: string[][] = [];
  for (const doc of docs) {
    const sign = doc.type === "credit_note" ? -1 : 1;
    const live = liveClients.get(doc.clientId);
    const client = doc.clientSnapshot ?? {
      name: live?.name ?? "",
      number: live?.number ?? 0,
      country: live?.country ?? "",
      uid: live?.uid ?? "",
    };
    const totals = calcTotals(itemsByDoc.get(doc.id) ?? [], doc.taxMode);
    const groups = totals.taxGroups.length ? totals.taxGroups : [{ rateBp: 0, netCents: 0, taxCents: 0 }];

    for (const g of groups) {
      rows.push([
        doc.number ?? "",
        DOCUMENT_TYPE_LABELS[doc.type],
        formatDate(doc.issueDate),
        servicePeriod(doc.servicePeriodStart, doc.servicePeriodEnd),
        client.name,
        client.number ? formatClientNumber(client.number) : "",
        client.country,
        client.uid,
        TAX_MODE_LABELS[doc.taxMode as TaxMode] ?? doc.taxMode,
        csvAmount(sign * g.netCents),
        csvRate(g.rateBp),
        csvAmount(sign * g.taxCents),
        csvAmount(sign * (g.netCents + g.taxCents)),
        formatDate(doc.dueDate),
        formatDate(doc.paidAt),
        doc.parentId != null ? (parentNumbers.get(doc.parentId) ?? "") : "",
      ]);
    }
  }
  return rows;
}

export function documentsCsv(db: DbOrTx, range: ExportRange): string {
  return toCsv(DOCUMENT_CSV_COLUMNS, documentCsvRows(db, listExportDocuments(db, range)));
}

export function clientsCsv(db: DbOrTx): string {
  const rows = db
    .select()
    .from(clients)
    .orderBy(asc(clients.number))
    .all()
    .map((c) => [
      formatClientNumber(c.number),
      c.type === "company" ? "Firma" : "Person",
      c.name,
      c.contactPerson,
      c.street,
      c.addressExtra,
      c.zip,
      c.city,
      c.country,
      c.uid,
      c.email,
      c.phone,
      c.paymentTermsDays != null ? String(c.paymentTermsDays) : "",
      c.defaultTaxMode ? TAX_MODE_LABELS[c.defaultTaxMode] : "",
      c.notes,
      formatDate(c.archivedAt),
    ]);
  return toCsv(CLIENT_CSV_COLUMNS, rows);
}

// ── Summary + ZIP ──────────────────────────────────────────────────────────────

export interface ExportSummary {
  label: string;
  invoices: number;
  creditNotes: number;
  /** net/tax/gross with credit notes subtracted */
  netCents: number;
  taxCents: number;
  grossCents: number;
  /** documents without a frozen PDF on disk (rendered on the fly for the ZIP) */
  missingPdfs: number;
}

export async function exportSummary(db: DbOrTx, range: ExportRange): Promise<ExportSummary> {
  const docs = listExportDocuments(db, range);
  const summary: ExportSummary = {
    label: rangeLabel(range),
    invoices: 0,
    creditNotes: 0,
    netCents: 0,
    taxCents: 0,
    grossCents: 0,
    missingPdfs: 0,
  };
  for (const d of docs) {
    const sign = d.type === "credit_note" ? -1 : 1;
    if (d.type === "credit_note") summary.creditNotes++;
    else summary.invoices++;
    summary.netCents += sign * d.netCents;
    summary.taxCents += sign * d.taxCents;
    summary.grossCents += sign * d.grossCents;
    if (!(await frozenPdfFile(d.pdfPath))) summary.missingPdfs++;
  }
  return summary;
}

/** The frozen PDF for a pdf_path (relative to data/), or null when unset, missing or outside data/. */
async function frozenPdfFile(pdfPath: string | null) {
  if (!pdfPath) return null;
  const abs = resolve(DATA_DIR, pdfPath);
  const rel = relative(DATA_DIR, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  const file = Bun.file(abs);
  return (await file.exists()) ? file : null;
}

/**
 * ZIP with the documents CSV plus one PDF per document (frozen PDF, or a fresh render when missing):
 *   belege-2026-Q3.csv
 *   pdfs/RE-2026-0001.pdf
 */
export async function documentsZip(
  db: DbOrTx,
  range: ExportRange,
  render: (id: number) => Promise<Uint8Array> = (id) => renderDocumentPdfWith(db, id),
): Promise<Uint8Array> {
  const docs = listExportDocuments(db, range);
  const label = rangeLabel(range);
  const files: Zippable = {
    [`belege-${label}.csv`]: new TextEncoder().encode(toCsv(DOCUMENT_CSV_COLUMNS, documentCsvRows(db, docs))),
  };
  for (const doc of docs) {
    const frozen = await frozenPdfFile(doc.pdfPath);
    const bytes = frozen ? new Uint8Array(await frozen.arrayBuffer()) : await render(doc.id);
    // PDFs are already compressed; store them as-is.
    files[`pdfs/${documentPdfFileName(doc)}`] = [bytes, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

// ── Range labels ───────────────────────────────────────────────────────────────

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** "2026-10" (month), "2026-Q3" (quarter), "2026" (year), otherwise "2026-07-01_2026-08-15". */
export function rangeLabel({ from, to }: ExportRange): string {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  if (fy === ty && fd === 1 && td === lastDayOfMonth(ty, tm)) {
    if (fm === tm) return `${fy}-${String(fm).padStart(2, "0")}`;
    if (fm === 1 && tm === 12) return String(fy);
    if ((fm - 1) % 3 === 0 && tm === fm + 2) return `${fy}-Q${(fm + 2) / 3}`;
  }
  return `${from}_${to}`;
}

export const exportFileNames = {
  documentsCsv: (range: ExportRange) => `belege-${rangeLabel(range)}.csv`,
  documentsZip: (range: ExportRange) => `nesev-export-${rangeLabel(range)}.zip`,
  clientsCsv: (date: string) => `kunden-${date}.csv`,
};
