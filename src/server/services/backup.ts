import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
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

interface ZipSource {
  name: string;
  /** file to read, or the content itself */
  path?: string;
  bytes?: Uint8Array;
  compress: boolean;
}

/** Every regular file under `dir` (no dotfiles, symlinks not followed) as a zip entry "<prefix>/<relative path>". */
function collectDir(dir: string, prefix: string, compress: boolean): ZipSource[] {
  if (!existsSync(dir)) return [];
  const out: ZipSource[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const abs = join(entry.parentPath, entry.name);
    out.push({ name: `${prefix}/${relative(dir, abs).split("\\").join("/")}`, path: abs, compress });
  }
  return out;
}

const RESTORE_README = `nesev – Backup

Inhalt:
  nesev.db   Datenbank (konsistenter Snapshot)
  assets/    Logo, Briefpapier, Schriften
  pdfs/      Eingefrorene Beleg-PDFs
  receipts/  Belege der Ausgaben (inkl. Originalfotos zugeschnittener Belege)

Wiederherstellen:
  In nesev unter Einstellungen → Export → „Backup einspielen“ dieses ZIP auswählen
  (unverändert, nicht entpacken). Die aktuellen Daten werden dabei nicht gelöscht,
  sondern im Datenordner unter backups/before-restore-<Datum>/ aufbewahrt.
  Das Backup wird beim nächsten Start von nesev übernommen.

  Bei einer neuen Installation kann das ZIP auch in der Ersteinrichtung
  eingespielt werden.

Manuell (nur falls nesev nicht startet):
  1. nesev beenden.
  2. Im Datenordner (Pfad unter Einstellungen angezeigt) nesev.db, nesev.db-wal,
     nesev.db-shm sowie die Ordner assets/, pdfs/ und receipts/ in einen anderen
     Ordner verschieben.
  3. nesev.db, assets/, pdfs/ und receipts/ aus diesem Archiv in den Datenordner kopieren.
  4. nesev wieder starten.
`;

/**
 * ZIP of a fresh DB snapshot plus data/assets, data/pdfs and data/receipts (for "Backup herunterladen"), streamed:
 * files are read asynchronously one at a time as the client pulls, so a large receipts folder neither sits in
 * memory as a whole nor blocks the event loop. The snapshot is taken right away (consistent point in time); its
 * temp file is removed when the stream ends, fails or is cancelled.
 */
export function createBackupZip(
  db: Db,
  dirs = { assets: ASSETS_DIR, pdfs: PDFS_DIR, receipts: RECEIPTS_DIR },
): ReadableStream<Uint8Array> {
  const tmp = join(tmpdir(), `nesev-snapshot-${randomUUID()}.db`);
  const cleanup = () => rmSync(tmp, { force: true });
  let sources: ZipSource[];
  try {
    snapshotDatabase(db, tmp);
    sources = [
      { name: "nesev.db", path: tmp, compress: true },
      { name: "LIESMICH.txt", bytes: new TextEncoder().encode(RESTORE_README), compress: true },
      ...collectDir(dirs.assets, "assets", true),
      // photos and PDFs are already compressed
      ...collectDir(dirs.pdfs, "pdfs", false),
      ...collectDir(dirs.receipts, "receipts", false),
    ];
  } catch (err) {
    cleanup();
    throw err;
  }
  let zip: Zip;
  let next = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) {
          cleanup();
          return controller.error(err);
        }
        controller.enqueue(chunk);
        if (final) {
          cleanup();
          controller.close();
        }
      });
    },
    // one file per pull: the consumer's pace drives the reads
    async pull(controller) {
      try {
        const src = sources[next++];
        if (!src) return zip.end();
        let bytes = src.bytes;
        if (!bytes) {
          try {
            bytes = await Bun.file(src.path!).bytes();
          } catch (err) {
            if (src.path === tmp) throw err;
            return; // deleted since the listing: skip it
          }
        }
        const entry = src.compress ? new ZipDeflate(src.name, { level: 6 }) : new ZipPassThrough(src.name);
        zip.add(entry);
        entry.push(bytes, true);
        if (src.path === tmp) cleanup();
      } catch (err) {
        cleanup();
        controller.error(err);
      }
    },
    cancel() {
      zip?.terminate();
      cleanup();
    },
  });
}

// ── Automatic local backups (data/backups/nesev-YYYY-MM-DD.db) ─────────────────

export interface LocalBackup {
  name: string;
  /** daily local backups are database snapshots only; assets, PDFs and receipts are only in the ZIP download */
  contents: "database";
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
      return { name, contents: "database" as const, date: m[1]!, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
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
