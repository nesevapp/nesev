import { asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { todayIso } from "../../shared/dates";
import type { TaxStatusInput } from "../../shared/schemas/tax-status";
import type { VatPeriod } from "../../shared/tax-report";
import {
  DEFAULT_TAX_STATUS,
  TAX_STATUS_BEGINNING,
  type TaxStatus,
  type TaxStatusPeriod,
  TaxStatusTimeline,
  taxStatusProblems,
} from "../../shared/tax-status";
import type { DbOrTx } from "../db/client";
import { settings, type TaxStatusPeriodRow, taxStatusPeriods } from "../db/schema";

// Steuerstatus history (Kleinunternehmer, Soll/Ist) with valid-from dates; rules and reference dates in
// src/shared/tax-status.ts. Every computation loads the history once (loadTaxStatus) and asks it per date.

const unprocessable = (message: string) => new HTTPException(422, { message });

function toPeriod(r: TaxStatusPeriodRow): TaxStatusPeriod {
  return { id: r.id, validFrom: r.validFrom, smallBusiness: r.smallBusiness, vatBasis: r.vatBasis, note: r.note };
}

/** All entries, oldest first. Creates the first entry ("von Beginn an", defaults) if the table is empty. */
export function listTaxStatusPeriods(db: DbOrTx): TaxStatusPeriod[] {
  const rows = db.select().from(taxStatusPeriods).orderBy(asc(taxStatusPeriods.validFrom)).all();
  if (rows.length) return rows.map(toPeriod);
  // the migration inserts the first entry; this only covers a table emptied by hand
  const row = db.insert(taxStatusPeriods).values({ validFrom: TAX_STATUS_BEGINNING, ...DEFAULT_TAX_STATUS }).returning().get();
  return [toPeriod(row)];
}

/** The history as a lookup, loaded once (use it for whole reports instead of taxStatusAt per item). */
export function loadTaxStatus(db: DbOrTx): TaxStatusTimeline {
  return new TaxStatusTimeline(listTaxStatusPeriods(db));
}

/** Status valid on `date` (default today). */
export function taxStatusAt(db: DbOrTx, date: string = todayIso()): TaxStatus {
  return loadTaxStatus(db).at(date);
}

function vatPeriodOf(db: DbOrTx): VatPeriod {
  return db.select({ vatPeriod: settings.vatPeriod }).from(settings).where(eq(settings.id, 1)).get()?.vatPeriod ?? "quarterly";
}

function check(db: DbOrTx, next: Pick<TaxStatusPeriod, "validFrom" | "vatBasis">[]) {
  const problems = taxStatusProblems(next, vatPeriodOf(db));
  if (problems.length) throw unprocessable(problems.join(" "));
}

function requirePeriod(db: DbOrTx, id: number): TaxStatusPeriod {
  const row = db.select().from(taxStatusPeriods).where(eq(taxStatusPeriods.id, id)).get();
  if (!row) throw new HTTPException(404, { message: "Steuerstatus nicht gefunden" });
  return toPeriod(row);
}

/** New entry valid from `validFrom` (a real date after the first entry). Returns the whole history. */
export function createTaxStatusPeriod(db: DbOrTx, input: TaxStatusInput): TaxStatusPeriod[] {
  return db.transaction((tx) => {
    const list = listTaxStatusPeriods(tx);
    if (input.validFrom <= TAX_STATUS_BEGINNING) throw unprocessable("Bitte ein Datum angeben, ab dem der neue Steuerstatus gilt.");
    check(tx, [...list, input]);
    tx.insert(taxStatusPeriods).values(input).run();
    return listTaxStatusPeriods(tx);
  });
}

/** Change an entry. The first entry keeps "von Beginn an"; the others can't be moved there. */
export function updateTaxStatusPeriod(db: DbOrTx, id: number, input: TaxStatusInput): TaxStatusPeriod[] {
  return db.transaction((tx) => {
    const current = requirePeriod(tx, id);
    const isFirst = current.validFrom === TAX_STATUS_BEGINNING;
    const validFrom = isFirst ? TAX_STATUS_BEGINNING : input.validFrom;
    if (!isFirst && validFrom <= TAX_STATUS_BEGINNING) throw unprocessable("Bitte ein Datum angeben, ab dem der Steuerstatus gilt.");
    const list = listTaxStatusPeriods(tx).map((p) => (p.id === id ? { ...p, ...input, validFrom } : p));
    check(tx, list);
    tx.update(taxStatusPeriods).set({ ...input, validFrom }).where(eq(taxStatusPeriods.id, id)).run();
    return listTaxStatusPeriods(tx);
  });
}

/** Delete an entry (not the first one: it covers every date before the others). */
export function deleteTaxStatusPeriod(db: DbOrTx, id: number): TaxStatusPeriod[] {
  return db.transaction((tx) => {
    const current = requirePeriod(tx, id);
    if (current.validFrom === TAX_STATUS_BEGINNING) {
      throw unprocessable("Der erste Steuerstatus gilt von Beginn an und kann nur geändert, nicht gelöscht werden.");
    }
    check(tx, listTaxStatusPeriods(tx).filter((p) => p.id !== id));
    tx.delete(taxStatusPeriods).where(eq(taxStatusPeriods.id, id)).run();
    return listTaxStatusPeriods(tx);
  });
}

/**
 * Set the status valid from `validFrom` (default: from the beginning), creating or updating that entry; fields not
 * given are taken from the status valid on that date. For seeds and tests.
 */
export function setTaxStatus(db: DbOrTx, patch: Partial<TaxStatus> & { note?: string }, validFrom: string = TAX_STATUS_BEGINNING): TaxStatusPeriod[] {
  const list = listTaxStatusPeriods(db);
  const existing = list.find((p) => p.validFrom === validFrom);
  const base = new TaxStatusTimeline(list).at(validFrom);
  const input = { validFrom, smallBusiness: patch.smallBusiness ?? base.smallBusiness, vatBasis: patch.vatBasis ?? base.vatBasis, note: patch.note ?? existing?.note ?? "" };
  return existing ? updateTaxStatusPeriod(db, existing.id, input) : createTaxStatusPeriod(db, input);
}
