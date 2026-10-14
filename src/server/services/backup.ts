import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { todayIso } from "../../shared/dates";
import type { Db } from "../db/client";
import { ASSETS_DIR, DATA_DIR, PDFS_DIR, RECEIPTS_DIR } from "../lib/paths";

export const BACKUPS_DIR = join(DATA_DIR, "backups");
export const BACKUP_KEEP = 14;
const BACKUP_FILE_RE = /^nesev-(\d{4}-\d{2}-\d{2})\.db$/;

/**
 * Consistent snapshot of the live database via `VACUUM INTO` (safe with WAL and concurrent use; never
 * copy nesev.db directly). `dest` must not exist yet.
 */
export function snapshotDatabase(db: Db, dest: string): void {
  db.$client.query("VACUUM INTO ?").run(dest);
}

/** Every file under `dir` as { "<prefix>/<relative path>": bytes }. */
function collectDir(dir: string, prefix: string, out: Zippable, level: 0 | 6): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const abs = join(entry.parentPath, entry.name);
    out[`${prefix}/${relative(dir, abs).split("\\").join("/")}`] = [readFileSync(abs), { level }];
  }
}

const RESTORE_README = `nesev – Backup

Inhalt:
  nesev.db   Datenbank (konsistenter Snapshot)
  assets/    Logo, Briefpapier, Schriften
  pdfs/      Eingefrorene Beleg-PDFs
  receipts/  Belege der Ausgaben (inkl. Originalfotos zugeschnittener Belege)

Wiederherstellen:
  1. nesev-Server beenden.
  2. Im Datenordner (standardmäßig data/) nesev.db, nesev.db-wal und nesev.db-shm
     beiseite legen bzw. löschen.
  3. nesev.db, assets/, pdfs/ und receipts/ aus diesem Archiv in den Datenordner kopieren.
  4. Server wieder starten.
`;

/** ZIP of a fresh DB snapshot plus data/assets, data/pdfs and data/receipts (for "Backup herunterladen"). */
export function createBackupZip(
  db: Db,
  dirs = { assets: ASSETS_DIR, pdfs: PDFS_DIR, receipts: RECEIPTS_DIR },
): Uint8Array {
  const tmp = join(tmpdir(), `nesev-snapshot-${randomUUID()}.db`);
  try {
    snapshotDatabase(db, tmp);
    const files: Zippable = {
      "nesev.db": [readFileSync(tmp), { level: 6 }],
      "LIESMICH.txt": new TextEncoder().encode(RESTORE_README),
    };
    collectDir(dirs.assets, "assets", files, 6);
    collectDir(dirs.pdfs, "pdfs", files, 0);
    // photos and PDFs are already compressed
    collectDir(dirs.receipts, "receipts", files, 0);
    return zipSync(files);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// ── Automatic local backups (data/backups/nesev-YYYY-MM-DD.db) ─────────────────

export interface LocalBackup {
  name: string;
  date: string;
  sizeBytes: number;
  createdAt: string;
}

export function listLocalBackups(dir = BACKUPS_DIR): LocalBackup[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: BACKUP_FILE_RE.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => !!e.m)
    .map(({ name, m }) => {
      const st = statSync(join(dir, name));
      return { name, date: m[1]!, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function isLocalBackupName(name: string): boolean {
  return BACKUP_FILE_RE.test(name);
}

/** Deletes all but the newest `keep` backups. Returns the deleted file names. */
export function pruneLocalBackups(dir = BACKUPS_DIR, keep = BACKUP_KEEP): string[] {
  const stale = listLocalBackups(dir).slice(keep);
  for (const b of stale) rmSync(join(dir, b.name), { force: true });
  return stale.map((b) => b.name);
}

/**
 * Writes today's snapshot to `dir` (replacing an existing one only with `force`) and prunes old ones.
 * Returns the backup, or null when today's already exists.
 */
export function writeLocalBackup(
  db: Db,
  { dir = BACKUPS_DIR, date = todayIso(), force = false, keep = BACKUP_KEEP } = {},
): LocalBackup | null {
  mkdirSync(dir, { recursive: true });
  const name = `nesev-${date}.db`;
  const dest = join(dir, name);
  if (existsSync(dest) && !force) return null;
  // Snapshot to a temp name first so a crash never leaves a half-written backup behind.
  const tmp = join(dir, `.${name}.${randomUUID()}.tmp`);
  try {
    snapshotDatabase(db, tmp);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
  pruneLocalBackups(dir, keep);
  return listLocalBackups(dir).find((b) => b.name === name) ?? null;
}

const SCHEDULER_KEY = Symbol.for("nesev.backupScheduler");
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Daily backups: one on server start (unless today's exists), then an hourly check that creates the
 * next one after midnight. Idempotent across `bun --hot` reloads.
 */
export function startBackupScheduler(db: Db): void {
  const g = globalThis as { [SCHEDULER_KEY]?: Timer };
  if (g[SCHEDULER_KEY]) return;
  const run = () => {
    try {
      const b = writeLocalBackup(db);
      if (b) console.log(`nesev backup written: ${join(BACKUPS_DIR, b.name)}`);
    } catch (err) {
      console.error("nesev backup failed", err);
    }
  };
  run();
  g[SCHEDULER_KEY] = setInterval(run, CHECK_INTERVAL_MS);
  g[SCHEDULER_KEY].unref?.();
}
