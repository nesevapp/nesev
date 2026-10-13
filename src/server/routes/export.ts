import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { todayIso } from "../../shared/dates";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  BACKUPS_DIR,
  createBackupZip,
  isLocalBackupName,
  listLocalBackups,
  writeLocalBackup,
} from "../services/backup";
import { clientsCsv, documentsCsv, documentsZip, exportFileNames, exportSummary } from "../services/export";

// Automatic daily snapshots to data/backups (not for in-memory DBs / tests).

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT erwartet");
const rangeSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, { message: "Das Enddatum liegt vor dem Startdatum", path: ["to"] });

function download(body: string | Uint8Array, fileName: string, contentType: string) {
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

const CSV = "text/csv; charset=utf-8";
const ZIP = "application/zip";

const app = new Hono()
  /** Counts and totals for the range (finalized invoices and credit notes). */
  .get("/summary", validate("query", rangeSchema), async (c) => c.json(await exportSummary(db, c.req.valid("query"))))
  .get("/documents.csv", validate("query", rangeSchema), (c) => {
    const range = c.req.valid("query");
    return download(documentsCsv(db, range), exportFileNames.documentsCsv(range), CSV);
  })
  .get("/documents.zip", validate("query", rangeSchema), async (c) => {
    const range = c.req.valid("query");
    return download(await documentsZip(db, range), exportFileNames.documentsZip(range), ZIP);
  })
  .get("/clients.csv", () => download(clientsCsv(db), exportFileNames.clientsCsv(todayIso()), CSV))
  /** Full backup: DB snapshot + assets + PDFs. */
  .get("/backup", () => download(createBackupZip(db), `nesev-backup-${todayIso()}.zip`, ZIP))
  .get("/backups", (c) => c.json(listLocalBackups()))
  /** Create (or refresh) today's local backup now. */
  .post("/backups", (c) => c.json(writeLocalBackup(db, { force: true }), 201))
  .get("/backups/:name", validate("param", z.object({ name: z.string() })), async (c) => {
    const { name } = c.req.valid("param");
    const file = Bun.file(join(BACKUPS_DIR, name));
    if (!isLocalBackupName(name) || !(await file.exists())) return c.json({ error: "Backup nicht gefunden" }, 404);
    return download(new Uint8Array(await file.arrayBuffer()), name, "application/vnd.sqlite3");
  });

export default app;
