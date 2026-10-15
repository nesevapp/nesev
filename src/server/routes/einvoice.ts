import { Hono } from "hono";
import { z } from "zod";
import { EINVOICE_FORMATS } from "../../shared/einvoice";
import { db } from "../db";
import { validate } from "../lib/validate";
import { buildEInvoiceFile, eInvoiceStatus } from "../services/einvoice";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const app = new Hono()
  /** Client's default format and, per format, what is missing (German messages). Finalized invoices/credit notes only. */
  .get("/documents/:id/status", validate("param", idParam), (c) => c.json(eInvoiceStatus(db, c.req.valid("param").id)))
  /**
   * Download: ?format=ebinterface|xrechnung → XML, zugferd → PDF with embedded factur-x.xml.
   * 422 { error } when required data is missing.
   */
  .get(
    "/documents/:id",
    validate("param", idParam),
    validate("query", z.object({ format: z.enum(EINVOICE_FORMATS) })),
    async (c) => {
      const file = await buildEInvoiceFile(db, c.req.valid("param").id, c.req.valid("query").format);
      return c.body(file.bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      });
    },
  );

export default app;
