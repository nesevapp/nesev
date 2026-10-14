import { app } from "./app";
import { db } from "./db";
import { DB_PATH, WEB_DIST_DIR } from "./lib/paths";
import { startBackupScheduler } from "./services/backup";
import { getLlamaServer } from "./services/receipt-llama";
import { initReceiptQueue } from "./services/receipt-queue";
import { startRecurringScheduler } from "./services/recurring";
import { serveFile } from "./lib/static";

export type { AppType } from "./app";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3001);

if (isProd) {
  // Built SPA: static assets, falling back to index.html for client-side routes.
  app.get("*", async (c) => {
    return (await serveFile(WEB_DIST_DIR, c.req.path)) ?? (await serveFile(WEB_DIST_DIR, "index.html")) ?? c.notFound();
  });
} else {
  app.get("/", (c) => c.text("nesev API — open the web app at http://localhost:5173"));
}

// Daily local DB snapshots to data/backups (guarded against double start under bun --hot).
if (DB_PATH !== ":memory:") startBackupScheduler(db);
if (DB_PATH !== ":memory:") startRecurringScheduler(db);
if (DB_PATH !== ":memory:") {
  // receipt analysis: recover runs interrupted by a restart, resume the queue
  initReceiptQueue(db);
  // llama-server: exit handlers + reap a llama-server orphaned by a hard-killed previous instance
  getLlamaServer();
}

console.log(`nesev ${isProd ? "server" : "API"} listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };
