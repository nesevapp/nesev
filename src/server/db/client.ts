import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { MIGRATIONS_DIR } from "../lib/paths";
import * as schema from "./schema";

export function createDb(path: string) {
  const sqlite = new Database(path, { create: true });
  // the dev server and the MCP server may write concurrently: wait for the lock instead of failing.
  // Set first: switching to WAL / WAL recovery on open can hit a lock held by another process starting up.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;
/** Either the db or a transaction handle — accept this in helpers that may run inside a tx. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function runMigrations(target: Db) {
  migrate(target, { migrationsFolder: MIGRATIONS_DIR });
}

/** Fresh in-memory DB with all migrations applied (for tests). */
export function createTestDb(): Db {
  const d = createDb(":memory:");
  runMigrations(d);
  return d;
}
