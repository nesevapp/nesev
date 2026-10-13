import { DetailedError, hc, parseResponse } from "hono/client";
import type { AppType } from "@server/app";

/**
 * Typed API client. Usage:
 *   const settings = await parseResponse(api.settings.$get());
 *   await parseResponse(api.settings.$put({ json: values }));
 *   await parseResponse(api.clients[":id"].$get({ param: { id: String(id) } }));
 * parseResponse() returns the typed JSON body and throws DetailedError on non-2xx.
 */
export const api = hc<AppType>(window.location.origin).api;

export { parseResponse };

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

/** URL for a file under data/ (e.g. settings.logoPath = "assets/logo.png"). */
export function fileUrl(relPath: string): string {
  return `/api/files/${relPath}`;
}
