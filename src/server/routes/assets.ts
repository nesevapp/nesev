import { Hono } from "hono";

// Placeholder – implemented by the feature agent. Keep all handlers chained on this one Hono instance.
const app = new Hono().get("/", (c) => c.json({ todo: true }));

export default app;
