import { Hono } from "hono";
import { z } from "zod";
import {
  documentCreateSchema,
  documentDefaultsQuerySchema,
  documentListQuerySchema,
  documentStatusSchema,
  documentUpdateSchema,
} from "../../shared/schemas/document";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  changeStatus,
  convertOfferToInvoice,
  createCreditNote,
  createDocument,
  deleteDocument,
  documentDefaults,
  duplicateDocument,
  finalizeDocument,
  getDocument,
  listDocuments,
  setPdfPath,
  updateDocument,
} from "../services/documents";
import { freezeDocumentPdf } from "../services/pdf";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", validate("query", documentListQuerySchema), (c) => c.json(listDocuments(db, c.req.valid("query"))))
  /** Prefill values for a new draft (texts, tax mode, due/valid-until) for the given type and client. */
  .get("/defaults", validate("query", documentDefaultsQuerySchema), (c) => {
    const { type, clientId, issueDate } = c.req.valid("query");
    return c.json(documentDefaults(db, type, clientId, issueDate));
  })
  .get("/:id", idParam, (c) => c.json(getDocument(db, c.req.valid("param").id)))
  .post("/", validate("json", documentCreateSchema), (c) => c.json(createDocument(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", documentUpdateSchema), (c) =>
    c.json(updateDocument(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id", idParam, (c) => {
    deleteDocument(db, c.req.valid("param").id);
    return c.json({ ok: true });
  })
  .post("/:id/finalize", idParam, async (c) => {
    const { id } = c.req.valid("param");
    const doc = finalizeDocument(db, id);
    // The number is committed at this point; a failing PDF freeze must not undo it.
    try {
      const pdfPath = await freezeDocumentPdf(id);
      if (pdfPath) {
        setPdfPath(db, id, pdfPath);
        return c.json({ ...doc, pdfPath });
      }
    } catch (err) {
      console.error(`freezeDocumentPdf(${id}) failed`, err);
    }
    return c.json(doc);
  })
  .post("/:id/status", idParam, validate("json", documentStatusSchema), (c) =>
    c.json(changeStatus(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/convert-to-invoice", idParam, (c) => c.json(convertOfferToInvoice(db, c.req.valid("param").id), 201))
  .post("/:id/credit-note", idParam, (c) => c.json(createCreditNote(db, c.req.valid("param").id), 201))
  .post("/:id/duplicate", idParam, (c) => c.json(duplicateDocument(db, c.req.valid("param").id), 201));

export default app;
