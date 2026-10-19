import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, or, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import { todayIso } from "../../shared/dates";
import {
  calcExpenseTotals,
  isExpenseIncomplete,
  RECEIPT_MAX_BYTES,
  RECEIPT_MIME_TYPES,
  type VatTreatment,
} from "../../shared/expenses";
import { isCroppablePath, type Quad } from "../../shared/receipt-crop";
import type {
  ExpenseCreate,
  ExpenseLineInput,
  ExpenseListQuery,
  ExpenseUpdate,
} from "../../shared/schemas/expense";
import type { DbOrTx } from "../db/client";
import { bankMatches, type Expense, type ExpenseLine, expenseLines, expenses } from "../db/schema";
import { nextNumber } from "../lib/numbering";
import { runHelper } from "../lib/ocr/helper";
import { CommandError } from "../lib/ocr/run";
import { DATA_DIR } from "../lib/paths";
import { unmatch } from "./bank-matching";

// Expenses (Ausgaben / Belege). Semantics of the tables and totals: see src/shared/expenses.ts.
// Receipts live under <DATA_DIR>/receipts/<year>/ and are stored as "receipts/<year>/<file>".
// A cropped photo receipt keeps its original in attachmentOriginalPath; attachmentPath points to the crop
// ("<original stem>-crop-<ts>.jpg" next to it). Every replace/remove/delete cleans up both files.

export type ExpenseWithLines = Omit<Expense, "vatTreatment"> & {
  vatTreatment: VatTreatment;
  lines: ExpenseLine[];
  incomplete: boolean;
};

export type ExpenseListRow = Omit<Expense, "vatTreatment"> & {
  vatTreatment: VatTreatment;
  /** distinct line categories */
  categories: string[];
  lineCount: number;
  incomplete: boolean;
};

export interface SupplierSuggestion {
  name: string;
  uid: string;
  country: string;
  vatTreatment: VatTreatment;
  /** category / rate / deductible share of the first line of the latest expense, if any */
  category: string | null;
  taxRateBp: number | null;
  deductibleBp: number | null;
  description: string;
  lastIssueDate: string;
  count: number;
}

// Raw SQL with explicit aliases: drizzle renders unqualified column names in single-table selects,
// which would resolve to expense_lines inside these correlated subqueries.
const lineCountSql = sql<number>`(select count(*) from expense_lines el where el.expense_id = "expenses"."id")`;
const categoriesSql = sql<
  string | null
>`(select group_concat(distinct el.category) from expense_lines el where el.expense_id = "expenses"."id")`;
const hasCategorySql = (category: string) =>
  sql`exists (select 1 from expense_lines el where el.expense_id = "expenses"."id" and el.category = ${category})`;

/** Case-insensitive (ASCII) substring match with %/_ escaped. */
function contains(column: AnySQLiteColumn, term: string): SQL {
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}

const incompleteSql = or(eq(expenses.supplierName, ""), sql`${lineCountSql} = 0`);

export function listExpenses(db: DbOrTx, filter: Partial<ExpenseListQuery> = {}): ExpenseListRow[] {
  const q = filter.q?.trim();
  const where = and(
    filter.from ? gte(expenses.issueDate, filter.from) : undefined,
    filter.to ? lte(expenses.issueDate, filter.to) : undefined,
    q
      ? or(
          contains(expenses.supplierName, q),
          contains(expenses.description, q),
          contains(expenses.number, q),
          contains(expenses.supplierInvoiceNumber, q),
          contains(expenses.notes, q),
          contains(expenses.attachmentName, q),
        )
      : undefined,
    filter.category ? hasCategorySql(filter.category)      : undefined,
    filter.status === "open" ? isNull(expenses.paidAt) : undefined,
    filter.status === "paid" ? isNotNull(expenses.paidAt) : undefined,
    filter.status === "incomplete" ? incompleteSql : undefined,
    filter.attachment === "with" ? isNotNull(expenses.attachmentPath) : undefined,
    filter.attachment === "without" ? isNull(expenses.attachmentPath) : undefined,
  );
  const rows = db
    .select({ expense: expenses, lineCount: lineCountSql, categories: categoriesSql })
    .from(expenses)
    .where(where)
    .orderBy(desc(expenses.issueDate), desc(expenses.id))
    .all();
  return rows.map(({ expense, lineCount, categories }) => ({
    ...expense,
    vatTreatment: expense.vatTreatment as VatTreatment,
    categories: categories ? categories.split(",") : [],
    lineCount,
    incomplete: isExpenseIncomplete({ supplierName: expense.supplierName, lineCount }),
  }));
}

export function getExpense(db: DbOrTx, id: number): ExpenseWithLines | undefined {
  const expense = db.select().from(expenses).where(eq(expenses.id, id)).get();
  if (!expense) return undefined;
  const lines = db
    .select()
    .from(expenseLines)
    .where(eq(expenseLines.expenseId, id))
    .orderBy(asc(expenseLines.position), asc(expenseLines.id))
    .all();
  return {
    ...expense,
    vatTreatment: expense.vatTreatment as VatTreatment,
    lines,
    incomplete: isExpenseIncomplete({ supplierName: expense.supplierName, lineCount: lines.length }),
  };
}

/** Like getExpense, but throws a 404 HTTPException when missing. */
export function requireExpense(db: DbOrTx, id: number): ExpenseWithLines {
  const expense = getExpense(db, id);
  if (!expense) throw new HTTPException(404, { message: "Ausgabe nicht gefunden" });
  return expense;
}

type LineValues = Omit<ExpenseLineInput, "category"> & { category: string };

/** Replaces all lines and rewrites the cached totals. "none" carries no VAT: lines get rate 0 and tax 0. */
function writeLines(tx: DbOrTx, expenseId: number, lines: readonly LineValues[], treatment: VatTreatment) {
  const values = lines.map((l, position) => ({
    expenseId,
    position,
    category: l.category,
    description: l.description,
    netCents: l.netCents,
    taxRateBp: treatment === "none" ? 0 : l.taxRateBp,
    taxCents: treatment === "none" ? 0 : l.taxCents,
    deductibleBp: l.deductibleBp,
  }));
  tx.delete(expenseLines).where(eq(expenseLines.expenseId, expenseId)).run();
  if (values.length) tx.insert(expenseLines).values(values).run();
  tx.update(expenses).set(calcExpenseTotals(values, treatment)).where(eq(expenses.id, expenseId)).run();
}

export function createExpense(db: DbOrTx, input: ExpenseCreate): ExpenseWithLines {
  const issueDate = input.issueDate ?? todayIso();
  const vatTreatment = input.vatTreatment ?? "domestic";
  const id = db.transaction((tx) => {
    const { number } = nextNumber(tx, "expense", Number(issueDate.slice(0, 4)));
    const row = tx
      .insert(expenses)
      .values({
        number,
        supplierName: input.supplierName ?? "",
        supplierUid: input.supplierUid ?? "",
        supplierCountry: input.supplierCountry ?? "AT",
        supplierInvoiceNumber: input.supplierInvoiceNumber ?? "",
        issueDate,
        dueDate: input.dueDate ?? null,
        paidAt: input.paidAt ?? null,
        vatTreatment,
        description: input.description ?? "",
        notes: input.notes ?? "",
      })
      .returning({ id: expenses.id })
      .get();
    writeLines(tx, row.id, input.lines ?? [], vatTreatment);
    return row.id;
  });
  return requireExpense(db, id);
}

export function updateExpense(db: DbOrTx, id: number, input: ExpenseUpdate): ExpenseWithLines {
  db.transaction((tx) => {
    const current = requireExpense(tx, id);
    const { lines, ...fields } = input;
    const treatment = fields.vatTreatment ?? current.vatTreatment;
    if (Object.keys(fields).length) {
      tx.update(expenses).set(fields).where(eq(expenses.id, id)).run();
    }
    // Totals depend on the treatment too, so rewrite them whenever either changes.
    if (lines || fields.vatTreatment) writeLines(tx, id, lines ?? current.lines, treatment);
  });
  return requireExpense(db, id);
}

export function setExpensePaid(db: DbOrTx, id: number, paidAt: string | null): ExpenseWithLines {
  requireExpense(db, id);
  db.update(expenses).set({ paidAt }).where(eq(expenses.id, id)).run();
  return requireExpense(db, id);
}

/**
 * Deletes the expense (lines cascade) and its receipt file. Its bank allocations are removed via `unmatch` first,
 * so the transactions go back to "open" instead of staying "matched" with nothing allocated.
 */
export async function deleteExpense(db: DbOrTx, id: number, dataDir = DATA_DIR): Promise<void> {
  const expense = db.transaction((tx) => {
    const row = requireExpense(tx, id);
    const matches = tx.select({ id: bankMatches.id }).from(bankMatches).where(eq(bankMatches.expenseId, id)).all();
    for (const m of matches) unmatch(tx, { matchId: m.id });
    tx.delete(expenses).where(eq(expenses.id, id)).run();
    return row;
  });
  await removeReceiptFiles(expense, dataDir);
}

// --- receipts ----------------------------------------------------------------------------------

async function removeReceiptFile(relPath: string | null, dataDir: string) {
  if (relPath) await unlink(join(dataDir, relPath)).catch(() => {});
}

/** The receipt and, for a cropped one, its original. */
async function removeReceiptFiles(e: Pick<Expense, "attachmentPath" | "attachmentOriginalPath">, dataDir: string) {
  await removeReceiptFile(e.attachmentPath, dataDir);
  if (e.attachmentOriginalPath !== e.attachmentPath) await removeReceiptFile(e.attachmentOriginalPath, dataDir);
}

/** Validates an upload; returns the file extension or throws 400. */
export function receiptExtension(file: File): string {
  const ext = RECEIPT_MIME_TYPES[file.type] ?? extFromName(file.name);
  if (!ext) throw new HTTPException(400, { message: "Nur PDF, JPG, PNG oder WebP erlaubt" });
  if (file.size > RECEIPT_MAX_BYTES) throw new HTTPException(400, { message: "Datei ist zu groß (max. 20 MB)" });
  if (file.size === 0) throw new HTTPException(400, { message: "Datei ist leer" });
  return ext;
}

/** Fallback when the browser sends no/generic MIME type. */
function extFromName(name: string): string | undefined {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "jpeg") return "jpg";
  return ext && Object.values(RECEIPT_MIME_TYPES).includes(ext) ? ext : undefined;
}

/** Date.now(), but strictly increasing within the process (two uploads in the same ms get distinct file names). */
let lastStamp = 0;
function fileStamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Stores (or replaces) the receipt of an expense. */
export async function setExpenseAttachment(
  db: DbOrTx,
  id: number,
  file: File,
  dataDir = DATA_DIR,
): Promise<ExpenseWithLines> {
  const expense = requireExpense(db, id);
  const ext = receiptExtension(file);
  const year = expense.issueDate.slice(0, 4);
  const base = (expense.number ?? `ausgabe-${id}`).replace(/[^A-Za-z0-9-]/g, "");
  const relPath = `receipts/${year}/${base}-${fileStamp()}.${ext}`;
  mkdirSync(join(dataDir, "receipts", year), { recursive: true });
  try {
    await Bun.write(join(dataDir, relPath), file);
  } catch (err) {
    await removeReceiptFile(relPath, dataDir);
    throw err;
  }
  // Re-read after the await: a concurrent upload/removal may have changed the row meanwhile. The files to drop are
  // the ones the row points to right before this update, not the ones read above (else they'd be orphaned).
  const previous = db.transaction((tx) => {
    const current = tx
      .select({ attachmentPath: expenses.attachmentPath, attachmentOriginalPath: expenses.attachmentOriginalPath })
      .from(expenses)
      .where(eq(expenses.id, id))
      .get();
    if (!current) return null;
    tx.update(expenses)
      .set({ attachmentPath: relPath, attachmentName: file.name.slice(0, 255), attachmentOriginalPath: null })
      .where(eq(expenses.id, id))
      .run();
    return current;
  });
  if (!previous) {
    await removeReceiptFile(relPath, dataDir);
    throw new HTTPException(404, { message: "Ausgabe nicht gefunden" });
  }
  await removeReceiptFiles(previous, dataDir);
  return requireExpense(db, id);
}

export async function removeExpenseAttachment(db: DbOrTx, id: number, dataDir = DATA_DIR): Promise<ExpenseWithLines> {
  const expense = db.transaction((tx) => {
    const row = requireExpense(tx, id);
    tx.update(expenses)
      .set({ attachmentPath: null, attachmentName: "", attachmentOriginalPath: null })
      .where(eq(expenses.id, id))
      .run();
    return row;
  });
  await removeReceiptFiles(expense, dataDir);
  return requireExpense(db, id);
}

// --- cropping photographed receipts (Swift helper: detect-document / crop) ------------------------

export interface ReceiptDetection {
  /** suggested corners on the original photo, or null when nothing was found */
  quad: Quad | null;
  confidence: number;
  method: "segmentation" | "rectangles" | null;
  /** size of the original as displayed (EXIF orientation applied) */
  width: number;
  height: number;
}

/** Runs a helper command and parses its JSON (tests pass a fake). */
export type ReceiptImageHelper = <T>(args: string[]) => Promise<T>;

export interface ReceiptCropOptions {
  dataDir?: string;
  helper?: ReceiptImageHelper;
}

const defaultImageHelper: ReceiptImageHelper = (args) => runHelper(args, { timeoutMs: 60_000 });

async function callImageHelper<T>(helper: ReceiptImageHelper, args: string[]): Promise<T> {
  try {
    return await helper<T>(args);
  } catch (err) {
    if (err instanceof CommandError) throw new HTTPException(422, { message: `Zuschneiden nicht möglich: ${err.message}` });
    throw err;
  }
}

/** The file crops start from: the original of a cropped receipt, else the receipt itself (photos only). */
function cropSource(e: Expense, dataDir: string): string {
  const source = e.attachmentOriginalPath ?? e.attachmentPath;
  if (!source) throw new HTTPException(422, { message: "Kein Beleg vorhanden" });
  if (!isCroppablePath(source)) {
    throw new HTTPException(422, { message: "Nur Fotos (JPG, PNG, WebP) können zugeschnitten werden" });
  }
  if (!existsSync(join(dataDir, source))) throw new HTTPException(404, { message: "Belegdatei fehlt" });
  return source;
}

/** Suggested receipt outline on the original photo (explicit user action only, never on upload). */
export async function detectReceiptQuad(
  db: DbOrTx,
  id: number,
  { dataDir = DATA_DIR, helper = defaultImageHelper }: ReceiptCropOptions = {},
): Promise<ReceiptDetection> {
  const source = cropSource(requireExpense(db, id), dataDir);
  return callImageHelper<ReceiptDetection>(helper, ["detect-document", join(dataDir, source)]);
}

/**
 * Cuts the quad out of the ORIGINAL photo and straightens it. The crop becomes attachmentPath, the original
 * is kept in attachmentOriginalPath; a previous crop is replaced (and its file deleted).
 */
export async function cropExpenseReceipt(
  db: DbOrTx,
  id: number,
  { quad, enhance = false }: { quad: Quad; enhance?: boolean },
  { dataDir = DATA_DIR, helper = defaultImageHelper }: ReceiptCropOptions = {},
): Promise<ExpenseWithLines> {
  const source = cropSource(requireExpense(db, id), dataDir);
  const png = source.toLowerCase().endsWith(".png"); // screenshots stay lossless
  const stem = basename(source).replace(/\.[^.]+$/, "");
  const relPath = `${dirname(source)}/${stem}-crop-${Date.now()}.${png ? "png" : "jpg"}`;
  const abs = join(dataDir, relPath);
  // a partial file is dropped on any failure below
  const discard = () => unlink(abs).catch(() => {});
  try {
    await callImageHelper(helper, [
      "crop",
      join(dataDir, source),
      abs,
      "--quad",
      quad.flat().join(","),
      "--format",
      png ? "png" : "jpeg",
      "--quality",
      "0.9",
      "--max-side",
      "3000",
      ...(enhance ? ["--enhance"] : []),
    ]);
  } catch (err) {
    await discard();
    throw err;
  }
  // the receipt may have been replaced while the helper ran
  const current = requireExpense(db, id);
  if ((current.attachmentOriginalPath ?? current.attachmentPath) !== source) {
    await discard();
    throw new HTTPException(409, { message: "Der Beleg wurde inzwischen geändert" });
  }
  db.update(expenses).set({ attachmentPath: relPath, attachmentOriginalPath: source }).where(eq(expenses.id, id)).run();
  if (current.attachmentPath !== source) await removeReceiptFile(current.attachmentPath, dataDir);
  return requireExpense(db, id);
}

/** Back to the original photo; the crop file is deleted. */
export async function restoreExpenseReceipt(db: DbOrTx, id: number, dataDir = DATA_DIR): Promise<ExpenseWithLines> {
  const expense = requireExpense(db, id);
  const original = expense.attachmentOriginalPath;
  if (!original) throw new HTTPException(409, { message: "Der Beleg ist nicht zugeschnitten" });
  db.update(expenses).set({ attachmentPath: original, attachmentOriginalPath: null }).where(eq(expenses.id, id)).run();
  if (expense.attachmentPath !== original) await removeReceiptFile(expense.attachmentPath, dataDir);
  return requireExpense(db, id);
}

/** A batch upload stopped after some drafts were created: `createdIds` are kept (the route sends them along). */
export class DraftsPartialError extends HTTPException {
  constructor(
    status: ConstructorParameters<typeof HTTPException>[0],
    message: string,
    readonly createdIds: number[],
  ) {
    super(status, { message });
  }
}

/**
 * Quick capture: one draft expense (no supplier, no lines, issue date today) per dropped receipt. If storing a file
 * fails, its draft is deleted again (no empty drafts left behind) and the error (DraftsPartialError) says how many
 * were created.
 */
export async function createDraftsFromFiles(db: DbOrTx, files: File[], dataDir = DATA_DIR): Promise<ExpenseWithLines[]> {
  for (const f of files) receiptExtension(f); // validate all before creating anything
  const created: ExpenseWithLines[] = [];
  for (const file of files) {
    const draft = createExpense(db, {});
    try {
      created.push(await setExpenseAttachment(db, draft.id, file, dataDir));
    } catch (err) {
      await deleteExpense(db, draft.id, dataDir).catch(() => {});
      if (!created.length) throw err;
      const reason = err instanceof HTTPException ? err.message : "Datei konnte nicht gespeichert werden";
      throw new DraftsPartialError(
        err instanceof HTTPException ? err.status : 500,
        `${created.length} von ${files.length} Belegen angelegt; „${file.name}“ und folgende nicht: ${reason}`,
        created.map((e) => e.id),
      );
    }
  }
  return created;
}

// --- suppliers ---------------------------------------------------------------------------------

/** Distinct previous suppliers (latest expense wins), most frequently used first. */
export function supplierSuggestions(db: DbOrTx, q?: string, limit = 10): SupplierSuggestion[] {
  const term = q?.trim();
  const rows = db
    .select({
      id: expenses.id,
      name: expenses.supplierName,
      uid: expenses.supplierUid,
      country: expenses.supplierCountry,
      vatTreatment: expenses.vatTreatment,
      description: expenses.description,
      issueDate: expenses.issueDate,
    })
    .from(expenses)
    .where(and(ne(expenses.supplierName, ""), term ? contains(expenses.supplierName, term) : undefined))
    .orderBy(desc(expenses.issueDate), desc(expenses.id))
    .all();

  const byName = new Map<string, SupplierSuggestion & { id: number }>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    byName.set(key, {
      id: r.id,
      name: r.name,
      uid: r.uid,
      country: r.country,
      vatTreatment: r.vatTreatment as VatTreatment,
      category: null,
      taxRateBp: null,
      deductibleBp: null,
      description: r.description,
      lastIssueDate: r.issueDate,
      count: 1,
    });
  }

  const lower = term?.toLowerCase();
  const picked = [...byName.values()]
    .sort(
      (a, b) =>
        // prefix matches first, then usage, then recency
        Number(!!lower && b.name.toLowerCase().startsWith(lower)) -
          Number(!!lower && a.name.toLowerCase().startsWith(lower)) ||
        b.count - a.count ||
        b.lastIssueDate.localeCompare(a.lastIssueDate),
    )
    .slice(0, limit);

  return picked.map(({ id, ...s }) => {
    const line = db
      .select()
      .from(expenseLines)
      .where(eq(expenseLines.expenseId, id))
      .orderBy(asc(expenseLines.position))
      .limit(1)
      .get();
    return line ? { ...s, category: line.category, taxRateBp: line.taxRateBp, deductibleBp: line.deductibleBp } : s;
  });
}
