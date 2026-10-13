// Tax reports (UVA / ZM / EAR): periods, due dates and the U 30 Kennzahlen — shared by server and web.
// A helper for preparing FinanzOnline entries, not tax advice.

import { addDays, toIsoDate } from "./dates";

export type VatBasis = "accrual" | "cash";
export type VatPeriod = "monthly" | "quarterly";

export const VAT_BASIS_LABELS: Record<VatBasis, string> = {
  accrual: "Sollbesteuerung (vereinbarte Entgelte)",
  cash: "Istbesteuerung (vereinnahmte Entgelte)",
};

export const VAT_PERIOD_LABELS: Record<VatPeriod, string> = {
  monthly: "monatlich",
  quarterly: "vierteljährlich",
};

// ── Periods ─────────────────────────────────────────────────────────────────────

export type PeriodKind = "month" | "quarter" | "year";

export interface TaxPeriod {
  /** "2026-03" | "2026-Q1" | "2026" */
  key: string;
  kind: PeriodKind;
  year: number;
  /** "YYYY-MM-DD", inclusive */
  from: string;
  to: string;
  label: string;
}

const MONTH_NAMES = [
  "Jänner", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export const PERIOD_KEY_RE = /^(\d{4})(?:-(0[1-9]|1[0-2])|-Q([1-4]))?$/;

function lastDay(year: number, month: number): string {
  return toIsoDate(new Date(year, month, 0));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-03" | "2026-Q1" | "2026" → period, or null when malformed. */
export function parsePeriod(key: string): TaxPeriod | null {
  const m = PERIOD_KEY_RE.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  if (m[2]) {
    const month = Number(m[2]);
    return { key, kind: "month", year, from: `${year}-${m[2]}-01`, to: lastDay(year, month), label: `${MONTH_NAMES[month - 1]} ${year}` };
  }
  if (m[3]) {
    const q = Number(m[3]);
    const first = (q - 1) * 3 + 1;
    return {
      key,
      kind: "quarter",
      year,
      from: `${year}-${pad(first)}-01`,
      to: lastDay(year, first + 2),
      label: `${q}. Quartal ${year}`,
    };
  }
  return { key, kind: "year", year, from: `${year}-01-01`, to: `${year}-12-31`, label: `Jahr ${year}` };
}

export function periodKind(vatPeriod: VatPeriod): PeriodKind {
  return vatPeriod === "monthly" ? "month" : "quarter";
}

/** Key of the period of `kind` containing `date`. */
export function periodKeyFor(date: string, kind: PeriodKind): string {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  if (kind === "month") return `${year}-${pad(month)}`;
  if (kind === "quarter") return `${year}-Q${Math.ceil(month / 3)}`;
  return year;
}

/** The period before/after `key` (same kind). */
export function shiftPeriod(key: string, delta: number): string {
  const p = parsePeriod(key);
  if (!p) return key;
  if (p.kind === "year") return String(p.year + delta);
  const step = p.kind === "month" ? 1 : 3;
  const d = new Date(p.year, Number(p.from.slice(5, 7)) - 1 + delta * step, 1);
  return periodKeyFor(toIsoDate(d), p.kind);
}

/** The last completed period of `kind` before `today` (the UVA usually prepared next). */
export function previousPeriodKey(today: string, kind: PeriodKind): string {
  return shiftPeriod(periodKeyFor(today, kind), -1);
}

// ── Due dates ───────────────────────────────────────────────────────────────────

/** Easter Sunday (Gregorian, anonymous algorithm). */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Days on which a deadline does not end (§ 108 Abs. 3 BAO): weekends, public holidays, Karfreitag, 24.12. */
function isNonWorkingDay(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = new Date(y, m - 1, d).getDay();
  if (dow === 0 || dow === 6) return true;
  const md = date.slice(5);
  if (["01-01", "01-06", "05-01", "08-15", "10-26", "11-01", "12-08", "12-24", "12-25", "12-26"].includes(md)) return true;
  const easter = easterSunday(y);
  // Karfreitag, Ostermontag, Christi Himmelfahrt, Pfingstmontag, Fronleichnam
  return [-2, 1, 39, 50, 60].some((offset) => addDays(easter, offset) === date);
}

function nextWorkingDay(date: string): string {
  let d = date;
  while (isNonWorkingDay(d)) d = addDays(d, 1);
  return d;
}

/** UVA payment/filing due date: 15th of the second month after the period (shifted past weekends/holidays). */
export function uvaDueDate(period: TaxPeriod): string {
  const end = new Date(Number(period.to.slice(0, 4)), Number(period.to.slice(5, 7)) - 1, 1);
  return nextWorkingDay(toIsoDate(new Date(end.getFullYear(), end.getMonth() + 2, 15)));
}

/** ZM due date: end of the month following the period (shifted past weekends/holidays). */
export function zmDueDate(period: TaxPeriod): string {
  const end = new Date(Number(period.to.slice(0, 4)), Number(period.to.slice(5, 7)) - 1, 1);
  return nextWorkingDay(toIsoDate(new Date(end.getFullYear(), end.getMonth() + 2, 0)));
}

// ── U 30 Kennzahlen ─────────────────────────────────────────────────────────────

export type UvaSection = "umsatz" | "steuerfrei" | "steuerpflichtig" | "steuerschuld" | "erwerb" | "vorsteuer" | "berichtigung" | "ergebnis";

export interface KzMeta {
  kz: string;
  label: string;
  section: UvaSection;
  /** rate in bp when the KZ is a taxable base with a computed tax column */
  rateBp?: number;
}

/** The Kennzahlen this app can fill, in form order (U 30, Version 2026). */
export const UVA_KZ: readonly KzMeta[] = [
  { kz: "000", section: "umsatz", label: "Gesamtbetrag der Bemessungsgrundlagen für Lieferungen und sonstige Leistungen" },
  { kz: "021", section: "umsatz", label: "abzüglich Umsätze, für die die Steuerschuld auf den Leistungsempfänger übergegangen ist" },
  { kz: "011", section: "steuerfrei", label: "Ausfuhrlieferungen (§ 6 Abs. 1 Z 1 iVm § 7)" },
  { kz: "017", section: "steuerfrei", label: "Innergemeinschaftliche Lieferungen (Art. 6 Abs. 1)" },
  { kz: "016", section: "steuerfrei", label: "Kleinunternehmer (§ 6 Abs. 1 Z 27)" },
  { kz: "022", section: "steuerpflichtig", label: "20 % Normalsteuersatz", rateBp: 2000 },
  { kz: "029", section: "steuerpflichtig", label: "10 % ermäßigter Steuersatz", rateBp: 1000 },
  { kz: "006", section: "steuerpflichtig", label: "13 % ermäßigter Steuersatz", rateBp: 1300 },
  { kz: "037", section: "steuerpflichtig", label: "19 % für Jungholz und Mittelberg", rateBp: 1900 },
  { kz: "056", section: "steuerschuld", label: "Steuerschuld gemäß § 11 Abs. 12 und 14, § 16 Abs. 2 sowie Art. 7 Abs. 4" },
  { kz: "057", section: "steuerschuld", label: "Steuerschuld gemäß § 19 Abs. 1 zweiter Satz, § 19 Abs. 1c, 1e sowie Art. 25 Abs. 5 (Reverse Charge)" },
  { kz: "070", section: "erwerb", label: "Gesamtbetrag der Bemessungsgrundlagen für innergemeinschaftliche Erwerbe" },
  { kz: "071", section: "erwerb", label: "davon steuerfrei gemäß Art. 6 Abs. 2" },
  { kz: "072", section: "erwerb", label: "ig. Erwerbe 20 % Normalsteuersatz", rateBp: 2000 },
  { kz: "073", section: "erwerb", label: "ig. Erwerbe 10 % ermäßigter Steuersatz", rateBp: 1000 },
  { kz: "008", section: "erwerb", label: "ig. Erwerbe 13 % ermäßigter Steuersatz", rateBp: 1300 },
  { kz: "088", section: "erwerb", label: "ig. Erwerbe 19 % Jungholz und Mittelberg", rateBp: 1900 },
  { kz: "060", section: "vorsteuer", label: "Gesamtbetrag der Vorsteuern (ohne die gesondert anzuführenden Beträge)" },
  { kz: "061", section: "vorsteuer", label: "Vorsteuern betreffend die entrichtete Einfuhrumsatzsteuer (§ 12 Abs. 1 Z 2 lit. a)" },
  { kz: "065", section: "vorsteuer", label: "Vorsteuern aus dem innergemeinschaftlichen Erwerb" },
  { kz: "066", section: "vorsteuer", label: "Vorsteuern betreffend die Steuerschuld gemäß § 19 Abs. 1 zweiter Satz, 1c, 1e sowie Art. 25 Abs. 5" },
  { kz: "067", section: "berichtigung", label: "Berichtigung gemäß § 16 (Vorsteuer)" },
  { kz: "090", section: "berichtigung", label: "Sonstige Berichtigungen" },
  { kz: "095", section: "ergebnis", label: "Vorauszahlung (Zahllast) / Überschuss (Gutschrift)" },
];

export const UVA_SECTION_LABELS: Record<UvaSection, string> = {
  umsatz: "Lieferungen, sonstige Leistungen und Eigenverbrauch",
  steuerfrei: "Davon steuerfrei mit / ohne Vorsteuerabzug",
  steuerpflichtig: "Davon steuerpflichtig",
  steuerschuld: "Weitere Steuerschulden",
  erwerb: "Innergemeinschaftliche Erwerbe",
  vorsteuer: "Abziehbare Vorsteuer",
  berichtigung: "Berichtigungen",
  ergebnis: "Ergebnis",
};

/** KZ for taxable domestic revenue at a rate. */
export const REVENUE_RATE_KZ: Record<number, string> = { 2000: "022", 1000: "029", 1300: "006", 1900: "037" };
/** KZ for intra-community acquisitions at a rate (0 % → 071 steuerfrei). */
export const ACQUISITION_RATE_KZ: Record<number, string> = { 2000: "072", 1000: "073", 1300: "008", 1900: "088", 0: "071" };
