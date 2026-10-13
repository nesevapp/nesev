import { Hono } from "hono";
import { z } from "zod";
import { todayIso } from "../../shared/dates";
import { db } from "../db";
import { validate } from "../lib/validate";
import { getDashboard } from "../services/dashboard";

const query = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

const app = new Hono().get("/", validate("query", query), (c) => {
  const today = todayIso();
  const year = c.req.valid("query").year ?? Number(today.slice(0, 4));
  return c.json(getDashboard(db, year, today));
});

export default app;
