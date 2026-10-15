import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { createTestDb } from "../db/client";
import { receiptInboxItems } from "../db/schema";
import { getExpense, setExpenseAttachment, createExpense } from "./expenses";
import {
  addInboxFile,
  checkInboxFolder,
  convertInboxItems,
  dismissInboxItems,
  IMPORTED_DIR_NAME,
  InboxScanner,
  type InboxTimers,
  listInboxItems,
} from "./receipt-inbox";
import { updateSettings } from "./settings";

const root = mkdtempSync(join(tmpdir(), "nesev-inbox-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function setup() {
  const dir = join(root, `case-${++n}`);
  const dataDir = join(dir, "data");
  const inbox = join(dir, "inbox");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(inbox, { recursive: true });
  const db = createTestDb();
  updateSettings(db, { receiptInboxPath: inbox });
  return { db, dataDir, inbox };
}

/** Fake timers: nothing fires unless the test calls `fire`. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number; repeat: boolean }>();
  let id = 0;
  const timers: InboxTimers = {
    setTimeout: (fn, ms) => {
      const own = ++id;
      pending.set(own, { fn: () => (pending.delete(own), fn()), ms, repeat: false });
      return own;
    },
    clearTimeout: (h) => void pending.delete(h as number),
    setInterval: (fn, ms) => (pending.set(++id, { fn, ms, repeat: true }), id),
    clearInterval: (h) => void pending.delete(h as number),
  };
  return { timers, pending };
}

const clock = () => {
  let t = Date.parse("2026-10-15T10:00:00Z");
  return { now: () => new Date(t), tick: (ms: number) => (t += ms) };
};

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);

function scanner(db: ReturnType<typeof createTestDb>, dataDir: string, extra: Partial<ConstructorParameters<typeof InboxScanner>[1]> = {}) {
  const c = clock();
  const t = fakeTimers();
  const s = new InboxScanner(db, { dataDir, now: c.now, timers: t.timers, watch: null, log: () => {}, ...extra });
  return { s, clock: c, timers: t };
}

describe("InboxScanner", () => {
  test("imports a file once its size is stable across two scans, then moves it to Importiert/", async () => {
    const { db, dataDir, inbox } = setup();
    writeFileSync(join(inbox, "Rechnung A1.pdf"), pdf("a"));
    const { s, clock: c } = scanner(db, dataDir);

    const first = await s.scan();
    expect(first).toMatchObject({ imported: 0, pending: 1, error: null });
    expect(listInboxItems(db)).toHaveLength(0);

    c.tick(45_000);
    const second = await s.scan();
    expect(second.imported).toBe(1);
    const [item] = listInboxItems(db);
    expect(item).toMatchObject({ fileName: "Rechnung A1.pdf", status: "new", sizeBytes: pdf("a").byteLength });
    expect(item!.storedPath).toMatch(/^receipts\/inbox\/[0-9a-f]{12}-Rechnung_A1\.pdf$/);
    expect(existsSync(join(dataDir, item!.storedPath!))).toBe(true);
    expect(existsSync(join(inbox, "Rechnung A1.pdf"))).toBe(false);
    expect(readdirSync(join(inbox, IMPORTED_DIR_NAME))).toEqual(["Rechnung A1.pdf"]);
    expect(s.status()).toMatchObject({ path: inbox, error: null, newCount: 1, lastScanAt: "2026-10-15T10:00:45.000Z" });
  });

  test("waits while a file is still growing", async () => {
    const { db, dataDir, inbox } = setup();
    const file = join(inbox, "scan.jpg");
    writeFileSync(file, "a");
    const { s } = scanner(db, dataDir);
    await s.scan();
    writeFileSync(file, "ab");
    expect((await s.scan()).imported).toBe(0);
    expect((await s.scan()).imported).toBe(1);
  });

  test("skips hidden files, iCloud placeholders, folders and unsupported types", async () => {
    const { db, dataDir, inbox } = setup();
    writeFileSync(join(inbox, ".DS_Store"), "x");
    writeFileSync(join(inbox, ".Beleg.pdf.icloud"), "x");
    writeFileSync(join(inbox, "notiz.txt"), "x");
    mkdirSync(join(inbox, "Unterordner"));
    const { s } = scanner(db, dataDir);
    await s.scan();
    const r = await s.scan();
    expect(r).toMatchObject({ imported: 0, pending: 0 });
    expect(r.skipped).toEqual([{ name: "notiz.txt", reason: "Dateityp nicht unterstützt" }]);
    expect(existsSync(join(inbox, "notiz.txt"))).toBe(true);
  });

  test("a duplicate (same content) is not imported again but still moved", async () => {
    const { db, dataDir, inbox } = setup();
    writeFileSync(join(inbox, "a.pdf"), pdf("same"));
    const { s } = scanner(db, dataDir);
    await s.scan();
    await s.scan();
    writeFileSync(join(inbox, "a.pdf"), pdf("same"));
    await s.scan();
    expect((await s.scan()).imported).toBe(0);
    expect(listInboxItems(db, "all")).toHaveLength(1);
    expect(readdirSync(join(inbox, IMPORTED_DIR_NAME)).sort()).toEqual(["a (2).pdf", "a.pdf"]);
  });

  test("missing or unreadable folder gives a German status, no throw", async () => {
    const { db, dataDir, inbox } = setup();
    updateSettings(db, { receiptInboxPath: join(inbox, "gibts-nicht") });
    const { s } = scanner(db, dataDir);
    const r = await s.scan();
    expect(r.error).toStartWith("Ordner nicht gefunden");
    expect(s.status().error).toStartWith("Ordner nicht gefunden");

    if (process.getuid?.() !== 0) {
      const locked = join(inbox, "gesperrt");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      updateSettings(db, { receiptInboxPath: locked });
      expect((await s.scan()).error).toStartWith("Ordner nicht lesbar");
      chmodSync(locked, 0o755);
    }
  });

  test("off when no folder is configured", async () => {
    const { db, dataDir } = setup();
    updateSettings(db, { receiptInboxPath: "" });
    const { s } = scanner(db, dataDir);
    expect(await s.scan()).toEqual({ imported: 0, pending: 0, skipped: [], error: null });
    expect(s.status()).toMatchObject({ path: "", error: null, lastScanAt: null });
  });

  test("start arms the poll and a re-check for pending files; stop clears every timer and the watcher", async () => {
    const { db, dataDir, inbox } = setup();
    writeFileSync(join(inbox, "a.png"), "png");
    let closed = 0;
    const { s, timers } = scanner(db, dataDir, { watch: () => ({ close: () => void closed++ }) });
    s.start();
    await s.scan(); // joins the start scan
    const kinds = [...timers.pending.values()].map((p) => [p.ms, p.repeat]);
    expect(kinds).toContainEqual([45_000, true]);
    expect(kinds).toContainEqual([3_000, false]);
    expect(s.status().watching).toBe(true);
    // the re-check imports the file
    const recheck = [...timers.pending.values()].find((p) => !p.repeat)!;
    recheck.fn();
    await s.scan();
    expect(listInboxItems(db)).toHaveLength(1);

    s.stop();
    expect(timers.pending.size).toBe(0);
    expect(closed).toBe(1);
    expect(s.started).toBe(false);
  });

  test("HEIC is converted to JPEG via the converter", async () => {
    const { db, dataDir } = setup();
    const r = await addInboxFile(
      db,
      { name: "IMG_0001.HEIC", bytes: new Uint8Array([1, 2, 3]) },
      { dataDir, convertHeic: async (_src, dest) => writeFileSync(dest, "jpeg") },
    );
    expect(r.kind).toBe("added");
    if (r.kind !== "added") return;
    expect(r.item.storedPath).toEndWith("-IMG_0001.jpg");
    expect(Bun.file(join(dataDir, r.item.storedPath!)).size).toBe(4);
  });
});

describe("inbox items", () => {
  test("convert creates a draft expense with the file as receipt and removes the copy", async () => {
    const { db, dataDir } = setup();
    const r = await addInboxFile(db, { name: "beleg.pdf", bytes: pdf("x") }, { dataDir });
    if (r.kind !== "added") throw new Error("not added");
    const stored = join(dataDir, r.item.storedPath!);

    const [expense] = await convertInboxItems(db, [r.item.id], dataDir);
    expect(expense).toMatchObject({ supplierName: "", attachmentName: "beleg.pdf", incomplete: true });
    expect(existsSync(join(dataDir, expense!.attachmentPath!))).toBe(true);
    expect(existsSync(stored)).toBe(false);
    const row = db.select().from(receiptInboxItems).where(eq(receiptInboxItems.id, r.item.id)).get();
    expect(row).toMatchObject({ status: "converted", expenseId: expense!.id, storedPath: null });

    // converting again is refused; the same file is now a duplicate
    expect(convertInboxItems(db, [r.item.id], dataDir)).rejects.toBeInstanceOf(HTTPException);
    expect((await addInboxFile(db, { name: "x.pdf", bytes: pdf("x") }, { dataDir })).kind).toBe("duplicate");
  });

  test("dismiss deletes the copy; the same file dropped again comes back", async () => {
    const { db, dataDir } = setup();
    const r = await addInboxFile(db, { name: "a.pdf", bytes: pdf("d") }, { dataDir });
    if (r.kind !== "added") throw new Error("not added");
    expect(await dismissInboxItems(db, [r.item.id], dataDir)).toBe(1);
    expect(existsSync(join(dataDir, r.item.storedPath!))).toBe(false);
    expect(listInboxItems(db)).toHaveLength(0);

    const again = await addInboxFile(db, { name: "a.pdf", bytes: pdf("d") }, { dataDir });
    expect(again).toMatchObject({ kind: "added", item: { id: r.item.id, status: "new" } });
  });

  test("a file already attached to an expense is a duplicate", async () => {
    const { db, dataDir } = setup();
    const e = createExpense(db, {});
    await setExpenseAttachment(db, e.id, new File([pdf("att")], "r.pdf", { type: "application/pdf" }), dataDir);
    const r = await addInboxFile(db, { name: "r.pdf", bytes: pdf("att") }, { dataDir });
    expect(r).toMatchObject({ kind: "duplicate", reason: `bereits bei Ausgabe ${getExpense(db, e.id)!.number} hinterlegt` });
  });

  test("rejects unsupported and empty files", async () => {
    const { db, dataDir } = setup();
    expect(addInboxFile(db, { name: "a.txt", bytes: pdf("t") }, { dataDir })).rejects.toThrow("Nur PDF");
    expect(addInboxFile(db, { name: "a.pdf", bytes: new Uint8Array() }, { dataDir })).rejects.toThrow("leer");
  });
});

describe("checkInboxFolder", () => {
  test("validates the folder", () => {
    const { dataDir, inbox } = setup();
    expect(checkInboxFolder("", dataDir)).toEqual({ path: "" });
    expect(checkInboxFolder(inbox, dataDir)).toEqual({ path: inbox });
    expect(checkInboxFolder("relativ/pfad", dataDir)).toMatchObject({ error: expect.stringContaining("absoluten") });
    expect(checkInboxFolder(join(inbox, "nope"), dataDir)).toEqual({ error: "Ordner nicht gefunden" });
    mkdirSync(join(dataDir, "eingang"));
    expect(checkInboxFolder(join(dataDir, "eingang"), dataDir)).toMatchObject({ error: expect.stringContaining("Datenordner") });
    expect(checkInboxFolder(dataDir, dataDir)).toMatchObject({ error: expect.stringContaining("Datenordner") });
    writeFileSync(join(inbox, "f.pdf"), "x");
    expect(checkInboxFolder(join(inbox, "f.pdf"), dataDir)).toMatchObject({ error: expect.stringContaining("Datei") });
  });
});
