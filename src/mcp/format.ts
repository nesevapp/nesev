import { z } from "zod";
import { DOCUMENT_STATUS_LABELS, DOCUMENT_TYPE_LABELS, OVERDUE_LABEL, type DocumentStatus, type DocumentType } from "../shared/documents";
import { formatBp, formatCents, formatQuantity, parseMoneyToCents, QTY_SCALE, roundHalfAwayFromZero } from "../shared/money";

// Formatting for model-facing output and parsing of model input. Amounts go out as formatted euros plus the raw
// cents (`Money`), come in as euro numbers or decimal strings (`euroAmount`). Dates are always "YYYY-MM-DD".

// ── money ───────────────────────────────────────────────────────────────────────

export const Money = z.object({
  cents: z.number().int().describe("integer euro cents"),
  formatted: z.string().describe('formatted euros, e.g. "€ 1.234,56"'),
});
export type Money = z.infer<typeof Money>;

export function money(cents: number): Money {
  return { cents, formatted: formatCents(cents) };
}

export const eur = formatCents;

/**
 * Euro amount from the model → cents. Numbers are euros (12.5 → 1250); strings accept German and English
 * decimals ("1.234,56", "1234.56", "1,234.56", "€ 12,50"). Returns null for anything unparsable.
 */
export function eurosToCents(input: number | string): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? roundHalfAwayFromZero(input * 100) : null;
  // English grouping ("1,234.56"): a comma before the last dot is a thousands separator
  const lastComma = input.lastIndexOf(",");
  if (lastComma >= 0 && input.lastIndexOf(".") > lastComma) return parseMoneyToCents(input.replace(/,/g, ""));
  return parseMoneyToCents(input);
}

/** Zod schema for euro input (number or decimal string), transformed to integer cents. */
export const euroAmount = z
  .union([z.number(), z.string()])
  .describe('euro amount: number (1234.56) or decimal string ("1.234,56" or "1234.56")')
  .transform((v, ctx) => {
    const cents = eurosToCents(v);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: `Ungültiger Betrag: ${String(v)}` });
      return z.NEVER;
    }
    return cents;
  });

// ── quantities, rates ───────────────────────────────────────────────────────────

/** milli-units → plain number (1500 → 1.5) */
export const qty = (milli: number) => milli / QTY_SCALE;
/** plain number → milli-units (1.5 → 1500) */
export const toMilli = (n: number) => roundHalfAwayFromZero(n * QTY_SCALE);
/** basis points → percent number (2000 → 20) */
export const percent = (bp: number) => bp / 100;
export { formatBp, formatQuantity };

// ── dates ───────────────────────────────────────────────────────────────────────

export const isoDate = z.iso.date().describe("date YYYY-MM-DD");

/** "2026-10-14" → "14.10.2026" (for text summaries) */
export function deDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

// ── labels ──────────────────────────────────────────────────────────────────────

export const docTypeLabel = (t: DocumentType) => DOCUMENT_TYPE_LABELS[t];

/** German status label incl. the derived states ("Überfällig", "teilbezahlt"). */
export function docStatusLabel(d: { status: DocumentStatus; overdue?: boolean; partial?: boolean }): string {
  const base = d.overdue ? OVERDUE_LABEL : DOCUMENT_STATUS_LABELS[d.status];
  return d.partial ? `${base} (teilbezahlt)` : base;
}

// ── text helpers ────────────────────────────────────────────────────────────────

/** Markdown-ish bullet list; `empty` when there are no rows. */
export function bullets(rows: string[], empty = "(keine Einträge)"): string {
  return rows.length ? rows.map((r) => `- ${r}`).join("\n") : empty;
}

/** Joins the non-empty parts with " · ". */
export const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");
