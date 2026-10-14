// Expenses (Ausgaben / Eingangsrechnungen & Belege) — shared by server, web and the tax/bank features.
//
// Table semantics (src/server/db/schema.ts → expenses, expense_lines):
// - expenses.paidAt: date the expense was fully paid ("YYYY-MM-DD"), null = open.
// - Each line stores netCents, taxRateBp and taxCents. taxCents is stored (not derived) so the receipt's
//   rounding can be matched exactly; the default is expenseTaxCents(net, rate).
// - line.deductibleBp: share of the line's tax that is deductible as Vorsteuer (10000 = fully, 0 = none).
// - Cached expense totals are always calcExpenseTotals(lines, vatTreatment) (written by the server on every change):
//     netCents   = Σ line.netCents
//     taxCents   = Σ line.taxCents  (for reverse_charge / ig_acquisition: the self-assessed tax)
//     grossCents = amount payable to the supplier: net + tax, except for self-assessed treatments where it is net
//                  (the supplier invoices without VAT). Bank matching compares against grossCents.
// - Per vatTreatment:
//     domestic        lines carry the rate on the receipt; taxCents = Vorsteuer charged by the supplier.
//     reverse_charge  supplier invoices net; lines carry the rate that applies in AT (e.g. 2000 = 20 %) and
//     ig_acquisition  taxCents = self-assessed tax, which is BOTH owed (UVA KZ 057/066 resp. 072) AND deductible
//                     as Vorsteuer (× deductibleBp). grossCents excludes it.
//     import          taxCents = Einfuhrumsatzsteuer (EUSt) paid, deductible as Vorsteuer (× deductibleBp).
//     none            no VAT: the server normalizes lines to taxRateBp 0 and taxCents 0.
// - An expense with zero lines is a draft ("unvollständig"), e.g. created by dropping a receipt on the list.

import { BP_SCALE, roundHalfAwayFromZero } from "./money";
import { isEuCountry } from "./tax";

export const VAT_TREATMENTS = ["domestic", "reverse_charge", "ig_acquisition", "import", "none"] as const;
export type VatTreatment = (typeof VAT_TREATMENTS)[number];

export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  domestic: "Inland (Vorsteuer lt. Rechnung)",
  reverse_charge: "Reverse Charge §19 (EU/Drittland-Leistung, Steuerschuld geht über)",
  ig_acquisition: "Innergemeinschaftlicher Erwerb (Waren aus EU)",
  import: "Einfuhr (EUSt)",
  none: "ohne USt (z.B. Kleinunternehmer-Lieferant, Versicherung, Gebühren)",
};

/** Compact labels for tables and badges. */
export const VAT_TREATMENT_SHORT_LABELS: Record<VatTreatment, string> = {
  domestic: "Inland",
  reverse_charge: "Reverse Charge",
  ig_acquisition: "ig. Erwerb",
  import: "Einfuhr",
  none: "ohne USt",
};

/** Treatments where the recipient self-assesses the tax (owed and deductible at the same time). */
export function isSelfAssessed(treatment: VatTreatment): boolean {
  return treatment === "reverse_charge" || treatment === "ig_acquisition";
}

/** Rates offered in the line editor (basis points). */
export const EXPENSE_TAX_RATES_BP = [2000, 1300, 1000, 0] as const;

/**
 * Default treatment for a supplier (the user can always override): AT → domestic; EU with UID → reverse_charge
 * (services; switch to ig_acquisition for goods); EU without UID → domestic (user adjusts); non-EU →
 * reverse_charge (B2B services, e.g. US software subscriptions; switch to import for goods).
 */
export function defaultVatTreatment(country: string, uid?: string | null): VatTreatment {
  const c = country.trim().toUpperCase();
  if (!c || c === "AT") return "domestic";
  if (isEuCountry(c)) return uid?.trim() ? "reverse_charge" : "domestic";
  return "reverse_charge";
}

export interface ExpenseCategory {
  key: string;
  label: string;
  group: string;
  /** E1a Kennzahl the category usually maps to (EAR). Verify with the tax advisor. */
  e1aKz: string;
  /** default line.deductibleBp (Vorsteuer share) */
  defaultDeductibleBp: number;
  /** share deductible for income tax if not 100 % (e.g. Bewirtung 50 %); informational */
  incomeTaxDeductibleBp?: number;
  hint?: string;
}

export const EXPENSE_CATEGORIES = [
  { key: "wareneinkauf", label: "Wareneinkauf / Material", group: "Waren & Fremdleistungen", e1aKz: "9100", defaultDeductibleBp: 10000 },
  { key: "fremdleistungen", label: "Fremdleistungen / Subunternehmer", group: "Waren & Fremdleistungen", e1aKz: "9110", defaultDeductibleBp: 10000 },
  { key: "software_abos", label: "Software & Abos", group: "Betrieb", e1aKz: "9230", defaultDeductibleBp: 10000 },
  {
    key: "hardware_gwg",
    label: "Hardware / GWG (≤ 1.000 €)",
    group: "Anlagen",
    e1aKz: "9130",
    defaultDeductibleBp: 10000,
    hint: "Geringwertige Wirtschaftsgüter bis 1.000 € netto sofort absetzbar",
  },
  {
    key: "anlagen",
    label: "Anlagegüter (> 1.000 €, AfA)",
    group: "Anlagen",
    e1aKz: "9130",
    defaultDeductibleBp: 10000,
    hint: "Wird über die Nutzungsdauer abgeschrieben (AfA): im Anlagenverzeichnis anlegen",
  },
  { key: "buero", label: "Büromaterial", group: "Betrieb", e1aKz: "9230", defaultDeductibleBp: 10000 },
  { key: "telefon_internet", label: "Telefon & Internet", group: "Betrieb", e1aKz: "9230", defaultDeductibleBp: 10000 },
  { key: "miete", label: "Miete & Betriebskosten", group: "Betrieb", e1aKz: "9180", defaultDeductibleBp: 10000 },
  { key: "instandhaltung", label: "Instandhaltung & Reparaturen", group: "Betrieb", e1aKz: "9150", defaultDeductibleBp: 10000 },
  { key: "reise", label: "Reisekosten", group: "Reise & Fahrzeug", e1aKz: "9160", defaultDeductibleBp: 10000 },
  {
    key: "kfz",
    label: "KFZ-Kosten",
    group: "Reise & Fahrzeug",
    e1aKz: "9170",
    defaultDeductibleBp: 0,
    hint: "PKW: kein Vorsteuerabzug (außer E-Auto / Fiskal-LKW)",
  },
  {
    key: "bewirtung",
    label: "Bewirtung (50 %)",
    group: "Werbung & Repräsentation",
    e1aKz: "9200",
    defaultDeductibleBp: 10000,
    incomeTaxDeductibleBp: 5000,
    hint: "Geschäftsessen mit Werbezweck: 50 % ertragsteuerlich absetzbar",
  },
  { key: "werbung", label: "Werbung & Marketing", group: "Werbung & Repräsentation", e1aKz: "9200", defaultDeductibleBp: 10000 },
  { key: "fortbildung", label: "Fortbildung & Fachliteratur", group: "Betrieb", e1aKz: "9230", defaultDeductibleBp: 10000 },
  { key: "versicherung", label: "Versicherungen (betrieblich)", group: "Versicherung & Abgaben", e1aKz: "9230", defaultDeductibleBp: 10000 },
  { key: "beratung", label: "Steuer- & Rechtsberatung", group: "Betrieb", e1aKz: "9230", defaultDeductibleBp: 10000 },
  { key: "bankgebuehren", label: "Bank- & Zahlungsgebühren", group: "Versicherung & Abgaben", e1aKz: "9230", defaultDeductibleBp: 10000 },
  {
    key: "svs",
    label: "Sozialversicherung (SVS)",
    group: "Versicherung & Abgaben",
    e1aKz: "9225",
    defaultDeductibleBp: 10000,
    hint: "Eigene Pflichtversicherungsbeiträge",
  },
  { key: "sonstiges", label: "Sonstiges", group: "Sonstiges", e1aKz: "9230", defaultDeductibleBp: 10000 },
] as const satisfies readonly ExpenseCategory[];

export type ExpenseCategoryKey = (typeof EXPENSE_CATEGORIES)[number]["key"];
export const EXPENSE_CATEGORY_KEYS = EXPENSE_CATEGORIES.map((c) => c.key) as [ExpenseCategoryKey, ...ExpenseCategoryKey[]];
export const DEFAULT_EXPENSE_CATEGORY: ExpenseCategoryKey = "sonstiges";

export function getExpenseCategory(key: string): ExpenseCategory | undefined {
  return (EXPENSE_CATEGORIES as readonly ExpenseCategory[]).find((c) => c.key === key);
}

/** Label for a category key; unknown keys are returned unchanged. */
export function categoryLabel(key: string): string {
  return getExpenseCategory(key)?.label ?? key;
}

/** Tax for a net amount at a rate, commercially rounded: expenseTaxCents(1000, 2000) → 200. */
export function expenseTaxCents(netCents: number, rateBp: number): number {
  return roundHalfAwayFromZero((netCents * rateBp) / BP_SCALE);
}

/** Deductible input VAT (Vorsteuer) of a line: taxCents × deductibleBp, rounded. */
export function deductibleTaxCents(line: { taxCents: number; deductibleBp: number }): number {
  return roundHalfAwayFromZero((line.taxCents * line.deductibleBp) / BP_SCALE);
}

/** Back-calculate net and tax from a gross amount ("Brutto-Eingabe"): gross 1200 @ 20 % → { net 1000, tax 200 }. */
export function netFromGross(grossCents: number, rateBp: number): { netCents: number; taxCents: number } {
  const netCents = roundHalfAwayFromZero((grossCents * BP_SCALE) / (BP_SCALE + rateBp));
  return { netCents, taxCents: grossCents - netCents };
}

export interface ExpenseLineAmounts {
  netCents: number;
  taxCents: number;
}

export interface ExpenseTotals {
  netCents: number;
  taxCents: number;
  grossCents: number;
}

/** The single totals function for expenses (see header comment). */
export function calcExpenseTotals(lines: readonly ExpenseLineAmounts[], treatment: VatTreatment): ExpenseTotals {
  let netCents = 0;
  let taxCents = 0;
  for (const l of lines) {
    netCents += l.netCents;
    taxCents += l.taxCents;
  }
  return { netCents, taxCents, grossCents: isSelfAssessed(treatment) ? netCents : netCents + taxCents };
}

/** Draft expenses (e.g. a dropped receipt) have no lines or no supplier yet. */
export function isExpenseIncomplete(e: { supplierName: string; lineCount: number }): boolean {
  return !e.supplierName.trim() || e.lineCount === 0;
}

/** Accepted receipt uploads. */
export const RECEIPT_MIME_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export const RECEIPT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";
export const RECEIPT_MAX_BYTES = 20 * 1024 * 1024;
