import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { inboxFolderSchema, inboxIdsSchema, inboxListQuerySchema } from "../../shared/schemas/receipt-inbox";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  addUploadedFiles,
  convertInboxItems,
  countNewInboxItems,
  dismissInboxItems,
  getInboxScanner,
  listInboxItems,
  setInboxFolder,
} from "../services/receipt-inbox";

// Belege-Eingang (receipt inbox). Nothing here analyses a receipt: the web queues analysis for converted expenses
// explicitly via POST /api/receipts/analyze. The scanner itself is started in server/index.ts.

/** multipart field "files" (one or more) */
const filesForm = validate(
  "form",
  z.object({
    files: z
      .union([z.instanceof(File), z.array(z.instanceof(File))], { message: "Keine Datei hochgeladen" })
      .transform((f) => (Array.isArray(f) ? f : [f]))
      .pipe(z.array(z.instanceof(File)).min(1).max(50)),
  }),
);

/** Upload cap per request (each file is checked against 20 MB in the service). */
const uploadLimit = bodyLimit({
  maxSize: 200 * 1024 * 1024,
  onError: (c) => c.json({ error: "Zu viele Daten auf einmal (max. 200 MB) – bitte in mehreren Schritten hochladen" }, 413),
});

const app = new Hono()
  .get("/", validate("query", inboxListQuerySchema), (c) => c.json(listInboxItems(db, c.req.valid("query").status)))
  /** New items count (nav badge). */
  .get("/count", (c) => c.json({ count: countNewInboxItems(db) }))
  /** Folder, last scan, error and skipped files. */
  .get("/status", (c) => c.json(getInboxScanner(db).status()))
  /** "Jetzt prüfen": scan now; files seen for the first time are checked once more shortly after. */
  .post("/scan", async (c) => {
    const scanner = getInboxScanner(db);
    let result = await scanner.scan();
    if (result.pending && !result.error) {
      await Bun.sleep(1500);
      result = await scanner.scan();
    }
    return c.json({ result, status: scanner.status() });
  })
  /** Set or clear (path "") the inbox folder; validated (exists, readable, outside the data dir), then scanned. */
  .put("/folder", validate("json", inboxFolderSchema), async (c) => {
    setInboxFolder(db, c.req.valid("json").path);
    const scanner = getInboxScanner(db);
    await scanner.refresh();
    return c.json(scanner.status());
  })
  /** Manual drop on the inbox page (multipart, field "files"): one item per file, duplicates reported. */
  .post("/upload", uploadLimit, filesForm, async (c) => c.json(await addUploadedFiles(db, c.req.valid("form").files), 201))
  /** One expense draft per item, the file as its receipt. */
  .post("/convert", validate("json", inboxIdsSchema), async (c) =>
    c.json(await convertInboxItems(db, c.req.valid("json").ids), 201),
  )
  .post("/dismiss", validate("json", inboxIdsSchema), async (c) =>
    c.json({ dismissed: await dismissInboxItems(db, c.req.valid("json").ids) }),
  );

export default app;
