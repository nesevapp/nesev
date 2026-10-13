import { addDays, todayIso } from "../../shared/dates";
import { EXPENSE_TAX_RATES_BP, isSelfAssessed } from "../../shared/expenses";
import { formatCents } from "../../shared/money";
import type { FieldSuggestion, ReceiptFields, ReceiptFieldKey, TaxLineSuggestion } from "../../shared/receipts";
import { checkUid, ibanValid, normalizeSupplierName, uidCountry } from "./receipt-parse";

// Post-processing in code (never trusted to the model): sums, rates, UID / IBAN check digits, plausible dates.
// Failed checks lower the confidence and add a German note; passed cross-checks raise it slightly.

const MAX_CONFIDENCE = 0.98;

function adjust<T>(f: FieldSuggestion<T> | undefined, factor: number, note?: string): FieldSuggestion<T> | undefined {
  if (!f) return f;
  const confidence = Math.max(0, Math.min(MAX_CONFIDENCE, f.confidence * factor));
  return { ...f, confidence: Math.round(confidence * 100) / 100, ...(note ? { note: f.note ? `${f.note}; ${note}` : note } : {}) };
}

function boost<T>(f: FieldSuggestion<T> | undefined, by = 0.1): FieldSuggestion<T> | undefined {
  if (!f) return f;
  return { ...f, confidence: Math.round(Math.min(MAX_CONFIDENCE, Math.max(f.confidence, f.confidence + by)) * 100) / 100 };
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

export interface ValidationResult {
  fields: ReceiptFields;
  warnings: string[];
}

export function validateFields(input: ReceiptFields, today = todayIso()): ValidationResult {
  const fields: ReceiptFields = { ...input };
  const warnings: string[] = [];
  const treatment = fields.vatTreatment?.value;

  // --- tax breakdown --------------------------------------------------------------------------
  const rows: TaxLineSuggestion[] = fields.taxLines?.value ?? [];
  if (fields.taxLines && rows.length) {
    let rowsOk = true;
    for (const r of rows) {
      if (!near(r.netCents + r.taxCents, r.grossCents)) {
        rowsOk = false;
        warnings.push(`Steuerzeile ${r.taxRateBp / 100} %: Netto + Steuer ≠ Brutto`);
      }
      // receipts round per rate group; allow a few cents (or 0.2 % on large amounts)
      if (!near(Math.round((r.netCents * r.taxRateBp) / 10000), r.taxCents, Math.max(2, Math.abs(r.netCents) / 500))) {
        rowsOk = false;
        warnings.push(`Steuerzeile ${r.taxRateBp / 100} %: Steuerbetrag passt nicht zum Satz`);
      }
    }
    const atRate = (bp: number) => (EXPENSE_TAX_RATES_BP as readonly number[]).includes(bp);
    const foreign = rows.filter((r) => !atRate(r.taxRateBp));
    if (foreign.length) {
      rowsOk = false;
      warnings.push(
        `Steuersatz ${foreign.map((r) => `${r.taxRateBp / 100} %`).join(", ")} ist kein österreichischer Satz – ausländische USt. ist nicht als Vorsteuer abziehbar`,
      );
    }
    if (treatment && isSelfAssessed(treatment) && rows.some((r) => r.taxCents > 0)) {
      warnings.push("Reverse Charge erkannt, aber der Beleg weist Steuer aus – bitte prüfen");
      fields.vatTreatment = adjust(fields.vatTreatment, 0.6);
    }
    fields.taxLines = rowsOk ? fields.taxLines : adjust(fields.taxLines, 0.6, "Rechenprüfung fehlgeschlagen");

    const rowsGross = rows.reduce((s, r) => s + r.grossCents, 0);
    const gross = fields.grossCents?.value;
    if (gross != null) {
      if (near(rowsGross, gross, 2 * rows.length)) {
        if (rowsOk) fields.taxLines = boost(fields.taxLines, 0.15);
        fields.grossCents = boost(fields.grossCents, 0.15);
      } else {
        warnings.push(`Summe der Steuerzeilen (${formatCents(rowsGross)}) ≠ Gesamtbetrag (${formatCents(gross)})`);
        fields.taxLines = adjust(fields.taxLines, 0.6, "Summe passt nicht zum Gesamtbetrag");
        fields.grossCents = adjust(fields.grossCents, 0.7);
      }
    }
  }

  const gross = fields.grossCents?.value;
  if (gross != null && (gross <= 0 || gross > 100_000_000)) {
    fields.grossCents = adjust(fields.grossCents, 0.3, "Betrag unplausibel");
  }

  // --- identifiers ---------------------------------------------------------------------------
  const uid = fields.supplierUid?.value;
  if (uid) {
    const check = checkUid(uid);
    if (check === "invalid") fields.supplierUid = adjust(fields.supplierUid, 0.4, "Format oder Prüfziffer ungültig");
    else if (check === "valid") fields.supplierUid = boost(fields.supplierUid, 0.1);
    const c = uidCountry(uid);
    if (c && fields.supplierCountry && fields.supplierCountry.value !== c) {
      fields.supplierCountry = adjust(fields.supplierCountry, 0.6, `UID deutet auf ${c}`);
    }
  }
  if (fields.iban && !ibanValid(fields.iban.value)) fields.iban = adjust(fields.iban, 0.3, "Prüfziffer ungültig");
  if (fields.supplierCountry && !/^[A-Z]{2}$/.test(fields.supplierCountry.value)) delete fields.supplierCountry;

  // --- dates ---------------------------------------------------------------------------------
  const issue = fields.issueDate?.value;
  if (issue && (issue > addDays(today, 31) || issue < addDays(today, -5 * 365))) {
    fields.issueDate = adjust(fields.issueDate, 0.4, "Datum unplausibel");
  }
  const due = fields.dueDate?.value;
  if (due && issue && (due < issue || due > addDays(issue, 366))) {
    fields.dueDate = adjust(fields.dueDate, 0.4, "Fälligkeit vor dem Rechnungsdatum oder zu weit entfernt");
  }

  const currency = fields.currency?.value;
  if (currency && currency !== "EUR") {
    warnings.push(`Beleg in ${currency} – Beträge bitte in EUR umrechnen`);
    fields.grossCents = adjust(fields.grossCents, 0.5, `Betrag in ${currency}`);
    fields.taxLines = adjust(fields.taxLines, 0.5, `Beträge in ${currency}`);
  }

  for (const k of Object.keys(fields) as ReceiptFieldKey[]) if (!fields[k]) delete fields[k];
  return { fields, warnings };
}

// --- merging ---------------------------------------------------------------------------------------

function sameValue(key: ReceiptFieldKey, a: unknown, b: unknown): boolean {
  if (key === "taxLines") {
    const x = a as TaxLineSuggestion[];
    const y = b as TaxLineSuggestion[];
    return (
      x.length === y.length &&
      x.every((r, i) => r.taxRateBp === y[i]!.taxRateBp && near(r.netCents, y[i]!.netCents) && near(r.taxCents, y[i]!.taxCents))
    );
  }
  if (key === "supplierName") return normalizeSupplierName(String(a)) === normalizeSupplierName(String(b));
  if (typeof a === "string" && typeof b === "string") {
    return a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
  }
  return a === b;
}

function rowsConsistent(rows: readonly TaxLineSuggestion[]): boolean {
  return rows.every(
    (r) =>
      near(r.netCents + r.taxCents, r.grossCents) &&
      near(Math.round((r.netCents * r.taxRateBp) / 10000), r.taxCents, Math.max(2, Math.abs(r.netCents) / 500)),
  );
}

function sumMatches(rows: readonly TaxLineSuggestion[] | undefined, gross: number): boolean {
  return !!rows?.length && near(rows.reduce((s, r) => s + r.grossCents, 0), gross, 2 * rows.length);
}

/**
 * For the tax breakdown and the total, the candidate that passes the arithmetic checks wins (e.g. the model
 * swapped the rates, or took the cash tendered as total). null = no decision.
 */
function preferConsistent(
  key: ReceiptFieldKey,
  a: unknown,
  b: unknown,
  primary: ReceiptFields,
  secondary: ReceiptFields,
): "a" | "b" | null {
  if (key === "taxLines") {
    const okA = rowsConsistent(a as TaxLineSuggestion[]);
    const okB = rowsConsistent(b as TaxLineSuggestion[]);
    return okA === okB ? null : okA ? "a" : "b";
  }
  if (key === "grossCents") {
    const rows = [primary.taxLines?.value, secondary.taxLines?.value].filter((r) => r && rowsConsistent(r));
    const okA = rows.some((r) => sumMatches(r, a as number));
    const okB = rows.some((r) => sumMatches(r, b as number));
    return okA === okB ? null : okA ? "a" : "b";
  }
  return null;
}

function namePrefix(a: string, b: string): boolean {
  const x = normalizeSupplierName(a);
  const y = normalizeSupplierName(b);
  return x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x));
}

function describe(key: ReceiptFieldKey, value: unknown): string {
  if (key === "grossCents") return formatCents(value as number);
  if (key === "taxLines") return (value as TaxLineSuggestion[]).map((r) => `${r.taxRateBp / 100} %: ${formatCents(r.grossCents)}`).join(", ");
  return String(value);
}

/**
 * Combines two extractions field by field. Agreement raises the confidence; on disagreement the primary
 * (model) value wins unless the secondary (rules) is clearly more confident, and the other value is noted.
 */
export function mergeFields(primary: ReceiptFields, secondary: ReceiptFields): ReceiptFields {
  const out: ReceiptFields = {};
  const keys = new Set([...Object.keys(primary), ...Object.keys(secondary)] as ReceiptFieldKey[]);
  for (const key of keys) {
    const a = primary[key] as FieldSuggestion<unknown> | undefined;
    const b = secondary[key] as FieldSuggestion<unknown> | undefined;
    let merged: FieldSuggestion<unknown> | undefined;
    if (!a || !b) merged = a ?? b;
    else if (sameValue(key, a.value, b.value)) merged = boost(a, Math.max(0.1, b.confidence - a.confidence + 0.05));
    else if (key === "supplierName" && namePrefix(String(a.value), String(b.value))) {
      // "BILLA AG" vs "BILLA AG Filiale 1234 Wien": keep the shorter one
      const shorter = String(a.value).length <= String(b.value).length ? a : b;
      merged = boost({ ...shorter, confidence: Math.max(a.confidence, b.confidence) }, 0);
    }
    else {
      // arithmetic beats self-reported confidence: prefer the value that checks out
      const consistent = preferConsistent(key, a.value, b.value, primary, secondary);
      const [win, lose] =
        consistent === "a" ? [a, b] : consistent === "b" ? [b, a] : b.confidence > a.confidence + 0.2 ? [b, a] : [a, b];
      merged = adjust(win, 0.85, `${lose.source === "rules" ? "Regeln" : "Modell"}: ${describe(key, lose.value)}`);
    }
    if (merged) (out as Record<string, unknown>)[key] = merged;
  }
  return out;
}
