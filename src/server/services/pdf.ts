import { extname, join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { type DocumentType, TEMPLATE_DOC_TYPES, type TemplateDocType } from "../../shared/documents";
import { defaultTemplate, defaultTemplateName } from "../../shared/pdf/default-template";
import { renderPdf } from "../../shared/pdf/render";
import type { PdfInput } from "../../shared/pdf/variables";
import type { ClientSnapshot, SellerSnapshot } from "../../shared/types";
import type { Template } from "@pdfme/common";
import type { DbOrTx } from "../db/client";
import { clients, documentItems, documents, type PdfTemplate, pdfTemplates, reminders } from "../db/schema";
import { loadPdfFonts } from "../lib/pdf/fonts";
import { clientToSnapshot, mapDocumentToPdfInput, type PdfItemFields } from "../lib/pdf/mapper";
import { mapReminderToPdfInput } from "../lib/pdf/reminder-mapper";
import { getReminderSettings } from "./reminders";
import { DATA_DIR, PDFS_DIR } from "../lib/paths";
import { getSettings, sellerSnapshot } from "./settings";

// The app-wide db is imported lazily so tests can import this module without touching data/nesev.db.
const appDb = async () => (await import("../db")).db;

// ── Templates ──────────────────────────────────────────────────────────────────

/** Seeds a default template for every document type that has none, and makes sure each type has a default. */
export function ensureDefaultTemplates(db: DbOrTx): void {
  for (const docType of TEMPLATE_DOC_TYPES) {
    const rows = db.select().from(pdfTemplates).where(eq(pdfTemplates.docType, docType)).orderBy(asc(pdfTemplates.id)).all();
    if (rows.length === 0) {
      db.insert(pdfTemplates)
        .values({ name: defaultTemplateName(docType), docType, template: defaultTemplate(docType), isDefault: true })
        .run();
    } else if (!rows.some((r) => r.isDefault)) {
      db.update(pdfTemplates).set({ isDefault: true }).where(eq(pdfTemplates.id, rows[0]!.id)).run();
    }
  }
}

export function getDefaultTemplate(db: DbOrTx, docType: TemplateDocType): PdfTemplate {
  ensureDefaultTemplates(db);
  return db
    .select()
    .from(pdfTemplates)
    .where(and(eq(pdfTemplates.docType, docType), eq(pdfTemplates.isDefault, true)))
    .get()!;
}

/** The document's chosen template, falling back to the default for its type. */
export function resolveTemplate(db: DbOrTx, doc: { type: TemplateDocType; templateId: number | null }): PdfTemplate {
  if (doc.templateId != null) {
    const row = db.select().from(pdfTemplates).where(eq(pdfTemplates.id, doc.templateId)).get();
    if (row) return row;
  }
  return getDefaultTemplate(db, doc.type);
}

// ── Assets ─────────────────────────────────────────────────────────────────────

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

/** Logo for pdfme: PNG/JPG as data URI, SVG as markup. Other formats (WebP) are not supported by pdfme. */
export async function loadLogo(logoPath: string | null): Promise<{ dataUri?: string; svg?: string } | null> {
  if (!logoPath) return null;
  const file = Bun.file(join(DATA_DIR, logoPath));
  if (!(await file.exists())) return null;
  const ext = extname(logoPath).toLowerCase();
  if (ext === ".svg") return { svg: await file.text() };
  const mime = IMAGE_MIME[ext];
  if (!mime) return null;
  return { dataUri: `data:${mime};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}` };
}

export async function loadLetterhead(basePdfPath: string | null): Promise<Uint8Array | null> {
  if (!basePdfPath) return null;
  const file = Bun.file(join(DATA_DIR, basePdfPath));
  return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
}

// ── Documents ──────────────────────────────────────────────────────────────────

export class DocumentNotFoundError extends Error {
  constructor(id: number) {
    super(`Beleg ${id} nicht gefunden`);
  }
}

/** Collects everything needed to render a document: pdfme input, template row and PDF metadata. */
export async function buildDocumentPdfData(db: DbOrTx, documentId: number) {
  const doc = db.select().from(documents).where(eq(documents.id, documentId)).get();
  if (!doc) throw new DocumentNotFoundError(documentId);
  const items = db
    .select()
    .from(documentItems)
    .where(eq(documentItems.documentId, documentId))
    .orderBy(asc(documentItems.position))
    .all();
  const settings = getSettings(db);

  let client: ClientSnapshot | null = doc.clientSnapshot;
  if (!client) {
    const row = db.select().from(clients).where(eq(clients.id, doc.clientId)).get();
    if (!row) throw new Error(`Kunde ${doc.clientId} nicht gefunden`);
    client = clientToSnapshot(row);
  }
  const seller: SellerSnapshot = doc.sellerSnapshot ?? sellerSnapshot(settings);
  const parentNumber =
    doc.parentId != null
      ? (db.select({ number: documents.number }).from(documents).where(eq(documents.id, doc.parentId)).get()?.number ?? null)
      : null;

  const input = mapDocumentToPdfInput({
    document: doc,
    items,
    client,
    seller,
    taxNotes: settings,
    parentNumber,
    logo: await loadLogo(seller.logoPath),
  });
  const template = resolveTemplate(db, doc);
  return {
    doc,
    input,
    template,
    title: input.heading!,
    author: input.sellerName!,
  };
}

/** Renders a pdf_templates row with the given input (fonts and letterhead included). */
export async function renderTemplate(row: Pick<PdfTemplate, "template" | "basePdfPath">, input: PdfInput, meta = { title: "", author: "" }) {
  return renderPdf({
    template: row.template as Template,
    input,
    fonts: await loadPdfFonts(),
    letterhead: await loadLetterhead(row.basePdfPath),
    ...meta,
  });
}

export async function renderDocumentPdfWith(db: DbOrTx, documentId: number): Promise<Uint8Array> {
  const data = await buildDocumentPdfData(db, documentId);
  return renderTemplate(data.template, data.input, { title: data.title, author: data.author });
}

/** File name for downloads: "RE-2026-0001.pdf", drafts "Entwurf-12.pdf". */
export function documentPdfFileName(doc: { id: number; number: string | null }): string {
  return doc.number ? `${doc.number.replace(/[^\w.-]+/g, "_")}.pdf` : `Entwurf-${doc.id}.pdf`;
}

// ── Contract used by the documents feature ─────────────────────────────────────

/** Render a document (draft or final) to PDF bytes using its template (or the default for its type). */
export async function renderDocumentPdf(documentId: number): Promise<Uint8Array> {
  return renderDocumentPdfWith(await appDb(), documentId);
}

/**
 * Render and store the PDF for a just-finalized document under data/pdfs.
 * Returns the stored path relative to data/ (to be saved in documents.pdf_path).
 */
export async function freezeDocumentPdf(documentId: number): Promise<string | null> {
  return freezeDocumentPdfWith(await appDb(), documentId);
}

export async function freezeDocumentPdfWith(db: DbOrTx, documentId: number, dir = PDFS_DIR): Promise<string | null> {
  const data = await buildDocumentPdfData(db, documentId);
  const bytes = await renderTemplate(data.template, data.input, { title: data.title, author: data.author });
  const name = documentPdfFileName(data.doc);
  await Bun.write(join(dir, name), bytes);
  return `pdfs/${name}`;
}

// ── Sample data for the designer ───────────────────────────────────────────────

const SAMPLE_SELLER: SellerSnapshot = {
  companyName: "Muster Design GmbH",
  ownerName: "Maria Muster",
  street: "Mariahilfer Straße 1",
  zip: "1060",
  city: "Wien",
  country: "AT",
  uid: "ATU12345678",
  taxNumber: "",
  companyRegister: "123456a",
  email: "office@muster-design.at",
  phone: "+43 1 234 56 78",
  website: "www.muster-design.at",
  iban: "AT611904300234573201",
  bic: "BKAUATWW",
  bankName: "Bank Austria",
  logoPath: null,
};

const SAMPLE_CLIENT: ClientSnapshot = {
  clientId: 0,
  number: 1001,
  type: "company",
  name: "Beispiel Handels AG",
  contactPerson: "Max Mustermann",
  street: "Herrengasse 12",
  addressExtra: "",
  zip: "8010",
  city: "Graz",
  country: "AT",
  uid: "ATU87654321",
  email: "max@beispiel.at",
};

const SAMPLE_ITEMS: PdfItemFields[] = [
  { title: "Konzeption & Workshop", description: "Anforderungsanalyse, Sitemap und Wireframes", quantity: 8000, unit: "Std.", unitPriceCents: 9500, taxRateBp: 2000, discountBp: 0 },
  { title: "Design", description: "Screendesign für Desktop und Mobile", quantity: 1000, unit: "Pauschale", unitPriceCents: 240000, taxRateBp: 2000, discountBp: 0 },
  { title: "Umsetzung", description: "", quantity: 24500, unit: "Std.", unitPriceCents: 9500, taxRateBp: 2000, discountBp: 1000 },
  { title: "Fachbuch „Gutes Webdesign“", description: "", quantity: 2000, unit: "Stk.", unitPriceCents: 3990, taxRateBp: 1000, discountBp: 0 },
];

const SAMPLE_NUMBERS: Record<DocumentType, string> = { offer: "AN-2026-0042", invoice: "RE-2026-0042", credit_note: "GS-2026-0007" };

/** Realistic input for designer previews: real seller data from the settings if present, otherwise sample data. */
export async function buildSampleInput(db: DbOrTx, docType: TemplateDocType): Promise<PdfInput> {
  const settings = getSettings(db);
  const hasSeller = !!(settings.companyName || settings.ownerName);
  const seller = hasSeller ? sellerSnapshot(settings) : SAMPLE_SELLER;
  if (docType === "reminder") return buildReminderSampleInput(db, seller);
  const intro = { offer: settings.defaultOfferIntro, invoice: settings.defaultInvoiceIntro, credit_note: settings.defaultCreditNoteIntro }[docType];
  const closing = { offer: settings.defaultOfferClosing, invoice: settings.defaultInvoiceClosing, credit_note: settings.defaultCreditNoteClosing }[docType];
  return mapDocumentToPdfInput({
    document: {
      type: docType,
      number: SAMPLE_NUMBERS[docType],
      issueDate: "2026-10-13",
      servicePeriodStart: "2026-09-01",
      servicePeriodEnd: "2026-09-30",
      dueDate: docType === "invoice" ? "2026-10-27" : null,
      validUntil: docType === "offer" ? "2026-11-12" : null,
      taxMode: "AT_DOMESTIC",
      title: "Website-Relaunch",
      introText: intro,
      closingText: closing,
    },
    items: SAMPLE_ITEMS,
    client: SAMPLE_CLIENT,
    seller,
    taxNotes: settings,
    parentNumber: docType === "credit_note" ? SAMPLE_NUMBERS.invoice : null,
    logo: await loadLogo(seller.logoPath),
  });
}

async function buildReminderSampleInput(db: DbOrTx, seller: SellerSnapshot): Promise<PdfInput> {
  const settings = getSettings(db);
  const level = getReminderSettings(db).levels[1] ?? getReminderSettings(db).levels[0]!;
  return mapReminderToPdfInput({
    reminder: {
      level: 2,
      number: "MA-2026-0007",
      issueDate: "2026-10-13",
      dueDate: "2026-10-20",
      openCents: 379200,
      feeCents: level.feeCents,
      interestCents: 0,
      title: level.title,
      introText: level.introText,
      closingText: level.closingText,
    },
    invoice: { number: SAMPLE_NUMBERS.invoice, issueDate: "2026-09-01", dueDate: "2026-09-15", grossCents: 379200 },
    client: SAMPLE_CLIENT,
    seller,
    taxNotes: settings,
    logo: await loadLogo(seller.logoPath),
  });
}

// ── Reminders ──────────────────────────────────────────────────────────────────

export class ReminderNotFoundError extends Error {
  constructor(id: number) {
    super(`Mahnung ${id} nicht gefunden`);
  }
}

/** Like buildDocumentPdfData, for a reminder (drafts use live client and seller data). */
export async function buildReminderPdfData(db: DbOrTx, reminderId: number) {
  const reminder = db.select().from(reminders).where(eq(reminders.id, reminderId)).get();
  if (!reminder) throw new ReminderNotFoundError(reminderId);
  const invoice = db.select().from(documents).where(eq(documents.id, reminder.invoiceId)).get();
  if (!invoice) throw new DocumentNotFoundError(reminder.invoiceId);
  const settings = getSettings(db);

  let client: ClientSnapshot | null = reminder.clientSnapshot;
  if (!client) {
    const row = db.select().from(clients).where(eq(clients.id, invoice.clientId)).get();
    client = row ? clientToSnapshot(row) : invoice.clientSnapshot;
    if (!client) throw new Error(`Kunde ${invoice.clientId} nicht gefunden`);
  }
  const seller: SellerSnapshot = reminder.sellerSnapshot ?? sellerSnapshot(settings);

  const input = mapReminderToPdfInput({
    reminder,
    invoice,
    client,
    seller,
    taxNotes: settings,
    logo: await loadLogo(seller.logoPath),
  });
  const template = resolveTemplate(db, { type: "reminder", templateId: reminder.templateId });
  return { reminder, input, template, title: input.heading!, author: input.sellerName! };
}

export async function renderReminderPdfWith(db: DbOrTx, reminderId: number): Promise<Uint8Array> {
  const data = await buildReminderPdfData(db, reminderId);
  return renderTemplate(data.template, data.input, { title: data.title, author: data.author });
}

/** "MA-2026-0001.pdf", drafts "Mahnung-Entwurf-3.pdf". */
export function reminderPdfFileName(r: { id: number; number: string | null }): string {
  return r.number ? `${r.number.replace(/[^\w.-]+/g, "_")}.pdf` : `Mahnung-Entwurf-${r.id}.pdf`;
}

/** Renders and stores a finalized reminder's PDF under data/pdfs; returns the path relative to data/. */
export async function freezeReminderPdfWith(db: DbOrTx, reminderId: number, dir = PDFS_DIR): Promise<string> {
  const data = await buildReminderPdfData(db, reminderId);
  const bytes = await renderTemplate(data.template, data.input, { title: data.title, author: data.author });
  const name = reminderPdfFileName(data.reminder);
  await Bun.write(join(dir, name), bytes);
  return `pdfs/${name}`;
}
