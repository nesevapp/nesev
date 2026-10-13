import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { validate } from "../lib/validate";
import { buildForecast } from "../services/forecast";

const flag = z
  .enum(["0", "1", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

const querySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
  drafts: flag,
  offers: flag,
  /** 0..100 */
  probability: z.coerce.number().int().min(0).max(100).default(50),
});

const app = new Hono().get("/", validate("query", querySchema), (c) => {
  const q = c.req.valid("query");
  return c.json(
    buildForecast(db, {
      months: q.months,
      includeDrafts: q.drafts,
      includeOffers: q.offers,
      offerProbability: q.probability,
    }),
  );
});

export default app;
