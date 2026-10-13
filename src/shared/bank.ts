import { z } from "./schemas/zod";

// Bank accounts, imports and payment matching — shared by server and web.
//
// Rules:
// - Transactions store signed cents: incoming > 0, outgoing < 0. Matches (bank_matches) store positive
//   allocations; one transaction may be split across several invoices/expenses and one invoice may be
//   paid by several transactions (partial payments).
// - A transaction is "matched" once its full amount is allocated, otherwise "open" (or "ignored").
// - Invoices: open amount = gross − finalized credit notes − allocated payments. Fully covered → status
//   "paid" with paidAt = booking date of the latest covering transaction.

export const BANK_TX_STATUSES = ["open", "matched", "ignored"] as const;
export type BankTxStatus = (typeof BANK_TX_STATUSES)[number];

export const BANK_TX_STATUS_LABELS: Record<BankTxStatus, string> = {
  open: "Offen",
  matched: "Zugeordnet",
  ignored: "Ignoriert",
};

/** Auto-apply policy for matches after an import. */
export const AUTO_MATCH_MODES = ["off", "safe", "aggressive"] as const;
export type AutoMatchMode = (typeof AUTO_MATCH_MODES)[number];

export const AUTO_MATCH_MODE_LABELS: Record<AutoMatchMode, string> = {
  off: "Aus – nur Vorschläge",
  safe: "Sicher – Nummer + Betrag oder Betrag + bekannte IBAN",
  aggressive: "Großzügig – zusätzlich Betrag + Name eindeutig",
};

// ── CSV mapping ─────────────────────────────────────────────────────────────────

export const CSV_DELIMITERS = [";", ",", "\t", "|"] as const;
export const CSV_ENCODINGS = ["utf-8", "windows-1252", "utf-16le"] as const;
export const CSV_DATE_FORMATS = ["DD.MM.YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY", "DD.MM.YY"] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

const col = z.number().int().min(0).max(200).nullable();

/** How to read a CSV export. Column fields are 0-based indexes (null = not present). */
export const csvMappingSchema = z.object({
  /** preset id this mapping came from ("generic" when edited by hand) */
  preset: z.string().max(40).default("generic"),
  delimiter: z.enum(CSV_DELIMITERS),
  encoding: z.enum(CSV_ENCODINGS),
  /** lines to skip before the header / first data row */
  skipRows: z.number().int().min(0).max(50).default(0),
  hasHeader: z.boolean(),
  decimal: z.enum([",", "."]),
  dateFormat: z.enum(CSV_DATE_FORMATS),
  bookingDate: z.number().int().min(0).max(200),
  valueDate: col.default(null),
  /** signed amount; alternatively credit/debit columns */
  amount: col.default(null),
  credit: col.default(null),
  debit: col.default(null),
  /** subtracted from the amount (e.g. Revolut "Fee") */
  fee: col.default(null),
  currency: col.default(null),
  /** first non-empty of these columns (e.g. Wise "Payer Name" / "Payee Name" / "Merchant") */
  counterpartyName: z.array(z.number().int().min(0).max(200)).max(5).default([]),
  counterpartyIban: col.default(null),
  /** joined with " " */
  purpose: z.array(z.number().int().min(0).max(200)).max(10).default([]),
  reference: col.default(null),
  /** keep only rows whose value in `stateColumn` is one of `stateAccept` (e.g. Revolut COMPLETED) */
  stateColumn: col.default(null),
  stateAccept: z.array(z.string().max(40)).max(10).default([]),
  /** header row (or column count) the mapping was made for; a saved mapping is reused when it matches */
  signature: z.string().max(2000).default(""),
});
export type CsvMapping = z.infer<typeof csvMappingSchema>;
export type CsvMappingInput = z.input<typeof csvMappingSchema>;

export const bankAccountSchema = z.object({
  name: z.string().trim().min(1, "Name ist erforderlich").max(100),
  iban: z
    .string()
    .trim()
    .max(42)
    .transform((s) => normalizeIban(s)),
  bankName: z.string().trim().max(100),
  autoMatch: z.enum(AUTO_MATCH_MODES).default("safe"),
});
export type BankAccountInput = z.input<typeof bankAccountSchema>;

export const allocationSchema = z
  .object({
    documentId: z.number().int().positive().nullish(),
    expenseId: z.number().int().positive().nullish(),
    amountCents: z.number().int().positive().max(99_999_999_99),
  })
  .refine((a) => !!a.documentId !== !!a.expenseId, "Rechnung oder Ausgabe angeben");

export const matchSchema = z.object({
  allocations: z.array(allocationSchema).min(1).max(50),
});
export type MatchInput = z.infer<typeof matchSchema>;

export const transactionListQuerySchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  status: z.enum(BANK_TX_STATUSES).optional(),
  direction: z.enum(["in", "out"]).optional(),
  q: z.string().max(200).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** "at61 1904 3002 3457 3201" → "AT611904300234573201" */
export function normalizeIban(s: string | null | undefined): string {
  return (s ?? "").replace(/[\s-]/g, "").toUpperCase();
}

/** "AT611904300234573201" → "AT61 1904 3002 3457 3201" */
export function formatIban(s: string | null | undefined): string {
  return normalizeIban(s).replace(/(.{4})/g, "$1 ").trim();
}

/** Mod-97 check (ISO 13616). */
export function isValidIban(s: string): boolean {
  const iban = normalizeIban(s);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}
