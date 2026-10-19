import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { accountingExportSettingsSchema } from "../../shared/accounting-export";
import { todayIso } from "../../shared/dates";
import { db } from "../db";
import { DATA_DIR } from "../lib/paths";
import { validate } from "../lib/validate";
import {
  BACKUPS_DIR,
  createBackupZip,
  isLocalBackupName,
  listLocalBackups,
  writeLocalBackup,
} from "../services/backup";
import { confirmPendingRestore, discardPendingRestore, pendingRestore, RestoreError, stageRestore } from "../services/restore";
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

/**
 * Under the service (launchd/systemd unit sets NESEV_SERVICE=1, restarts the process when it exits) nesev can restart
 * itself to apply a staged restore; otherwise the user restarts it.
 */
const canRestart = () => process.env.NESEV_SERVICE === "1";
/** ZIPs over 4 GB (ZIP64) aren't supported anyway; it's a local upload. */
const RESTORE_MAX_BYTES = 4 * 1024 ** 3;

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
  })
  /** "Backup einspielen": the restore staged for the next start, if any. */
  .get("/restore", (c) => c.json({ pending: pendingRestore(DATA_DIR), canRestart: canRestart() }))
  /**
   * multipart/form-data, field "file": a backup ZIP or a nesev .db. Validated and staged (unconfirmed) in
   * <data>/restore-pending (services/restore.ts). Answers with what the backup contains; POST /restore/confirm makes
   * the next start apply it, DELETE /restore drops it.
   */
  .post(
    "/restore",
    bodyLimit({ maxSize: RESTORE_MAX_BYTES, onError: (c) => c.json({ error: "Datei ist zu groß (max. 4 GB)" }, 413) }),
    validate("form", z.object({ file: z.instanceof(File, { message: "Keine Datei hochgeladen" }) })),
    async (c) => {
      const { file } = c.req.valid("form");
      try {
        const summary = stageRestore(DATA_DIR, new Uint8Array(await file.arrayBuffer()), { confirmed: false });
        return c.json({ summary });
      } catch (err) {
        if (err instanceof RestoreError) return c.json({ error: err.message }, 422);
        throw err;
      }
    },
  )
  .post("/restore/confirm", (c) => {
    try {
      return c.json({ pending: confirmPendingRestore(DATA_DIR), canRestart: canRestart() });
    } catch (err) {
      if (err instanceof RestoreError) return c.json({ error: err.message }, 409);
      throw err;
    }
  })
  .delete("/restore", (c) => {
    try {
      discardPendingRestore(DATA_DIR);
    } catch (err) {
      if (err instanceof RestoreError) return c.json({ error: err.message }, 409);
      throw err;
    }
    return c.json({ pending: null, canRestart: canRestart() });
  })
  /** Restart to apply a staged restore: only under the service, which starts the process again after it exits. */
  .post("/restart", (c) => {
    if (!canRestart()) return c.json({ error: "nesev läuft nicht als Dienst und kann sich nicht selbst neu starten. Bitte nesev beenden und wieder starten." }, 409);
    console.log("nesev: restarting to apply a restore (the service starts it again)");
    // non-zero, so units that restart only on failure start it again too; after the response went out
    setTimeout(() => process.exit(75), 500);
    return c.json({ restarting: true });
  });

export default app;
