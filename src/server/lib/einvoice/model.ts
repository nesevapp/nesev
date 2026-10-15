import { formatDate } from "../../../shared/dates";
import type { EInvoiceFormat } from "../../../shared/einvoice";
import type { TaxMode } from "../../../shared/tax";
import { calcTotals, type Totals } from "../../../shared/totals";
import type { ClientSnapshot, SellerSnapshot } from "../../../shared/types";

// Input shared by all e-invoice generators: a finalized invoice or credit note as frozen at finalize
// (snapshots, items, cached totals) plus the routing data the client needs (buyer reference, our
// supplier number). Credit notes carry positive amounts like everywhere else in nesev; the
// document type (ebInterface CreditMemo, UBL CreditNote, CII 381) gives them their meaning.

export interface EInvoiceItem {
  title: string;
  description: string;
  /** milli-units */
  quantity: number;
  unit: string;
  unitPriceCents: number;
  taxRateBp: number;
  discountBp: number;
}

export interface EInvoiceInput {
  type: "invoice" | "credit_note";
  number: string;
  issueDate: string;
  dueDate: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  taxMode: TaxMode;
  title: string;
  introText: string;
  closingText: string;
  seller: SellerSnapshot;
  client: ClientSnapshot;
  /** Leitweg-ID (XRechnung) / Auftragsreferenz (ebInterface); document value, else the client's default */
  buyerReference: string;
  /** our supplier number at the client (ebInterface InvoiceRecipientsBillerID) */
  supplierId: string;
  items: EInvoiceItem[];
  /** the document's cached totals; must equal calcTotals(items, taxMode) */
  netCents: number;
  taxCents: number;
  grossCents: number;
  /** note printed on the PDF for non-domestic modes (reverse charge, small business, third country) */
  taxNote: string | null;
  /** credit notes: the invoice they correct */
  precedingInvoice: { number: string; issueDate: string } | null;
}

export const CURRENCY = "EUR";
export const GENERATOR = "nesev";

/** Totals from calcTotals (the one totals function); throws when the cached document totals disagree. */
export function totalsOf(input: EInvoiceInput): Totals {
  const t = calcTotals(input.items, input.taxMode);
  if (t.netCents !== input.netCents || t.taxCents !== input.taxCents || t.grossCents !== input.grossCents) {
    throw new Error(`Summen von ${input.number} stimmen nicht mit den Positionen überein`);
  }
  return t;
}

// ── VAT categories (UNTDID 5305, as used by EN 16931 and ebInterface) ─────────────────────────────

export interface VatCategory {
  /** S standard, Z zero rated, E exempt, AE reverse charge, G export outside the EU */
  code: "S" | "Z" | "E" | "AE" | "G";
  /** exemption reason (BT-120); required for E, AE, G */
  reason: string | null;
  /** VATEX code (BT-121) where one fits */
  reasonCode: string | null;
}

/**
 * Category for a tax group. Third country uses G rather than O ("not subject to VAT"): EN 16931
 * forbids a seller VAT ID on O invoices (BR-O-02), and nesev sellers usually have one.
 */
export function vatCategory(mode: TaxMode, rateBp: number, taxNote: string | null): VatCategory {
  switch (mode) {
    case "AT_DOMESTIC":
      return { code: rateBp > 0 ? "S" : "Z", reason: null, reasonCode: null };
    case "EU_REVERSE_CHARGE":
      return { code: "AE", reason: taxNote || "Reverse Charge", reasonCode: "VATEX-EU-AE" };
    case "THIRD_COUNTRY":
      return { code: "G", reason: taxNote || "Nicht im Inland steuerbare Leistung", reasonCode: "VATEX-EU-G" };
    case "SMALL_BUSINESS":
      return { code: "E", reason: taxNote || "Umsatzsteuerbefreit – Kleinunternehmer", reasonCode: null };
  }
}

// ── Checks before generating ───────────────────────────────────────────────────────────────────────

/** Missing data that makes the e-invoice invalid for the format (German, shown in the UI). Empty = OK. */
export function eInvoiceProblems(input: EInvoiceInput, format: EInvoiceFormat): string[] {
  const p: string[] = [];
  const s = input.seller;
  const c = input.client;
  if (!s.companyName.trim() && !s.ownerName.trim()) p.push("Einstellungen: Firmenname fehlt");
  if (!s.street.trim() || !s.zip.trim() || !s.city.trim()) p.push("Einstellungen: Anschrift (Straße, PLZ, Ort) unvollständig");
  if (!s.uid.trim() && !s.taxNumber.trim()) p.push("Einstellungen: UID-Nummer oder Steuernummer fehlt");
  if (input.taxMode === "EU_REVERSE_CHARGE" && !s.uid.trim()) p.push("Einstellungen: Reverse Charge erfordert die eigene UID-Nummer");
  if (input.taxMode === "THIRD_COUNTRY" && !s.uid.trim()) p.push("Einstellungen: Drittland-Rechnungen erfordern die eigene UID-Nummer");
  if (input.taxMode === "EU_REVERSE_CHARGE" && !c.uid.trim()) p.push("Kunde: Reverse Charge erfordert die UID-Nummer des Kunden");
  if (input.type === "invoice" && !s.iban.trim()) p.push("Einstellungen: IBAN fehlt (Zahlungsanweisung)");
  if (!c.city.trim() || !c.zip.trim()) p.push("Kunde: PLZ und Ort fehlen");
  if (input.type === "credit_note" && !input.precedingInvoice) p.push("Gutschrift ohne zugehörige Rechnung");

  switch (format) {
    case "ebinterface":
      if (!input.buyerReference.trim()) {
        p.push("Auftragsreferenz fehlt (beim Bund Pflicht) – beim Kunden oder im Beleg eintragen");
      }
      if (!input.supplierId.trim()) p.push("Kunde: Lieferantennummer fehlt (beim Bund Pflicht)");
      break;
    case "xrechnung":
      if (!input.buyerReference.trim()) p.push("Leitweg-ID fehlt – beim Kunden oder im Beleg eintragen");
      if (!s.email.trim()) p.push("Einstellungen: E-Mail-Adresse fehlt (XRechnung-Pflicht)");
      if (!s.phone.trim()) p.push("Einstellungen: Telefonnummer fehlt (XRechnung-Pflicht)");
      if (!isLeitwegId(input.buyerReference) && input.buyerReference.trim() && !c.email.trim()) {
        p.push("Kunde: E-Mail-Adresse fehlt (elektronische Adresse, da die Referenz keine Leitweg-ID ist)");
      }
      break;
    case "zugferd":
      if (!s.email.trim()) p.push("Einstellungen: E-Mail-Adresse fehlt");
      break;
  }
  return p;
}

/** Leitweg-ID: Grobadressierung (2–12 digits), optional Feinadressierung, 2-digit check number. */
export function isLeitwegId(ref: string): boolean {
  return /^\d{2,12}(-[A-Za-z0-9]{1,30})?-\d{2}$/.test(ref.trim());
}

/** "Max Muster e.U." – the seller's legal name for registration fields. */
export function sellerName(s: SellerSnapshot): string {
  return s.companyName.trim() || s.ownerName.trim();
}

/** Payment terms text for due dates (BT-20). */
export function paymentTermsText(input: EInvoiceInput): string | null {
  if (!input.dueDate) return null;
  const due = formatDate(input.dueDate);
  return input.type === "credit_note" ? `Auszahlung bis ${due}` : `Zahlbar bis ${due} ohne Abzug`;
}
