import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR } from "../lib/app-files";

// Which migrations a database has, compared with the ones this nesev version ships (drizzle's journal). drizzle's
// migrator applies every journal entry whose `when` is newer than the latest `created_at` in __drizzle_migrations, so
// that is what "pending" means here too. A database whose latest migration is newer than every known one was written
// by a newer nesev: opening it with this version is refused (runMigrations, restore). No lib/paths import: the restore
// (services/restore.ts) uses it before a data dir is known.

export interface KnownMigration {
  tag: string;
  /** journal timestamp, stored by drizzle as __drizzle_migrations.created_at */
  when: number;
}

export function knownMigrations(dir = MIGRATIONS_DIR): KnownMigration[] {
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: KnownMigration[] };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

export interface MigrationState {
  /** rows in __drizzle_migrations (0 = fresh database) */
  applied: number;
  /** migrations this version would apply */
  pending: KnownMigration[];
  /** written by a newer nesev: has a migration later than every one this version knows */
  newer: boolean;
}

export function migrationState(sqlite: Database, known = knownMigrations()): MigrationState {
  const table = sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  const times = table
    ? (sqlite.query("SELECT created_at AS t FROM __drizzle_migrations").all() as { t: number | string | null }[])
        .map((r) => Number(r.t))
        .filter(Number.isFinite)
    : [];
  const latest = times.length > 0 ? Math.max(...times) : null;
  const latestKnown = Math.max(...known.map((m) => m.when));
  return {
    applied: times.length,
    pending: known.filter((m) => latest === null || m.when > latest),
    newer: latest !== null && latest > latestKnown,
  };
}

export const NEWER_DATABASE_MESSAGE =
  "Die Datenbank wurde von einer neueren nesev-Version geschrieben. Bitte nesev aktualisieren, bevor Sie sie öffnen. " +
  "(This database was written by a newer version of nesev. Please update nesev.)";

/** Local date and time for file names: 2026-10-19-143005. */
export function fileStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Pre-migration snapshots kept in the backups folder (the daily backup pruning doesn't touch them). */
export const PRE_MIGRATION_KEEP = 5;
const PRE_MIGRATION_RE = /^pre-migration-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.db$/;

export function isPreMigrationSnapshotName(name: string): boolean {
  return PRE_MIGRATION_RE.test(name);
}

/**
 * Consistent `VACUUM INTO` snapshot to `<dir>/pre-migration-<stamp>.db` (temp name first, so a crash never leaves a
 * half-written file under the real name), then prunes all but the newest `keep`. Returns the snapshot's path.
 */
export function snapshotBeforeMigration(sqlite: Database, dir: string, { now = new Date(), keep = PRE_MIGRATION_KEEP } = {}): string {
  mkdirSync(dir, { recursive: true });
  const base = `pre-migration-${fileStamp(now)}`;
  let name = `${base}.db`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}.db`;
  const dest = join(dir, name);
  const tmp = join(dir, `.${name}.tmp`);
  try {
    sqlite.query("VACUUM INTO ?").run(tmp);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
  // names sort chronologically
  const old = readdirSync(dir).filter(isPreMigrationSnapshotName).sort().reverse().slice(keep);
  for (const n of old) rmSync(join(dir, n), { force: true });
  return dest;
}
