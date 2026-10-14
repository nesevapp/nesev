import { and, asc, eq, max, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  afaForYear,
  type AfaYear,
  type AssetInput,
  assetSchedule,
  annualAfaCents,
  bookValueAtYearEnd,
  formatAssetNumber,
  GWG_LIMIT_CENTS,
  spreadOverMonths,
} from "../../shared/assets";
import { formatDate, todayIso } from "../../shared/dates";
import { deductibleTaxCents } from "../../shared/expenses";
import type { AssetCreate, AssetDisposal, AssetUpdate } from "../../shared/schemas/asset";
import type { DbOrTx } from "../db/client";
import { expenseLines, expenses, type FixedAsset, fixedAssets } from "../db/schema";
import { csvAmount, toCsv } from "./export";
import { getSettings } from "./settings";

// Anlagenverzeichnis (fixed_assets). Depreciation math lives in src/shared/assets.ts; this service adds
// persistence, the yearly register, the prefill from an expense's "anlagen" lines and the per-year AfA that
// the EAR (services/tax.ts) and the dashboard use instead of those expense lines.
// Asset numbers are integers shown as AV-0001: max + 1 unless given, unique but not gapless.

/** Category of expense lines that are capitalized instead of expensed. */
export const ASSET_CATEGORY = "anlagen";

export interface ExpenseRef {
  id: number;
  number: string | null;
  supplierName: string;
  issueDate: string;
}

export type AssetWithExpense = FixedAsset & { expense: ExpenseRef | null };

export interface AssetDetail extends AssetWithExpense {
  annualAfaCents: number;
  schedule: AfaYear[];
  /** cost at or below the GWG limit (could have been expensed at once) */
  gwg: boolean;
}

export interface AssetRegisterRow extends AssetWithExpense {
  /** book value at 1.1. of the year (cost if put in service that year) */
  startCents: number;
  afaCents: number;
  /** remaining book value written off on disposal in this year */
  disposalCents: number;
  /** AfA up to and including this year (incl. disposal write-off) */
  accumulatedCents: number;
  /** book value at 31.12. */
  endCents: number;
  /** disposed in this year */
  disposedThisYear: boolean;
}

export interface AssetRegister {
  year: number;
  years: number[];
  rows: AssetRegisterRow[];
  totals: { costCents: number; startCents: number; afaCents: number; disposalCents: number; endCents: number; proceedsCents: number };
  /** assets not in this year's register (put in service later or disposed earlier) */
  hiddenCount: number;
}

export function assetInput(a: Pick<FixedAsset, "costCents" | "usefulLifeYears" | "inServiceDate" | "disposalDate">): AssetInput {
  return { costCents: a.costCents, usefulLifeYears: a.usefulLifeYears, inServiceDate: a.inServiceDate, disposalDate: a.disposalDate };
}

const yearOf = (date: string) => Number(date.slice(0, 4));

function loadAssets(db: DbOrTx, where?: ReturnType<typeof eq>): AssetWithExpense[] {
  return db
    .select({
      asset: fixedAssets,
      expenseId: expenses.id,
      expenseNumber: expenses.number,
      supplierName: expenses.supplierName,
      issueDate: expenses.issueDate,
    })
    .from(fixedAssets)
    .leftJoin(expenses, eq(expenses.id, fixedAssets.expenseId))
    .where(where)
    .orderBy(asc(fixedAssets.number))
    .all()
    .map((r) => ({
      ...r.asset,
      expense:
        r.expenseId != null
          ? { id: r.expenseId, number: r.expenseNumber, supplierName: r.supplierName ?? "", issueDate: r.issueDate ?? "" }
          : null,
    }));
}

export function getAsset(db: DbOrTx, id: number): AssetWithExpense | undefined {
  return loadAssets(db, eq(fixedAssets.id, id))[0];
}

/** Like getAsset, but throws a 404 HTTPException when missing. */
export function requireAsset(db: DbOrTx, id: number): AssetWithExpense {
  const asset = getAsset(db, id);
  if (!asset) throw new HTTPException(404, { message: "Anlage nicht gefunden" });
  return asset;
}

export function getAssetDetail(db: DbOrTx, id: number): AssetDetail {
  const a = requireAsset(db, id);
  return { ...a, annualAfaCents: annualAfaCents(a), schedule: assetSchedule(assetInput(a)), gwg: a.costCents <= GWG_LIMIT_CENTS };
}

export function nextAssetNumber(db: DbOrTx): number {
  const row = db.select({ last: max(fixedAssets.number) }).from(fixedAssets).get();
  return (row?.last ?? 0) + 1;
}

function assertNumberFree(db: DbOrTx, number: number, exceptId?: number) {
  const taken = db
    .select({ id: fixedAssets.id })
    .from(fixedAssets)
    .where(and(eq(fixedAssets.number, number), exceptId ? ne(fixedAssets.id, exceptId) : undefined))
    .get();
  if (taken) throw new HTTPException(409, { message: `Anlagennummer ${formatAssetNumber(number)} ist bereits vergeben` });
}

function assertExpense(db: DbOrTx, expenseId: number | null | undefined) {
  if (expenseId == null) return;
  if (!db.select({ id: expenses.id }).from(expenses).where(eq(expenses.id, expenseId)).get())
    throw new HTTPException(404, { message: "Ausgabe nicht gefunden" });
}

function assertDates(a: { acquisitionDate: string; inServiceDate: string; disposalDate?: string | null }) {
  if (a.inServiceDate < a.acquisitionDate)
    throw new HTTPException(400, { message: "Die Inbetriebnahme kann nicht vor der Anschaffung liegen" });
  if (a.disposalDate && a.disposalDate < a.inServiceDate)
    throw new HTTPException(400, { message: "Das Ausscheiden kann nicht vor der Inbetriebnahme liegen" });
}

export function createAsset(db: DbOrTx, data: AssetCreate): AssetDetail {
  const id = db.transaction((tx) => {
    const { number, ...rest } = data;
    if (number !== undefined) assertNumberFree(tx, number);
    assertExpense(tx, rest.expenseId);
    assertDates(rest);
    return tx
      .insert(fixedAssets)
      .values({ ...rest, number: number ?? nextAssetNumber(tx) })
      .returning({ id: fixedAssets.id })
      .get().id;
  });
  return getAssetDetail(db, id);
}

export function updateAsset(db: DbOrTx, id: number, data: AssetUpdate): AssetDetail {
  db.transaction((tx) => {
    const current = requireAsset(tx, id);
    if (data.number !== undefined) assertNumberFree(tx, data.number, id);
    if (data.expenseId !== undefined) assertExpense(tx, data.expenseId);
    assertDates({ ...current, ...data });
    if (Object.keys(data).length) tx.update(fixedAssets).set({ ...data }).where(eq(fixedAssets.id, id)).run();
  });
  return getAssetDetail(db, id);
}

export function deleteAsset(db: DbOrTx, id: number): void {
  requireAsset(db, id);
  db.delete(fixedAssets).where(eq(fixedAssets.id, id)).run();
}

/** Sold or scrapped: the remaining book value is written off in the disposal year. */
export function disposeAsset(db: DbOrTx, id: number, data: AssetDisposal): AssetDetail {
  const current = requireAsset(db, id);
  assertDates({ ...current, disposalDate: data.disposalDate });
  db.update(fixedAssets).set({ ...data }).where(eq(fixedAssets.id, id)).run();
  return getAssetDetail(db, id);
}

export function undoDisposal(db: DbOrTx, id: number): AssetDetail {
  requireAsset(db, id);
  db.update(fixedAssets)
    .set({ disposalDate: null, disposalProceedsCents: null })
    .where(eq(fixedAssets.id, id))
    .run();
  return getAssetDetail(db, id);
}

// ── Register (Anlagenverzeichnis) ───────────────────────────────────────────────

/** In the register of `year`: put in service by then and not disposed before it. */
function inRegister(a: FixedAsset, year: number): boolean {
  return yearOf(a.inServiceDate) <= year && (!a.disposalDate || yearOf(a.disposalDate) >= year);
}

export function assetRegister(db: DbOrTx, year: number, today = todayIso()): AssetRegister {
  const all = loadAssets(db);
  const rows: AssetRegisterRow[] = [];
  for (const a of all) {
    if (!inRegister(a, year)) continue;
    const input = assetInput(a);
    const { afaCents, disposalCents } = afaForYear(input, year);
    const startCents = yearOf(a.inServiceDate) === year ? a.costCents : bookValueAtYearEnd(input, year - 1);
    const endCents = bookValueAtYearEnd(input, year);
    rows.push({
      ...a,
      startCents,
      afaCents,
      disposalCents,
      accumulatedCents: a.costCents - endCents,
      endCents,
      disposedThisYear: !!a.disposalDate && yearOf(a.disposalDate) === year,
    });
  }
  const sum = (f: (r: AssetRegisterRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const thisYear = yearOf(today);
  const firstYear = Math.min(thisYear, year, ...all.map((a) => yearOf(a.inServiceDate)));
  const years = Array.from({ length: Math.max(thisYear, year) - firstYear + 1 }, (_, i) => Math.max(thisYear, year) - i);
  return {
    year,
    years,
    rows,
    totals: {
      costCents: sum((r) => r.costCents),
      startCents: sum((r) => r.startCents),
      afaCents: sum((r) => r.afaCents),
      disposalCents: sum((r) => r.disposalCents),
      endCents: sum((r) => r.endCents),
      proceedsCents: sum((r) => (r.disposedThisYear ? (r.disposalProceedsCents ?? 0) : 0)),
    },
    hiddenCount: all.length - rows.length,
  };
}

export function assetsCsv(r: AssetRegister): string {
  const rows = r.rows.map((a) => [
    formatAssetNumber(a.number),
    a.name,
    formatDate(a.acquisitionDate),
    formatDate(a.inServiceDate),
    csvAmount(a.costCents),
    String(a.usefulLifeYears),
    csvAmount(a.startCents),
    csvAmount(a.afaCents),
    csvAmount(a.disposalCents),
    csvAmount(a.accumulatedCents),
    csvAmount(a.endCents),
    a.disposalDate ? formatDate(a.disposalDate) : "",
    a.disposedThisYear && a.disposalProceedsCents != null ? csvAmount(a.disposalProceedsCents) : "",
    a.expense?.number ?? "",
  ]);
  const t = r.totals;
  rows.push(["Summe", "", "", "", csvAmount(t.costCents), "", csvAmount(t.startCents), csvAmount(t.afaCents), csvAmount(t.disposalCents), "", csvAmount(t.endCents), "", csvAmount(t.proceedsCents), ""]);
  return toCsv(
    [
      "Nr.",
      "Bezeichnung",
      "Anschaffung",
      "Inbetriebnahme",
      "Anschaffungskosten",
      "Nutzungsdauer (Jahre)",
      `Buchwert 1.1.${r.year}`,
      `AfA ${r.year}`,
      "Restbuchwert-Abgang",
      "AfA kumuliert",
      `Buchwert 31.12.${r.year}`,
      "Ausgeschieden am",
      "Erlös",
      "Ausgabe",
    ],
    rows,
  );
}

export const assetFileNames = { register: (year: number) => `anlagenverzeichnis-${year}.csv` };

// ── Links to expenses ───────────────────────────────────────────────────────────

export interface AssetLink {
  id: number;
  number: number;
  name: string;
  expenseId: number;
  costCents: number;
}

/** Assets bought with an expense (for the hints in the expense editor and list). */
export function assetLinks(db: DbOrTx): AssetLink[] {
  return db
    .select({ id: fixedAssets.id, number: fixedAssets.number, name: fixedAssets.name, expenseId: fixedAssets.expenseId, costCents: fixedAssets.costCents })
    .from(fixedAssets)
    .where(sql`${fixedAssets.expenseId} is not null`)
    .orderBy(asc(fixedAssets.number))
    .all() as AssetLink[];
}

export interface AssetPrefill {
  expenseId: number;
  expenseNumber: string | null;
  supplierName: string;
  name: string;
  acquisitionDate: string;
  inServiceDate: string;
  /** cost of the "anlagen" lines not yet covered by linked assets */
  costCents: number;
  /** cost of all "anlagen" lines: net + non-deductible tax (Kleinunternehmer: + all tax) */
  totalCostCents: number;
  /** cost of assets already linked to this expense */
  linkedCostCents: number;
}

/** Prefill for "Im Anlagenverzeichnis anlegen" from an expense's "anlagen" lines. */
export function assetPrefillFromExpense(db: DbOrTx, expenseId: number): AssetPrefill {
  const e = db.select().from(expenses).where(eq(expenses.id, expenseId)).get();
  if (!e) throw new HTTPException(404, { message: "Ausgabe nicht gefunden" });
  const lines = db
    .select()
    .from(expenseLines)
    .where(and(eq(expenseLines.expenseId, expenseId), eq(expenseLines.category, ASSET_CATEGORY)))
    .orderBy(asc(expenseLines.position))
    .all();
  if (lines.length === 0) throw new HTTPException(400, { message: "Die Ausgabe hat keine Position der Kategorie „Anlagegüter“" });
  const smallBusiness = getSettings(db).smallBusiness;
  const noTax = e.vatTreatment === "none";
  const totalCostCents = lines.reduce((s, l) => {
    if (noTax) return s + l.netCents;
    return s + l.netCents + l.taxCents - (smallBusiness ? 0 : deductibleTaxCents(l));
  }, 0);
  const linkedCostCents = db
    .select({ cents: sql<number>`coalesce(sum(${fixedAssets.costCents}), 0)` })
    .from(fixedAssets)
    .where(eq(fixedAssets.expenseId, expenseId))
    .get()!.cents;
  const descriptions = lines.map((l) => l.description.trim()).filter(Boolean);
  return {
    expenseId,
    expenseNumber: e.number,
    supplierName: e.supplierName,
    name: descriptions.join(", ") || e.description.trim() || e.supplierName,
    acquisitionDate: e.issueDate,
    inServiceDate: e.issueDate,
    costCents: Math.max(0, totalCostCents - linkedCostCents),
    totalCostCents,
    linkedCostCents,
  };
}

// ── AfA for reports ─────────────────────────────────────────────────────────────

export interface AfaEntry {
  id: number;
  number: number;
  name: string;
  afaCents: number;
  disposalCents: number;
  disposalDate: string | null;
}

/** Assets with AfA or a disposal write-off in `year`. */
export function afaEntries(db: DbOrTx, year: number): AfaEntry[] {
  const out: AfaEntry[] = [];
  for (const a of db.select().from(fixedAssets).orderBy(asc(fixedAssets.number)).all()) {
    const { afaCents, disposalCents } = afaForYear(assetInput(a), year);
    if (afaCents || disposalCents) out.push({ id: a.id, number: a.number, name: a.name, afaCents, disposalCents, disposalDate: a.disposalDate });
  }
  return out;
}

/**
 * AfA of `year` per month (index 0 = January): the annual AfA spread evenly over all 12 months (remainder in
 * December), the disposal write-off in the month of disposal.
 */
export function monthlyAfa(entries: readonly AfaEntry[]): number[] {
  const out = spreadOverMonths(entries.reduce((s, e) => s + e.afaCents, 0));
  for (const e of entries) if (e.disposalCents && e.disposalDate) out[Number(e.disposalDate.slice(5, 7)) - 1]! += e.disposalCents;
  return out;
}

export interface UnlinkedAssetExpense {
  id: number;
  number: string | null;
  supplierName: string;
  netCents: number;
}

/** Expenses issued in [from, to] with "anlagen" lines but no linked asset (their AfA is missing). */
export function expensesWithoutAsset(db: DbOrTx, from: string, to: string): UnlinkedAssetExpense[] {
  return db
    .select({
      id: expenses.id,
      number: expenses.number,
      supplierName: expenses.supplierName,
      netCents: sql<number>`sum(${expenseLines.netCents})`,
    })
    .from(expenses)
    .innerJoin(expenseLines, and(eq(expenseLines.expenseId, expenses.id), eq(expenseLines.category, ASSET_CATEGORY)))
    .where(
      and(
        sql`${expenses.issueDate} >= ${from} and ${expenses.issueDate} <= ${to}`,
        sql`not exists (select 1 from fixed_assets fa where fa.expense_id = ${expenses.id})`,
      ),
    )
    .groupBy(expenses.id)
    .orderBy(asc(expenses.issueDate), asc(expenses.id))
    .all();
}
