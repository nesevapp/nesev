// Parsing and check-digit helpers for receipt analysis (amounts, dates, UID, IBAN).

/**
 * "1.234,56" / "1,234.56" / "49.00" / "17,11" / "-3,20" / "1 234,56" → cents. The last "," or "." followed by
 * 1–2 digits is the decimal separator; other separators are thousands groups.
 */
export function parseAmountCents(input: string): number | null {
  let s = input.trim().replace(/[€\s ']|EUR/gi, "");
  let sign = 1;
  if (/^-|-$/.test(s)) {
    sign = -1;
    s = s.replace(/^-|-$/g, "");
  }
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const m = /^(.*?)[.,](\d{1,2})$/.exec(s);
  let whole = s;
  let frac = "00";
  if (m) {
    whole = m[1]!;
    frac = m[2]!.padEnd(2, "0");
  }
  if (!/^\d{1,3}([.,]?\d{3})*$|^\d+$/.test(whole)) return null;
  const cents = Number(whole.replace(/[.,]/g, "")) * 100 + Number(frac);
  return Number.isFinite(cents) ? sign * cents : null;
}

/** Number from the model (EUR, may be a string) → cents. */
export function eurToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === "string") return parseAmountCents(value);
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, jänner: 1, jaenner: 1, jän: 1,
  feb: 2, februar: 2, february: 2, feber: 2,
  mar: 3, mär: 3, märz: 3, maerz: 3, march: 3, mrz: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Date regexes for free text; each match is converted by parseDate. */
export const DATE_PATTERN =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})(?!\d)|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.?\s+[A-Za-zÄäÖöÜü]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/g;

/** "12.09.2026", "12.9.26", "2026-09-12", "03 Oct 2026", "3. Oktober 2026", "October 3, 2026", "20260912" → ISO. */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})$/.exec(s);
  if (m) return isoDate(+m[3]!, +m[2]!, +m[1]!);
  // dd/mm/yyyy (European order)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return isoDate(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})\.?\s+([A-Za-zÄäÖöÜü]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? isoDate(+m[3]!, month, +m[1]!) : null;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month ? isoDate(+m[3]!, month, +m[2]!) : null;
  }
  return null;
}

// --- UID (VAT identification number) -----------------------------------------------------------------

/** Formats per country (without the prefix); see VIES. */
const UID_FORMATS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[0-9A-Z]\d{7}[0-9A-Z]$/,
  FI: /^\d{8}$/,
  FR: /^[0-9A-Z]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^\d{7}[A-Z]{1,2}$|^\d[A-Z+*]\d{5}[A-Z]$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12})$/,
  CHE: /^\d{9}(MWST|TVA|IVA)?$/,
  GB: /^(\d{9}|\d{12})$/,
};

/** Candidate UIDs in free text, e.g. "ATU 3767 5002", "IE6388047V", "DE 123456789". */
export const UID_PATTERN =
  /\b(ATU\s?\d{4}\s?\d{4}|DE\s?\d{9}|CHE[-\s]?\d{3}\.?\d{3}\.?\d{3}(?:\s?(?:MWST|TVA|IVA))?|(?:BE|BG|CY|CZ|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|GB|XI)\s?[0-9A-Z+*]{8,12})\b/g;

export function normalizeUid(uid: string): string {
  return uid.toUpperCase().replace(/[\s.\-]/g, "");
}

/** ISO country of a UID ("EL" → "GR", "CHE" → "CH", "XI" → "GB"). */
export function uidCountry(uid: string): string | null {
  const u = normalizeUid(uid);
  if (u.startsWith("CHE")) return "CH";
  const prefix = u.slice(0, 2);
  if (prefix === "EL") return "GR";
  if (prefix === "XI") return "GB";
  return UID_FORMATS[prefix] ? prefix : null;
}

const crossSum = (n: number) => (n > 9 ? n - 9 : n);

/** Austrian UID check digit (ATU + 8 digits). */
function atChecksumValid(digits: string): boolean {
  const d = [...digits].map(Number);
  const r = d[0]! + crossSum(2 * d[1]!) + d[2]! + crossSum(2 * d[3]!) + d[4]! + crossSum(2 * d[5]!) + d[6]!;
  return (10 - ((r + 4) % 10)) % 10 === d[7];
}

/** German USt-IdNr check digit (ISO 7064 MOD 11,10). */
function deChecksumValid(digits: string): boolean {
  let product = 10;
  for (let i = 0; i < 8; i++) {
    let sum = (Number(digits[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(digits[8]);
}

export type UidCheck = "valid" | "format_ok" | "invalid";

/** Format check for all EU countries, check digit for AT and DE. */
export function checkUid(uid: string): UidCheck {
  const u = normalizeUid(uid);
  const prefix = u.startsWith("CHE") ? "CHE" : u.slice(0, 2);
  const rest = u.slice(prefix.length);
  const format = UID_FORMATS[prefix];
  if (!format || !format.test(rest)) return "invalid";
  if (prefix === "AT") return atChecksumValid(rest.slice(1)) ? "valid" : "invalid";
  if (prefix === "DE") return deChecksumValid(rest) ? "valid" : "invalid";
  return "format_ok";
}

// --- IBAN ----------------------------------------------------------------------------------------------

const IBAN_LENGTHS: Record<string, number> = {
  AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18, FR: 27, GB: 22,
  GR: 27, HR: 21, HU: 28, IE: 22, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MT: 31, NL: 18, NO: 15, PL: 28,
  PT: 25, RO: 24, SE: 24, SI: 19, SK: 24,
};

export const IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g;

export function normalizeIban(iban: string): string {
  return iban.toUpperCase().replace(/\s+/g, "");
}

/** A valid IBAN at the start of a regex match ("AT48 3200 … 5864 BIC" → "AT48…5864"), or null. */
export function ibanFromMatch(raw: string): string | null {
  const s = normalizeIban(raw);
  const len = IBAN_LENGTHS[s.slice(0, 2)];
  if (len) return ibanValid(s.slice(0, len)) ? s.slice(0, len) : null;
  return ibanValid(s) ? s : null;
}

/** Length per country (if known) and mod-97 check. */
export function ibanValid(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s)) return false;
  const len = IBAN_LENGTHS[s.slice(0, 2)];
  if (len && s.length !== len) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

/** Normalized name for supplier matching: lower case, no legal form, punctuation or spaces. */
export function normalizeSupplierName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(gmbh|ag|og|kg|e\.?\s?u\.?|ltd|limited|inc|llc|se|s\.?a\.?|b\.?v\.?|co|& co|gesmbh|ges\.m\.b\.h\.)\b/g, "")
    .replace(/[^a-z0-9äöüß]/g, "");
}
