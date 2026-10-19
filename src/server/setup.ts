import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { WEB_DIST_DIR } from "./lib/app-files";
import { originGuard } from "./lib/origin-guard";
import { securityHeaders } from "./lib/security-headers";
import { serveFile } from "./lib/static";
import setup, { setSetupCompleteHook } from "./routes/setup";

// Setup mode: no data dir yet (lib/data-location.ts). Serves the SPA (which shows the setup page) and /api/setup;
// every other API call answers 503 { setupRequired: true }. Imports nothing that resolves the data dir.

export function createSetupApp(opts: { isProd: boolean; onComplete: () => Promise<void> }) {
  setSetupCompleteHook(opts.onComplete);
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Interner Serverfehler" }, 500);
  });
  app.use("*", originGuard());
  app.use("*", securityHeaders());
  app.route("/api/setup", setup);
  app.all("/api/*", (c) => c.json({ error: "nesev ist noch nicht eingerichtet", setupRequired: true }, 503));
  if (opts.isProd) {
    app.get("*", async (c) => (await serveFile(WEB_DIST_DIR, c.req.path)) ?? (await serveFile(WEB_DIST_DIR, "index.html")) ?? c.notFound());
  } else {
    app.get("/", (c) => c.text("nesev API (Einrichtung) — open the web app via Vite (bun run dev prints its URL)"));
  }
  return app;
}
