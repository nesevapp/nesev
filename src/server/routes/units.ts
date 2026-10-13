import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { DEFAULT_UNITS, unitsSchema } from "../../shared/units";
import { db } from "../db";
import { settings } from "../db/schema";
import { validate } from "../lib/validate";
import { getSettings } from "../services/settings";

function currentUnits(): string[] {
  return getSettings(db).units ?? DEFAULT_UNITS;
}

const app = new Hono()
  .get("/", (c) => c.json({ units: currentUnits() }))
  .put("/", validate("json", z.object({ units: unitsSchema })), (c) => {
    getSettings(db); // ensure the singleton row exists
    db.update(settings).set({ units: c.req.valid("json").units }).where(eq(settings.id, 1)).run();
    return c.json({ units: currentUnits() });
  });

export default app;
