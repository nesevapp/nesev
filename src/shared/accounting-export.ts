// Accountant export (Steuerberater): account mapping for the BMD booking import, stored in settings.accountingExport.
// Shared by server (export) and web (settings UI). Defaults follow the Austrian Einheitskontenrahmen (EKR, BMF list
// for SAF-T) as most BMD/RZL Kontenpläne do; every office has its own plan, so everything is editable.
// Best effort: the BMD import itself couldn't be tested here — check the first import with the Steuerberater.

import { EXPENSE_CATEGORIES, type ExpenseCategoryKey } from "./expenses";
import { z } from "./schemas/zod";

/** Revenue account keys: domestic per rate, the other tax modes as a whole. */
export const REVENUE_ACCOUNT_KEYS = ["AT_2000", "AT_1300", "AT_1000", "AT_0", "EU_REVERSE_CHARGE", "THIRD_COUNTRY", "SMALL_BUSINESS"] as const;
export type RevenueAccountKey = (typeof REVENUE_ACCOUNT_KEYS)[number];

export const REVENUE_ACCOUNT_LABELS: Record<RevenueAccountKey, string> = {
  AT_2000: "Inland 20 %",
  AT_1300: "Inland 13 %",
  AT_1000: "Inland 10 %",
  AT_0: "Inland 0 % / steuerfrei",
  EU_REVERSE_CHARGE: "EU-Leistungen (Reverse Charge)",
  THIRD_COUNTRY: "Drittland (nicht steuerbar)",
  SMALL_BUSINESS: "Kleinunternehmer (steuerfrei)",
};

/** Revenue account key for a document tax mode and line rate. */
export function revenueAccountKey(taxMode: string, rateBp: number): RevenueAccountKey {
  if (taxMode === "AT_DOMESTIC") {
    if (rateBp === 2000 || rateBp === 1300 || rateBp === 1000) return `AT_${rateBp}`;
    return "AT_0";
  }
  if (taxMode === "EU_REVERSE_CHARGE" || taxMode === "THIRD_COUNTRY" || taxMode === "SMALL_BUSINESS") return taxMode;
  return "AT_0";
}

const DEFAULT_REVENUE_ACCOUNTS: Record<RevenueAccountKey, string> = {
  AT_2000: "4000", // Erlöse 20 %
  AT_1300: "4013", // not in the EKR list (4012 = 12 %); common choice for 13 %
  AT_1000: "4010", // Erlöse 10 %
  AT_0: "4064", // Übrige steuerfreie Umsätze ohne VSt-Abzug
  EU_REVERSE_CHARGE: "4111", // Erlöse grenzüberschreitende Dienstleistungen
  THIRD_COUNTRY: "4210", // Nicht steuerbare Auslandsumsätze
  SMALL_BUSINESS: "4062", // Erlöse 0 % Kleinunternehmer
};

const DEFAULT_EXPENSE_ACCOUNTS: Record<ExpenseCategoryKey, string> = {
  wareneinkauf: "5000", // Wareneinsatz
  fremdleistungen: "5700", // Fremdleistungen
  software_abos: "7840", // Verschiedene betriebliche Aufwendungen
  hardware_gwg: "7041", // Geringwertiges Sachanlagevermögen
  anlagen: "0620", // Büromaschinen, EDV-Anlagen (aktiviert, AfA bucht die Kanzlei)
  buero: "7600", // Büromaterial und Drucksorten
  telefon_internet: "7380", // Telefon
  miete: "7400", // Mietaufwand
  instandhaltung: "7200", // Instandhaltung
  reise: "7340", // Reisespesen
  kfz: "7335", // Sonstiger Aufwand PKW
  bewirtung: "7660", // Repräsentationsaufwand
  werbung: "7650", // Werbung
  fortbildung: "7770", // Aus- und Weiterbildung
  versicherung: "7700", // Versicherungen
  beratung: "7740", // Steuerberatungsaufwand (7750 = Rechts- und Beratungsaufwand)
  bankgebuehren: "7790", // Spesen des Geldverkehrs
  svs: "6580", // Eigene Pflichtversicherungsbeiträge
  sonstiges: "7840", // Verschiedene betriebliche Aufwendungen
};

export const BMD_ENCODINGS = ["windows-1252", "utf-8"] as const;
export type BmdEncoding = (typeof BMD_ENCODINGS)[number];

const account = z.string().trim().regex(/^\d{1,9}$/, "Kontonummer: 1–9 Ziffern");
const symbol = z.string().trim().regex(/^[A-Z0-9]{1,3}$/, "Buchungssymbol: 1–3 Großbuchstaben/Ziffern");

export const accountingExportSettingsSchema = z.object({
  revenueAccounts: z.object(Object.fromEntries(REVENUE_ACCOUNT_KEYS.map((k) => [k, account])) as Record<RevenueAccountKey, typeof account>),
  expenseAccounts: z.object(
    Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, account])) as Record<ExpenseCategoryKey, typeof account>,
  ),
  /** Debitoren: one collective Personenkonto, or base + Kundennummer per client */
  debtorAccount: account,
  debtorPerClient: z.boolean(),
  /** Kreditoren: one collective Personenkonto (suppliers have no numbers in nesev) */
  creditorAccount: account,
  bankAccount: account,
  symbols: z.object({ invoice: symbol, creditNote: symbol, expense: symbol, bank: symbol }),
  encoding: z.enum(BMD_ENCODINGS),
});
export type AccountingExportSettings = z.infer<typeof accountingExportSettingsSchema>;

export const DEFAULT_ACCOUNTING_EXPORT_SETTINGS: AccountingExportSettings = {
  revenueAccounts: DEFAULT_REVENUE_ACCOUNTS,
  expenseAccounts: DEFAULT_EXPENSE_ACCOUNTS,
  debtorAccount: "20000",
  debtorPerClient: false,
  creditorAccount: "33000",
  bankAccount: "2800",
  symbols: { invoice: "AR", creditNote: "GU", expense: "ER", bank: "BK" },
  encoding: "windows-1252",
};

/** Stored JSON (null, partial or outdated) → complete settings; invalid or unknown values fall back to the defaults. */
export function resolveAccountingExportSettings(stored: unknown): AccountingExportSettings {
  const d = DEFAULT_ACCOUNTING_EXPORT_SETTINGS;
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const r = schema.safeParse(value);
    return r.success ? r.data : fallback;
  };
  const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const rev = rec(s.revenueAccounts);
  const exp = rec(s.expenseAccounts);
  const sym = rec(s.symbols);
  return {
    revenueAccounts: Object.fromEntries(REVENUE_ACCOUNT_KEYS.map((k) => [k, pick(account, rev[k], d.revenueAccounts[k])])) as Record<RevenueAccountKey, string>,
    expenseAccounts: Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, pick(account, exp[c.key], d.expenseAccounts[c.key])])) as Record<ExpenseCategoryKey, string>,
    debtorAccount: pick(account, s.debtorAccount, d.debtorAccount),
    debtorPerClient: pick(z.boolean(), s.debtorPerClient, d.debtorPerClient),
    creditorAccount: pick(account, s.creditorAccount, d.creditorAccount),
    bankAccount: pick(account, s.bankAccount, d.bankAccount),
    symbols: {
      invoice: pick(symbol, sym.invoice, d.symbols.invoice),
      creditNote: pick(symbol, sym.creditNote, d.symbols.creditNote),
      expense: pick(symbol, sym.expense, d.symbols.expense),
      bank: pick(symbol, sym.bank, d.symbols.bank),
    },
    encoding: pick(z.enum(BMD_ENCODINGS), s.encoding, d.encoding),
  };
}
