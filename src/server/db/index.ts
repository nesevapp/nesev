import { DB_PATH, ensureDataDirs } from "../lib/paths";
import { createDb, runMigrations } from "./client";

export * from "./client";

if (DB_PATH !== ":memory:") ensureDataDirs();

/** The app-wide DB (data/nesev.db). Migrations are applied on first import. */
export const db = createDb(DB_PATH);
runMigrations(db);
