import { Hono } from "hono";
import { z } from "zod";
import {
  reminderBulkCreateSchema,
  reminderCreateSchema,
  reminderListQuerySchema,
  reminderSettingsSchema,
  reminderUpdateSchema,
} from "../../shared/schemas/reminder";
import { db } from "../db";
import { validate } from "../lib/validate";
import { freezeReminderPdfWith } from "../services/pdf";
import {
  createReminder,
  createReminders,
  deleteReminder,
  finalizeReminder,
  getReminder,
  getReminderSettings,
  listDueInvoices,
  listReminders,
  markReminderSent,
  setReminderPdfPath,
  updateReminder,
  updateReminderSettings,
} from "../services/reminders";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", validate("query", reminderListQuerySchema), (c) => c.json(listReminders(db, c.req.valid("query"))))
  /** Overdue unpaid invoices with their dunning state ("Fällig zum Mahnen"). */
  .get("/due", (c) => c.json(listDueInvoices(db)))
  /** Mahnstufen, fees and interest (settings.reminder_levels; defaults when unset). */
  .get("/settings", (c) => c.json(getReminderSettings(db)))
  .put("/settings", validate("json", reminderSettingsSchema), (c) =>
    c.json(updateReminderSettings(db, c.req.valid("json"))),
  )
  .get("/:id", idParam, (c) => c.json(getReminder(db, c.req.valid("param").id)))
  /** New draft for an overdue invoice (next level unless `level` is given). */
  .post("/", validate("json", reminderCreateSchema), (c) => c.json(createReminder(db, c.req.valid("json")), 201))
  /** Drafts for several invoices: { created, errors }. */
  .post("/bulk", validate("json", reminderBulkCreateSchema), (c) =>
    c.json(createReminders(db, c.req.valid("json").invoiceIds), 201),
  )
  .put("/:id", idParam, validate("json", reminderUpdateSchema), (c) =>
    c.json(updateReminder(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id", idParam, (c) => {
    deleteReminder(db, c.req.valid("param").id);
    return c.json({ ok: true });
  })
  .post("/:id/finalize", idParam, async (c) => {
    const { id } = c.req.valid("param");
    const reminder = finalizeReminder(db, id);
    // The number is committed at this point; a failing PDF freeze must not undo it.
    try {
      const pdfPath = await freezeReminderPdfWith(db, id);
      setReminderPdfPath(db, id, pdfPath);
      return c.json({ ...reminder, pdfPath });
    } catch (err) {
      console.error(`freezeReminderPdf(${id}) failed`, err);
    }
    return c.json(reminder);
  })
  .post("/:id/sent", idParam, (c) => c.json(markReminderSent(db, c.req.valid("param").id)));

export default app;
