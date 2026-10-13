import { createHash } from "node:crypto";
import type { CsvMapping } from "../../../shared/bank";
import { looksLikeCamt, parseCamt } from "./camt";
import { type CsvRowError, decode, detectDelimiter, detectEncoding, parseCsvRows, splitCsv } from "./csv";
import { looksLikeGeorgeJson, parseGeorgeJson } from "./george-json";
import { CSV_PRESETS, detectPreset, guessMapping, signatureOf } from "./presets";
import { BankParseError, type ParsedTransaction, type ParseResult } from "./types";

export { BankParseError, CSV_PRESETS };
export type { ParsedTransaction, ParseResult };

export interface CsvInfo {
  mapping: CsvMapping;
  /** header cells, or "Spalte 1".. for header-less files */
  columns: string[];
  /** first data rows, raw cells */
  sample: string[][];
  /** preset that recognized the file (null = generic guess or saved/given mapping) */
  detectedPreset: string | null;
  usedSavedMapping: boolean;
  /** rows dropped by the state filter (e.g. Revolut pending/reverted) */
  filtered: number;
}

export interface ParsedFile extends ParseResult {
  errors: CsvRowError[];
  csv: CsvInfo | null;
}

export interface ParseOptions {
  /** explicit mapping from the mapping dialog (CSV only) */
  mapping?: CsvMapping | null;
  /** mapping remembered for the account; used when its signature matches the file */
  savedMapping?: CsvMapping | null;
  /** force a CSV preset ("generic" = column guess) instead of auto-detection */
  preset?: string | null;
  /** the account's own IBAN (ignored when searching IBANs in purpose texts) */
  ownIban?: string;
}

/** Detect the format (camt XML, George JSON, CSV) and parse. Throws BankParseError for unreadable files. */
export function parseBankFile(bytes: Uint8Array, opts: ParseOptions = {}): ParsedFile {
  if (bytes.length === 0) throw new BankParseError("Die Datei ist leer");
  const encoding = opts.mapping?.encoding ?? detectEncoding(bytes);
  const text = decode(bytes, encoding);
  if (looksLikeCamt(text)) return { ...parseCamt(text), errors: [], csv: null };
  if (looksLikeGeorgeJson(text)) return { ...parseGeorgeJson(text), errors: [], csv: null };
  if (/^\s*</.test(text)) throw new BankParseError("XML-Datei erkannt, aber kein camt.053-Kontoauszug");
  return parseCsv(text, encoding, opts);
}

function parseCsv(text: string, encoding: CsvMapping["encoding"], opts: ParseOptions): ParsedFile {
  let mapping: CsvMapping;
  let detectedPreset: string | null = null;
  let usedSavedMapping = false;
  const warnings: string[] = [];
  if (opts.mapping) {
    mapping = opts.mapping;
  } else {
    const delimiter = detectDelimiter(text);
    const rows = splitCsv(text, delimiter);
    const saved = opts.savedMapping;
    if (opts.preset) {
      const preset = opts.preset === "generic" ? null : detectPreset(rows, delimiter, opts.preset);
      detectedPreset = preset?.preset ?? null;
      mapping = { ...(preset ?? guessMapping(rows, delimiter)), encoding };
      if (!preset && opts.preset !== "generic") warnings.push("Die gewählte Vorlage passt nicht zu dieser Datei.");
    } else if (saved && saved.delimiter === delimiter && saved.signature === signatureOf(rows, saved.hasHeader, saved.skipRows)) {
      mapping = { ...saved, encoding };
      usedSavedMapping = true;
    } else {
      const preset = detectPreset(rows, delimiter);
      detectedPreset = preset?.preset ?? null;
      mapping = { ...(preset ?? guessMapping(rows, delimiter)), encoding };
    }
  }
  const rows = splitCsv(text, mapping.delimiter);
  if (rows.length === 0) throw new BankParseError("Die CSV-Datei enthält keine Zeilen");
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length));
  const header = mapping.hasHeader ? rows[mapping.skipRows] : undefined;
  const columns = Array.from({ length: width }, (_, i) => header?.[i] || `Spalte ${i + 1}`);
  const { transactions, errors, filtered } = parseCsvRows(rows, mapping, opts.ownIban);
  return {
    format: "csv",
    transactions,
    accountIban: null,
    openingBalanceCents: null,
    closingBalanceCents: null,
    warnings,
    errors,
    csv: {
      mapping: { ...mapping, signature: signatureOf(rows, mapping.hasHeader, mapping.skipRows) },
      columns,
      sample: rows.slice(mapping.skipRows + (mapping.hasHeader ? 1 : 0), mapping.skipRows + (mapping.hasHeader ? 1 : 0) + 8),
      detectedPreset,
      usedSavedMapping,
      filtered,
    },
  };
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Stable dedupe keys: hash of date + amount + counterparty + purpose + reference, plus an occurrence
 * counter so identical rows on the same day (two equal card payments) stay distinct. Overlapping imports
 * of the same export produce the same keys and are skipped.
 */
export function importHashes(txs: ParsedTransaction[]): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const base = [t.bookingDate, t.amountCents, normText(t.counterpartyName), normText(t.purpose), normText(t.reference)].join("|");
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return createHash("sha256").update(`${base}#${n}`).digest("hex").slice(0, 32);
  });
}
