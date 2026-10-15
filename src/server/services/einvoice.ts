import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { EINVOICE_FORMAT_LABELS, EINVOICE_FORMATS, type EInvoiceFormat } from "../../shared/einvoice";
import { taxNoteFor } from "../../shared/tax";
import type { DbOrTx } from "../db/client";
import { clients, type Document, documentItems, documents } from "../db/schema";
import { buildEInvoiceXml, eInvoiceFileName, eInvoiceProblems, embedFacturX, type EInvoiceInput } from "../lib/einvoice";
import { DATA_DIR } from "../lib/paths";
import { renderDocumentPdfWith } from "./pdf";
import { getSettings } from "./settings";

// E-invoices for finalized invoices and credit notes, generated on demand from the frozen document
// (snapshots, items, cached totals). Routing data that is not part of the snapshot (buyer reference
// default, our supplier number, the format) comes from the live client. ZUGFeRD embeds the XML into a
// copy of the frozen PDF; data/pdfs is never modified.

function requireEInvoiceDocument(db: DbOrTx, id: number): Document & { type: "invoice" | "credit_note" } {
  const doc = db.select().from(documents).where(eq(documents.id, id)).get();
  if (!doc) throw new HTTPException(404, { message: "Beleg nicht gefunden" });
  if (doc.type !== "invoice" && doc.type !== "credit_note") {
    throw new HTTPException(422, { message: "E-Rechnungen gibt es nur für Rechnungen und Gutschriften" });
  }
  if (doc.status === "draft" || !doc.number || !doc.clientSnapshot || !doc.sellerSnapshot) {
    throw new HTTPException(409, { message: "Beleg muss zuerst finalisiert werden" });
  }
  return { ...doc, type: doc.type };
}

export function eInvoiceInput(db: DbOrTx, id: number): { input: EInvoiceInput; defaultFormat: EInvoiceFormat | null } {
  const doc = requireEInvoiceDocument(db, id);
  const client = db.select().from(clients).where(eq(clients.id, doc.clientId)).get();
  const items = db.select().from(documentItems).where(eq(documentItems.documentId, id)).orderBy(asc(documentItems.position)).all();
  const parent =
    doc.type === "credit_note" && doc.parentId
      ? db.select().from(documents).where(eq(documents.id, doc.parentId)).get()
      : undefined;
  const input: EInvoiceInput = {
    type: doc.type,
    number: doc.number!,
    issueDate: doc.issueDate,
    dueDate: doc.dueDate,
    servicePeriodStart: doc.servicePeriodStart,
    servicePeriodEnd: doc.servicePeriodEnd,
    taxMode: doc.taxMode,
    title: doc.title,
    introText: doc.introText,
    closingText: doc.closingText,
    seller: doc.sellerSnapshot!,
    client: doc.clientSnapshot!,
    buyerReference: doc.buyerReference.trim() || client?.eInvoiceBuyerReference.trim() || "",
    supplierId: client?.eInvoiceSupplierId.trim() ?? "",
    items: items.map(({ title, description, quantity, unit, unitPriceCents, taxRateBp, discountBp }) => ({
      title,
      description,
      quantity,
      unit,
      unitPriceCents,
      taxRateBp,
      discountBp,
    })),
    netCents: doc.netCents,
    taxCents: doc.taxCents,
    grossCents: doc.grossCents,
    taxNote: taxNoteFor(doc.taxMode, getSettings(db)),
    precedingInvoice: parent?.number ? { number: parent.number, issueDate: parent.issueDate } : null,
  };
  return { input, defaultFormat: client?.eInvoiceFormat ?? null };
}

export interface EInvoiceStatus {
  /** the client's format (preselected in the UI); null = client gets PDF only */
  defaultFormat: EInvoiceFormat | null;
  buyerReference: string;
  formats: { format: EInvoiceFormat; label: string; problems: string[] }[];
}

/** What can be downloaded, and what is missing per format. */
export function eInvoiceStatus(db: DbOrTx, id: number): EInvoiceStatus {
  const { input, defaultFormat } = eInvoiceInput(db, id);
  return {
    defaultFormat,
    buyerReference: input.buyerReference,
    formats: EINVOICE_FORMATS.map((format) => ({
      format,
      label: EINVOICE_FORMAT_LABELS[format],
      problems: eInvoiceProblems(input, format),
    })),
  };
}

export interface EInvoiceFile {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

/** The e-invoice file; 422 with the missing data when the format's requirements are not met. */
export async function buildEInvoiceFile(db: DbOrTx, id: number, format: EInvoiceFormat): Promise<EInvoiceFile> {
  const { input } = eInvoiceInput(db, id);
  const problems = eInvoiceProblems(input, format);
  if (problems.length) throw new HTTPException(422, { message: `${EINVOICE_FORMAT_LABELS[format]}: ${problems.join("; ")}` });

  const xml = buildEInvoiceXml(input, format);
  const fileName = eInvoiceFileName(input.number, format);
  if (format !== "zugferd") {
    return { fileName, contentType: "application/xml; charset=utf-8", bytes: new TextEncoder().encode(xml) };
  }
  const doc = db.select({ pdfPath: documents.pdfPath }).from(documents).where(eq(documents.id, id)).get()!;
  const frozen = doc.pdfPath ? Bun.file(join(DATA_DIR, doc.pdfPath)) : null;
  const pdf = frozen && (await frozen.exists()) ? new Uint8Array(await frozen.arrayBuffer()) : await renderDocumentPdfWith(db, id);
  return { fileName, contentType: "application/pdf", bytes: await embedFacturX(pdf, xml) };
}
