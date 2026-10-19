import { join } from "node:path";
import { DATA_DIR, DB_PATH, ensureDataDirs } from "../lib/paths";
import { createDb, runMigrations } from "./client";

export * from "./client";

if (DB_PATH !== ":memory:") ensureDataDirs();

/** The app-wide DB (<data dir>/nesev.db). Migrations are applied on first import. */
export const db = createDb(DB_PATH);
// existing file DBs get a snapshot in backups/ before pending migrations are applied
runMigrations(db, DB_PATH === ":memory:" ? {} : { backupDir: join(DATA_DIR, "backups") });
