import { join } from "node:path";
import { DATA_DIR, DATA_DIR_SOURCE, DB_PATH, ensureDataDirs } from "../lib/paths";
import { createDb, runMigrations } from "./client";

export * from "./client";

// Never create books in a folder nobody chose: without NESEV_DATA_DIR / a configured or existing data dir, DATA_DIR is
// only a placeholder (lib/paths.ts). The server imports this after the setup; other entry points must set one.
if (!DATA_DIR_SOURCE && !process.env.NESEV_DB) {
  throw new Error("nesev: no data dir chosen yet (start the server for the setup, or set NESEV_DATA_DIR)");
}
if (DB_PATH !== ":memory:") ensureDataDirs();

/** The app-wide DB (<data dir>/nesev.db). Migrations are applied on first import. */
export const db = createDb(DB_PATH);
// existing file DBs get a snapshot in backups/ before pending migrations are applied
runMigrations(db, DB_PATH === ":memory:" ? {} : { backupDir: join(DATA_DIR, "backups") });
