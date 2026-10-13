import { Hono } from "hono";
import { z } from "zod";
import { analyzeRequestSchema, ollamaProbeQuerySchema, ocrSettingsSchema } from "../../shared/schemas/receipt";
import { db } from "../db";
import { ensureHelper, helperStatus } from "../lib/ocr/helper";
import { DB_PATH } from "../lib/paths";
import { validate } from "../lib/validate";
import {
  cancelAnalysis,
  enqueueAnalyses,
  getReceiptWorker,
  initReceiptQueue,
  latestAnalysis,
  markApplied,
  queueOverview,
} from "../services/receipt-queue";
import { componentStatus, getOcrSettings, updateOcrSettings } from "../services/receipt-settings";

// On-demand receipt analysis (Belegerkennung). Nothing here runs on upload: runs are queued explicitly via
// POST /analyze and processed one at a time by the in-process worker.

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

if (DB_PATH !== ":memory:") initReceiptQueue(db);

const app = new Hono()
  /** Queue runs for expenses with a receipt; skips ones without receipt or already queued/running. */
  .post("/analyze", validate("json", analyzeRequestSchema), (c) => {
    const result = enqueueAnalyses(db, c.req.valid("json").expenseIds);
    if (result.queued.length) getReceiptWorker(db).kick();
    return c.json(result);
  })
  /** Latest analysis per expense (for the list) and queue counters. */
  .get("/queue", (c) => c.json(queueOverview(db)))
  /** Latest analysis of one expense incl. text and result, or null. */
  .get("/expenses/:id", idParam, (c) => c.json({ analysis: latestAnalysis(db, c.req.valid("param").id) }))
  .post("/:id/cancel", idParam, (c) => {
    const { id } = c.req.valid("param");
    const row = cancelAnalysis(db, id);
    getReceiptWorker(db).cancel(id);
    return c.json({ id: row.id, status: row.status });
  })
  /** The user saved the expense with suggestions from this analysis. */
  .post("/:id/applied", idParam, (c) => {
    const row = markApplied(db, c.req.valid("param").id);
    return c.json({ id: row.id, appliedAt: row.appliedAt });
  })
  .get("/settings", (c) => c.json(getOcrSettings(db)))
  .put("/settings", validate("json", ocrSettingsSchema), (c) => c.json(updateOcrSettings(db, c.req.valid("json"))))
  /** Health of the components: Swift helper, Tesseract, Ollama (+ installed models). `ollamaUrl` tests an unsaved URL. */
  .get("/status", validate("query", ollamaProbeQuerySchema), async (c) =>
    c.json(await componentStatus(db, c.req.valid("query").ollamaUrl)),
  )
  /** Compile the Swift OCR helper now (otherwise it is compiled on the first analysis). */
  .post("/helper/build", async (c) => {
    try {
      await ensureHelper();
    } catch (err) {
      return c.json({ error: (err as Error).message }, 422);
    }
    return c.json(helperStatus());
  });

export default app;
