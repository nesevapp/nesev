import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { FONT_FILES } from "../../shared/pdf/plugins";
import { db } from "../db";
import { documents, reminders } from "../db/schema";
import { DATA_DIR } from "../lib/paths";
import { FONTS_DIR } from "../lib/pdf/fonts";
import { validate } from "../lib/validate";
import { documentPdfFileName, reminderPdfFileName, renderDocumentPdfWith, renderReminderPdfWith } from "../services/pdf";

const FONT_FILE_NAMES = new Set<string>(Object.values(FONT_FILES));

const app = new Hono()
  /**
   * Frozen PDF (documents.pdf_path) if present, otherwise a live render.
   * Inline by default; ?download=1 → attachment ("RE-2026-0001.pdf" / "Entwurf-12.pdf").
   */
  .get(
    "/documents/:id",
    validate("param", z.object({ id: z.coerce.number().int().positive() })),
    validate("query", z.object({ download: z.string().optional() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const doc = db.select().from(documents).where(eq(documents.id, id)).get();
      if (!doc) return c.json({ error: "Beleg nicht gefunden" }, 404);

      const frozen = doc.pdfPath ? Bun.file(join(DATA_DIR, doc.pdfPath)) : null;
      const bytes = frozen && (await frozen.exists()) ? await frozen.arrayBuffer() : await renderDocumentPdfWith(db, id);

      const disposition = c.req.valid("query").download === "1" ? "attachment" : "inline";
      return c.body(bytes as ArrayBuffer, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${documentPdfFileName(doc)}"`,
        "Cache-Control": "no-store",
      });
    },
  )
  /** Reminder (Mahnung) PDF: frozen if finalized, otherwise a live render. Same query as above. */
  .get(
    "/reminders/:id",
    validate("param", z.object({ id: z.coerce.number().int().positive() })),
    validate("query", z.object({ download: z.string().optional() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const reminder = db.select().from(reminders).where(eq(reminders.id, id)).get();
      if (!reminder) return c.json({ error: "Mahnung nicht gefunden" }, 404);

      const frozen = reminder.pdfPath ? Bun.file(join(DATA_DIR, reminder.pdfPath)) : null;
      const bytes = frozen && (await frozen.exists()) ? await frozen.arrayBuffer() : await renderReminderPdfWith(db, id);

      const disposition = c.req.valid("query").download === "1" ? "attachment" : "inline";
      return c.body(bytes as ArrayBuffer, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${reminderPdfFileName(reminder)}"`,
        "Cache-Control": "no-store",
      });
    },
  )
  /** Bundled fonts for the browser-side designer/preview. */
  .get("/fonts/:file", (c) => {
    const file = c.req.param("file");
    if (!FONT_FILE_NAMES.has(file)) return c.json({ error: "Not found" }, 404);
    return new Response(Bun.file(join(FONTS_DIR, file)), {
      headers: { "Content-Type": "font/ttf", "Cache-Control": "public, max-age=86400" },
    });
  });

export default app;
