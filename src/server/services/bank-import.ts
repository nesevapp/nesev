import { and, eq, inArray, notExists } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { CsvMapping } from "../../shared/bank";
import type { DbOrTx } from "../db/client";
import { bankAccounts, type BankImport, bankImports, bankMatches, bankTransactions } from "../db/schema";
import { BankParseError, type CsvInfo, importHashes, type ParsedTransaction, parseBankFile } from "../lib/bank-parsers";
import { requireAccount, savedCsvMapping } from "./bank";
import { autoMatch } from "./bank-matching";

// Bank file import: parse → preview (with duplicate flags) → commit (insert new rows, remember the CSV
// mapping, auto-match). Undo deletes the import's transactions that have no allocations.

const PREVIEW_ROWS = 500;

export type PreviewRowStatus = "new" | "duplicate" | "foreign_currency" | "zero";

export interface ImportPreview {
  format: string;
  fileName: string;
  /** IBAN stated in the file differs from the account's IBAN */
  fileIban: string | null;
  ibanMismatch: boolean;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  warnings: string[];
  errors: { line: number; message: string }[];
  csv: CsvInfo | null;
  counts: { total: number; new: number; duplicate: number; skipped: number; errors: number };
  periodFrom: string | null;
  periodTo: string | null;
  /** sums over the new rows */
  inCents: number;
  outCents: number;
  rows: (ParsedTransaction & { status: PreviewRowStatus })[];
}

interface Analysis {
  preview: ImportPreview;
  toInsert: (ParsedTransaction & { importHash: string })[];
}

export interface ImportOptions {
  /** explicit CSV mapping from the mapping dialog */
  mapping?: CsvMapping | null;
  /** force a CSV preset */
  preset?: string | null;
}

function parse(db: DbOrTx, accountId: number, bytes: Uint8Array, opts: ImportOptions) {
  const account = requireAccount(db, accountId);
  try {
    const parsed = parseBankFile(bytes, { ...opts, savedMapping: savedCsvMapping(account), ownIban: account.iban });
    return { account, parsed };
  } catch (err) {
    if (err instanceof BankParseError) throw new HTTPException(422, { message: err.message });
    throw err;
  }
}

function analyze(db: DbOrTx, accountId: number, bytes: Uint8Array, fileName: string, opts: ImportOptions): Analysis {
  const { account, parsed } = parse(db, accountId, bytes, opts);
  const hashes = importHashes(parsed.transactions);
  const existing = new Set<string>();
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    for (const r of db
      .select({ h: bankTransactions.importHash })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.accountId, accountId), inArray(bankTransactions.importHash, chunk)))
      .all()) {
      existing.add(r.h);
    }
  }

  const rows = parsed.transactions.map((t, i) => {
    const status: PreviewRowStatus =
      t.amountCents === 0 ? "zero" : t.currency !== "EUR" ? "foreign_currency" : existing.has(hashes[i]!) ? "duplicate" : "new";
    return { ...t, status };
  });
  const toInsert = rows.flatMap((r, i) => (r.status === "new" ? [{ ...r, importHash: hashes[i]! }] : []));
  const dates = parsed.transactions.map((t) => t.bookingDate).sort();
  const warnings = [...parsed.warnings];
  const foreign = rows.filter((r) => r.status === "foreign_currency").length;
  if (foreign) warnings.push(`${foreign} Buchung(en) in Fremdwährung werden nicht importiert.`);
  if (parsed.csv?.filtered) warnings.push(`${parsed.csv.filtered} nicht abgeschlossene Buchung(en) übersprungen.`);
  const fileIban = parsed.accountIban;
  const ibanMismatch = !!fileIban && !!account.iban && fileIban !== account.iban;
  if (ibanMismatch) warnings.push(`Die Datei gehört zum Konto ${fileIban}, nicht zu ${account.iban}.`);

  return {
    toInsert,
    preview: {
      format: parsed.format,
      fileName,
      fileIban,
      ibanMismatch,
      openingBalanceCents: parsed.openingBalanceCents,
      closingBalanceCents: parsed.closingBalanceCents,
      warnings,
      errors: parsed.errors,
      csv: parsed.csv,
      counts: {
        total: rows.length,
        new: toInsert.length,
        duplicate: rows.filter((r) => r.status === "duplicate").length,
        skipped: rows.filter((r) => r.status === "zero" || r.status === "foreign_currency").length,
        errors: parsed.errors.length,
      },
      periodFrom: dates[0] ?? null,
      periodTo: dates.at(-1) ?? null,
      inCents: toInsert.reduce((s, t) => s + Math.max(0, t.amountCents), 0),
      outCents: toInsert.reduce((s, t) => s + Math.min(0, t.amountCents), 0),
      rows: rows.slice(0, PREVIEW_ROWS),
    },
  };
}

export function previewImport(db: DbOrTx, accountId: number, bytes: Uint8Array, fileName: string, opts: ImportOptions = {}): ImportPreview {
  return analyze(db, accountId, bytes, fileName, opts).preview;
}

export interface ImportResult {
  import: BankImport | null;
  importedCount: number;
  skippedCount: number;
  autoMatched: number;
}

export function commitImport(db: DbOrTx, accountId: number, bytes: Uint8Array, fileName: string, opts: ImportOptions = {}): ImportResult {
  const { imp, ids, skipped } = db.transaction((tx) => {
    const { preview, toInsert } = analyze(tx, accountId, bytes, fileName, opts);
    if (preview.counts.total === 0) throw new HTTPException(422, { message: "Die Datei enthält keine Buchungen" });
    if (preview.csv) {
      tx.update(bankAccounts).set({ csvMapping: preview.csv.mapping }).where(eq(bankAccounts.id, accountId)).run();
    }
    const skipped = preview.counts.duplicate + preview.counts.skipped;
    if (toInsert.length === 0) return { imp: null, ids: [] as number[], skipped };
    const imp = tx
      .insert(bankImports)
      .values({
        accountId,
        fileName,
        format: preview.format,
        importedCount: toInsert.length,
        skippedCount: skipped,
      })
      .returning()
      .get();
    const ids: number[] = [];
    for (const t of toInsert) {
      ids.push(
        tx
          .insert(bankTransactions)
          .values({ ...t, accountId, importId: imp.id, status: "open" })
          .returning({ id: bankTransactions.id })
          .get().id,
      );
    }
    return { imp, ids, skipped };
  });
  const account = requireAccount(db, accountId);
  const autoMatched = autoMatch(db, { mode: account.autoMatch, transactionIds: ids });
  return {
    import: imp,
    importedCount: ids.length,
    skippedCount: skipped,
    autoMatched,
  };
}

/** Undo: delete the import's transactions without allocations; allocated ones are kept. */
export function undoImport(db: DbOrTx, importId: number): { deleted: number; kept: number } {
  return db.transaction((tx) => {
    const imp = tx.select().from(bankImports).where(eq(bankImports.id, importId)).get();
    if (!imp) throw new HTTPException(404, { message: "Import nicht gefunden" });
    const unmatched = and(
      eq(bankTransactions.importId, importId),
      notExists(tx.select({ one: bankMatches.id }).from(bankMatches).where(eq(bankMatches.transactionId, bankTransactions.id))),
    );
    const deleted = tx.delete(bankTransactions).where(unmatched).returning({ id: bankTransactions.id }).all().length;
    const kept = tx.select({ id: bankTransactions.id }).from(bankTransactions).where(eq(bankTransactions.importId, importId)).all().length;
    if (kept === 0) tx.delete(bankImports).where(eq(bankImports.id, importId)).run();
    return { deleted, kept };
  });
}
