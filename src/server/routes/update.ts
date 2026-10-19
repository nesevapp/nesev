import { Hono } from "hono";
import { z } from "zod";
import { validate } from "../lib/validate";
import { getUpdateStatus, setUpdateCheck } from "../services/update-check";

// Update hint: GET answers from a once-a-day cache (?force=1 checks now), PUT switches the check on or off.
const app = new Hono()
  .get("/", validate("query", z.object({ force: z.literal("1").optional() })), async (c) =>
    c.json(await getUpdateStatus({ force: c.req.valid("query").force === "1" })),
  )
  .put("/", validate("json", z.object({ enabled: z.boolean() })), async (c) => {
    if (process.env.NESEV_UPDATE_CHECK === "0") return c.json({ error: "Durch NESEV_UPDATE_CHECK=0 abgeschaltet" }, 409);
    setUpdateCheck(c.req.valid("json").enabled);
    return c.json(await getUpdateStatus());
  });

export default app;
