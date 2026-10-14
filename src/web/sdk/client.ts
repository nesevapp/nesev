import { DetailedError, hc, parseResponse } from "hono/client";
import type articlesApp from "@server/routes/articles";
import type bankApp from "@server/routes/bank";
import type clientsApp from "@server/routes/clients";
import type dashboardApp from "@server/routes/dashboard";
import type documentsApp from "@server/routes/documents";
import type expensesApp from "@server/routes/expenses";
import type exportApp from "@server/routes/export";
import type forecastApp from "@server/routes/forecast";
import type receiptsApp from "@server/routes/receipts";
import type recurringApp from "@server/routes/recurring";
import type remindersApp from "@server/routes/reminders";
import type settingsApp from "@server/routes/settings";
import type taxApp from "@server/routes/tax";
import type templatesApp from "@server/routes/templates";
import type unitsApp from "@server/routes/units";
import type recurringExpensesApp from "@server/routes/recurring-expenses";
import type assetsApp from "@server/routes/assets";
import type searchApp from "@server/routes/search";
import type chatApp from "@server/routes/chat";

/**
 * One typed hc client per route module, each typed against that module only (not the merged AppType),
 * so the editor's TS server only has to instantiate the routes a resource file actually uses.
 * Only resource modules in src/web/sdk/ use these; features call the functions/hooks exported there.
 *
 * A module's root route ("/") is `.index` on its client: `clients.index.$get()` requests `/api/clients`.
 */
const base = `${window.location.origin}/api`;

export const articles = hc<typeof articlesApp>(`${base}/articles`);
export const bank = hc<typeof bankApp>(`${base}/bank`);
export const clients = hc<typeof clientsApp>(`${base}/clients`);
export const dashboard = hc<typeof dashboardApp>(`${base}/dashboard`);
export const documents = hc<typeof documentsApp>(`${base}/documents`);
export const expenses = hc<typeof expensesApp>(`${base}/expenses`);
export const exports = hc<typeof exportApp>(`${base}/export`);
export const forecast = hc<typeof forecastApp>(`${base}/forecast`);
export const receipts = hc<typeof receiptsApp>(`${base}/receipts`);
export const recurring = hc<typeof recurringApp>(`${base}/recurring`);
export const reminders = hc<typeof remindersApp>(`${base}/reminders`);
export const settings = hc<typeof settingsApp>(`${base}/settings`);
export const tax = hc<typeof taxApp>(`${base}/tax`);
export const templates = hc<typeof templatesApp>(`${base}/templates`);
export const recurringExpenses = hc<typeof recurringExpensesApp>(`${base}/recurring-expenses`);
export const assets = hc<typeof assetsApp>(`${base}/assets`);
export const search = hc<typeof searchApp>(`${base}/search`);
export const chat = hc<typeof chatApp>(`${base}/chat`);
export const units = hc<typeof unitsApp>(`${base}/units`);

/** parseResponse() returns the typed JSON body and throws DetailedError on non-2xx. */
export { parseResponse };

/** Route param for `/:id` routes. */
export const idParam = (id: number) => ({ id: String(id) });

/** Human-readable message from an API error (server sends { error: string }). */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof DetailedError) {
    const detail = err.detail as { data?: { error?: unknown } } | undefined;
    if (typeof detail?.data?.error === "string") return detail.data.error;
    return `Fehler ${err.statusCode ?? ""}`.trim();
  }
  if (err instanceof Error) return err.message;
  return "Unbekannter Fehler";
}
