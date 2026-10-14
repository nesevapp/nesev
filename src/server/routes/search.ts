import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { validate } from "../lib/validate";
import { search } from "../services/search";

const searchQuerySchema = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});

/** Global search for the command palette: grouped results, see services/search.ts. */
const app = new Hono().get("/", validate("query", searchQuerySchema), (c) => {
  const { q, limit } = c.req.valid("query");
  return c.json(search(db, q, limit));
});

export default app;
