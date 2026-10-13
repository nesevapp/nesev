import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
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
import type {
  ExpenseCreate,
  ExpenseLineInput,
  ExpenseListQuery,
  ExpenseUpdate,
} from "../../shared/schemas/expense";
import type { DbOrTx } from "../db/client";
import { type Expense, type ExpenseLine, expenseLines, expenses } from "../db/schema";
import { nextNumber } from "../lib/numbering";
import { DATA_DIR } from "../lib/paths";

// Expenses (Ausgaben / Belege). Semantics of the tables and totals: see src/shared/expenses.ts.
// Receipts live under <DATA_DIR>/receipts/<year>/ and are stored as "receipts/<year>/<file>".

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

/** Deletes the expense (lines and bank matches cascade) and its receipt file. */
export async function deleteExpense(db: DbOrTx, id: number, dataDir = DATA_DIR): Promise<void> {
  const expense = requireExpense(db, id);
  db.delete(expenses).where(eq(expenses.id, id)).run();
  await removeReceiptFile(expense.attachmentPath, dataDir);
}

// --- receipts ----------------------------------------------------------------------------------

async function removeReceiptFile(relPath: string | null, dataDir: string) {
  if (relPath) await unlink(join(dataDir, relPath)).catch(() => {});
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
  const relPath = `receipts/${year}/${base}-${Date.now()}.${ext}`;
  mkdirSync(join(dataDir, "receipts", year), { recursive: true });
  await Bun.write(join(dataDir, relPath), file);
  db.update(expenses)
    .set({ attachmentPath: relPath, attachmentName: file.name.slice(0, 255) })
    .where(eq(expenses.id, id))
    .run();
  if (expense.attachmentPath !== relPath) await removeReceiptFile(expense.attachmentPath, dataDir);
  return requireExpense(db, id);
}

export async function removeExpenseAttachment(db: DbOrTx, id: number, dataDir = DATA_DIR): Promise<ExpenseWithLines> {
  const expense = requireExpense(db, id);
  db.update(expenses).set({ attachmentPath: null, attachmentName: "" }).where(eq(expenses.id, id)).run();
  await removeReceiptFile(expense.attachmentPath, dataDir);
  return requireExpense(db, id);
}

/** Quick capture: one draft expense (no supplier, no lines, issue date today) per dropped receipt. */
export async function createDraftsFromFiles(db: DbOrTx, files: File[], dataDir = DATA_DIR): Promise<ExpenseWithLines[]> {
  for (const f of files) receiptExtension(f); // validate all before creating anything
  const created: ExpenseWithLines[] = [];
  for (const file of files) {
    const draft = createExpense(db, {});
    created.push(await setExpenseAttachment(db, draft.id, file, dataDir));
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
