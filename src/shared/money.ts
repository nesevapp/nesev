// Units used everywhere (DB, API, UI, PDF):
//   money     → integer cents          (1234 = 12,34 €)
//   quantity  → integer milli-units    (1500 = 1,5)
//   rates     → integer basis points   (2000 = 20 %)

export const QTY_SCALE = 1000;
export const BP_SCALE = 10000;

/** Round half away from zero (commercial rounding), safe for negatives. */
export function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

const eurFormatter = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" });
// Plain numbers use de-DE: browsers (CLDR) group de-AT plain numbers with a narrow space, not ".".
const decimalFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 123456 → "€ 1.234,56" (de-AT locale formatting). */
export function formatCents(cents: number): string {
  return eurFormatter.format(cents / 100);
}

/** 123456 → "1.234,56" (no currency symbol). */
export function formatCentsPlain(cents: number): string {
  return decimalFormatter.format(cents / 100);
}

/**
 * Parse user input like "1.234,56", "1234.5", "12" into cents. Returns null if invalid.
 * A single "." or "," followed by 1–2 digits at the end is treated as decimal separator.
 */
export function parseMoneyToCents(input: string): number | null {
  const n = parseLocaleDecimal(input);
  return n === null ? null : roundHalfAwayFromZero(n * 100);
}

/** Cents → string suitable for an <input> ("1234,56"). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** 1500 → "1,5" */
export function formatQuantity(milli: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(milli / QTY_SCALE);
}

/** "1,5" → 1500. Returns null if invalid. */
export function parseQuantity(input: string): number | null {
  const n = parseLocaleDecimal(input);
  return n === null ? null : roundHalfAwayFromZero(n * QTY_SCALE);
}

/** 2000 → "20 %", 550 → "5,5 %" */
export function formatBp(bp: number): string {
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(bp / 100)} %`;
}

export function percentToBp(percent: number): number {
  return Math.round(percent * 100);
}

/**
 * de-AT aware decimal parsing: "," is the decimal separator, "." thousands separator.
 * A lone "." is treated as decimal separator unless followed by exactly 3 digits ("1.500" = 1500).
 */
function parseLocaleDecimal(input: string): number | null {
  let s = input.trim().replace(/[\s€]/g, "");
  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  }
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    const dots = s.split(".").length - 1;
    if (dots > 1 || /^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(/\./g, "");
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return sign * Number(s);
}

// Machine formats (XML, e-invoices): "." as decimal separator, no grouping.

/** 123456 → "1234.56", -5 → "-0.05" */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** 1500 → "1.5", 2000 → "2", 1234 → "1.234" */
export function quantityToDecimal(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(milli);
  const frac = String(abs % QTY_SCALE).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${Math.floor(abs / QTY_SCALE)}${frac ? `.${frac}` : ""}`;
}

/** 2000 → "20.00", 550 → "5.50" (percent with two decimals) */
export function bpToPercentDecimal(bp: number): string {
  return centsToDecimal(bp);
}
