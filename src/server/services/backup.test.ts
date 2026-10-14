import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { createDb, runMigrations } from "../db/client";
import { clients } from "../db/schema";
import { createBackupZip, listLocalBackups, pruneLocalBackups, snapshotDatabase, writeLocalBackup } from "./backup";

function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "nesev-backup-test-"));
  const db = createDb(join(dir, "nesev.db"));
  runMigrations(db);
  db.insert(clients).values({ number: 1, name: "Muster GmbH" }).run();
  return { dir, db };
}

function openAndCount(bytesOrPath: string) {
  const snap = new Database(bytesOrPath, { readonly: true });
  try {
    expect(snap.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    return (snap.query("SELECT count(*) AS n FROM clients").get() as { n: number }).n;
  } finally {
    snap.close();
  }
}

describe("snapshot", () => {
  test("VACUUM INTO produces a valid, openable DB with the live data (WAL)", () => {
    const { dir, db } = fileDb();
    const dest = join(dir, "snap.db");
    snapshotDatabase(db, dest);
    expect(openAndCount(dest)).toBe(1);
  });

  test("backup zip contains db, assets, pdfs and receipts", () => {
    const { dir, db } = fileDb();
    const assets = join(dir, "assets");
    const pdfs = join(dir, "pdfs");
    mkdirSync(join(assets, "fonts"), { recursive: true });
    mkdirSync(pdfs);
    writeFileSync(join(assets, "logo.png"), "png");
    writeFileSync(join(assets, "fonts", "a.ttf"), "ttf");
    writeFileSync(join(pdfs, "RE-2026-0001.pdf"), "%PDF");
    const receipts = join(dir, "receipts");
    mkdirSync(join(receipts, "2026"), { recursive: true });
    writeFileSync(join(receipts, "2026", "ER-2026-0001-1.jpg"), "jpg");
    writeFileSync(join(receipts, "2026", "ER-2026-0001-1-crop-2.jpg"), "jpg");

    const files = unzipSync(createBackupZip(db, { assets, pdfs, receipts }));
    expect(Object.keys(files).sort()).toEqual([
      "LIESMICH.txt",
      "assets/fonts/a.ttf",
      "assets/logo.png",
      "nesev.db",
      "pdfs/RE-2026-0001.pdf",
      "receipts/2026/ER-2026-0001-1-crop-2.jpg",
      "receipts/2026/ER-2026-0001-1.jpg",
    ]);
    const out = join(dir, "restored.db");
    writeFileSync(out, files["nesev.db"]!);
    expect(openAndCount(out)).toBe(1);
  });
});

describe("local backups", () => {
  test("one per day, force overwrites", () => {
    const { dir, db } = fileDb();
    const backups = join(dir, "backups");
    expect(writeLocalBackup(db, { dir: backups, date: "2026-10-13" })?.name).toBe("nesev-2026-10-13.db");
    expect(writeLocalBackup(db, { dir: backups, date: "2026-10-13" })).toBeNull();
    db.insert(clients).values({ number: 2, name: "Zweite AG" }).run();
    writeLocalBackup(db, { dir: backups, date: "2026-10-13", force: true });
    expect(openAndCount(join(backups, "nesev-2026-10-13.db"))).toBe(2);
    expect(readdirSync(backups)).toEqual(["nesev-2026-10-13.db"]); // no temp files left
  });

  test("retention keeps the newest 14 and ignores other files", () => {
    const { dir } = fileDb();
    const backups = join(dir, "backups");
    mkdirSync(backups);
    for (let d = 1; d <= 20; d++) writeFileSync(join(backups, `nesev-2026-09-${String(d).padStart(2, "0")}.db`), "x");
    writeFileSync(join(backups, "notes.txt"), "keep me");

    const deleted = pruneLocalBackups(backups, 14);
    expect(deleted.sort()).toEqual(
      ["01", "02", "03", "04", "05", "06"].map((d) => `nesev-2026-09-${d}.db`),
    );
    const left = listLocalBackups(backups);
    expect(left).toHaveLength(14);
    expect(left[0]!.date).toBe("2026-09-20");
    expect(readdirSync(backups)).toContain("notes.txt");
  });

  test("writeLocalBackup prunes", () => {
    const { dir, db } = fileDb();
    const backups = join(dir, "backups");
    for (let d = 1; d <= 3; d++) writeLocalBackup(db, { dir: backups, date: `2026-10-0${d}`, keep: 2 });
    expect(listLocalBackups(backups).map((b) => b.date)).toEqual(["2026-10-03", "2026-10-02"]);
  });
});
