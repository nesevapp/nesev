import {
  CSV_DELIMITERS,
  type CsvDateFormat,
  type CsvMapping,
  isValidIban,
  normalizeIban,
} from "../../../shared/bank";
import { BankParseError, clean, type ParsedTransaction } from "./types";

// Generic CSV reading: decoding, splitting (RFC 4180 quotes), and turning rows into transactions via a
// CsvMapping. Bank-specific presets live in ./presets.

export type CsvEncoding = CsvMapping["encoding"];

/** BOM → that encoding; valid UTF-8 → utf-8; otherwise Windows-1252 (typical for ELBA/BAWAG exports). */
export function detectEncoding(bytes: Uint8Array): CsvEncoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

export function decode(bytes: Uint8Array, encoding: CsvEncoding): string {
  return new TextDecoder(encoding).decode(bytes).replace(/^﻿/, "");
}

/** Split CSV text into rows of cells. Handles quoted fields with delimiters, "" escapes and newlines. */
export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else cell += ch;
    i++;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

/** Delimiter that yields the most consistent column count (> 1) over the first lines. */
export function detectDelimiter(text: string): CsvMapping["delimiter"] {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20).join("\n");
  let best: { d: CsvMapping["delimiter"]; score: number } = { d: ";", score: -1 };
  for (const d of CSV_DELIMITERS) {
    const counts = splitCsv(sample, d).map((r) => r.length);
    if (counts.length === 0) continue;
    const mode = [...counts].sort((a, b) => counts.filter((c) => c === b).length - counts.filter((c) => c === a).length)[0]!;
    if (mode < 2) continue;
    const share = counts.filter((c) => c === mode).length / counts.length;
    const score = share * 100 + Math.min(mode, 30);
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

const DATE_PATTERNS: Record<CsvDateFormat, RegExp> = {
  "DD.MM.YYYY": /^(\d{1,2})\.(\d{1,2})\.(\d{4})/,
  "DD.MM.YY": /^(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\d)/,
  "YYYY-MM-DD": /^(\d{4})-(\d{1,2})-(\d{1,2})/,
  "DD/MM/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})/,
  "MM/DD/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})/,
  "DD-MM-YYYY": /^(\d{1,2})-(\d{1,2})-(\d{4})/,
};

/** Cell → "YYYY-MM-DD" (time suffixes are ignored); null if it doesn't fit the format. */
export function parseDate(cell: string, format: CsvDateFormat): string | null {
  const m = DATE_PATTERNS[format].exec(cell.trim());
  if (!m) return null;
  let [y, mo, d] =
    format === "YYYY-MM-DD"
      ? [m[1]!, m[2]!, m[3]!]
      : format === "MM/DD/YYYY"
        ? [m[3]!, m[1]!, m[2]!]
        : [m[3]!, m[2]!, m[1]!];
  if (y.length === 2) y = `20${y}`;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** First date format that parses every given cell. */
export function detectDateFormat(cells: string[]): CsvDateFormat | null {
  const filled = cells.filter((c) => c.trim());
  if (filled.length === 0) return null;
  const order: CsvDateFormat[] = ["DD.MM.YYYY", "YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YY"];
  return order.find((f) => filled.every((c) => parseDate(c, f) !== null)) ?? null;
}

/**
 * "1.234,56" / "-1234.56" / "1 234,56 €" / "12,50-" / "(12.50)" → cents. `decimal` decides which separator
 * is the decimal point; the other one is a thousands separator. null if not a number.
 */
export function parseAmount(cell: string, decimal: "," | "."): number | null {
  let s = cell.trim().replace(/[\s  '€$£]|EUR|CHF|USD/g, "").replace(/−/g, "-");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    sign = -sign;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  const thousands = decimal === "," ? "." : ",";
  s = s.split(thousands).join("");
  if (decimal === ",") s = s.replace(",", ".");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100) || 0;
}

/** Decimal separator guess from amount-like cells: "1.234,56" / "12,5" → ","; "12.50" → ".". */
export function detectDecimal(cells: string[]): "," | "." {
  let comma = 0;
  let dot = 0;
  for (const c of cells) {
    const sep = /([.,])\d{1,2}-?$/.exec(c.trim().replace(/\s*(€|EUR)$/, ""))?.[1];
    if (sep === ",") comma++;
    else if (sep === ".") dot++;
  }
  return comma >= dot && comma > 0 ? "," : dot > 0 ? "." : ",";
}

const IBAN_IN_TEXT = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/g;

/** First valid IBAN mentioned in a text that isn't `own`. */
export function findIban(text: string, own = ""): string {
  for (const m of text.toUpperCase().matchAll(IBAN_IN_TEXT)) {
    const iban = normalizeIban(m[1]);
    if (iban !== own && isValidIban(iban)) return iban;
  }
  return "";
}

export interface CsvRowError {
  line: number;
  message: string;
}

/** Data rows (after skipRows and header) of an already split file. */
export function dataRows(rows: string[][], mapping: Pick<CsvMapping, "skipRows" | "hasHeader">): string[][] {
  return rows.slice(mapping.skipRows + (mapping.hasHeader ? 1 : 0));
}

export function parseCsvRows(
  rows: string[][],
  mapping: CsvMapping,
  ownIban = "",
): { transactions: ParsedTransaction[]; errors: CsvRowError[]; filtered: number } {
  const transactions: ParsedTransaction[] = [];
  const errors: CsvRowError[] = [];
  let filtered = 0;
  const firstLine = mapping.skipRows + (mapping.hasHeader ? 1 : 0) + 1;
  const at = (row: string[], idx: number | null) => (idx === null ? "" : (row[idx] ?? ""));
  const amountOf = (row: string[]): number | null => {
    if (mapping.amount !== null) return parseAmount(at(row, mapping.amount), mapping.decimal);
    const credit = parseAmount(at(row, mapping.credit), mapping.decimal);
    const debit = parseAmount(at(row, mapping.debit), mapping.decimal);
    if (credit === null && debit === null) return null;
    return Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
  };

  dataRows(rows, mapping).forEach((row, i) => {
    const line = firstLine + i;
    if (mapping.stateColumn !== null && mapping.stateAccept.length > 0) {
      const state = at(row, mapping.stateColumn).toUpperCase();
      if (!mapping.stateAccept.some((s) => s.toUpperCase() === state)) {
        filtered++;
        return;
      }
    }
    const bookingDate = parseDate(at(row, mapping.bookingDate), mapping.dateFormat);
    if (!bookingDate) {
      errors.push({ line, message: `Datum „${at(row, mapping.bookingDate)}" nicht lesbar` });
      return;
    }
    let amountCents = amountOf(row);
    if (amountCents === null) {
      errors.push({ line, message: "Betrag nicht lesbar" });
      return;
    }
    if (mapping.fee !== null) amountCents -= Math.abs(parseAmount(at(row, mapping.fee), mapping.decimal) ?? 0);
    const purpose = clean(mapping.purpose.map((c) => at(row, c)).filter(Boolean).join(" "));
    const name = mapping.counterpartyName.map((c) => clean(at(row, c))).find(Boolean) ?? "";
    const ibanCell = normalizeIban(at(row, mapping.counterpartyIban));
    transactions.push({
      bookingDate,
      valueDate: mapping.valueDate === null ? null : parseDate(at(row, mapping.valueDate), mapping.dateFormat),
      amountCents,
      currency: clean(at(row, mapping.currency)).toUpperCase() || "EUR",
      counterpartyName: name,
      counterpartyIban: ibanCell || (mapping.counterpartyIban === null ? findIban(purpose, ownIban) : ""),
      purpose,
      reference: clean(at(row, mapping.reference)),
    });
  });
  return { transactions, errors, filtered };
}

export { BankParseError };
