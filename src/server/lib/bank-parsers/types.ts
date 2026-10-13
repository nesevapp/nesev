/** One booked line from a bank file, normalized. Amounts are signed cents (incoming > 0). */
export interface ParsedTransaction {
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  counterpartyName: string;
  counterpartyIban: string;
  purpose: string;
  reference: string;
}

export type BankFileFormat = "camt053" | "csv" | "george-json";

export interface ParseResult {
  format: BankFileFormat;
  transactions: ParsedTransaction[];
  /** account IBAN stated in the file (camt / George JSON), if any */
  accountIban: string | null;
  /** statement balances in cents (camt OPBD/CLBD) */
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  warnings: string[];
}

export class BankParseError extends Error {}

/** Collapse whitespace; bank exports love padding and line breaks inside fields. */
export function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}
