import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import articles from "./routes/articles";
import bank from "./routes/bank";
import clients from "./routes/clients";
import dashboard from "./routes/dashboard";
import documents from "./routes/documents";
import einvoice from "./routes/einvoice";
import expenses from "./routes/expenses";
import exportRoutes from "./routes/export";
import files from "./routes/files";
import forecast from "./routes/forecast";
import recurring from "./routes/recurring";
import reminders from "./routes/reminders";
import settings from "./routes/settings";
import pdf from "./routes/pdf";
import receipts from "./routes/receipts";
import receiptInbox from "./routes/receipt-inbox";
import recurringExpenses from "./routes/recurring-expenses";
import assets from "./routes/assets";
import search from "./routes/search";
import chat from "./routes/chat";
import transcribe from "./routes/transcribe";
import tax from "./routes/tax";
import templates from "./routes/templates";
import units from "./routes/units";

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
  .route("/api/einvoice", einvoice)
  .route("/api/files", files)
  .route("/api/dashboard", dashboard)
  .route("/api/export", exportRoutes)
  .route("/api/articles", articles)
  .route("/api/reminders", reminders)
  .route("/api/recurring", recurring)
  .route("/api/forecast", forecast)
  .route("/api/expenses", expenses)
  .route("/api/bank", bank)
  .route("/api/tax", tax)
  .route("/api/units", units)
  .route("/api/receipts", receipts)
  .route("/api/receipt-inbox", receiptInbox)
  .route("/api/recurring-expenses", recurringExpenses)
  .route("/api/assets", assets)
  .route("/api/search", search)
  .route("/api/chat", chat)
  .route("/api/transcribe", transcribe);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export type AppType = typeof app;
