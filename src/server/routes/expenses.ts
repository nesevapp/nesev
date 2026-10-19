import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  expenseCreateSchema,
  expenseListQuerySchema,
  expensePaidSchema,
  expenseUpdateSchema,
  receiptCropSchema,
  supplierQuerySchema,
} from "../../shared/schemas/expense";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  createDraftsFromFiles,
  DraftsPartialError,
  createExpense,
  cropExpenseReceipt,
  deleteExpense,
  detectReceiptQuad,
  listExpenses,
  removeExpenseAttachment,
  requireExpense,
  restoreExpenseReceipt,
  setExpenseAttachment,
  setExpensePaid,
  supplierSuggestions,
  updateExpense,
} from "../services/expenses";
import { cancelExpenseAnalyses } from "../services/receipt-queue";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));
const fileForm = validate("form", z.object({ file: z.instanceof(File, { message: "Keine Datei hochgeladen" }) }));
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

/** Upload size caps (the per-file 20 MB check runs in the service): one receipt, or a batch of dropped receipts. */
const MB = 1024 * 1024;
const singleUploadLimit = bodyLimit({
  maxSize: 25 * MB,
  onError: (c) => c.json({ error: "Datei ist zu groß (max. 20 MB)" }, 413),
});
const batchUploadLimit = bodyLimit({
  maxSize: 200 * MB,
  onError: (c) => c.json({ error: "Zu viele Daten auf einmal (max. 200 MB) – bitte in mehreren Schritten hochladen" }, 413),
});

const app = new Hono()
  .get("/", validate("query", expenseListQuerySchema), (c) => c.json(listExpenses(db, c.req.valid("query"))))
  /** Supplier autocomplete: distinct previous suppliers with their latest uid/country/treatment/category. */
  .get("/suppliers", validate("query", supplierQuerySchema), (c) => {
    const { q, limit } = c.req.valid("query");
    return c.json(supplierSuggestions(db, q, limit));
  })
  .get("/:id", idParam, (c) => c.json(requireExpense(db, c.req.valid("param").id)))
  .post("/", validate("json", expenseCreateSchema), (c) => c.json(createExpense(db, c.req.valid("json")), 201))
  /** Quick capture: one draft per uploaded receipt (multipart, field "files"). */
  .post("/drafts", batchUploadLimit, filesForm, async (c) => {
    try {
      return c.json(await createDraftsFromFiles(db, c.req.valid("form").files), 201);
    } catch (err) {
      // partial failure: the drafts created before it stay; their ids go along (the chat records them)
      if (err instanceof DraftsPartialError) return c.json({ error: err.message, createdIds: err.createdIds }, err.status as 400 | 409 | 500);
      throw err;
    }
  })
  .put("/:id", idParam, validate("json", expenseUpdateSchema), (c) =>
    c.json(updateExpense(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/paid", idParam, validate("json", expensePaidSchema), (c) =>
    c.json(setExpensePaid(db, c.req.valid("param").id, c.req.valid("json").paidAt)),
  )
  /**
   * Upload or replace the receipt (multipart, field "file"; PDF/JPG/PNG/WebP, max 20 MB). A queued/running analysis
   * of the old receipt is cancelled first (likewise on remove and delete).
   */
  .post("/:id/attachment", idParam, singleUploadLimit, fileForm, async (c) => {
    const { id } = c.req.valid("param");
    requireExpense(db, id);
    cancelExpenseAnalyses(db, id);
    return c.json(await setExpenseAttachment(db, id, c.req.valid("form").file));
  })
  .delete("/:id/attachment", idParam, async (c) => {
    const { id } = c.req.valid("param");
    requireExpense(db, id);
    cancelExpenseAnalyses(db, id);
    return c.json(await removeExpenseAttachment(db, id));
  })
  /** Photo receipts: suggested outline on the original (422 for PDFs or without the macOS helper). */
  .get("/:id/receipt/detect", idParam, async (c) => c.json(await detectReceiptQuad(db, c.req.valid("param").id)))
  /** Cut out + straighten from the original; the original stays in attachmentOriginalPath. */
  .post("/:id/receipt/crop", idParam, validate("json", receiptCropSchema), async (c) =>
    c.json(await cropExpenseReceipt(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/receipt/restore", idParam, async (c) => c.json(await restoreExpenseReceipt(db, c.req.valid("param").id)))
  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param");
    requireExpense(db, id);
    cancelExpenseAnalyses(db, id);
    await deleteExpense(db, id);
    return c.json({ ok: true });
  });

export default app;
