import { Hono } from "hono";

// Placeholder – implemented by the chat server agent (contract: src/shared/chat.ts). Keep all handlers
// chained on this one Hono instance.
const app = new Hono().get("/status", (c) => c.json({ todo: true }));

export default app;
