import { Hono } from "hono";
import { z } from "zod";
import { PDF_VARIABLES } from "../../shared/pdf/variables";
import { templateCreateSchema, templateUpdateSchema } from "../../shared/schemas/template";
import { db } from "../db";
import { validate } from "../lib/validate";
import { buildSampleInput } from "../services/pdf";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  removeTemplateBasePdf,
  requireTemplate,
  setDefaultTemplate,
  setTemplateBasePdf,
  updateTemplate,
} from "../services/pdf-templates";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", (c) => c.json(listTemplates(db)))
  /** Variables the mapper provides (for the designer's variable picker). */
  .get("/variables", (c) => c.json(PDF_VARIABLES))
  .get("/:id", idParam, (c) => c.json(requireTemplate(db, c.req.valid("param").id)))
  /** Sample input for designer previews, matching the mapper's fields, plus the variable list. */
  .get("/:id/sample-input", idParam, async (c) => {
    const row = requireTemplate(db, c.req.valid("param").id);
    return c.json({ input: await buildSampleInput(db, row.docType), variables: PDF_VARIABLES });
  })
  .post("/", validate("json", templateCreateSchema), async (c) => c.json(await createTemplate(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", templateUpdateSchema), (c) =>
    c.json(updateTemplate(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/default", idParam, (c) => c.json(setDefaultTemplate(db, c.req.valid("param").id)))
  /** multipart/form-data, field "file": letterhead PDF drawn under every page */
  .post(
    "/:id/base-pdf",
    idParam,
    validate("form", z.object({ file: z.instanceof(File, { message: "Keine Datei hochgeladen" }) })),
    async (c) => c.json(await setTemplateBasePdf(db, c.req.valid("param").id, c.req.valid("form").file)),
  )
  .delete("/:id/base-pdf", idParam, async (c) => c.json(await removeTemplateBasePdf(db, c.req.valid("param").id)))
  .delete("/:id", idParam, async (c) => {
    await deleteTemplate(db, c.req.valid("param").id);
    return c.json({ ok: true });
  });

export default app;
