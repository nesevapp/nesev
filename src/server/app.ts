import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import articles from "./routes/articles";
import clients from "./routes/clients";
import dashboard from "./routes/dashboard";
import documents from "./routes/documents";
import exportRoutes from "./routes/export";
import files from "./routes/files";
import forecast from "./routes/forecast";
import recurring from "./routes/recurring";
import reminders from "./routes/reminders";
import settings from "./routes/settings";
import pdf from "./routes/pdf";
import templates from "./routes/templates";

const base = new Hono();

base.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Interner Serverfehler" }, 500);
});

// Mount points. Feature agents implement the route files; this list should not need changes.
export const app = base
  .route("/api/settings", settings)
  .route("/api/clients", clients)
  .route("/api/documents", documents)
  .route("/api/templates", templates)
  .route("/api/pdf", pdf)
  .route("/api/files", files)
  .route("/api/dashboard", dashboard)
  .route("/api/export", exportRoutes)
  .route("/api/articles", articles)
  .route("/api/reminders", reminders)
  .route("/api/recurring", recurring)
  .route("/api/forecast", forecast);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export type AppType = typeof app;
