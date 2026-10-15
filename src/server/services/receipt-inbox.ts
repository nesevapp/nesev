import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, watch } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { and, count, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { RECEIPT_MAX_BYTES } from "../../shared/expenses";
import type { DbOrTx } from "../db/client";
import { expenses, receiptInboxItems } from "../db/schema";
import { DATA_DIR } from "../lib/paths";
import { createExpense, deleteExpense, type ExpenseWithLines, receiptExtension, setExpenseAttachment } from "./expenses";
import { getSettings, updateSettings } from "./settings";

// Belege-Eingang: receipt files dropped into a folder (settings.receiptInboxPath, e.g. in iCloud Drive) or
// uploaded on the inbox page become inbox items. The file is copied to <DATA_DIR>/receipts/inbox/ (stored as
// "receipts/inbox/<sha12>-<name>"), the source is moved to "<folder>/Importiert/" so the user sees it was taken.
// Nothing is analysed here: the user turns an item into an expense draft (the copy goes through
// setExpenseAttachment, so the expense receipt rules hold) and may queue analysis explicitly, or dismisses it.
// The folder is polled (fs.watch on iCloud folders is unreliable, so a watch event only triggers an early scan).
// A file is imported once its size and mtime are unchanged across two scans (still being written / synced otherwise).

export const IMPORTED_DIR_NAME = "Importiert";
const INBOX_REL_DIR = "receipts/inbox";
const POLL_MS = 45_000;
/** watch event → scan; pending (still changing) files → re-check */
const DEBOUNCE_MS = 1_500;
const RECHECK_MS = 3_000;
const HEIC_EXT = new Set(["heic", "heif"]);
const ACCEPTED_EXT = new Set(["pdf", "jpg", "jpeg", "png", "webp", ...HEIC_EXT]);

export type InboxItemDTO = typeof receiptInboxItems.$inferSelect;

export interface InboxSkipped {
  name: string;
  reason: string;
}

export interface InboxStatus {
  /** configured folder ("" = off) */
  path: string;
  watching: boolean;
  lastScanAt: string | null;
  /** German message when the folder is missing/unreadable */
  error: string | null;
  /** files left in the folder on the last scan, with the reason */
  skipped: InboxSkipped[];
  /** items waiting in the inbox */
  newCount: number;
}

export interface ScanResult {
  imported: number;
  /** still being written, checked again shortly */
  pending: number;
  skipped: InboxSkipped[];
  error: string | null;
}

/** HEIC/HEIF → JPEG (`dest`). Default: macOS `sips`. */
export type HeicConverter = (src: string, dest: string) => Promise<void>;

export const sipsConvert: HeicConverter = async (src, dest) => {
  if (!Bun.which("sips")) throw new Error("HEIC-Umwandlung ist auf diesem System nicht verfügbar (nur macOS) – bitte als JPG, PNG oder PDF ablegen");
  const proc = Bun.spawn(["sips", "-s", "format", "jpeg", src, "--out", dest], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0 || !existsSync(dest)) {
    throw new Error(`HEIC-Umwandlung fehlgeschlagen: ${(await new Response(proc.stderr).text()).trim() || `Code ${code}`}`);
  }
};

const extOf = (name: string) => extname(name).slice(1).toLowerCase();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(-80);

// --- items ---------------------------------------------------------------------------------------

export function listInboxItems(db: DbOrTx, status: "new" | "all" = "new"): InboxItemDTO[] {
  return db
    .select()
    .from(receiptInboxItems)
    .where(status === "new" ? eq(receiptInboxItems.status, "new") : undefined)
    .orderBy(desc(receiptInboxItems.createdAt), desc(receiptInboxItems.id))
    .all();
}

export function countNewInboxItems(db: DbOrTx): number {
  return db.select({ n: count() }).from(receiptInboxItems).where(eq(receiptInboxItems.status, "new")).get()?.n ?? 0;
}

function requireItem(db: DbOrTx, id: number): InboxItemDTO {
  const row = db.select().from(receiptInboxItems).where(eq(receiptInboxItems.id, id)).get();
  if (!row) throw new HTTPException(404, { message: "Beleg im Eingang nicht gefunden" });
  return row;
}

/** Expense numbers whose receipt (or cropped original) has this hash; hashes cached per stored path. */
const attachmentHashCache = new Map<string, string>();
function expenseWithSameFile(db: DbOrTx, hash: string, dataDir: string): { id: number; number: string | null } | null {
  const rows = db
    .select({ id: expenses.id, number: expenses.number, a: expenses.attachmentPath, o: expenses.attachmentOriginalPath })
    .from(expenses)
    .where(or(isNotNull(expenses.attachmentPath), isNotNull(expenses.attachmentOriginalPath)))
    .all();
  for (const r of rows) {
    for (const rel of [r.o, r.a]) {
      if (!rel) continue;
      const key = `${dataDir}\0${rel}`;
      let h = attachmentHashCache.get(key);
      if (h === undefined) {
        try {
          h = sha256(new Uint8Array(readFileSync(join(dataDir, rel))));
        } catch {
          h = "";
        }
        attachmentHashCache.set(key, h);
      }
      if (h === hash) return { id: r.id, number: r.number };
    }
  }
  return null;
}

export interface AddFileInput {
  name: string;
  bytes: Uint8Array;
  sourcePath?: string;
}

export type AddFileResult =
  | { kind: "added"; item: InboxItemDTO }
  | { kind: "duplicate"; reason: string; item?: InboxItemDTO };

/**
 * Stores one receipt as an inbox item (copy under receipts/inbox, HEIC converted to JPEG). Duplicates (same sha256
 * as an item that is new/converted, or as an existing expense receipt) are not added; a dismissed item with the
 * same file comes back as new.
 */
export async function addInboxFile(
  db: DbOrTx,
  input: AddFileInput,
  opts: { dataDir?: string; convertHeic?: HeicConverter } = {},
): Promise<AddFileResult> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const ext = extOf(input.name);
  if (!ACCEPTED_EXT.has(ext)) throw new HTTPException(400, { message: "Nur PDF, JPG, PNG, WebP oder HEIC erlaubt" });
  if (input.bytes.byteLength === 0) throw new HTTPException(400, { message: "Datei ist leer" });
  if (input.bytes.byteLength > RECEIPT_MAX_BYTES) throw new HTTPException(400, { message: "Datei ist zu groß (max. 20 MB)" });

  const hash = sha256(input.bytes);
  const existing = db.select().from(receiptInboxItems).where(eq(receiptInboxItems.sha256, hash)).get() as
    | InboxItemDTO
    | undefined;
  if (existing && existing.status !== "dismissed") {
    return {
      kind: "duplicate",
      item: existing,
      reason: existing.status === "new" ? "bereits im Eingang" : "bereits als Ausgabe übernommen",
    };
  }
  const expense = expenseWithSameFile(db, hash, dataDir);
  if (expense) return { kind: "duplicate", reason: `bereits bei Ausgabe ${expense.number ?? `#${expense.id}`} hinterlegt` };

  const isHeic = HEIC_EXT.has(ext);
  const stem = safeName(input.name.slice(0, input.name.length - ext.length - 1)) || "beleg";
  const relPath = `${INBOX_REL_DIR}/${hash.slice(0, 12)}-${stem}.${isHeic ? "jpg" : ext === "jpeg" ? "jpg" : ext}`;
  const abs = join(dataDir, relPath);
  mkdirSync(join(dataDir, INBOX_REL_DIR), { recursive: true });
  if (isHeic) {
    const tmp = `${abs}.src.${ext}`;
    await Bun.write(tmp, input.bytes);
    try {
      await (opts.convertHeic ?? sipsConvert)(tmp, abs);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  } else {
    await Bun.write(abs, input.bytes);
  }

  const values = {
    fileName: input.name.slice(0, 255),
    storedPath: relPath,
    sourcePath: input.sourcePath ?? "",
    sha256: hash,
    sizeBytes: input.bytes.byteLength,
    status: "new" as const,
    expenseId: null,
  };
  const item = existing
    ? db.update(receiptInboxItems).set(values).where(eq(receiptInboxItems.id, existing.id)).returning().get()
    : db.insert(receiptInboxItems).values(values).returning().get();
  return { kind: "added", item: item as InboxItemDTO };
}

/** Manual upload on the inbox page: one item per file; duplicates are reported, not added. */
export async function addUploadedFiles(
  db: DbOrTx,
  files: File[],
  opts: { dataDir?: string; convertHeic?: HeicConverter } = {},
): Promise<{ added: InboxItemDTO[]; duplicates: InboxSkipped[] }> {
  const added: InboxItemDTO[] = [];
  const duplicates: InboxSkipped[] = [];
  for (const file of files) {
    const r = await addInboxFile(db, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, opts);
    if (r.kind === "added") added.push(r.item);
    else duplicates.push({ name: file.name, reason: r.reason });
  }
  return { added, duplicates };
}

const MIME_BY_EXT: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Turns new inbox items into expense drafts (one each): createExpense + setExpenseAttachment with the stored copy,
 * then the copy is removed and the item marked converted. Validates all items before creating anything.
 */
export async function convertInboxItems(db: DbOrTx, ids: number[], dataDir = DATA_DIR): Promise<ExpenseWithLines[]> {
  const items = ids.map((id) => requireItem(db, id));
  for (const item of items) {
    if (item.status !== "new" || !item.storedPath) {
      throw new HTTPException(409, { message: `„${item.fileName}“ ist nicht mehr im Eingang` });
    }
    if (!existsSync(join(dataDir, item.storedPath))) {
      throw new HTTPException(410, { message: `Datei zu „${item.fileName}“ fehlt im Datenordner` });
    }
  }
  const created: ExpenseWithLines[] = [];
  for (const item of items) {
    const stored = item.storedPath!;
    const ext = extOf(stored);
    const name = HEIC_EXT.has(extOf(item.fileName)) ? item.fileName.replace(/\.[^.]+$/, ".jpg") : item.fileName;
    const file = new File([await Bun.file(join(dataDir, stored)).arrayBuffer()], name, { type: MIME_BY_EXT[ext] ?? "" });
    receiptExtension(file);
    const draft = createExpense(db, {});
    let expense: ExpenseWithLines;
    try {
      expense = await setExpenseAttachment(db, draft.id, file, dataDir);
    } catch (err) {
      await deleteExpense(db, draft.id, dataDir);
      throw err;
    }
    db.update(receiptInboxItems)
      .set({ status: "converted", expenseId: expense.id, storedPath: null })
      .where(eq(receiptInboxItems.id, item.id))
      .run();
    await unlink(join(dataDir, stored)).catch(() => {});
    created.push(expense);
  }
  return created;
}

/** Dismisses new items: status dismissed, stored copy deleted (the moved source stays in Importiert/). */
export async function dismissInboxItems(db: DbOrTx, ids: number[], dataDir = DATA_DIR): Promise<number> {
  if (!ids.length) return 0;
  const rows = db
    .select()
    .from(receiptInboxItems)
    .where(and(inArray(receiptInboxItems.id, ids), eq(receiptInboxItems.status, "new")))
    .all();
  if (!rows.length) return 0;
  db.update(receiptInboxItems)
    .set({ status: "dismissed", storedPath: null })
    .where(inArray(receiptInboxItems.id, rows.map((r) => r.id)))
    .run();
  for (const r of rows) if (r.storedPath) await unlink(join(dataDir, r.storedPath)).catch(() => {});
  return rows.length;
}

// --- folder --------------------------------------------------------------------------------------

/** Expands "~", resolves; validates exists / directory / readable / outside the data dir. Returns the path or a message. */
export function checkInboxFolder(input: string, dataDir = DATA_DIR): { path: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { path: "" };
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(expanded)) return { error: "Bitte einen absoluten Pfad angeben (z. B. /Users/…/Belege)" };
  const path = resolve(expanded);
  if (!existsSync(path)) return { error: "Ordner nicht gefunden" };
  let real: string;
  try {
    if (!statSync(path).isDirectory()) return { error: "Das ist eine Datei, kein Ordner" };
    real = realpathSync(path);
    accessSync(path, constants.R_OK);
    readdirSync(path);
  } catch {
    return { error: "Ordner nicht lesbar (Zugriffsrechte prüfen)" };
  }
  const data = existsSync(dataDir) ? realpathSync(dataDir) : resolve(dataDir);
  const rel = relative(data, real);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return { error: "Der Ordner darf nicht im nesev-Datenordner liegen" };
  }
  return { path };
}

export function setInboxFolder(db: DbOrTx, input: string, dataDir = DATA_DIR): string {
  const r = checkInboxFolder(input, dataDir);
  if ("error" in r) throw new HTTPException(400, { message: r.error });
  updateSettings(db, { receiptInboxPath: r.path });
  return r.path;
}

/** Free target name in `dir`: "x.pdf", "x (2).pdf", … */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

// --- scanner -------------------------------------------------------------------------------------

export interface InboxTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface InboxScannerDeps {
  dataDir?: string;
  now?: () => Date;
  timers?: InboxTimers;
  /** fs.watch; pass `null` to disable (tests) */
  watch?: ((path: string, onChange: () => void) => { close(): void }) | null;
  convertHeic?: HeicConverter;
  log?: (msg: string) => void;
}

const realTimers: InboxTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as Timer),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as Timer),
};

const fsWatch = (path: string, onChange: () => void) => {
  const w: FSWatcher = watch(path, { persistent: false }, () => onChange());
  w.on("error", () => {}); // the poll keeps going
  return w;
};

interface Seen {
  size: number;
  mtimeMs: number;
}

/**
 * Polls the configured inbox folder. Each scan re-reads the setting, so a changed folder is picked up on the next
 * tick (or right away via `refresh()`).
 */
export class InboxScanner {
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly timers: InboxTimers;
  private readonly watchFn: InboxScannerDeps["watch"];
  private readonly convertHeic?: HeicConverter;
  private readonly log: (msg: string) => void;

  private interval: unknown = null;
  private debounce: unknown = null;
  private watcher: { close(): void } | null = null;
  private watchedPath = "";
  private running: Promise<ScanResult> | null = null;
  private again = false;
  /** path → size/mtime on the previous scan (stability check) */
  private seen = new Map<string, Seen>();
  /** files that could not be moved after import: path → size/mtime, not hashed again while unchanged */
  private handled = new Map<string, Seen>();
  private state: Omit<InboxStatus, "newCount" | "path"> = { watching: false, lastScanAt: null, error: null, skipped: [] };

  constructor(
    private readonly db: DbOrTx,
    deps: InboxScannerDeps = {},
  ) {
    this.dataDir = deps.dataDir ?? DATA_DIR;
    this.now = deps.now ?? (() => new Date());
    this.timers = deps.timers ?? realTimers;
    this.watchFn = deps.watch === undefined ? fsWatch : deps.watch;
    this.convertHeic = deps.convertHeic;
    this.log = deps.log ?? ((m) => console.log(m));
  }

  get started(): boolean {
    return this.interval !== null;
  }

  /** Scan now, then every POLL_MS. */
  start(): void {
    if (this.interval) return;
    this.interval = this.timers.setInterval(() => void this.scan(), POLL_MS);
    void this.scan();
  }

  stop(): void {
    if (this.interval) this.timers.clearInterval(this.interval);
    if (this.debounce) this.timers.clearTimeout(this.debounce);
    this.interval = this.debounce = null;
    this.unwatch();
  }

  /** Folder setting changed: forget per-folder state and scan now. */
  refresh(): Promise<ScanResult> {
    this.seen.clear();
    this.handled.clear();
    return this.scan();
  }

  status(): InboxStatus {
    return { path: getSettings(this.db).receiptInboxPath, ...this.state, newCount: countNewInboxItems(this.db) };
  }

  private schedule(ms: number) {
    if (!this.interval) return; // only while started (manual scans don't arm timers)
    if (this.debounce) this.timers.clearTimeout(this.debounce);
    this.debounce = this.timers.setTimeout(() => {
      this.debounce = null;
      void this.scan();
    }, ms);
  }

  private unwatch() {
    this.watcher?.close();
    this.watcher = null;
    this.watchedPath = "";
    this.state.watching = false;
  }

  private ensureWatch(path: string) {
    if (this.watchedPath === path && this.watcher) return;
    this.unwatch();
    if (!this.watchFn || !this.interval) return;
    try {
      this.watcher = this.watchFn(path, () => this.schedule(DEBOUNCE_MS));
      this.watchedPath = path;
      this.state.watching = true;
    } catch {
      // polling only
    }
  }

  /** One scan (concurrent calls share the running scan and trigger one more afterwards). */
  scan(): Promise<ScanResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.scanOnce().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.scan();
      }
    });
    return this.running;
  }

  private fail(error: string): ScanResult {
    this.unwatch();
    this.state = { ...this.state, error, skipped: [], lastScanAt: this.now().toISOString() };
    return { imported: 0, pending: 0, skipped: [], error };
  }

  private async scanOnce(): Promise<ScanResult> {
    const path = getSettings(this.db).receiptInboxPath;
    if (!path) {
      this.unwatch();
      this.seen.clear();
      this.state = { watching: false, lastScanAt: null, error: null, skipped: [] };
      return { imported: 0, pending: 0, skipped: [], error: null };
    }
    if (!existsSync(path)) return this.fail(`Ordner nicht gefunden: ${path}`);
    let names: string[];
    try {
      if (!statSync(path).isDirectory()) return this.fail(`Kein Ordner: ${path}`);
      names = readdirSync(path);
    } catch {
      return this.fail(`Ordner nicht lesbar: ${path} (Zugriffsrechte prüfen)`);
    }
    this.ensureWatch(path);

    const skipped: InboxSkipped[] = [];
    const nextSeen = new Map<string, Seen>();
    let imported = 0;
    let pending = 0;
    for (const name of names) {
      // hidden files, iCloud placeholders (".x.pdf.icloud") and our own subfolder
      if (name.startsWith(".") || name.endsWith(".icloud")) continue;
      const abs = join(path, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!ACCEPTED_EXT.has(extOf(name))) {
        skipped.push({ name, reason: "Dateityp nicht unterstützt" });
        continue;
      }
      if (st.size > RECEIPT_MAX_BYTES) {
        skipped.push({ name, reason: "zu groß (max. 20 MB)" });
        continue;
      }
      const cur = { size: st.size, mtimeMs: st.mtimeMs };
      const done = this.handled.get(abs);
      if (done && done.size === cur.size && done.mtimeMs === cur.mtimeMs) {
        skipped.push({ name, reason: "übernommen, konnte aber nicht nach „Importiert“ verschoben werden" });
        continue;
      }
      const prev = this.seen.get(abs);
      if (!prev || prev.size !== cur.size || prev.mtimeMs !== cur.mtimeMs || cur.size === 0) {
        // new or still changing: check again shortly
        nextSeen.set(abs, cur);
        pending++;
        if (cur.size === 0 && prev?.size === 0) skipped.push({ name, reason: "leer" });
        continue;
      }
      try {
        const r = await addInboxFile(
          this.db,
          { name, bytes: new Uint8Array(await Bun.file(abs).arrayBuffer()), sourcePath: abs },
          { dataDir: this.dataDir, convertHeic: this.convertHeic },
        );
        if (r.kind === "added") imported++;
        else this.log(`nesev Belege-Eingang: ${name} übersprungen (${r.reason})`);
      } catch (err) {
        nextSeen.set(abs, cur); // retried next scan
        skipped.push({ name, reason: (err as Error).message });
        continue;
      }
      // taken (or a duplicate): move it out of the way, so it isn't read again
      try {
        const target = join(path, IMPORTED_DIR_NAME);
        mkdirSync(target, { recursive: true });
        renameSync(abs, join(target, freeName(target, name)));
      } catch {
        this.handled.set(abs, cur);
        skipped.push({ name, reason: "übernommen, konnte aber nicht nach „Importiert“ verschoben werden" });
      }
    }
    this.seen = nextSeen;
    this.state = { ...this.state, error: null, skipped, lastScanAt: this.now().toISOString() };
    if (imported) this.log(`nesev Belege-Eingang: ${imported} Beleg(e) übernommen aus ${path}`);
    if (pending) this.schedule(RECHECK_MS);
    return { imported, pending, skipped, error: null };
  }
}

const SCANNER_KEY = Symbol.for("nesev.receiptInbox");

/** The process-wide scanner (one per server; survives `bun --hot` reloads). */
export function getInboxScanner(db: DbOrTx): InboxScanner {
  const g = globalThis as { [SCANNER_KEY]?: InboxScanner };
  return (g[SCANNER_KEY] ??= new InboxScanner(db));
}

/** Server start: scan the inbox folder now and periodically. */
export function startReceiptInbox(db: DbOrTx): void {
  getInboxScanner(db).start();
}
