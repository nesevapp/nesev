import { Hono } from "hono";
import { z } from "zod";
import { analyzeRequestSchema, llamaTestSchema, ocrProbeQuerySchema, ocrSettingsSchema } from "../../shared/schemas/receipt";
import { db } from "../db";
import { ensureHelper, helperStatus } from "../lib/ocr/helper";
import { DB_PATH } from "../lib/paths";
import { discoverModels } from "../lib/llama/paths";
import { validate } from "../lib/validate";
import { getLlamaServer, syncLlamaServer, testLlama } from "../services/receipt-llama";
import { LlmError } from "../services/receipt-ollama";
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

if (DB_PATH !== ":memory:") {
  initReceiptQueue(db);
  // llama.cpp provider: exit handlers + reap a llama-server orphaned by a hard-killed previous instance
  getLlamaServer();
}

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
  .put("/settings", validate("json", ocrSettingsSchema), async (c) => {
    const saved = updateOcrSettings(db, c.req.valid("json"));
    // an idle llama-server started for other settings (model, context, provider) is stopped
    await syncLlamaServer(saved, getReceiptWorker(db).busy);
    return c.json(saved);
  })
  /** llama.cpp: GGUF models found on disk (HF cache, llama.cpp cache, Unsloth, LM Studio) for the model picker. */
  .get("/llamacpp/models", (c) => c.json(discoverModels()))
  /**
   * llama.cpp: start a separate llama-server with the (unsaved) form values, extract a sample receipt, stop it.
   * Only on explicit click; refused while a batch runs.
   */
  .post("/llamacpp/test", validate("json", llamaTestSchema), async (c) => {
    if (getReceiptWorker(db).busy) return c.json({ error: "Gerade läuft eine Analyse – Test danach wiederholen" }, 409);
    try {
      return c.json(await testLlama(getOcrSettings(db), c.req.valid("json"), c.req.raw.signal));
    } catch (err) {
      if (err instanceof LlmError) return c.json({ error: err.message }, 422);
      throw err;
    }
  })
  /**
   * Health of the components: Swift helper, Tesseract and the active model server (Ollama: installed models;
   * OpenAI-compatible: loaded models). provider/url/apiKey/model test unsaved form values.
   */
  .get("/status", validate("query", ocrProbeQuerySchema), async (c) => c.json(await componentStatus(db, c.req.valid("query"))))
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
