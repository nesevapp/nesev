import { Hono } from "hono";
import { z } from "zod";
import { recurringCreateSchema, recurringUpdateSchema } from "../../shared/schemas/recurring";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  createRecurring,
  deleteRecurring,
  freezeGeneratedPdfs,
  generateNow,
  getRecurring,
  listRecurring,
  runDueRecurring,
  updateRecurring,
} from "../services/recurring";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", (c) => c.json(listRecurring(db)))
  /** "Jetzt ausführen": generate all due invoices (same as the hourly scheduler). */
  .post("/run", async (c) => {
    const created = runDueRecurring(db);
    await freezeGeneratedPdfs(db, created);
    return c.json({ created });
  })
  .get("/:id", idParam, (c) => c.json(getRecurring(db, c.req.valid("param").id)))
  .post("/", validate("json", recurringCreateSchema), (c) => c.json(createRecurring(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", recurringUpdateSchema), (c) =>
    c.json(updateRecurring(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id", idParam, (c) => {
    deleteRecurring(db, c.req.valid("param").id);
    return c.json({ ok: true });
  })
  /** "Rechnung jetzt erstellen": invoice the next period now and advance the schedule. */
  .post("/:id/generate", idParam, async (c) => {
    const created = generateNow(db, c.req.valid("param").id);
    await freezeGeneratedPdfs(db, [created]);
    return c.json(created, 201);
  });

export default app;
