import { type CsvDateFormat, type CsvMapping, csvMappingSchema } from "../../../shared/bank";
import { dataRows, detectDateFormat, detectDecimal, parseAmount, parseDate } from "./csv";

// CSV presets for bank exports common in Austria. A preset recognizes a file by its header (or, for
// header-less exports, by the shape of the first rows) and produces a CsvMapping. Decimal separator and
// date format are always re-detected from the data, so small format drifts don't break a preset.
//
// verified = built against a documented/known sample of the export; otherwise the layout is inferred and
// the user should check the preview (the mapping step is always shown for CSV files).

export interface CsvPresetInfo {
  id: string;
  label: string;
  verified: boolean;
}

interface Preset extends CsvPresetInfo {
  detect(rows: string[][], delimiter: CsvMapping["delimiter"]): CsvMapping | null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Index of the first header cell equal to one of the aliases (normalized). */
function find(header: string[], aliases: string[]): number | null {
  const h = header.map(norm);
  for (const a of aliases) {
    const i = h.indexOf(norm(a));
    if (i !== -1) return i;
  }
  return null;
}

const present = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);

function columnCells(rows: string[][], idx: number | null): string[] {
  return idx === null ? [] : rows.slice(0, 50).map((r) => r[idx] ?? "");
}

function finish(
  rows: string[][],
  partial: Partial<CsvMapping> & Pick<CsvMapping, "bookingDate" | "delimiter" | "hasHeader" | "preset">,
  defaults: { decimal: "," | "."; dateFormat: CsvDateFormat },
): CsvMapping {
  const data = dataRows(rows, { skipRows: partial.skipRows ?? 0, hasHeader: partial.hasHeader });
  const amountCells = [partial.amount, partial.credit, partial.debit].flatMap((c) => columnCells(data, c ?? null));
  const dateFormat = detectDateFormat(columnCells(data, partial.bookingDate)) ?? defaults.dateFormat;
  const decimal = amountCells.some((c) => /\d/.test(c)) ? detectDecimal(amountCells) : defaults.decimal;
  const header = partial.hasHeader ? (rows[partial.skipRows ?? 0] ?? []) : [];
  return csvMappingSchema.parse({
    encoding: "utf-8",
    ...partial,
    decimal,
    dateFormat,
    signature: signatureOf(rows, partial.hasHeader, partial.skipRows ?? 0, header),
  });
}

export function signatureOf(rows: string[][], hasHeader: boolean, skipRows: number, header?: string[]): string {
  if (hasHeader) return (header ?? rows[skipRows] ?? []).map(norm).join("|");
  return `cols:${rows[skipRows]?.length ?? 0}`;
}

interface HeaderSpec {
  id: string;
  label: string;
  verified: boolean;
  /** all of these alias groups must be present */
  required: string[][];
  columns: {
    bookingDate: string[];
    valueDate?: string[];
    amount?: string[];
    credit?: string[];
    debit?: string[];
    fee?: string[];
    currency?: string[];
    counterpartyName?: string[][];
    counterpartyIban?: string[];
    purpose?: string[][];
    reference?: string[];
    state?: string[];
  };
  stateAccept?: string[];
  decimal: "," | ".";
  dateFormat: CsvDateFormat;
}

function headerPreset(spec: HeaderSpec): Preset {
  return {
    id: spec.id,
    label: spec.label,
    verified: spec.verified,
    detect(rows, delimiter) {
      // the header may follow a few title lines (some exports put the account name first)
      for (let skip = 0; skip < Math.min(5, rows.length); skip++) {
        const header = rows[skip]!;
        if (!spec.required.every((aliases) => find(header, aliases) !== null)) continue;
        const c = spec.columns;
        const idx = (a?: string[]) => (a ? find(header, a) : null);
        const bookingDate = idx(c.bookingDate);
        if (bookingDate === null) continue;
        return finish(
          rows,
          {
            preset: spec.id,
            delimiter,
            hasHeader: true,
            skipRows: skip,
            bookingDate,
            valueDate: idx(c.valueDate),
            amount: idx(c.amount),
            credit: c.amount && idx(c.amount) !== null ? null : idx(c.credit),
            debit: c.amount && idx(c.amount) !== null ? null : idx(c.debit),
            fee: idx(c.fee),
            currency: idx(c.currency),
            counterpartyName: present((c.counterpartyName ?? []).map(idx)),
            counterpartyIban: idx(c.counterpartyIban),
            purpose: present((c.purpose ?? []).map(idx)),
            reference: idx(c.reference),
            stateColumn: idx(c.state),
            stateAccept: idx(c.state) === null ? [] : (spec.stateAccept ?? []),
          },
          spec,
        );
      }
      return null;
    },
  };
}

const PRESETS: Preset[] = [
  headerPreset({
    id: "n26",
    label: "N26",
    verified: true,
    required: [["Booking Date", "Date", "Buchungsdatum", "Datum"], ["Amount (EUR)", "Betrag (EUR)"]],
    columns: {
      bookingDate: ["Booking Date", "Date", "Buchungsdatum", "Datum"],
      valueDate: ["Value Date", "Wertstellungsdatum", "Valutadatum"],
      amount: ["Amount (EUR)", "Betrag (EUR)"],
      counterpartyName: [["Partner Name", "Payee", "Empfänger", "Partnername"]],
      counterpartyIban: ["Partner Iban", "Account number", "Kontonummer", "Partner IBAN"],
      purpose: [["Payment Reference", "Payment reference", "Verwendungszweck", "Zahlungsreferenz"]],
    },
    decimal: ".",
    dateFormat: "YYYY-MM-DD",
  }),
  headerPreset({
    id: "revolut-business",
    label: "Revolut Business",
    verified: true,
    required: [["Date completed (UTC)", "Date completed"], ["Total amount", "Amount"], ["State"]],
    columns: {
      bookingDate: ["Date completed (UTC)", "Date completed", "Date started (UTC)"],
      amount: ["Total amount"],
      currency: ["Payment currency", "Currency"],
      counterpartyName: [["Payer"], ["Description"]],
      counterpartyIban: ["Beneficiary IBAN"],
      purpose: [["Reference"], ["Description"]],
      reference: ["ID"],
      state: ["State"],
    },
    stateAccept: ["COMPLETED"],
    decimal: ".",
    dateFormat: "YYYY-MM-DD",
  }),
  headerPreset({
    id: "revolut",
    label: "Revolut",
    verified: true,
    required: [["Completed Date", "Datum des Abschlusses", "Abschlussdatum"], ["Amount", "Betrag"], ["Description", "Beschreibung"]],
    columns: {
      bookingDate: ["Completed Date", "Datum des Abschlusses", "Abschlussdatum", "Started Date", "Startdatum"],
      amount: ["Amount", "Betrag"],
      fee: ["Fee", "Gebühr"],
      currency: ["Currency", "Währung"],
      counterpartyName: [["Description", "Beschreibung"]],
      purpose: [["Description", "Beschreibung"]],
      state: ["State", "Status"],
    },
    stateAccept: ["COMPLETED", "ABGESCHLOSSEN"],
    decimal: ".",
    dateFormat: "YYYY-MM-DD",
  }),
  headerPreset({
    id: "wise",
    label: "Wise",
    verified: true,
    required: [["TransferWise ID", "Wise ID", "ID"], ["Amount"], ["Running Balance"]],
    columns: {
      bookingDate: ["Date"],
      amount: ["Amount"],
      currency: ["Currency"],
      counterpartyName: [["Payer Name"], ["Payee Name"], ["Merchant"]],
      counterpartyIban: ["Payee Account Number"],
      purpose: [["Payment Reference"], ["Description"]],
      reference: ["TransferWise ID", "Wise ID", "ID"],
    },
    decimal: ".",
    dateFormat: "DD-MM-YYYY",
  }),
  headerPreset({
    id: "george",
    label: "George (Erste Bank / Sparkasse)",
    verified: false,
    required: [["Buchungsdatum"], ["Partnername", "Partner Name", "Partner"], ["Betrag"]],
    columns: {
      bookingDate: ["Buchungsdatum"],
      valueDate: ["Valutadatum", "Valuta"],
      amount: ["Betrag"],
      currency: ["Währung"],
      counterpartyName: [["Partnername", "Partner Name", "Partner"]],
      counterpartyIban: ["Partner IBAN", "IBAN"],
      purpose: [["Verwendungszweck"], ["Zahlungsreferenz"], ["Buchungstext", "Buchungs-Info", "Buchungsinfo"]],
      reference: ["Buchungsreferenz", "Auftraggeberreferenz", "Referenz"],
    },
    decimal: ",",
    dateFormat: "DD.MM.YYYY",
  }),
  {
    // Mein ELBA (Raiffeisen): no header; Buchungsdatum;Buchungstext;Valutadatum;Betrag;Währung;Zeitstempel
    id: "elba",
    label: "Raiffeisen ELBA",
    verified: false,
    detect(rows, delimiter) {
      const r = rows[0];
      if (!r || r.length < 5 || r.length > 7) return null;
      if (!parseDate(r[0]!, "DD.MM.YYYY") || !parseDate(r[2]!, "DD.MM.YYYY")) return null;
      if (parseAmount(r[3]!, ",") === null || !/^[A-Z]{3}$/.test(r[4]!)) return null;
      return finish(
        rows,
        { preset: "elba", delimiter, hasHeader: false, bookingDate: 0, valueDate: 2, amount: 3, currency: 4, purpose: [1] },
        { decimal: ",", dateFormat: "DD.MM.YYYY" },
      );
    },
  },
  {
    // BAWAG / easybank: no header; Konto-IBAN;Text;Buchungsdatum;Valutadatum;Betrag;Währung
    id: "bawag",
    label: "BAWAG / easybank",
    verified: false,
    detect(rows, delimiter) {
      const r = rows[0];
      if (!r || r.length < 6 || !/^[A-Z]{2}\d{2}[A-Z0-9 ]{10,}$/.test(r[0]!)) return null;
      if (!parseDate(r[2]!, "DD.MM.YYYY") || parseAmount(r[4]!, ",") === null || !/^[A-Z]{3}$/.test(r[5]!)) return null;
      return finish(
        rows,
        { preset: "bawag", delimiter, hasHeader: false, bookingDate: 2, valueDate: 3, amount: 4, currency: 5, purpose: [1] },
        { decimal: ",", dateFormat: "DD.MM.YYYY" },
      );
    },
  },
];

export const CSV_PRESETS: CsvPresetInfo[] = [
  ...PRESETS.map(({ id, label, verified }) => ({ id, label, verified })),
  { id: "generic", label: "Andere Bank (eigene Zuordnung)", verified: true },
];

/** First preset that recognizes the file. */
export function detectPreset(rows: string[][], delimiter: CsvMapping["delimiter"], only?: string): CsvMapping | null {
  for (const p of PRESETS) {
    if (only && p.id !== only) continue;
    const m = p.detect(rows, delimiter);
    if (m) return m;
  }
  return null;
}

// ── Generic guess ───────────────────────────────────────────────────────────────

const GUESS = {
  bookingDate: ["buchungsdatum", "buchungstag", "booking date", "date", "datum", "transaction date", "completed date"],
  valueDate: ["valutadatum", "valuta", "wertstellung", "value date", "wertstellungsdatum"],
  amount: ["betrag", "amount", "umsatz", "betrag (eur)", "amount (eur)", "betrag in eur"],
  credit: ["haben", "gutschrift", "eingang", "credit", "einnahmen"],
  debit: ["soll", "lastschrift", "ausgang", "debit", "ausgaben"],
  currency: ["währung", "waehrung", "currency", "whg"],
  name: ["empfänger", "auftraggeber", "partnername", "partner name", "name", "zahlungspflichtiger", "begünstigter", "auftraggeber/empfänger", "payee", "counterparty", "beguenstigter/zahlungspflichtiger", "begünstigter/zahlungspflichtiger"],
  iban: ["iban", "partner iban", "iban auftraggeber", "iban empfänger", "konto", "kontonummer", "account number", "gegenkonto"],
  purpose: ["verwendungszweck", "buchungstext", "zahlungsreferenz", "text", "beschreibung", "description", "reference", "payment reference", "umsatztext", "zweck"],
  reference: ["buchungsreferenz", "referenz", "transaction id", "id"],
};

/** Best-effort mapping for an unknown CSV (header names in German/English, or column contents). */
export function guessMapping(rows: string[][], delimiter: CsvMapping["delimiter"]): CsvMapping {
  const first = rows[0] ?? [];
  const hasHeader = first.length > 0 && !first.some((c) => detectDateFormat([c]) !== null || parseAmount(c, ",") !== null);
  if (hasHeader) {
    const idx = (a: string[]) => find(first, a) ?? first.findIndex((h) => a.some((x) => norm(h).includes(x)));
    const opt = (a: string[]) => {
      const i = idx(a);
      return i === null || i < 0 ? null : i;
    };
    const amount = opt(GUESS.amount);
    const purpose = first
      .map((h, i) => (GUESS.purpose.some((x) => norm(h).includes(x)) ? i : -1))
      .filter((i) => i >= 0)
      .slice(0, 3);
    const name = opt(GUESS.name);
    return finish(
      rows,
      {
        preset: "generic",
        delimiter,
        hasHeader: true,
        bookingDate: opt(GUESS.bookingDate) ?? 0,
        valueDate: opt(GUESS.valueDate),
        amount,
        credit: amount === null ? opt(GUESS.credit) : null,
        debit: amount === null ? opt(GUESS.debit) : null,
        currency: opt(GUESS.currency),
        counterpartyName: name === null ? [] : [name],
        counterpartyIban: opt(GUESS.iban),
        purpose: purpose.filter((i) => i !== name),
        reference: opt(GUESS.reference),
      },
      { decimal: ",", dateFormat: "DD.MM.YYYY" },
    );
  }
  // no header: pick columns by content
  const sample = rows.slice(0, 30);
  const cols = first.map((_, i) => sample.map((r) => r[i] ?? ""));
  const dateCols = cols.map((c, i) => (detectDateFormat(c) ? i : -1)).filter((i) => i >= 0);
  const amountCol = cols.findIndex((c, i) => !dateCols.includes(i) && c.every((x) => parseAmount(x, ",") !== null));
  const textCols = cols
    .map((c, i) => ({ i, len: c.reduce((s, x) => s + x.length, 0) }))
    .filter(({ i }) => !dateCols.includes(i) && i !== amountCol)
    .sort((a, b) => b.len - a.len);
  return finish(
    rows,
    {
      preset: "generic",
      delimiter,
      hasHeader: false,
      bookingDate: dateCols[0] ?? 0,
      valueDate: dateCols[1] ?? null,
      amount: amountCol >= 0 ? amountCol : null,
      purpose: textCols[0] ? [textCols[0].i] : [],
    },
    { decimal: ",", dateFormat: "DD.MM.YYYY" },
  );
}
