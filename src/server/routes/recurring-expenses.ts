import { Hono } from "hono";
import { z } from "zod";
import { recurringExpenseCreateSchema, recurringExpenseUpdateSchema } from "../../shared/schemas/recurring-expense";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  createRecurringExpense,
  deleteRecurringExpense,
  getRecurringExpense,
  listRecurringExpenses,
  updateRecurringExpense,
} from "../services/recurring-expenses";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", (c) => c.json(listRecurringExpenses(db)))
  .get("/:id", idParam, (c) => c.json(getRecurringExpense(db, c.req.valid("param").id)))
  .post("/", validate("json", recurringExpenseCreateSchema), (c) => c.json(createRecurringExpense(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", recurringExpenseUpdateSchema), (c) =>
    c.json(updateRecurringExpense(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id", idParam, (c) => {
    deleteRecurringExpense(db, c.req.valid("param").id);
    return c.json({ ok: true });
  });

export default app;
