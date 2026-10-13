import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  calcExpenseTotals,
  deductibleTaxCents,
  defaultVatTreatment,
  expenseTaxCents,
  netFromGross,
} from "../../shared/expenses";
import type { ExpenseLineInput } from "../../shared/schemas/expense";
import { createTestDb } from "../db/client";
import { bankAccounts, bankMatches, bankTransactions, expenseLines, expenses } from "../db/schema";
import {
  createDraftsFromFiles,
  createExpense,
  deleteExpense,
  getExpense,
  listExpenses,
  removeExpenseAttachment,
  setExpenseAttachment,
  setExpensePaid,
  supplierSuggestions,
  updateExpense,
} from "./expenses";

const dataDir = mkdtempSync(join(tmpdir(), "nesev-expenses-test-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const line = (over: Partial<ExpenseLineInput> = {}): ExpenseLineInput => ({
  category: "software_abos",
  description: "",
  netCents: 1000,
  taxRateBp: 2000,
  taxCents: 200,
  deductibleBp: 10000,
  ...over,
});

const pdf = (name = "beleg.pdf") => new File(["%PDF-1.4 test"], name, { type: "application/pdf" });

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof HTTPException) return err.status;
    throw err;
  }
  return undefined;
}

describe("shared helpers", () => {
  test("expenseTaxCents rounds half away from zero", () => {
    expect(expenseTaxCents(1000, 2000)).toBe(200);
    expect(expenseTaxCents(1234, 2000)).toBe(247); // 246.8
    expect(expenseTaxCents(25, 2000)).toBe(5);
    expect(expenseTaxCents(-1234, 2000)).toBe(-247);
  });

  test("netFromGross back-calculates and net + tax = gross", () => {
    expect(netFromGross(1200, 2000)).toEqual({ netCents: 1000, taxCents: 200 });
    expect(netFromGross(1999, 2000)).toEqual({ netCents: 1666, taxCents: 333 });
    expect(netFromGross(1130, 1300)).toEqual({ netCents: 1000, taxCents: 130 });
    expect(netFromGross(500, 0)).toEqual({ netCents: 500, taxCents: 0 });
    for (const gross of [1, 99, 1001, 4711, 123456]) {
      for (const rate of [2000, 1300, 1000]) {
        const { netCents, taxCents } = netFromGross(gross, rate);
        expect(netCents + taxCents).toBe(gross);
        expect(Math.abs(expenseTaxCents(netCents, rate) - taxCents)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("deductibleTaxCents applies the share", () => {
    expect(deductibleTaxCents({ taxCents: 333, deductibleBp: 5000 })).toBe(167);
    expect(deductibleTaxCents({ taxCents: 200, deductibleBp: 0 })).toBe(0);
  });

  test("totals: self-assessed tax is not payable to the supplier", () => {
    const lines = [line(), line({ netCents: 500, taxCents: 65, taxRateBp: 1300 })];
    expect(calcExpenseTotals(lines, "domestic")).toEqual({ netCents: 1500, taxCents: 265, grossCents: 1765 });
    expect(calcExpenseTotals(lines, "reverse_charge")).toEqual({ netCents: 1500, taxCents: 265, grossCents: 1500 });
    expect(calcExpenseTotals(lines, "ig_acquisition").grossCents).toBe(1500);
  });

  test("defaultVatTreatment", () => {
    expect(defaultVatTreatment("AT", "ATU12345678")).toBe("domestic");
    expect(defaultVatTreatment("DE", "DE123456789")).toBe("reverse_charge");
    expect(defaultVatTreatment("DE", "")).toBe("domestic");
    expect(defaultVatTreatment("US")).toBe("reverse_charge");
  });
});

describe("expenses service", () => {
  test("create assigns ER numbers per issue year and caches totals", () => {
    const db = createTestDb();
    const a = createExpense(db, { supplierName: "A1", issueDate: "2026-03-01", lines: [line()] });
    const b = createExpense(db, { supplierName: "B", issueDate: "2026-03-02", lines: [] });
    const c = createExpense(db, { supplierName: "C", issueDate: "2025-12-31", lines: [] });
    expect(a.number).toBe("ER-2026-0001");
    expect(b.number).toBe("ER-2026-0002");
    expect(c.number).toBe("ER-2025-0001");
    expect(a).toMatchObject({ netCents: 1000, taxCents: 200, grossCents: 1200, incomplete: false });
    expect(b.incomplete).toBe(true);
  });

  test("update keeps totals consistent with lines and treatment", () => {
    const db = createTestDb();
    const e = createExpense(db, { supplierName: "X", issueDate: "2026-01-10", lines: [line()] });

    const twoLines = updateExpense(db, e.id, {
      lines: [line(), line({ category: "bewirtung", netCents: 3000, taxRateBp: 1000, taxCents: 301, deductibleBp: 5000 })],
    });
    expect(twoLines.lines.map((l) => l.position)).toEqual([0, 1]);
    expect(twoLines).toMatchObject({ netCents: 4000, taxCents: 501, grossCents: 4501 });

    // Changing only the treatment recomputes the cache from the stored lines.
    const rc = updateExpense(db, e.id, { vatTreatment: "reverse_charge" });
    expect(rc).toMatchObject({ netCents: 4000, taxCents: 501, grossCents: 4000 });

    // "none" normalizes lines to 0 %.
    const none = updateExpense(db, e.id, { vatTreatment: "none" });
    expect(none).toMatchObject({ netCents: 4000, taxCents: 0, grossCents: 4000 });
    expect(none.lines.every((l) => l.taxRateBp === 0 && l.taxCents === 0)).toBe(true);

    // Updating other fields keeps lines and totals.
    const renamed = updateExpense(db, e.id, { supplierName: "Y" });
    expect(renamed).toMatchObject({ supplierName: "Y", netCents: 4000, vatTreatment: "none" });
    expect(renamed.lines).toHaveLength(2);

    const cleared = updateExpense(db, e.id, { lines: [] });
    expect(cleared).toMatchObject({ netCents: 0, taxCents: 0, grossCents: 0, incomplete: true });
  });

  test("mark paid / unpaid", () => {
    const db = createTestDb();
    const e = createExpense(db, { supplierName: "X", lines: [line()] });
    expect(setExpensePaid(db, e.id, "2026-02-01").paidAt).toBe("2026-02-01");
    expect(setExpensePaid(db, e.id, null).paidAt).toBeNull();
    expect(statusOf(() => setExpensePaid(db, 999, null))).toBe(404);
  });

  test("list filters", () => {
    const db = createTestDb();
    const a = createExpense(db, {
      supplierName: "Hetzner Online",
      issueDate: "2026-01-05",
      lines: [line({ category: "software_abos" })],
      paidAt: "2026-01-06",
    });
    const b = createExpense(db, {
      supplierName: "Billa",
      issueDate: "2026-02-05",
      description: "Bürobedarf 100%_",
      lines: [line({ category: "buero" }), line({ category: "bewirtung" })],
    });
    const draft = createExpense(db, { issueDate: "2026-03-01" });

    const ids = (f: Parameters<typeof listExpenses>[1]) => listExpenses(db, f).map((r) => r.id);
    expect(ids({})).toEqual([draft.id, b.id, a.id]);
    expect(ids({ from: "2026-02-01", to: "2026-02-28" })).toEqual([b.id]);
    expect(ids({ category: "bewirtung" })).toEqual([b.id]);
    expect(ids({ q: "hetz" })).toEqual([a.id]);
    expect(ids({ q: "100%_" })).toEqual([b.id]);
    expect(ids({ q: "ER-2026-0002" })).toEqual([b.id]);
    expect(ids({ status: "paid" })).toEqual([a.id]);
    expect(ids({ status: "open" })).toEqual([draft.id, b.id]);
    expect(ids({ status: "incomplete" })).toEqual([draft.id]);

    const row = listExpenses(db, { q: "billa" })[0]!;
    expect(row.categories.sort()).toEqual(["bewirtung", "buero"]);
    expect(row.lineCount).toBe(2);
  });

  test("attachments: upload, replace, filter, remove, delete removes file", async () => {
    const db = createTestDb();
    const e = createExpense(db, { supplierName: "X", issueDate: "2026-04-01", lines: [line()] });
    const first = await setExpenseAttachment(db, e.id, pdf("rechnung.pdf"), dataDir);
    expect(first.attachmentPath).toMatch(/^receipts\/2026\/ER-2026-0001-\d+\.pdf$/);
    expect(first.attachmentName).toBe("rechnung.pdf");
    const firstFile = join(dataDir, first.attachmentPath!);
    expect(existsSync(firstFile)).toBe(true);
    expect(listExpenses(db, { attachment: "with" }).map((r) => r.id)).toEqual([e.id]);
    expect(listExpenses(db, { attachment: "without" })).toEqual([]);

    await Bun.sleep(2);
    const png = new File([new Uint8Array([137, 80, 78, 71])], "foto.png", { type: "image/png" });
    const replaced = await setExpenseAttachment(db, e.id, png, dataDir);
    expect(replaced.attachmentPath).toEndWith(".png");
    expect(existsSync(firstFile)).toBe(false);

    const removed = await removeExpenseAttachment(db, e.id, dataDir);
    expect(removed.attachmentPath).toBeNull();
    expect(existsSync(join(dataDir, replaced.attachmentPath!))).toBe(false);

    const withFile = await setExpenseAttachment(db, e.id, pdf(), dataDir);
    const path = join(dataDir, withFile.attachmentPath!);
    await deleteExpense(db, e.id, dataDir);
    expect(getExpense(db, e.id)).toBeUndefined();
    expect(db.select().from(expenseLines).where(eq(expenseLines.expenseId, e.id)).all()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("attachment validation", async () => {
    const db = createTestDb();
    const e = createExpense(db, { supplierName: "X" });
    const txt = new File(["hi"], "notes.txt", { type: "text/plain" });
    await expect(setExpenseAttachment(db, e.id, txt, dataDir)).rejects.toThrow("Nur PDF");
    // generic MIME type falls back to the extension
    const octet = new File(["x"], "scan.JPEG", { type: "application/octet-stream" });
    expect((await setExpenseAttachment(db, e.id, octet, dataDir)).attachmentPath).toEndWith(".jpg");
  });

  test("delete cascades bank matches", async () => {
    const db = createTestDb();
    const e = createExpense(db, { supplierName: "X", lines: [line()] });
    const acc = db.insert(bankAccounts).values({ name: "Giro" }).returning().get();
    const tx = db
      .insert(bankTransactions)
      .values({ accountId: acc.id, bookingDate: "2026-01-01", amountCents: -1200, importHash: "h1" })
      .returning()
      .get();
    db.insert(bankMatches).values({ transactionId: tx.id, expenseId: e.id, amountCents: 1200 }).run();
    await deleteExpense(db, e.id, dataDir);
    expect(db.select().from(bankMatches).all()).toEqual([]);
    expect(db.select().from(expenses).all()).toEqual([]);
  });

  test("drafts from files: one incomplete expense per receipt, today's date", async () => {
    const db = createTestDb();
    const drafts = await createDraftsFromFiles(db, [pdf("a.pdf"), pdf("b-rechnung.pdf")], dataDir);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.attachmentName)).toEqual(["a.pdf", "b-rechnung.pdf"]);
    expect(drafts.every((d) => d.incomplete && d.attachmentPath && d.number?.startsWith("ER-"))).toBe(true);
    // invalid files reject the whole batch before anything is created
    await expect(
      createDraftsFromFiles(db, [pdf(), new File(["x"], "x.exe", { type: "application/x-msdownload" })], dataDir),
    ).rejects.toThrow();
    expect(listExpenses(db)).toHaveLength(2);
  });

  test("supplier suggestions: distinct, latest data wins, most used first", () => {
    const db = createTestDb();
    createExpense(db, {
      supplierName: "Adobe",
      supplierCountry: "IE",
      supplierUid: "IE0000000",
      vatTreatment: "reverse_charge",
      issueDate: "2026-01-01",
      lines: [line({ category: "software_abos" })],
    });
    createExpense(db, {
      supplierName: "adobe",
      supplierCountry: "IE",
      supplierUid: "IE6364992H",
      vatTreatment: "reverse_charge",
      issueDate: "2026-02-01",
      description: "Creative Cloud",
      lines: [line({ category: "software_abos", taxRateBp: 2000 })],
    });
    createExpense(db, { supplierName: "A1 Telekom", issueDate: "2026-01-15", lines: [line({ category: "telefon_internet" })] });
    createExpense(db, { supplierName: "", issueDate: "2026-03-01" }); // drafts are ignored

    const all = supplierSuggestions(db);
    expect(all.map((s) => s.name)).toEqual(["adobe", "A1 Telekom"]);
    expect(all[0]).toMatchObject({
      uid: "IE6364992H",
      country: "IE",
      vatTreatment: "reverse_charge",
      category: "software_abos",
      taxRateBp: 2000,
      description: "Creative Cloud",
      count: 2,
      lastIssueDate: "2026-02-01",
    });
    expect(supplierSuggestions(db, "tel").map((s) => s.name)).toEqual(["A1 Telekom"]);
    // prefix matches rank before more frequently used substring matches
    expect(supplierSuggestions(db, "a1").map((s) => s.name)).toEqual(["A1 Telekom"]);
    expect(supplierSuggestions(db, "a", 1)).toHaveLength(1);
  });
});
