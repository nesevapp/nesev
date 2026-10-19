import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Inflate } from "fflate";
import { fileStamp, migrationState, NEWER_DATABASE_MESSAGE } from "../db/migration-state";

// "Backup einspielen": restores a backup ZIP from "Backup herunterladen" (nesev.db, assets/, pdfs/, receipts/) or a
// bare database file (daily backups/nesev-<date>.db, backups/pre-migration-*.db; replaces only the database).
// Takes the data dir as a parameter and imports neither lib/paths nor the db, so the first-start setup (no data dir
// yet), the CLI (`nesev restore`) and the running app (routes/export.ts) can all use it.
//
// Running app, two steps:
//  1. stageRestore(): extract + validate into <data>/restore-staging-<uuid>/, write READY.json last, then rename the
//     folder to <data>/restore-pending/ (atomic). A crash before that leaves only a staging folder, which is ignored
//     and removed on the next start. The web UI stages unconfirmed (the user sees the summary first) and confirms
//     with confirmPendingRestore(); an unconfirmed staged restore is discarded on the next start.
//  2. applyPendingRestore(), on the next start before the DB is opened (server/index.ts): moves the current nesev.db
//     (+ -wal/-shm), assets/, pdfs/, receipts/ to <data>/backups/before-restore-<stamp>/ and the staged ones in.
//     Progress is journaled in restore-pending/APPLYING.json; every step is a rename, so a crash midway is resumed on
//     the next start. READY.json is deleted first when cleaning up, so a half-deleted pending folder counts as gone.

export class RestoreError extends Error {}

export interface BackupSummary {
  /** "zip": full backup (replaces database and files); "database": a bare .db (replaces only the database) */
  kind: "zip" | "database";
  companyName: string;
  clients: number;
  /** finalized documents */
  invoices: number;
  creditNotes: number;
  offers: number;
  drafts: number;
  expenses: number;
  latestDocumentDate: string | null;
  latestExpenseDate: string | null;
  /** file counts in the backup (zip only) */
  files: { assets: number; pdfs: number; receipts: number };
  /** uncompressed size of everything restored */
  totalBytes: number;
  /** the backup is from an older nesev: these database updates run on the next start */
  pendingMigrations: number;
}

export interface PendingRestore {
  summary: BackupSummary;
  stagedAt: string;
}

const DB_FILES = ["nesev.db", "nesev.db-wal", "nesev.db-shm"] as const;
const DATA_FOLDERS = ["assets", "pdfs", "receipts"] as const;
type DataFolder = (typeof DATA_FOLDERS)[number];
const PENDING = "restore-pending";
const STAGING_PREFIX = "restore-staging-";
const READY = "READY.json";
const APPLYING = "APPLYING.json";

/** Bounds against zip bombs and broken archives (a real backup is far below them). */
export const RESTORE_LIMITS = { totalBytes: 50 * 1024 ** 3, entries: 500_000 };

// ── Reading the archive ──────────────────────────────────────────────────────

interface ZipEntry {
  /** path inside the backup (prefix of a wrapping folder removed), e.g. "receipts/2026/ER-2026-0001-1.jpg" */
  path: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  localOffset: number;
}

const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const SQLITE_MAGIC = "SQLite format 3\0";
const isSqlite = (b: Uint8Array) => b.length >= 100 && new TextDecoder().decode(b.subarray(0, 16)) === SQLITE_MAGIC;

const NOT_A_BACKUP = "Die Datei ist kein nesev-Backup (erwartet: ZIP aus „Backup herunterladen“ oder eine nesev-Datenbank .db).";
const BROKEN_ZIP = "Das ZIP ist unvollständig oder beschädigt.";

/**
 * Validates an entry name; null for directories and files a backup doesn't restore (LIESMICH.txt, Finder's
 * __MACOSX/ and .DS_Store). Unsafe names (absolute, "..", backslashes) reject the whole archive.
 */
function entryPath(name: string): string | null {
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new RestoreError(`Ungültiger Pfad im ZIP: ${name}`);
  }
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === ".")) throw new RestoreError(`Ungültiger Pfad im ZIP: ${name}`);
  if (name.endsWith("/")) return null;
  if (parts.some((p) => p === "")) throw new RestoreError(`Ungültiger Pfad im ZIP: ${name}`);
  if (parts[0] === "__MACOSX" || parts.at(-1)!.startsWith(".")) return null;
  return name;
}

/** Central directory of a (non-ZIP64) archive; entry paths relative to the backup root. */
function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new RestoreError(BROKEN_ZIP);
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new RestoreError("ZIP-Archive über 4 GB (ZIP64) werden nicht unterstützt.");
  if (count > RESTORE_LIMITS.entries) throw new RestoreError("Das ZIP enthält zu viele Dateien.");

  const raw: (Omit<ZipEntry, "path"> & { name: string })[] = [];
  const decoder = new TextDecoder();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new RestoreError(BROKEN_ZIP);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    raw.push({
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const files = raw.flatMap((e) => {
    const path = entryPath(e.name);
    return path ? [{ ...e, path }] : [];
  });
  // a backup re-zipped by hand may sit in one wrapping folder ("nesev-backup-2026-10-19/nesev.db")
  const db = files.find((e) => e.path === "nesev.db") ?? files.find((e) => /^[^/]+\/nesev\.db$/.test(e.path));
  if (!db) throw new RestoreError(`${NOT_A_BACKUP} Im ZIP fehlt die Datenbank nesev.db.`);
  const prefix = db.path.slice(0, -"nesev.db".length);

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const e of files) {
    if (!e.path.startsWith(prefix)) continue;
    const path = e.path.slice(prefix.length);
    const top = path.split("/")[0]!;
    if (path !== "nesev.db" && !(DATA_FOLDERS.includes(top as DataFolder) && path.includes("/"))) continue;
    if (seen.has(path)) throw new RestoreError(`Doppelte Datei im ZIP: ${path}`);
    seen.add(path);
    if (e.method !== 0 && e.method !== 8) throw new RestoreError(`Nicht unterstützte Komprimierung im ZIP: ${path}`);
    if (e.size === 0xffffffff || e.compressedSize === 0xffffffff) throw new RestoreError("ZIP-Archive über 4 GB (ZIP64) werden nicht unterstützt.");
    total += e.size;
    entries.push({ ...e, path });
  }
  if (total > RESTORE_LIMITS.totalBytes) throw new RestoreError("Das Backup ist zu groß.");
  return entries;
}

/** Decompresses one entry into `write`, checking its size and CRC against the directory (never trusts them for allocation). */
function inflateEntry(bytes: Uint8Array, e: ZipEntry, write: (chunk: Uint8Array) => void): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = e.localOffset;
  if (h + 30 > bytes.length || view.getUint32(h, true) !== 0x04034b50) throw new RestoreError(BROKEN_ZIP);
  const start = h + 30 + view.getUint16(h + 26, true) + view.getUint16(h + 28, true);
  const end = start + e.compressedSize;
  if (end > bytes.length) throw new RestoreError(BROKEN_ZIP);

  let written = 0;
  let crc = 0;
  const out = (chunk: Uint8Array) => {
    written += chunk.length;
    if (written > e.size) throw new RestoreError(`${BROKEN_ZIP} (${e.path})`);
    crc = Bun.hash.crc32(chunk, crc);
    write(chunk);
  };
  // small input slices bound each output chunk (deflate expands at most ~1000×)
  const STEP = 64 * 1024;
  if (e.method === 0) {
    for (let i = start; i < end; i += STEP) out(bytes.subarray(i, Math.min(end, i + STEP)));
  } else {
    const inflate = new Inflate();
    inflate.ondata = (chunk) => out(chunk);
    try {
      for (let i = start; i < end; i += STEP) inflate.push(bytes.subarray(i, Math.min(end, i + STEP)), i + STEP >= end);
      if (start === end) inflate.push(new Uint8Array(0), true);
    } catch (err) {
      if (err instanceof RestoreError) throw err;
      throw new RestoreError(`${BROKEN_ZIP} (${e.path})`);
    }
  }
  if (written !== e.size || (crc >>> 0) !== e.crc) throw new RestoreError(`${BROKEN_ZIP} (${e.path})`);
}

function extractTo(bytes: Uint8Array, e: ZipEntry, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  // "wx": never follow or overwrite anything already there
  const fd = openSync(dest, "wx");
  try {
    inflateEntry(bytes, e, (chunk) => {
      for (let off = 0; off < chunk.length; ) off += writeSync(fd, chunk, off);
    });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ── Inspecting the database ──────────────────────────────────────────────────

function inspectDatabase(path: string): Omit<BackupSummary, "kind" | "files" | "totalBytes"> {
  let sqlite: Database;
  try {
    sqlite = new Database(path, { readwrite: true, create: false });
  } catch {
    throw new RestoreError(NOT_A_BACKUP);
  }
  try {
    try {
      const check = sqlite.query("PRAGMA quick_check").get() as { quick_check: string } | null;
      if (check?.quick_check !== "ok") throw new RestoreError("Die Datenbank im Backup ist beschädigt.");
    } catch (err) {
      if (err instanceof RestoreError) throw err;
      throw new RestoreError(NOT_A_BACKUP);
    }
    const state = migrationState(sqlite);
    if (state.applied === 0 || !sqlite.query("SELECT 1 FROM sqlite_master WHERE name = 'settings'").get()) {
      throw new RestoreError(`${NOT_A_BACKUP} Die Datenbank enthält keine nesev-Daten.`);
    }
    if (state.newer) {
      throw new RestoreError(
        "Das Backup stammt von einer neueren nesev-Version. Bitte nesev zuerst aktualisieren und das Backup dann einspielen.",
      );
    }
    // the backup may be from an older schema: every figure falls back instead of failing the restore
    const one = <T>(sql: string, fallback: T): T => {
      try {
        return (sqlite.query(sql).get() as { v: T } | null)?.v ?? fallback;
      } catch {
        return fallback;
      }
    };
    const docs = (type: string) => one(`SELECT count(*) AS v FROM documents WHERE type = '${type}' AND status != 'draft'`, 0);
    return {
      companyName: one("SELECT coalesce(nullif(trim(company_name), ''), trim(owner_name)) AS v FROM settings LIMIT 1", ""),
      clients: one("SELECT count(*) AS v FROM clients", 0),
      invoices: docs("invoice"),
      creditNotes: docs("credit_note"),
      offers: docs("offer"),
      drafts: one("SELECT count(*) AS v FROM documents WHERE status = 'draft'", 0),
      expenses: one("SELECT count(*) AS v FROM expenses", 0),
      latestDocumentDate: one<string | null>("SELECT max(issue_date) AS v FROM documents WHERE status != 'draft'", null),
      latestExpenseDate: one<string | null>("SELECT max(issue_date) AS v FROM expenses", null),
      pendingMigrations: state.pending.length,
    };
  } finally {
    sqlite.close();
  }
}

function fileCounts(entries: ZipEntry[]): BackupSummary["files"] {
  const files = { assets: 0, pdfs: 0, receipts: 0 };
  for (const e of entries) {
    const top = e.path.split("/")[0] as DataFolder;
    if (top in files) files[top]++;
  }
  return files;
}

/**
 * Validates a backup (ZIP from "Backup herunterladen" or a bare nesev .db) without touching any data dir: has
 * nesev.db, which is an intact nesev database not newer than this version. Returns what it contains, or throws a
 * RestoreError with a German message.
 */
export function inspectBackupZip(bytes: Uint8Array): BackupSummary {
  const tmp = mkdtempSync(join(tmpdir(), "nesev-restore-inspect-"));
  try {
    const dbPath = join(tmp, "nesev.db");
    if (isSqlite(bytes)) {
      writeFileAtomicSync(dbPath, bytes);
      return { kind: "database", ...inspectDatabase(dbPath), files: { assets: 0, pdfs: 0, receipts: 0 }, totalBytes: bytes.length };
    }
    if (!isZip(bytes)) throw new RestoreError(NOT_A_BACKUP);
    const entries = readZip(bytes);
    extractTo(bytes, entries.find((e) => e.path === "nesev.db")!, dbPath);
    return {
      kind: "zip",
      ...inspectDatabase(dbPath),
      files: fileCounts(entries),
      totalBytes: entries.reduce((s, e) => s + e.size, 0),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Staging and applying ─────────────────────────────────────────────────────

function writeFileAtomicSync(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx");
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function checkFreeSpace(dir: string, needed: number): void {
  try {
    const fs = statfsSync(dir);
    if (fs.bavail * fs.bsize < needed + 100 * 1024 * 1024) {
      throw new RestoreError("Nicht genug freier Speicherplatz im Datenordner, um das Backup einzuspielen.");
    }
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    // statfs unsupported: the extraction fails cleanly if the disk fills up
  }
}

interface ReadyMarker extends PendingRestore {
  version: 1;
  confirmed: boolean;
}

/**
 * Extracts and validates a backup into `<dataDir>/restore-pending/`, replacing an earlier staged one. Applied by
 * applyPendingRestore() on the next start (only once confirmed); nothing in the data dir changes until then.
 */
export function stageRestore(
  dataDir: string,
  bytes: Uint8Array,
  { confirmed = true, now = new Date() }: { confirmed?: boolean; now?: Date } = {},
): BackupSummary {
  const pending = join(dataDir, PENDING);
  if (existsSync(join(pending, APPLYING))) {
    throw new RestoreError("Ein Backup wird gerade eingespielt. Bitte nesev neu starten.");
  }
  const zip = isZip(bytes);
  if (!zip && !isSqlite(bytes)) throw new RestoreError(NOT_A_BACKUP);
  const entries = zip ? readZip(bytes) : [];
  const totalBytes = zip ? entries.reduce((s, e) => s + e.size, 0) : bytes.length;
  mkdirSync(dataDir, { recursive: true });
  checkFreeSpace(dataDir, totalBytes);

  const staging = join(dataDir, `${STAGING_PREFIX}${randomUUID()}`);
  mkdirSync(staging);
  try {
    if (zip) {
      for (const e of entries) extractTo(bytes, e, join(staging, ...e.path.split("/")));
      // a full backup replaces the folders even when the backup has none of their files
      for (const f of DATA_FOLDERS) mkdirSync(join(staging, f), { recursive: true });
    } else {
      writeFileAtomicSync(join(staging, "nesev.db"), bytes);
    }
    const summary: BackupSummary = {
      kind: zip ? "zip" : "database",
      ...inspectDatabase(join(staging, "nesev.db")),
      files: zip ? fileCounts(entries) : { assets: 0, pdfs: 0, receipts: 0 },
      totalBytes,
    };
    // inspecting may leave an empty -wal/-shm behind on some systems; they must not replace the live ones
    for (const f of DB_FILES.slice(1)) rmSync(join(staging, f), { force: true });
    const marker: ReadyMarker = { version: 1, confirmed, summary, stagedAt: now.toISOString() };
    writeFileAtomicSync(join(staging, READY), JSON.stringify(marker, null, 2));
    discardPendingRestore(dataDir);
    renameSync(staging, pending);
    return summary;
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** The confirmed staged restore waiting for the next start, or null. */
export function pendingRestore(dataDir: string): PendingRestore | null {
  const marker = readJson<ReadyMarker>(join(dataDir, PENDING, READY));
  return marker?.confirmed ? { summary: marker.summary, stagedAt: marker.stagedAt } : null;
}

/** Marks the staged restore as confirmed: it's applied on the next start. */
export function confirmPendingRestore(dataDir: string): PendingRestore {
  const path = join(dataDir, PENDING, READY);
  const marker = readJson<ReadyMarker>(path);
  if (!marker) throw new RestoreError("Kein Backup zum Einspielen vorgemerkt. Bitte die Datei erneut auswählen.");
  writeFileAtomicSync(path, JSON.stringify({ ...marker, confirmed: true }, null, 2));
  return { summary: marker.summary, stagedAt: marker.stagedAt };
}

/** Drops a staged restore that hasn't been applied (READY.json first, so a half-deleted folder counts as gone). */
export function discardPendingRestore(dataDir: string): void {
  const pending = join(dataDir, PENDING);
  if (existsSync(join(pending, APPLYING))) {
    throw new RestoreError("Ein Backup wird gerade eingespielt. Bitte nesev neu starten.");
  }
  rmSync(join(pending, READY), { force: true });
  rmSync(pending, { recursive: true, force: true });
}

export interface AppliedRestore {
  summary: BackupSummary;
  /** where the replaced data went (absolute; null when there was nothing to replace) */
  previousDataDir: string | null;
}

interface ApplyJournal {
  /** relative to the data dir */
  backupDir: string;
  phase: "backup" | "install";
}

/**
 * Applies a staged restore. Call before the database is opened. Resumes an interrupted apply; removes leftovers of
 * interrupted stagings. Returns null when nothing was staged.
 */
export function applyPendingRestore(dataDir: string, now = new Date()): AppliedRestore | null {
  if (!existsSync(dataDir)) return null;
  for (const name of readdirSync(dataDir)) {
    if (name.startsWith(STAGING_PREFIX)) rmSync(join(dataDir, name), { recursive: true, force: true });
  }
  const pending = join(dataDir, PENDING);
  const marker = readJson<ReadyMarker>(join(pending, READY));
  if (!marker?.confirmed) {
    rmSync(join(pending, READY), { force: true });
    rmSync(pending, { recursive: true, force: true });
    return null;
  }
  const items: string[] = marker.summary.kind === "zip" ? [...DB_FILES, ...DATA_FOLDERS] : [...DB_FILES];

  const journalPath = join(pending, APPLYING);
  let journal = readJson<ApplyJournal>(journalPath);
  if (!journal) {
    let backupDir = join("backups", `before-restore-${fileStamp(now)}`);
    for (let i = 2; existsSync(join(dataDir, backupDir)); i++) backupDir = join("backups", `before-restore-${fileStamp(now)}-${i}`);
    journal = { backupDir, phase: "backup" };
    writeFileAtomicSync(journalPath, JSON.stringify(journal));
  }
  const backupDir = join(dataDir, journal.backupDir);

  if (journal.phase === "backup") {
    for (const item of items) {
      const current = join(dataDir, item);
      if (!existsSync(current)) continue;
      mkdirSync(backupDir, { recursive: true });
      if (existsSync(join(backupDir, item))) throw new Error(`nesev restore: ${join(backupDir, item)} already exists`);
      renameSync(current, join(backupDir, item));
    }
    journal = { ...journal, phase: "install" };
    writeFileAtomicSync(journalPath, JSON.stringify(journal));
  }

  for (const item of items) {
    const staged = join(pending, item);
    if (!existsSync(staged)) continue;
    const dest = join(dataDir, item);
    if (existsSync(dest)) {
      throw new Error(
        `nesev restore: ${dest} exists while a restore is being applied. The previous data is in ${backupDir}, the backup in ${pending}.`,
      );
    }
    renameSync(staged, dest);
  }

  unlinkSync(join(pending, READY));
  rmSync(pending, { recursive: true, force: true });
  return { summary: marker.summary, previousDataDir: existsSync(backupDir) ? backupDir : null };
}

/**
 * First-start setup / CLI: restores a backup into a new or empty data dir. Refuses a dir that already holds a
 * nesev database (use stageRestore there).
 */
export function restoreIntoEmptyDir(dataDir: string, bytes: Uint8Array): BackupSummary {
  if (existsSync(join(dataDir, "nesev.db"))) {
    throw new RestoreError("Im gewählten Ordner liegt bereits eine nesev-Datenbank. Backup dort bitte über „Backup einspielen“ in der App einspielen.");
  }
  if (existsSync(dataDir) && !statSync(dataDir).isDirectory()) throw new RestoreError("Der gewählte Datenordner ist kein Ordner.");
  const summary = stageRestore(dataDir, bytes);
  applyPendingRestore(dataDir);
  return summary;
}
