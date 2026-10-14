import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Quad } from "../../shared/receipt-crop";
import { createTestDb } from "../db/client";
import { helperAvailable, runHelper } from "../lib/ocr/helper";
import { CommandError } from "../lib/ocr/run";
import {
  createExpense,
  cropExpenseReceipt,
  deleteExpense,
  detectReceiptQuad,
  getExpense,
  type ReceiptDetection,
  type ReceiptImageHelper,
  removeExpenseAttachment,
  restoreExpenseReceipt,
  setExpenseAttachment,
} from "./expenses";

const dataDir = mkdtempSync(join(tmpdir(), "nesev-crop-test-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const QUAD: Quad = [
  [0.1, 0.1],
  [0.9, 0.12],
  [0.88, 0.9],
  [0.12, 0.88],
];

/** Records calls; "crop" writes a marker file containing the source path. */
function fakeHelper() {
  const calls: string[][] = [];
  const helper: ReceiptImageHelper = async <T,>(args: string[]) => {
    calls.push(args);
    if (args[0] === "detect-document") {
      return { quad: QUAD, confidence: 0.99, method: "segmentation", width: 30, height: 40 } as T;
    }
    writeFileSync(args[2]!, `crop of ${args[1]}`);
    return { width: 20, height: 30 } as T;
  };
  return { calls, helper };
}

const photo = (name = "foto.jpg") => new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: "image/jpeg" });
const exists = (rel: string | null) => !!rel && existsSync(join(dataDir, rel));

describe("receipt crop bookkeeping", () => {
  test("crop keeps the original, re-crop starts from it, restore deletes the crop", async () => {
    const db = createTestDb();
    const { calls, helper } = fakeHelper();
    const e = createExpense(db, { supplierName: "Billa", issueDate: "2026-03-02" });
    const uploaded = await setExpenseAttachment(db, e.id, photo(), dataDir);
    const original = uploaded.attachmentPath!;
    expect(uploaded.attachmentOriginalPath).toBeNull();

    const detected = await detectReceiptQuad(db, e.id, { dataDir, helper });
    expect(detected.quad).toEqual(QUAD);
    expect(calls[0]).toEqual(["detect-document", join(dataDir, original)]);

    const first = await cropExpenseReceipt(db, e.id, { quad: QUAD }, { dataDir, helper });
    expect(first.attachmentOriginalPath).toBe(original);
    expect(first.attachmentPath).toMatch(/^receipts\/2026\/ER-2026-0001-\d+-crop-\d+\.jpg$/);
    expect(first.attachmentName).toBe("foto.jpg");
    expect(readFileSync(join(dataDir, first.attachmentPath!), "utf8")).toBe(`crop of ${join(dataDir, original)}`);
    const cropArgs = calls[1]!;
    expect(cropArgs.slice(0, 3)).toEqual(["crop", join(dataDir, original), join(dataDir, first.attachmentPath!)]);
    expect(cropArgs).toContain("0.1,0.1,0.9,0.12,0.88,0.9,0.12,0.88");
    expect(cropArgs).not.toContain("--enhance");

    // detection after a crop still looks at the original
    await detectReceiptQuad(db, e.id, { dataDir, helper });
    expect(calls[2]![1]).toBe(join(dataDir, original));

    await Bun.sleep(2);
    const second = await cropExpenseReceipt(db, e.id, { quad: QUAD, enhance: true }, { dataDir, helper });
    expect(calls[3]![1]).toBe(join(dataDir, original)); // never a crop of the crop
    expect(calls[3]).toContain("--enhance");
    expect(second.attachmentOriginalPath).toBe(original);
    expect(second.attachmentPath).not.toBe(first.attachmentPath);
    expect(exists(first.attachmentPath)).toBe(false); // replaced crop is gone
    expect(exists(second.attachmentPath)).toBe(true);
    expect(exists(original)).toBe(true);

    const restored = await restoreExpenseReceipt(db, e.id, dataDir);
    expect(restored.attachmentPath).toBe(original);
    expect(restored.attachmentOriginalPath).toBeNull();
    expect(exists(second.attachmentPath)).toBe(false);
    expect(exists(original)).toBe(true);
    await expect(restoreExpenseReceipt(db, e.id, dataDir)).rejects.toThrow("nicht zugeschnitten");
  });

  test("PNG receipts are cropped to PNG", async () => {
    const db = createTestDb();
    const { calls, helper } = fakeHelper();
    const e = createExpense(db, { issueDate: "2026-03-02" });
    await setExpenseAttachment(db, e.id, new File([new Uint8Array([137, 80])], "s.png", { type: "image/png" }), dataDir);
    const cropped = await cropExpenseReceipt(db, e.id, { quad: QUAD }, { dataDir, helper });
    expect(cropped.attachmentPath).toEndWith(".png");
    expect(calls[0]).toContain("png");
  });

  test("replace, remove and delete clean up original and crop", async () => {
    const db = createTestDb();
    const { helper } = fakeHelper();
    const e = createExpense(db, { issueDate: "2026-03-02" });

    const a = await setExpenseAttachment(db, e.id, photo(), dataDir);
    const ca = await cropExpenseReceipt(db, e.id, { quad: QUAD }, { dataDir, helper });
    await Bun.sleep(2);
    const replaced = await setExpenseAttachment(db, e.id, photo("neu.jpg"), dataDir);
    expect(replaced.attachmentOriginalPath).toBeNull();
    expect(exists(a.attachmentPath)).toBe(false);
    expect(exists(ca.attachmentPath)).toBe(false);
    expect(exists(replaced.attachmentPath)).toBe(true);

    const cb = await cropExpenseReceipt(db, e.id, { quad: QUAD }, { dataDir, helper });
    const removed = await removeExpenseAttachment(db, e.id, dataDir);
    expect(removed.attachmentOriginalPath).toBeNull();
    expect(exists(replaced.attachmentPath)).toBe(false);
    expect(exists(cb.attachmentPath)).toBe(false);

    const c = await setExpenseAttachment(db, e.id, photo(), dataDir);
    const cc = await cropExpenseReceipt(db, e.id, { quad: QUAD }, { dataDir, helper });
    await deleteExpense(db, e.id, dataDir);
    expect(exists(c.attachmentPath)).toBe(false);
    expect(exists(cc.attachmentPath)).toBe(false);
  });

  test("PDFs, missing receipts and helper errors", async () => {
    const db = createTestDb();
    const { helper } = fakeHelper();
    const e = createExpense(db, { issueDate: "2026-03-02" });
    await expect(detectReceiptQuad(db, e.id, { dataDir, helper })).rejects.toThrow("Kein Beleg");

    await setExpenseAttachment(db, e.id, new File(["%PDF-1.4"], "r.pdf", { type: "application/pdf" }), dataDir);
    await expect(detectReceiptQuad(db, e.id, { dataDir, helper })).rejects.toThrow("Nur Fotos");
    await expect(cropExpenseReceipt(db, e.id, { quad: QUAD }, { dataDir, helper })).rejects.toThrow("Nur Fotos");

    const withPhoto = await setExpenseAttachment(db, e.id, photo(), dataDir);
    const failing: ReceiptImageHelper = async (args) => {
      if (args[0] === "crop") writeFileSync(args[2]!, "partial");
      throw new CommandError("swiftc fehlt");
    };
    const err = await cropExpenseReceipt(db, e.id, { quad: QUAD }, { dataDir, helper: failing }).catch((x) => x);
    expect(err.status).toBe(422);
    expect(err.message).toBe("Zuschneiden nicht möglich: swiftc fehlt");
    expect(getExpense(db, e.id)!.attachmentPath).toBe(withPhoto.attachmentPath);
    // no partial crop file left behind
    const stem = basename(withPhoto.attachmentPath!, ".jpg");
    expect(readdirSync(join(dataDir, "receipts", "2026")).filter((f) => f.startsWith(`${stem}-crop-`))).toEqual([]);
  });
});

// --- real Swift helper -------------------------------------------------------------------------------

/**
 * Minimal uncompressed RGB TIFF with an Orientation tag. `pixel(x, y)` describes the image as displayed;
 * with orientation 6 the stored pixels are rotated 90° counter-clockwise (viewers rotate them back).
 */
function tiff(width: number, height: number, orientation: 1 | 6, pixel: (x: number, y: number) => number): Uint8Array {
  const sw = orientation === 6 ? height : width;
  const sh = orientation === 6 ? width : height;
  const data = new Uint8Array(sw * sh * 3);
  for (let r = 0; r < sh; r++) {
    for (let c = 0; c < sw; c++) {
      // orientation 6: stored row r is displayed as column (width - 1 - r), stored column c as row c
      const v = orientation === 6 ? pixel(width - 1 - r, c) : pixel(c, r);
      data.set([v, v, v], (r * sw + c) * 3);
    }
  }
  const entries: [number, number, number][] = [
    [256, 3, sw], // ImageWidth
    [257, 3, sh], // ImageLength
    [258, 3, 8], // BitsPerSample (one value is accepted for all samples)
    [259, 3, 1], // Compression: none
    [262, 3, 2], // Photometric: RGB
    [273, 4, 0], // StripOffsets (patched below)
    [274, 3, orientation],
    [277, 3, 3], // SamplesPerPixel
    [278, 3, sh], // RowsPerStrip
    [279, 4, data.length], // StripByteCounts
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataOffset = 8 + ifdSize;
  const buf = new Uint8Array(dataOffset + data.length);
  const view = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]); // "II", 42
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, value], i) => {
    const o = 10 + i * 12;
    view.setUint16(o, tag, true);
    view.setUint16(o + 2, type, true);
    view.setUint32(o + 4, 1, true);
    const v = tag === 273 ? dataOffset : value;
    if (type === 3) view.setUint16(o + 8, v, true);
    else view.setUint32(o + 8, v, true);
  });
  buf.set(data, dataOffset);
  return buf;
}

/** A white "receipt" with text bars, rotated 12°, on a dark background (600×800 as displayed). */
function receiptPhoto(orientation: 1 | 6) {
  const W = 600, H = 800, cx = 300, cy = 420, hw = 140, hh = 280;
  const a = (12 * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const toImage = (u: number, v: number): [number, number] => [cx + u * cos - v * sin, cy + u * sin + v * cos];
  const quad = ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).map(([u, v]) => {
    const [x, y] = toImage(u, v);
    return [x / W, y / H];
  });
  const bytes = tiff(W, H, orientation, (x, y) => {
    // back into receipt coordinates
    const dx = x - cx, dy = y - cy;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    if (Math.abs(u) > hw || Math.abs(v) > hh) return 35;
    const line = Math.floor((v + hh - 30) / 22);
    const inText = v > -hh + 30 && v < hh - 40 && (v + hh - 30) % 22 < 9 && u > -hw + 20 && u < hw - 20 - (line % 4) * 30;
    return inText ? 30 : 245;
  });
  return { bytes, quad, aspect: hw / hh };
}

// compiled once per helper source into a shared temp dir (takes a few seconds the first time)
const helperDataDir = join(tmpdir(), "nesev-ocr-test-helper");

describe.skipIf(!helperAvailable())("Swift helper: detect-document / crop", () => {
  const dir = mkdtempSync(join(tmpdir(), "nesev-crop-real-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = <T,>(args: string[]) => runHelper<T>(args, { dataDir: helperDataDir, timeoutMs: 300_000 });

  for (const orientation of [1, 6] as const) {
    test(`finds and straightens the receipt (EXIF orientation ${orientation})`, async () => {
      mkdirSync(dir, { recursive: true });
      const { bytes, quad, aspect } = receiptPhoto(orientation);
      const file = join(dir, `photo-${orientation}.tif`);
      writeFileSync(file, bytes);

      const detected = await run<ReceiptDetection>(["detect-document", file]);
      expect([detected.width, detected.height]).toEqual([600, 800]);
      expect(detected.quad).not.toBeNull();
      detected.quad!.forEach(([x, y], i) => {
        expect(Math.abs(x - quad[i]![0]!)).toBeLessThan(0.03);
        expect(Math.abs(y - quad[i]![1]!)).toBeLessThan(0.03);
      });

      const out = join(dir, `crop-${orientation}.jpg`);
      const cropped = await run<{ width: number; height: number }>(["crop", file, out, "--quad", detected.quad!.flat().join(",")]);
      expect(existsSync(out)).toBe(true);
      expect(Math.abs(cropped.width / cropped.height - aspect)).toBeLessThan(0.05);
      expect(Math.abs(cropped.height - 560)).toBeLessThan(40);
    }, 300_000);
  }
});
