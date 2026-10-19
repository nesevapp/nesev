import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { MIGRATIONS_DIR } from "../lib/app-files";
import { migrationState, NEWER_DATABASE_MESSAGE, snapshotBeforeMigration } from "./migration-state";
import * as schema from "./schema";

export function createDb(path: string) {
  const sqlite = new Database(path, { create: true });
  // the dev server and the MCP server may write concurrently: wait for the lock instead of failing.
  // Set first: switching to WAL / WAL recovery on open can hit a lock held by another process starting up.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const d = drizzle(sqlite, { schema });
  // Every transaction defaults to BEGIN IMMEDIATE: a DEFERRED transaction that reads first and writes later fails
  // at once with SQLITE_BUSY_SNAPSHOT when the other process (MCP server) commits in between; busy_timeout can't help
  // there. IMMEDIATE takes the write lock up front, so it waits (busy_timeout) instead. Callers may still pass a config.
  const transaction = d.transaction.bind(d);
  d.transaction = ((fn, config) => transaction(fn, { behavior: "immediate", ...config })) as typeof d.transaction;
  return d;
}

export type Db = ReturnType<typeof createDb>;
/** Either the db or a transaction handle — accept this in helpers that may run inside a tx. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Applies pending migrations. Refuses a database written by a newer nesev. With `backupDir`, a database that already
 * has migrations gets a `VACUUM INTO` snapshot (backups/pre-migration-<stamp>.db) before any pending one is applied;
 * if that snapshot fails, nothing is migrated.
 */
export function runMigrations(target: Db, { backupDir }: { backupDir?: string } = {}) {
  const state = migrationState(target.$client);
  if (state.newer) throw new Error(NEWER_DATABASE_MESSAGE);
  if (backupDir && state.applied > 0 && state.pending.length > 0) {
    let snapshot: string;
    try {
      snapshot = snapshotBeforeMigration(target.$client, backupDir);
    } catch (err) {
      throw new Error(
        `Sicherung vor dem Datenbank-Update fehlgeschlagen, die Datenbank wurde nicht verändert (Speicherplatz und Schreibrechte in ${backupDir} prüfen). ` +
          `(Snapshot before the database update failed; nothing was migrated: ${err instanceof Error ? err.message : err})`,
        { cause: err },
      );
    }
    console.log(`nesev: ${state.pending.length} database update(s) pending, snapshot written: ${snapshot}`);
  }
  migrate(target, { migrationsFolder: MIGRATIONS_DIR });
}

/** Fresh in-memory DB with all migrations applied (for tests). */
export function createTestDb(): Db {
  const d = createDb(":memory:");
  runMigrations(d);
  return d;
}
