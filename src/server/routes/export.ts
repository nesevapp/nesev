import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { accountingExportSettingsSchema } from "../../shared/accounting-export";
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
import {
  accountingExportSummary,
  accountingFileNames,
  accountingZipStream,
  bmdCsv,
  genericCsv,
  getAccountingExportSettings,
  updateAccountingExportSettings,
} from "../services/export-accounting";

// Automatic daily snapshots to data/backups (not for in-memory DBs / tests).

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT erwartet");
const rangeSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from <= r.to, { message: "Das Enddatum liegt vor dem Startdatum", path: ["to"] });

/** Accountant export: range plus `payments=1` to include bank payments. */
const accountingQuery = z
  .object({ from: isoDate, to: isoDate, payments: z.enum(["0", "1"]).optional() })
  .refine((r) => r.from <= r.to, { message: "Das Enddatum liegt vor dem Startdatum", path: ["to"] });
const accountingOptions = (q: { payments?: "0" | "1" }) => ({ payments: q.payments === "1" });

function download(body: string | Uint8Array | ReadableStream<Uint8Array>, fileName: string, contentType: string) {
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
  /** Steuerberatung: BMD account mapping (settings.accountingExport, defaults when unset). */
  .get("/accounting-settings", (c) => c.json(getAccountingExportSettings(db)))
  .put("/accounting-settings", validate("json", accountingExportSettingsSchema), (c) =>
    c.json(updateAccountingExportSettings(db, c.req.valid("json"))),
  )
  .get("/accounting/summary", validate("query", accountingQuery), (c) => {
    const q = c.req.valid("query");
    return c.json(accountingExportSummary(db, q, accountingOptions(q)));
  })
  .get("/accounting/bmd.csv", validate("query", accountingQuery), (c) => {
    const q = c.req.valid("query");
    const { encoding } = getAccountingExportSettings(db);
    return download(bmdCsv(db, q, accountingOptions(q)), accountingFileNames.bmd(q), `text/csv; charset=${encoding}`);
  })
  .get("/accounting/belege.csv", validate("query", accountingQuery), (c) => {
    const q = c.req.valid("query");
    return download(genericCsv(db, q, accountingOptions(q)), accountingFileNames.generic(q), CSV);
  })
  .get("/accounting.zip", validate("query", accountingQuery), (c) => {
    const q = c.req.valid("query");
    return download(accountingZipStream(db, q, accountingOptions(q)), accountingFileNames.zip(q), ZIP);
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
