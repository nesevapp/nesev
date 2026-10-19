import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { MIGRATIONS_DIR } from "../lib/app-files";
import { createDb, runMigrations } from "./client";
import { isPreMigrationSnapshotName, knownMigrations, migrationState, snapshotBeforeMigration } from "./migration-state";

const known = knownMigrations();

/** A copy of the migrations folder with only the first `n` journal entries (an "older nesev"). */
function olderMigrations(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "nesev-old-migrations-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, n);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "nesev-migrate-test-"));
  return { dir, db: createDb(join(dir, "nesev.db")), backups: join(dir, "backups") };
}

const appliedCount = (path: string) => {
  const d = new Database(path, { readonly: true });
  try {
    return (d.query("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
  } finally {
    d.close();
  }
};

describe("migrationState", () => {
  test("fresh, current, older and newer databases", () => {
    const fresh = createDb(":memory:");
    expect(migrationState(fresh.$client)).toEqual({ applied: 0, pending: known, newer: false });

    const old = createDb(":memory:");
    migrate(old, { migrationsFolder: olderMigrations(known.length - 2) });
    const s = migrationState(old.$client);
    expect(s.applied).toBe(known.length - 2);
    expect(s.pending.map((m) => m.tag)).toEqual(known.slice(-2).map((m) => m.tag));
    expect(s.newer).toBe(false);

    runMigrations(old);
    expect(migrationState(old.$client)).toEqual({ applied: known.length, pending: [], newer: false });

    old.$client.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('x', ?)").run(known.at(-1)!.when + 1);
    expect(migrationState(old.$client).newer).toBe(true);
  });
});

describe("runMigrations with a backup dir", () => {
  test("snapshots an existing database before applying pending migrations", () => {
    const { dir, db, backups } = fileDb();
    migrate(db, { migrationsFolder: olderMigrations(known.length - 1) });
    db.$client.exec("INSERT INTO clients (number, name, created_at, updated_at) VALUES (1, 'Muster GmbH', 'x', 'x')");

    runMigrations(db, { backupDir: backups });

    const snaps = readdirSync(backups).filter(isPreMigrationSnapshotName);
    expect(snaps).toHaveLength(1);
    // the snapshot is the state before the update
    expect(appliedCount(join(backups, snaps[0]!))).toBe(known.length - 1);
    expect(appliedCount(join(dir, "nesev.db"))).toBe(known.length);
    const snap = new Database(join(backups, snaps[0]!), { readonly: true });
    expect(snap.query("SELECT name FROM clients").all()).toEqual([{ name: "Muster GmbH" }]);
    snap.close();

    // nothing pending → no further snapshot
    runMigrations(db, { backupDir: backups });
    expect(readdirSync(backups).filter(isPreMigrationSnapshotName)).toHaveLength(1);
  });

  test("a fresh database gets no snapshot", () => {
    const { db, backups } = fileDb();
    runMigrations(db, { backupDir: backups });
    expect(existsSync(backups)).toBe(false);
  });

  test("refuses to migrate when the snapshot fails", () => {
    const { dir, db } = fileDb();
    migrate(db, { migrationsFolder: olderMigrations(known.length - 1) });
    const notADir = join(dir, "backups-file");
    writeFileSync(notADir, "x");
    expect(() => runMigrations(db, { backupDir: notADir })).toThrow(/Sicherung vor dem Datenbank-Update fehlgeschlagen/);
    expect(migrationState(db.$client).pending).toHaveLength(1);
  });

  test("refuses a database written by a newer nesev", () => {
    const { db, backups } = fileDb();
    runMigrations(db);
    db.$client.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', ?)").run(known.at(-1)!.when + 1000);
    expect(() => runMigrations(db, { backupDir: backups })).toThrow(/neueren nesev-Version/);
  });
});

test("snapshotBeforeMigration keeps the newest few", () => {
  const { db, backups } = fileDb();
  runMigrations(db);
  mkdirSync(backups);
  writeFileSync(join(backups, "nesev-2026-01-01.db"), "daily");
  for (let i = 0; i < 7; i++) snapshotBeforeMigration(db.$client, backups, { now: new Date(2026, 0, 1, 10, 0, i), keep: 3 });
  expect(readdirSync(backups).sort()).toEqual([
    "nesev-2026-01-01.db",
    "pre-migration-2026-01-01-100004.db",
    "pre-migration-2026-01-01-100005.db",
    "pre-migration-2026-01-01-100006.db",
  ]);
});
