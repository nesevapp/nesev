import { type ClientResponse, DetailedError, hc, parseResponse } from "hono/client";
import { app } from "../server/app";
import type articlesApp from "../server/routes/articles";
import type assetsApp from "../server/routes/assets";
import type bankApp from "../server/routes/bank";
import type clientsApp from "../server/routes/clients";
import type dashboardApp from "../server/routes/dashboard";
import type documentsApp from "../server/routes/documents";
import type expensesApp from "../server/routes/expenses";
import type forecastApp from "../server/routes/forecast";
import type recurringApp from "../server/routes/recurring";
import type recurringExpensesApp from "../server/routes/recurring-expenses";
import type remindersApp from "../server/routes/reminders";
import type searchApp from "../server/routes/search";
import type settingsApp from "../server/routes/settings";
import type taxApp from "../server/routes/tax";
import type templatesApp from "../server/routes/templates";
import type unitsApp from "../server/routes/units";

// In-process access to nesev's own API: typed hc clients whose fetch is the Hono app itself (no HTTP, no port).
// Business logic, validation and error messages stay in the routes/services; the MCP layer only formats.
// Like src/web/sdk/client.ts, each client is typed against its route module only, not the merged AppType.

const BASE = "http://nesev.local/api";
const fetch = (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init));

export const api = {
  articles: hc<typeof articlesApp>(`${BASE}/articles`, { fetch }),
  assets: hc<typeof assetsApp>(`${BASE}/assets`, { fetch }),
  bank: hc<typeof bankApp>(`${BASE}/bank`, { fetch }),
  clients: hc<typeof clientsApp>(`${BASE}/clients`, { fetch }),
  dashboard: hc<typeof dashboardApp>(`${BASE}/dashboard`, { fetch }),
  documents: hc<typeof documentsApp>(`${BASE}/documents`, { fetch }),
  expenses: hc<typeof expensesApp>(`${BASE}/expenses`, { fetch }),
  forecast: hc<typeof forecastApp>(`${BASE}/forecast`, { fetch }),
  recurring: hc<typeof recurringApp>(`${BASE}/recurring`, { fetch }),
  recurringExpenses: hc<typeof recurringExpensesApp>(`${BASE}/recurring-expenses`, { fetch }),
  reminders: hc<typeof remindersApp>(`${BASE}/reminders`, { fetch }),
  search: hc<typeof searchApp>(`${BASE}/search`, { fetch }),
  settings: hc<typeof settingsApp>(`${BASE}/settings`, { fetch }),
  tax: hc<typeof taxApp>(`${BASE}/tax`, { fetch }),
  templates: hc<typeof templatesApp>(`${BASE}/templates`, { fetch }),
  units: hc<typeof unitsApp>(`${BASE}/units`, { fetch }),
};
export type Api = typeof api;

/** Route param for `/:id` routes. */
export const idParam = (id: number) => ({ id: String(id) });

/** A non-2xx API response; `message` is the API's (German) error text. Tools turn it into `isError: true`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ErrorBody {
  error?: unknown;
  issues?: { path?: (string | number)[]; message?: string }[];
}

/** "Ungültige Eingabe: dueDate: Ungültiges Datum" from the uniform 400 body of lib/validate.ts. */
function errorMessage(status: number, body: ErrorBody | undefined): string {
  const base = typeof body?.error === "string" && body.error ? body.error : `Fehler ${status}`;
  const issues = (body?.issues ?? [])
    .map((i) => [i.path?.length ? i.path.join(".") : "", i.message ?? ""].filter(Boolean).join(": "))
    .filter(Boolean);
  return issues.length ? `${base}: ${issues.join("; ")}` : base;
}

/**
 * Awaits an hc call and returns the typed JSON body; a non-2xx response throws ApiError with the API's message.
 * Usage: `const doc = await call(api.documents[":id"].$get({ param: idParam(id) }))`
 */
export async function call<T extends ClientResponse<any>>(request: Promise<T>) {
  try {
    return await parseResponse(request);
  } catch (err) {
    if (err instanceof DetailedError) {
      const detail = err.detail as { data?: ErrorBody } | undefined;
      throw new ApiError(err.statusCode ?? 500, errorMessage(err.statusCode ?? 500, detail?.data));
    }
    throw err;
  }
}
