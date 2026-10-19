import { app } from "./app";
import { db } from "./db";
import { DATA_DIR, DATA_DIR_SOURCE, DB_PATH, WEB_DIST_DIR } from "./lib/paths";
import { startBackupScheduler } from "./services/backup";
import { startPdfRefreeze } from "./services/pdf-refreeze";
import { startReceiptInbox } from "./services/receipt-inbox";
import { getLlamaServer } from "./services/receipt-llama";
import { initReceiptQueue } from "./services/receipt-queue";
import { startRecurringScheduler } from "./services/recurring";
import { serveFile } from "./lib/static";

// The app once a data dir is known (imported by index.ts, after the first-start setup if there was one). Importing it
// opens the DB (migrations) and starts the schedulers.

const isProd = process.env.NODE_ENV === "production";

if (isProd) {
  // Built SPA: static assets, falling back to index.html for client-side routes.
  app.get("*", async (c) => {
    return (await serveFile(WEB_DIST_DIR, c.req.path)) ?? (await serveFile(WEB_DIST_DIR, "index.html")) ?? c.notFound();
  });
} else {
  app.get("/", (c) => c.text("nesev API — open the web app via Vite (bun run dev prints its URL)"));
}

// Daily local DB snapshots to data/backups (guarded against double start under bun --hot).
if (DB_PATH !== ":memory:") startBackupScheduler(db);
if (DB_PATH !== ":memory:") startRecurringScheduler(db);
// finalized documents/reminders whose PDF freeze failed: freeze them now (background, logs what it fixed)
if (DB_PATH !== ":memory:") startPdfRefreeze(db);
// Belege-Eingang: poll the inbox folder (copies new files, never analyses them)
if (DB_PATH !== ":memory:") startReceiptInbox(db);
if (DB_PATH !== ":memory:") {
  // receipt analysis: recover runs interrupted by a restart, resume the queue
  initReceiptQueue(db);
  // llama-server: exit handlers + reap a llama-server orphaned by a hard-killed previous instance
  getLlamaServer();
}

console.log(`nesev data dir: ${DATA_DIR}${DATA_DIR_SOURCE ? ` (${DATA_DIR_SOURCE.source})` : ""}`);

export const fetch = app.fetch;
