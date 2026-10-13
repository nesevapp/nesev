import { normalizeIban } from "../../../shared/bank";
import { BankParseError, clean, type ParsedTransaction, type ParseResult } from "./types";

// George (Erste Bank / Sparkassen) JSON export: an array of bookings, e.g.
//   { "booking": "2026-01-02T00:00:00.000+0100", "valuation": "...", "partnerName": "...",
//     "partnerAccount": { "iban": "AT..", "bic": "..." }, "amount": { "value": -1234, "precision": 2, "currency": "EUR" },
//     "reference": "...", "referenceNumber": "...", "receiverReference": "...", "note": "..." }
// Field names are inferred from public samples of the export (not verified against every George version);
// unknown fields are ignored, and a missing date or amount is reported as an error.

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export function looksLikeGeorgeJson(text: string): boolean {
  const t = text.trimStart();
  return (t.startsWith("[") || t.startsWith("{")) && /"(booking|bookingDate)"\s*:/.test(text.slice(0, 20000));
}

function dateOf(v: unknown): string | null {
  if (typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function amountOf(v: unknown): { cents: number; currency: string } | null {
  if (typeof v === "number") return { cents: Math.round(v * 100), currency: "EUR" };
  if (!v || typeof v !== "object") return null;
  const a = v as Json;
  if (typeof a.value !== "number") return null;
  const precision = typeof a.precision === "number" ? a.precision : 2;
  return { cents: Math.round((a.value / 10 ** precision) * 100), currency: str(a.currency) || "EUR" };
}

export function parseGeorgeJson(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BankParseError("Die JSON-Datei ist ungültig");
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as Json)?.collection) ? ((data as Json).collection as unknown[]) : null;
  if (!list) throw new BankParseError("Unbekanntes JSON-Format (erwartet: George-Export)");

  const transactions: ParsedTransaction[] = [];
  const warnings: string[] = [];
  list.forEach((raw, i) => {
    const t = (raw ?? {}) as Json;
    const bookingDate = dateOf(t.booking ?? t.bookingDate);
    const amount = amountOf(t.amount);
    if (!bookingDate || !amount) {
      warnings.push(`Eintrag ${i + 1}: Datum oder Betrag fehlt – übersprungen`);
      return;
    }
    const partner = (t.partnerAccount ?? {}) as Json;
    transactions.push({
      bookingDate,
      valueDate: dateOf(t.valuation ?? t.valueDate),
      amountCents: amount.cents,
      currency: amount.currency,
      counterpartyName: clean(str(t.partnerName)),
      counterpartyIban: normalizeIban(str(partner.iban)),
      purpose: clean([t.reference, t.receiverReference, t.partnerReference, t.note].map(str).filter(Boolean).join(" ")),
      reference: clean(str(t.referenceNumber)),
    });
  });
  return {
    format: "george-json",
    transactions,
    accountIban: null,
    openingBalanceCents: null,
    closingBalanceCents: null,
    warnings,
  };
}
