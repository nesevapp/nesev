import type { Server } from "bun";
import { DEFAULT_PORT } from "./lib/app-files";
import { resolveDataDir } from "./lib/data-location";
import { applyPendingRestore } from "./services/restore";
import { createSetupApp } from "./setup";

export type { AppType } from "./app";

// Server entry. With a data dir (lib/data-location.ts) it loads the app right away; without one it serves the
// first-start setup and loads the app in-process once the user picked a folder. main.ts is imported dynamically
// because importing it opens the DB in the data dir.

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? DEFAULT_PORT);
// No auth: listen on the loopback interface only. NESEV_HOST=0.0.0.0 opens it to the network (at your own risk).
const hostname = process.env.NESEV_HOST ?? "127.0.0.1";

type Fetch = (req: Request, server: Server<undefined>) => Response | Promise<Response>;

async function loadApp(): Promise<Fetch> {
  // "Backup einspielen" staged a restore: swap it in before main.ts opens the DB (services/restore.ts)
  const dataDir = resolveDataDir();
  const restored = dataDir && applyPendingRestore(dataDir.dir);
  if (restored) console.log(`nesev: backup restored, the previous data is in ${restored.previousDataDir ?? "(nothing replaced)"}`);
  const main = await import("./main");
  return main.fetch;
}

let handler: Fetch;
if (resolveDataDir()) {
  handler = await loadApp();
} else {
  console.log("nesev: no data dir chosen yet, serving the setup");
  handler = createSetupApp({
    isProd,
    onComplete: async () => {
      handler = await loadApp();
    },
  }).fetch;
}

console.log(`nesev ${isProd ? "server" : "API"} listening on http://${hostname}:${port}`);

export default {
  port,
  hostname,
  // Bun's default (128 MB) would cut off "Backup einspielen" uploads with receipt photos; the routes set their own limits
  maxRequestBodySize: 4 * 1024 ** 3,
  fetch: (req: Request, server: Server<undefined>) => handler(req, server),
};
