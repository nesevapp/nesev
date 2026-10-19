import { Hono } from "hono";
import { z } from "zod";
import { todayIso } from "../../shared/dates";
import { taxStatusInputSchema } from "../../shared/schemas/tax-status";
import { db } from "../db";
import { validate } from "../lib/validate";
import { createTaxStatusPeriod, deleteTaxStatusPeriod, listTaxStatusPeriods, taxStatusAt, updateTaxStatusPeriod } from "../services/tax-status";

// Steuerstatus history (Kleinunternehmer, Soll/Ist with valid-from dates), see src/shared/tax-status.ts.
// Every write returns the whole history (oldest first); invalid histories → 422 with a German message.

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", (c) => c.json({ periods: listTaxStatusPeriods(db), today: todayIso(), current: taxStatusAt(db) }))
  .post("/", validate("json", taxStatusInputSchema), (c) => c.json({ periods: createTaxStatusPeriod(db, c.req.valid("json")) }, 201))
  .put("/:id", idParam, validate("json", taxStatusInputSchema), (c) =>
    c.json({ periods: updateTaxStatusPeriod(db, c.req.valid("param").id, c.req.valid("json")) }),
  )
  .delete("/:id", idParam, (c) => c.json({ periods: deleteTaxStatusPeriod(db, c.req.valid("param").id) }));

export default app;
