import { Hono } from "hono";
import { z } from "zod";
import {
  recurringExpenseCreateSchema,
  recurringExpenseLinkSchema,
  recurringExpenseUpdateSchema,
} from "../../shared/schemas/recurring-expense";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  candidateExpenses,
  createRecurringExpense,
  deleteRecurringExpense,
  getExpenseLink,
  getRecurringExpense,
  getSchedule,
  linkExpense,
  listRecurringExpenses,
  suggestSlots,
  unlinkExpense,
  updateRecurringExpense,
} from "../services/recurring-expenses";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));
const expenseQuery = validate("query", z.object({ expenseId: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", (c) => c.json(listRecurringExpenses(db)))
  /** Fixkosten slot the expense is linked to (or null). */
  .get("/link", expenseQuery, (c) => c.json(getExpenseLink(db, c.req.valid("query").expenseId)))
  /** Free slots the expense fits, best first. */
  .get("/suggestions", expenseQuery, (c) => c.json(suggestSlots(db, c.req.valid("query").expenseId)))
  .post("/links", validate("json", recurringExpenseLinkSchema), (c) => c.json(linkExpense(db, c.req.valid("json"))))
  .delete("/links/:expenseId", validate("param", z.object({ expenseId: z.coerce.number().int().positive() })), (c) => {
    unlinkExpense(db, c.req.valid("param").expenseId);
    return c.json({ ok: true });
  })
  .get("/:id", idParam, (c) => c.json(getRecurringExpense(db, c.req.valid("param").id)))
  /** Past and upcoming payment slots with the linked expenses. */
  .get("/:id/schedule", idParam, (c) => c.json(getSchedule(db, c.req.valid("param").id)))
  /** Unlinked expenses around a slot for the picker, matching ones first. */
  .get("/:id/candidates", idParam, validate("query", z.object({ date: z.iso.date() })), (c) =>
    c.json(candidateExpenses(db, c.req.valid("param").id, c.req.valid("query").date)),
  )
  .post("/", validate("json", recurringExpenseCreateSchema), (c) => c.json(createRecurringExpense(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", recurringExpenseUpdateSchema), (c) =>
    c.json(updateRecurringExpense(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id", idParam, (c) => {
    deleteRecurringExpense(db, c.req.valid("param").id);
    return c.json({ ok: true });
  });

export default app;
