// EPC QR code ("GiroCode", "Zahlen mit Code"): a SEPA credit transfer that banking apps fill in from a scan.
// Format EPC069-12 version 002, character set 1 (UTF-8), unstructured remittance text:
//   BCD / 002 / 1 / SCT / BIC / name / IBAN / EUR<amount> / purpose / structured ref / text
// Limits: name ≤ 70 chars, text ≤ 140 chars, amount 0.01–999 999 999.99 EUR, whole payload ≤ 331 bytes.

export const EPC_MAX_BYTES = 331;
const NAME_MAX = 70;
const TEXT_MAX = 140;
const MAX_CENTS = 99_999_999_999;

export interface EpcQrArgs {
  /** payee name (company name or owner) */
  name: string;
  iban: string;
  /** optional in version 002; dropped if not 8 or 11 characters */
  bic: string;
  amountCents: number;
  /** unstructured remittance text, e.g. the invoice number */
  reference: string;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** One line of free text: no line breaks or control characters, single spaces. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Cuts at a code point boundary (never splits a surrogate pair). */
function truncate(s: string, maxChars: number): string {
  const chars = Array.from(s);
  return chars.length <= maxChars ? s : chars.slice(0, maxChars).join("").trimEnd();
}

/** Shortens until the UTF-8 encoding fits into maxBytes. */
function truncateBytes(s: string, maxBytes: number): string {
  if (bytes(s) <= maxBytes) return s;
  const chars = Array.from(s);
  while (chars.length && bytes(chars.join("")) > maxBytes) chars.pop();
  return chars.join("").trimEnd();
}

/** 12345 → "EUR123.45" (from integer cents, no float formatting). */
export function epcAmount(cents: number): string {
  return `EUR${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * EPC QR payload, or "" when nothing payable can be encoded (no valid IBAN, no name, amount out of range).
 * Name and text are cleaned and truncated to their field limits; if multi-byte characters still push the
 * payload over 331 bytes, the text is shortened first, then the name.
 */
export function epcQrPayload(args: EpcQrArgs): string {
  const iban = args.iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(iban)) return "";
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0 || args.amountCents > MAX_CENTS) return "";
  let name = truncate(clean(args.name), NAME_MAX);
  if (!name) return "";
  const bic = args.bic.replace(/\s+/g, "").toUpperCase();
  let text = truncate(clean(args.reference), TEXT_MAX);

  const build = () =>
    [
      "BCD",
      "002",
      "1",
      "SCT",
      /^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic) ? bic : "",
      name,
      iban,
      epcAmount(args.amountCents),
      "", // purpose code
      "", // structured reference (exclusive with the text)
      text,
    ]
      .join("\n")
      .replace(/\n+$/, ""); // empty trailing fields are left out

  let payload = build();
  const over = bytes(payload) - EPC_MAX_BYTES;
  if (over > 0) {
    text = truncateBytes(text, Math.max(0, bytes(text) - over));
    payload = build();
    const still = bytes(payload) - EPC_MAX_BYTES;
    if (still > 0) {
      name = truncateBytes(name, bytes(name) - still);
      payload = build();
    }
  }
  return payload;
}
