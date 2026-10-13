import { copyFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, ne } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { checkTemplate, type Template } from "@pdfme/common";
import { PDFDocument } from "@pdfme/pdf-lib";
import { defaultTemplate } from "../../shared/pdf/default-template";
import type { TemplateCreate, TemplateUpdate } from "../../shared/schemas/template";
import type { DbOrTx } from "../db/client";
import { type PdfTemplate, pdfTemplates } from "../db/schema";
import { ASSETS_DIR, DATA_DIR } from "../lib/paths";
import { ensureDefaultTemplates } from "./pdf";

const summaryColumns = {
  id: pdfTemplates.id,
  name: pdfTemplates.name,
  docType: pdfTemplates.docType,
  isDefault: pdfTemplates.isDefault,
  basePdfPath: pdfTemplates.basePdfPath,
  createdAt: pdfTemplates.createdAt,
  updatedAt: pdfTemplates.updatedAt,
};

/** All templates without the (large) pdfme JSON, defaults first per document type. */
export function listTemplates(db: DbOrTx) {
  ensureDefaultTemplates(db);
  return db.select(summaryColumns).from(pdfTemplates).orderBy(asc(pdfTemplates.docType), asc(pdfTemplates.id)).all();
}

export function requireTemplate(db: DbOrTx, id: number): PdfTemplate {
  const row = db.select().from(pdfTemplates).where(eq(pdfTemplates.id, id)).get();
  if (!row) throw new HTTPException(404, { message: "Vorlage nicht gefunden" });
  return row;
}

function validateTemplateJson(template: unknown): Template {
  try {
    checkTemplate(template);
  } catch (err) {
    throw new HTTPException(400, { message: `Ungültige Vorlage: ${err instanceof Error ? err.message : String(err)}` });
  }
  return template as Template;
}

async function copyAsset(relPath: string | null, prefix: string): Promise<string | null> {
  if (!relPath) return null;
  const name = `${prefix}-${Date.now()}.pdf`;
  await copyFile(join(DATA_DIR, relPath), join(ASSETS_DIR, name)).catch(() => null);
  return `assets/${name}`;
}

async function removeAsset(relPath: string | null) {
  if (relPath) await unlink(join(DATA_DIR, relPath)).catch(() => {});
}

export async function createTemplate(db: DbOrTx, data: TemplateCreate): Promise<PdfTemplate> {
  const source = data.sourceId != null ? requireTemplate(db, data.sourceId) : null;
  const basePdfPath = source ? await copyAsset(source.basePdfPath, "letterhead") : null;
  return db
    .insert(pdfTemplates)
    .values({
      name: data.name,
      docType: data.docType,
      template: source?.template ?? defaultTemplate(data.docType),
      basePdfPath,
      isDefault: false,
    })
    .returning()
    .get();
}

export function updateTemplate(db: DbOrTx, id: number, data: TemplateUpdate): PdfTemplate {
  const row = requireTemplate(db, id);
  if (data.docType && data.docType !== row.docType && row.isDefault) {
    throw new HTTPException(400, {
      message: "Der Belegtyp einer Standardvorlage kann nicht geändert werden. Lege zuerst eine andere Vorlage als Standard fest.",
    });
  }
  const template = data.template ? validateTemplateJson(data.template) : undefined;
  return db
    .update(pdfTemplates)
    .set({ name: data.name, docType: data.docType, template })
    .where(eq(pdfTemplates.id, id))
    .returning()
    .get();
}

export function setDefaultTemplate(db: DbOrTx, id: number): PdfTemplate {
  return db.transaction((tx) => {
    const row = requireTemplate(tx, id);
    tx.update(pdfTemplates)
      .set({ isDefault: false })
      .where(and(eq(pdfTemplates.docType, row.docType), ne(pdfTemplates.id, id)))
      .run();
    return tx.update(pdfTemplates).set({ isDefault: true }).where(eq(pdfTemplates.id, id)).returning().get();
  });
}

export async function deleteTemplate(db: DbOrTx, id: number): Promise<void> {
  const row = requireTemplate(db, id);
  if (row.isDefault) {
    throw new HTTPException(400, {
      message: "Die Standardvorlage kann nicht gelöscht werden. Lege zuerst eine andere Vorlage als Standard fest.",
    });
  }
  db.delete(pdfTemplates).where(eq(pdfTemplates.id, id)).run();
  await removeAsset(row.basePdfPath);
}

const MAX_BASE_PDF_BYTES = 10 * 1024 * 1024;

/** Stores an uploaded letterhead PDF for the template (replacing a previous one). */
export async function setTemplateBasePdf(db: DbOrTx, id: number, file: File): Promise<PdfTemplate> {
  const row = requireTemplate(db, id);
  if (file.type && file.type !== "application/pdf") throw new HTTPException(400, { message: "Nur PDF-Dateien erlaubt" });
  if (file.size > MAX_BASE_PDF_BYTES) throw new HTTPException(400, { message: "Datei ist zu groß (max. 10 MB)" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await PDFDocument.load(bytes);
  } catch {
    throw new HTTPException(400, { message: "Die Datei ist kein gültiges PDF" });
  }
  const name = `letterhead-${id}-${Date.now()}.pdf`;
  await Bun.write(join(ASSETS_DIR, name), bytes);
  const updated = db
    .update(pdfTemplates)
    .set({ basePdfPath: `assets/${name}` })
    .where(eq(pdfTemplates.id, id))
    .returning()
    .get();
  await removeAsset(row.basePdfPath);
  return updated;
}

export async function removeTemplateBasePdf(db: DbOrTx, id: number): Promise<PdfTemplate> {
  const row = requireTemplate(db, id);
  const updated = db.update(pdfTemplates).set({ basePdfPath: null }).where(eq(pdfTemplates.id, id)).returning().get();
  await removeAsset(row.basePdfPath);
  return updated;
}
