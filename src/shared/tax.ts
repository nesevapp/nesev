export const TAX_MODES = ["AT_DOMESTIC", "EU_REVERSE_CHARGE", "THIRD_COUNTRY", "SMALL_BUSINESS"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export const TAX_MODE_LABELS: Record<TaxMode, string> = {
  AT_DOMESTIC: "Inland (AT)",
  EU_REVERSE_CHARGE: "EU Reverse Charge",
  THIRD_COUNTRY: "Drittland",
  SMALL_BUSINESS: "Kleinunternehmer",
};

/** Austrian VAT rates in basis points, for line-item rate pickers. */
export const AT_TAX_RATES_BP = [2000, 1300, 1000, 0] as const;
export const DEFAULT_TAX_RATE_BP = 2000;

/** EU member states (ISO 3166-1 alpha-2). Note: Greece uses "GR" here (VIES uses "EL"). */
export const EU_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU",
  "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

export function isEuCountry(country: string): boolean {
  return (EU_COUNTRIES as readonly string[]).includes(country.toUpperCase());
}

/** Only AT_DOMESTIC charges VAT; all other modes are 0 % regardless of the line rate. */
export function effectiveTaxRateBp(mode: TaxMode, lineRateBp: number): number {
  return mode === "AT_DOMESTIC" ? lineRateBp : 0;
}

export function requiresClientUid(mode: TaxMode): boolean {
  return mode === "EU_REVERSE_CHARGE";
}

export interface TaxModeClientInput {
  country: string;
  uid?: string | null;
  defaultTaxMode?: TaxMode | null;
}

export interface TaxModeSettingsInput {
  smallBusiness: boolean;
}

/**
 * Default tax mode for a new document.
 * Small business overrides everything; then an explicit client default; then:
 * AT → AT_DOMESTIC, EU + UID → EU_REVERSE_CHARGE, EU without UID (B2C) → AT_DOMESTIC,
 * non-EU (e.g. CH) → THIRD_COUNTRY.
 */
export function defaultTaxMode(client: TaxModeClientInput, settings: TaxModeSettingsInput): TaxMode {
  if (settings.smallBusiness) return "SMALL_BUSINESS";
  if (client.defaultTaxMode) return client.defaultTaxMode;
  const country = client.country.toUpperCase();
  if (country === "AT") return "AT_DOMESTIC";
  if (isEuCountry(country)) return client.uid?.trim() ? "EU_REVERSE_CHARGE" : "AT_DOMESTIC";
  return "THIRD_COUNTRY";
}

export interface TaxNoteSettings {
  taxNoteReverseCharge: string;
  taxNoteThirdCountry: string;
  taxNoteSmallBusiness: string;
}

export const DEFAULT_TAX_NOTES: TaxNoteSettings = {
  taxNoteReverseCharge:
    "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge). Die Umsatzsteuer ist vom Leistungsempfänger zu entrichten.",
  taxNoteThirdCountry: "Nicht im Inland steuerbare Leistung.",
  taxNoteSmallBusiness: "Umsatzsteuerbefreit – Kleinunternehmer gem. § 6 Abs. 1 Z 27 UStG.",
};

/** Note text to print on the document for the given mode (null for AT_DOMESTIC). */
export function taxNoteFor(mode: TaxMode, settings: TaxNoteSettings): string | null {
  switch (mode) {
    case "EU_REVERSE_CHARGE":
      return settings.taxNoteReverseCharge;
    case "THIRD_COUNTRY":
      return settings.taxNoteThirdCountry;
    case "SMALL_BUSINESS":
      return settings.taxNoteSmallBusiness;
    case "AT_DOMESTIC":
      return null;
  }
}
