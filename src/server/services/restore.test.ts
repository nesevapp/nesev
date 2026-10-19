import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { createDb, runMigrations } from "../db/client";
import { knownMigrations } from "../db/migration-state";
import { clients, documents, settings } from "../db/schema";
import { createBackupZip, snapshotDatabase } from "./backup";
import {
  applyPendingRestore,
  confirmPendingRestore,
  discardPendingRestore,
  inspectBackupZip,
  pendingRestore,
  restoreIntoEmptyDir,
  RestoreError,
  stageRestore,
} from "./restore";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `nesev-restore-${p}-`));

/**
 * A data dir whose nesev.db holds one client `name`, plus the given files. `db` is a separate source DB with the same
 * data (createBackupZip needs one): a drizzle connection on the data dir's own nesev.db would stay open after close()
 * (unfinalized statements), and macOS SQLite then fails on the renamed file (SQLITE_IOERR_VNODE).
 */
function dataDir(name: string, files: Record<string, string> = {}, setup?: (db: ReturnType<typeof createDb>) => void) {
  const dir = tmp("data");
  const db = createDb(join(tmp("src"), "source.db"));
  runMigrations(db);
  db.insert(settings).values({ id: 1, companyName: `${name} e.U.` }).run();
  db.insert(clients).values({ number: 1, name }).run();
  setup?.(db);
  snapshotDatabase(db, join(dir, "nesev.db"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return { dir, db };
}

async function backupOf(d: { dir: string; db: ReturnType<typeof createDb> }): Promise<Uint8Array> {
  const stream = createBackupZip(d.db, { assets: join(d.dir, "assets"), pdfs: join(d.dir, "pdfs"), receipts: join(d.dir, "receipts") });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function clientNames(dbPath: string): string[] {
  const d = new Database(dbPath, { readonly: true });
  try {
    return (d.query("SELECT name FROM clients").all() as { name: string }[]).map((r) => r.name);
  } finally {
    d.close();
  }
}

const restoreError = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RestoreError);
    return (err as Error).message;
  }
  throw new Error("expected a RestoreError");
};

describe("inspectBackupZip", () => {
  test("summarizes a backup from Backup herunterladen", async () => {
    const src = dataDir("Alt GmbH", { "assets/logo.png": "png", "pdfs/RE-2026-0001.pdf": "%PDF", "receipts/2026/a.jpg": "jpg" }, (db) =>
      db
        .insert(documents)
        .values({ type: "invoice", status: "final", number: "RE-2026-0001", clientId: 1, issueDate: "2026-03-01", taxMode: "AT_DOMESTIC" })
        .run(),
    );
    const s = inspectBackupZip(await backupOf(src));
    expect(s).toMatchObject({
      kind: "zip",
      companyName: "Alt GmbH e.U.",
      clients: 1,
      invoices: 1,
      creditNotes: 0,
      latestDocumentDate: "2026-03-01",
      files: { assets: 1, pdfs: 1, receipts: 1 },
      pendingMigrations: 0,
    });
  });

  test("accepts a bare database file and a backup wrapped in a folder", async () => {
    const src = dataDir("Alt GmbH");
    const snap = join(src.dir, "snap.db");
    snapshotDatabase(src.db, snap);
    expect(inspectBackupZip(new Uint8Array(readFileSync(snap)))).toMatchObject({ kind: "database", clients: 1 });

    const files = unzipSync(await backupOf(src));
    const wrapped = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`nesev-backup-2026-10-19/${k}`, v])));
    expect(inspectBackupZip(wrapped)).toMatchObject({ kind: "zip", clients: 1 });
  });

  test("rejects what isn't a valid nesev backup", async () => {
    expect(restoreError(() => inspectBackupZip(new TextEncoder().encode("hello")))).toMatch(/kein nesev-Backup/);
    expect(restoreError(() => inspectBackupZip(zipSync({ "foo.txt": new Uint8Array([1]) })))).toMatch(/nesev\.db/);
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE x (a)");
    expect(restoreError(() => inspectBackupZip(zipSync({ "nesev.db": sqlite.serialize() })))).toMatch(/keine nesev-Daten/);

    const src = dataDir("Alt GmbH");
    const files = unzipSync(await backupOf(src));
    expect(restoreError(() => inspectBackupZip(zipSync({ ...files, "../evil.txt": new Uint8Array([1]) })))).toMatch(/Ungültiger Pfad/);
    expect(restoreError(() => inspectBackupZip(zipSync({ ...files, "assets/../../evil": new Uint8Array([1]) })))).toMatch(/Ungültiger Pfad/);

    // corrupt compressed data → CRC/size check
    const zip = zipSync({ "nesev.db": files["nesev.db"]! }, { level: 0 });
    zip[200] = zip[200]! ^ 0xff;
    expect(restoreError(() => inspectBackupZip(zip))).toMatch(/beschädigt/);
    // truncated upload
    const full = await backupOf(src);
    expect(restoreError(() => inspectBackupZip(full.subarray(0, 2000)))).toMatch(/unvollständig|beschädigt/);
  });

  test("rejects a backup from a newer nesev", () => {
    const src = dataDir("Neu GmbH");
    src.db.$client.query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', ?)").run(knownMigrations().at(-1)!.when + 1);
    const snap = join(src.dir, "snap.db");
    snapshotDatabase(src.db, snap);
    expect(restoreError(() => inspectBackupZip(zipSync({ "nesev.db": new Uint8Array(readFileSync(snap)) })))).toMatch(/neueren nesev-Version/);
  });
});

describe("stage + apply", () => {
  test("replaces database and files, keeping the previous ones in backups/before-restore-…", async () => {
    const backup = await backupOf(dataDir("Backup GmbH", { "pdfs/RE-2025-0001.pdf": "%PDF backup", "assets/logo.png": "backup logo" }));
    const live = dataDir("Live GmbH", { "assets/logo.png": "live logo", "receipts/2026/x.jpg": "live receipt" });

    const summary = stageRestore(live.dir, backup);
    expect(summary.companyName).toBe("Backup GmbH e.U.");
    // nothing changes before the restart
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Live GmbH"]);
    expect(pendingRestore(live.dir)?.summary).toEqual(summary);

    const applied = applyPendingRestore(live.dir, new Date(2026, 9, 19, 12, 0, 0))!;
    expect(applied.previousDataDir).toBe(join(live.dir, "backups", "before-restore-2026-10-19-120000"));
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Backup GmbH"]);
    expect(readFileSync(join(live.dir, "assets/logo.png"), "utf8")).toBe("backup logo");
    expect(readFileSync(join(live.dir, "pdfs/RE-2025-0001.pdf"), "utf8")).toBe("%PDF backup");
    // receipts/ is replaced too, even though the backup has none
    expect(readdirSync(join(live.dir, "receipts"))).toEqual([]);

    const prev = applied.previousDataDir!;
    expect(clientNames(join(prev, "nesev.db"))).toEqual(["Live GmbH"]);
    expect(readFileSync(join(prev, "receipts/2026/x.jpg"), "utf8")).toBe("live receipt");
    expect(existsSync(join(live.dir, "restore-pending"))).toBe(false);
    expect(pendingRestore(live.dir)).toBeNull();
    expect(applyPendingRestore(live.dir)).toBeNull();
  });

  test("an unconfirmed staged restore is not applied (web UI: summary first, then confirm)", async () => {
    const backup = await backupOf(dataDir("Backup GmbH"));
    const live = dataDir("Live GmbH");
    stageRestore(live.dir, backup, { confirmed: false });
    expect(pendingRestore(live.dir)).toBeNull();
    expect(applyPendingRestore(live.dir)).toBeNull();
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Live GmbH"]);
    expect(existsSync(join(live.dir, "restore-pending"))).toBe(false);
    restoreError(() => confirmPendingRestore(live.dir));

    stageRestore(live.dir, backup, { confirmed: false });
    expect(confirmPendingRestore(live.dir).summary.companyName).toBe("Backup GmbH e.U.");
    expect(pendingRestore(live.dir)).not.toBeNull();
    applyPendingRestore(live.dir);
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Backup GmbH"]);
  });

  test("a bare database replaces only the database", () => {
    const src = dataDir("Backup GmbH");
    const snap = join(src.dir, "snap.db");
    snapshotDatabase(src.db, snap);
    const live = dataDir("Live GmbH", { "assets/logo.png": "live logo" });
    stageRestore(live.dir, new Uint8Array(readFileSync(snap)));
    const applied = applyPendingRestore(live.dir)!;
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Backup GmbH"]);
    expect(readFileSync(join(live.dir, "assets/logo.png"), "utf8")).toBe("live logo");
    expect(clientNames(join(applied.previousDataDir!, "nesev.db"))).toEqual(["Live GmbH"]);
    expect(existsSync(join(applied.previousDataDir!, "assets"))).toBe(false);
  });

  test("an invalid upload stages nothing and keeps an earlier staged restore", async () => {
    const live = dataDir("Live GmbH");
    stageRestore(live.dir, await backupOf(dataDir("Erstes Backup")));
    restoreError(() => stageRestore(live.dir, new TextEncoder().encode("nope")));
    expect(pendingRestore(live.dir)?.summary.companyName).toBe("Erstes Backup e.U.");
    expect(readdirSync(live.dir).filter((n) => n.startsWith("restore-staging-"))).toEqual([]);
    discardPendingRestore(live.dir);
    expect(pendingRestore(live.dir)).toBeNull();
  });

  test("leftovers of an interrupted staging are ignored", () => {
    const live = dataDir("Live GmbH");
    // crash while extracting: staging dir without marker
    mkdirSync(join(live.dir, "restore-staging-abc", "pdfs"), { recursive: true });
    writeFileSync(join(live.dir, "restore-staging-abc", "nesev.db"), "half");
    // crash while discarding: pending dir whose READY.json is already gone
    mkdirSync(join(live.dir, "restore-pending"));
    writeFileSync(join(live.dir, "restore-pending", "nesev.db"), "half");
    expect(applyPendingRestore(live.dir)).toBeNull();
    expect(readdirSync(live.dir).filter((n) => n.startsWith("restore-"))).toEqual([]);
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Live GmbH"]);
  });

  test("an apply interrupted midway is resumed on the next start", async () => {
    const backup = await backupOf(dataDir("Backup GmbH", { "assets/logo.png": "backup logo" }));
    const live = dataDir("Live GmbH", { "assets/logo.png": "live logo" });
    stageRestore(live.dir, backup);
    // crash after the journal was written and the live DB moved, before assets/ was moved
    const pending = join(live.dir, "restore-pending");
    writeFileSync(join(pending, "APPLYING.json"), JSON.stringify({ backupDir: "backups/before-restore-x", phase: "backup" }));
    mkdirSync(join(live.dir, "backups", "before-restore-x"), { recursive: true });
    renameSync(join(live.dir, "nesev.db"), join(live.dir, "backups", "before-restore-x", "nesev.db"));
    // a new upload must not replace a half-applied restore
    restoreError(() => stageRestore(live.dir, backup));

    const applied = applyPendingRestore(live.dir)!;
    expect(applied.previousDataDir).toBe(join(live.dir, "backups", "before-restore-x"));
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Backup GmbH"]);
    expect(readFileSync(join(live.dir, "assets/logo.png"), "utf8")).toBe("backup logo");
    expect(clientNames(join(applied.previousDataDir!, "nesev.db"))).toEqual(["Live GmbH"]);
    expect(readFileSync(join(applied.previousDataDir!, "assets/logo.png"), "utf8")).toBe("live logo");

    // crash in the install phase (backup done, DB already moved in)
    stageRestore(live.dir, await backupOf(dataDir("Drittes Backup")));
    writeFileSync(join(pending, "APPLYING.json"), JSON.stringify({ backupDir: "backups/before-restore-y", phase: "install" }));
    mkdirSync(join(live.dir, "backups", "before-restore-y"));
    for (const f of ["nesev.db", "assets", "pdfs", "receipts"]) {
      if (existsSync(join(live.dir, f))) renameSync(join(live.dir, f), join(live.dir, "backups", "before-restore-y", f));
    }
    renameSync(join(pending, "nesev.db"), join(live.dir, "nesev.db"));
    applyPendingRestore(live.dir);
    expect(clientNames(join(live.dir, "nesev.db"))).toEqual(["Drittes Backup"]);
    expect(existsSync(join(live.dir, "assets"))).toBe(true);
    expect(existsSync(pending)).toBe(false);
  });
});

describe("restoreIntoEmptyDir", () => {
  test("restores into a new folder and refuses one with a database", async () => {
    const backup = await backupOf(dataDir("Backup GmbH", { "pdfs/a.pdf": "%PDF" }));
    const target = join(tmp("new"), "Daten");
    expect(restoreIntoEmptyDir(target, backup).companyName).toBe("Backup GmbH e.U.");
    expect(clientNames(join(target, "nesev.db"))).toEqual(["Backup GmbH"]);
    expect(readFileSync(join(target, "pdfs/a.pdf"), "utf8")).toBe("%PDF");
    // nothing was replaced, so no before-restore folder
    expect(existsSync(join(target, "backups"))).toBe(false);
    expect(restoreError(() => restoreIntoEmptyDir(target, backup))).toMatch(/bereits eine nesev-Datenbank/);
  });
});
