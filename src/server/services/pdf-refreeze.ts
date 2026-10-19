// Re-freezes PDFs of finalized documents and reminders whose freeze failed (pdf_path null or file missing).
// Finalize commits the number first and freezes afterwards, so a render/write error there leaves a finalized
// record without its frozen PDF; readers then silently fall back to a live render. Run at startup (index.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, isNotNull, ne } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { documents, reminders } from "../db/schema";
import { DATA_DIR, PDFS_DIR } from "../lib/paths";
import { setPdfPath } from "./documents";
import { freezeDocumentPdfWith, freezeReminderPdfWith } from "./pdf";
import { setReminderPdfPath } from "./reminders";

export interface RefreezeResult {
  documents: { id: number; number: string | null; pdfPath: string }[];
  reminders: { id: number; number: string | null; pdfPath: string }[];
  failed: { kind: "document" | "reminder"; id: number; number: string | null; error: string }[];
}

const missing = (dataDir: string, pdfPath: string | null) => !pdfPath || !existsSync(join(dataDir, pdfPath));

export async function refreezeMissingPdfs(
  db: DbOrTx,
  { dataDir = DATA_DIR, pdfsDir = PDFS_DIR }: { dataDir?: string; pdfsDir?: string } = {},
): Promise<RefreezeResult> {
  const result: RefreezeResult = { documents: [], reminders: [], failed: [] };

  const docs = db
    .select({ id: documents.id, number: documents.number, pdfPath: documents.pdfPath })
    .from(documents)
    .where(and(isNotNull(documents.number), ne(documents.status, "draft")))
    .all()
    .filter((d) => missing(dataDir, d.pdfPath));
  for (const d of docs) {
    try {
      const pdfPath = await freezeDocumentPdfWith(db, d.id, pdfsDir);
      if (!pdfPath) continue;
      setPdfPath(db, d.id, pdfPath);
      result.documents.push({ id: d.id, number: d.number, pdfPath });
    } catch (err) {
      result.failed.push({ kind: "document", id: d.id, number: d.number, error: String(err) });
    }
  }

  const rems = db
    .select({ id: reminders.id, number: reminders.number, pdfPath: reminders.pdfPath })
    .from(reminders)
    .where(and(isNotNull(reminders.number), ne(reminders.status, "draft")))
    .all()
    .filter((r) => missing(dataDir, r.pdfPath));
  for (const r of rems) {
    try {
      const pdfPath = await freezeReminderPdfWith(db, r.id, pdfsDir);
      setReminderPdfPath(db, r.id, pdfPath);
      result.reminders.push({ id: r.id, number: r.number, pdfPath });
    } catch (err) {
      result.failed.push({ kind: "reminder", id: r.id, number: r.number, error: String(err) });
    }
  }
  return result;
}

/** Startup hook: re-freezes in the background and logs what it fixed. */
export function startPdfRefreeze(db: DbOrTx): void {
  // bun --hot re-runs index.ts on every reload: don't start a second pass while one is running
  const g = globalThis as { __nesevPdfRefreeze?: boolean };
  if (g.__nesevPdfRefreeze) return;
  g.__nesevPdfRefreeze = true;
  refreezeMissingPdfs(db)
    .then((r) => {
      const fixed = [...r.documents, ...r.reminders];
      if (fixed.length) console.log(`PDF re-freeze: ${fixed.map((f) => f.number ?? `#${f.id}`).join(", ")} nachgeholt`);
      for (const f of r.failed) console.error(`PDF re-freeze failed for ${f.kind} ${f.number ?? f.id}: ${f.error}`);
    })
    .catch((err) => console.error("PDF re-freeze failed", err))
    .finally(() => (g.__nesevPdfRefreeze = false));
}
