import { defaultVatTreatment, netFromGross, type VatTreatment } from "../../shared/expenses";
import type { FieldSuggestion, ReceiptFields, TaxLineSuggestion } from "../../shared/receipts";
import { addDays } from "../../shared/dates";
import type { ExpenseCategoryKey } from "../../shared/expenses";
import {
  checkUid,
  DATE_PATTERN,
  IBAN_PATTERN,
  ibanFromMatch,
  normalizeIban,
  normalizeUid,
  parseAmountCents,
  parseDate,
  UID_PATTERN,
  uidCountry,
} from "./receipt-parse";

// Rule-based field extraction for (mostly Austrian) receipts and invoices. Works without any model, so the
// user gets partial results even when the model can't run; with a model it serves as a cross-check.

export interface RulesContext {
  /** our own UID / IBAN / company name (from settings), never the supplier's */
  ownUid?: string;
  ownIban?: string;
  ownName?: string;
}

const rules = <T>(value: T, confidence: number): FieldSuggestion<T> => ({ value, confidence, source: "rules" });

/** amounts with exactly two decimals, e.g. "1.234,56", "1,234.56", "17,11", "-3,20" (not "3,5%" or "1,2kg") */
const AMOUNT_RE = /(?<![\d.,])-?\d{1,3}(?:[.\s]\d{3})*,\d{2}(?![\d%])|(?<![\d.,])-?\d{1,3}(?:,\d{3})*\.\d{2}(?![\d%])|(?<![\d.,])-?\d+[.,]\d{2}(?![\d%])/g;

export function amountsIn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const after = line.slice(m.index! + m[0].length).trimStart();
    if (after.startsWith("%")) continue;
    const cents = parseAmountCents(m[0]);
    if (cents != null) out.push(cents);
  }
  return out;
}

const RATE_RE = /(?<![\d,.])(\d{1,2})(?:[.,](\d{1,2}))?\s?%/g;
/** rates that may appear on receipts (AT rates plus common EU ones; validation flags non-AT rates) */
const KNOWN_RATES_BP = new Set([0, 500, 700, 900, 1000, 1300, 1900, 2000, 2100, 2200, 2300, 2400, 2500]);

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
const taxOf = (net: number, rateBp: number) => Math.round((net * rateBp) / 10000);

/** Interprets the amounts of a tax-summary row ("A 10% 6,03 0,60 6,63", "zzgl. 20% USt 80,00"). */
function taxRow(rateBp: number, amounts: number[], gross?: number): Partial<TaxLineSuggestion> | null {
  for (let i = 0; i + 2 < amounts.length; i++) {
    const [a, b, c] = [amounts[i]!, amounts[i + 1]!, amounts[i + 2]!];
    if (near(a + b, c) && near(taxOf(a, rateBp), b, Math.max(2, a / 1000))) return { netCents: a, taxCents: b, grossCents: c };
  }
  if (amounts.length >= 2) {
    const [a, b] = amounts.slice(-2) as [number, number];
    if (near(taxOf(a, rateBp), b)) return { netCents: a, taxCents: b, grossCents: a + b };
    if (near(taxOf(b, rateBp), a)) return { netCents: b, taxCents: a, grossCents: a + b };
    // tax and gross
    if (b > a && near(taxOf(b - a, rateBp), a)) return { netCents: b - a, taxCents: a, grossCents: b };
    if (a > b && near(taxOf(a - b, rateBp), b)) return { netCents: a - b, taxCents: b, grossCents: a };
  }
  if (amounts.length >= 1) {
    const x = amounts[amounts.length - 1]!;
    // "Gesamt 120,00 inkl. 20 % MwSt." – the amount is the gross total
    if (gross != null && x === gross && rateBp > 0) return { ...netFromGross(gross, rateBp), grossCents: gross };
    return rateBp === 0 ? { taxCents: 0, ...(x ? { netCents: x } : {}) } : { taxCents: x };
  }
  return null;
}

const NET_TOTAL_RE = /\b(summe netto|netto(?:betrag|summe)?|zwischensumme|subtotal|sub-total|net amount|total net|total excl\.?(?: vat)?)\b/i;
const GROSS_STRONG_RE =
  /\b(zu zahlen|zahlbetrag|rechnungsbetrag|gesamtbetrag|endbetrag|endsumme|amount due|total due|grand total|balance due|total amount|bruttobetrag|gesamt brutto|summe brutto)\b/i;
const GROSS_WEAK_RE = /\b(gesamt|total|summe|brutto|betrag)\b/i;
const NOT_GROSS_RE = /(netto|\bnet\b|subtotal|sub-total|zwischensumme|exkl|excl|ohne\s+(ust|mwst)|rückgeld|rueckgeld|gegeben|\bbar\b|change)/i;
const RATE_ON_LINE = /\d\s?%/;
/** "Gesamt 120,00 inkl. 20 % MwSt." */
const INCLUSIVE_RE = /\b(inkl|incl|including|inklusive)\b/i;

function findGross(lines: string[]): FieldSuggestion<number> | undefined {
  let best: { cents: number; prio: number } | undefined;
  lines.forEach((line, i) => {
    const prio = GROSS_STRONG_RE.test(line) ? 2 : GROSS_WEAK_RE.test(line) ? 1 : 0;
    if (!prio || NOT_GROSS_RE.test(line) || (RATE_ON_LINE.test(line) && !INCLUSIVE_RE.test(line))) return;
    let amounts = amountsIn(line);
    // OCR sometimes puts the amount on the next line
    if (!amounts.length && lines[i + 1] && /^[^A-Za-z]*$/.test(lines[i + 1]!)) amounts = amountsIn(lines[i + 1]!);
    const cents = amounts[amounts.length - 1];
    if (cents == null || cents <= 0) return;
    if (!best || prio > best.prio || (prio === best.prio && cents > best.cents)) best = { cents, prio };
  });
  return best && rules(best.cents, best.prio === 2 ? 0.75 : 0.65);
}

function findNetTotal(lines: string[]): number | undefined {
  for (const line of lines) {
    if (!NET_TOTAL_RE.test(line) || RATE_ON_LINE.test(line)) continue;
    const amounts = amountsIn(line);
    if (amounts.length) return amounts[amounts.length - 1];
  }
  return undefined;
}

function findTaxLines(lines: string[], gross: number | undefined, netTotal: number | undefined) {
  const rows = new Map<number, Partial<TaxLineSuggestion>>();
  for (const line of lines) {
    if (/rabatt|skonto|discount|nachlass|ermäßigung/i.test(line)) continue;
    const rates = [...line.matchAll(RATE_RE)];
    if (rates.length !== 1) continue;
    const m = rates[0]!;
    const rateBp = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
    if (!KNOWN_RATES_BP.has(rateBp) || rows.has(rateBp)) continue;
    // a tax keyword or a summary-table shape ("A 10% 6,03 0,60 6,63")
    const amounts = amountsIn(line);
    const isTaxLine = /\b(ust|mwst|mwst\.|vat|tax|steuer|ust\.|est)\b/i.test(line) || amounts.length >= 3;
    if (!isTaxLine) continue;
    const row = taxRow(rateBp, amounts, gross);
    if (row) rows.set(rateBp, row);
  }
  // "inkl. 20 % MwSt." without amounts → derive from the gross total
  if (!rows.size && gross) {
    const incl = /inkl\.?\s*(\d{1,2})\s?%/i.exec(lines.join("\n"));
    if (incl && KNOWN_RATES_BP.has(Number(incl[1]) * 100)) {
      const rateBp = Number(incl[1]) * 100;
      const { netCents, taxCents } = netFromGross(gross, rateBp);
      return { rows: [{ taxRateBp: rateBp, netCents, taxCents, grossCents: gross }], derived: true };
    }
  }

  const complete: TaxLineSuggestion[] = [];
  const single = rows.size === 1;
  for (const [taxRateBp, r] of rows) {
    let netCents = r.netCents;
    const taxCents = r.taxCents ?? 0;
    if (netCents == null && single) netCents = netTotal ?? (gross != null ? gross - taxCents : undefined);
    if (netCents == null) continue;
    complete.push({ taxRateBp, netCents, taxCents, grossCents: r.grossCents ?? netCents + taxCents });
  }
  return { rows: complete.sort((a, b) => a.taxRateBp - b.taxRateBp), derived: false };
}

const ISSUE_LABEL = /(rechnungsdatum|belegdatum|ausstellungsdatum|invoice date|date of issue|issue date|datum|date)\b/i;
const DUE_LABEL = /(fällig|faellig|zahlbar bis|due date|payment due|due on|zahlungsziel|fälligkeit|bis\s+\d)/i;
const NOT_ISSUE = /(fällig|faellig|due|leistung|liefer|zeitraum|period|zahlbar|gültig|valid|geburts|seit)/i;

function datesIn(line: string): string[] {
  return [...line.matchAll(DATE_PATTERN)].map((m) => parseDate(m[0])).filter((d): d is string => !!d);
}

function findDates(lines: string[]) {
  let issueDate: FieldSuggestion<string> | undefined;
  let dueDate: FieldSuggestion<string> | undefined;
  for (const line of lines) {
    const dates = datesIn(line);
    if (!dates.length) continue;
    if (!dueDate && DUE_LABEL.test(line)) dueDate = rules(dates[dates.length - 1]!, 0.7);
    else if (!issueDate && ISSUE_LABEL.test(line) && !NOT_ISSUE.test(line)) issueDate = rules(dates[0]!, 0.75);
  }
  if (!issueDate) {
    const first = lines.find((l) => !NOT_ISSUE.test(l) && datesIn(l).length);
    if (first) issueDate = rules(datesIn(first)[0]!, 0.55);
  }
  if (!dueDate && issueDate) {
    const days = /(?:innerhalb|within|binnen)\s+(?:von\s+)?(\d{1,3})\s+(?:tagen|days)/i.exec(lines.join("\n"));
    if (days) dueDate = rules(addDays(issueDate.value, Number(days[1])), 0.5);
  }
  return { issueDate, dueDate };
}

const INVOICE_NO_RE =
  /(?:rechnungs?[-\s]?(?:nr|nummer|no)|rechnung\s+(?:nr|no)|rg\.?[-\s]?nr|re[-\s]?nr|beleg[-\s]?(?:nr|nummer)|invoice\s*(?:no|number|nr|#)|invoice\s*id|document\s*(?:no|number)|bon(?:[-\s]?nr)?|quittung\s*nr)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/._]{0,30})/i;

function findInvoiceNumber(lines: string[]): FieldSuggestion<string> | undefined {
  for (const line of lines) {
    const m = INVOICE_NO_RE.exec(line);
    if (m && /\d/.test(m[1]!)) {
      const value = m[1]!.replace(/[.:]+$/, "");
      return rules(value, /^bon/i.test(m[0]) ? 0.5 : 0.75);
    }
  }
  return undefined;
}

const CUSTOMER_CONTEXT = /(kunde|customer|bill to|billed to|rechnungsempfänger|rechnungsadresse|empfänger|ihre uid|your vat|client|an:)/i;
const UID_LABEL = /(uid|ust-?id|ust\.?-?idnr|vat|mwst|tax\s?id|steuer)/i;

function findUid(lines: string[], ownUid: string) {
  const candidates: { uid: string; score: number }[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(UID_PATTERN)) {
      const uid = normalizeUid(m[0]);
      if (uid === ownUid || checkUid(uid) === "invalid") continue;
      const context = `${lines[i - 1] ?? ""} ${line}`;
      let score = 1 - i / Math.max(lines.length, 1) / 2;
      if (UID_LABEL.test(line)) score += 1;
      if (CUSTOMER_CONTEXT.test(context)) score -= 2;
      candidates.push({ uid, score });
    }
  });
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0) return undefined;
  return rules(best.uid, best.score > 1 ? 0.8 : 0.6);
}

function findIban(text: string, ownIban: string): FieldSuggestion<string> | undefined {
  for (const m of text.toUpperCase().matchAll(IBAN_PATTERN)) {
    const iban = ibanFromMatch(m[0]);
    if (iban && iban !== ownIban) return rules(iban, 0.85);
  }
  return undefined;
}

const LEGAL_FORM = /\b(gmbh|ges\.?m\.?b\.?h|ag|og|kg|e\.\s?u\.|eu|ltd\.?|limited|inc\.?|llc|se|s\.a\.|s\.r\.l\.|b\.v\.|plc|gbr|kft|s\.p\.a\.|sp\. z o\.o\.)(?=$|[\s,.])/i;
const NOT_NAME = /^(rechnung|invoice|tax invoice|receipt|beleg|kassabon|kassenbon|quittung|bon|lieferschein|gutschrift|credit note|seite|page|original|kopie|copy)\b/i;

function findSupplierName(lines: string[], ownName: string): FieldSuggestion<string> | undefined {
  const head = lines.slice(0, 10).filter((l) => l.length >= 3 && l.length <= 80);
  const own = ownName.trim().toLowerCase();
  const usable = (l: string) =>
    !NOT_NAME.test(l) &&
    /[A-Za-zÄÖÜäöü]{3}/.test(l) &&
    !datesIn(l).length &&
    !/[:@]|www\.|https?:|tel\.?|fax|uid|iban|\d{4,}/i.test(l) &&
    !(own && l.toLowerCase().includes(own));
  const legal = head.find((l) => LEGAL_FORM.test(l) && usable(l));
  if (legal) return rules(legal.replace(/\s{2,}.*/, "").trim(), 0.65);
  const first = head.find(usable);
  return first ? rules(first.replace(/\s{2,}.*/, "").trim(), 0.4) : undefined;
}

function findCountry(text: string, uid?: string, iban?: string): FieldSuggestion<string> | undefined {
  const fromUid = uid ? uidCountry(uid) : null;
  if (fromUid) return rules(fromUid, 0.8);
  if (/\b(österreich|oesterreich|austria)\b/i.test(text) || /\bA-\d{4}\b/.test(text)) return rules("AT", 0.6);
  if (/\b(deutschland|germany)\b/i.test(text) || /\bD-\d{5}\b/.test(text)) return rules("DE", 0.55);
  if (/\b(ireland|irland)\b/i.test(text)) return rules("IE", 0.55);
  if (/\b(schweiz|switzerland|suisse)\b/i.test(text) || /\bCH-\d{4}\b/.test(text)) return rules("CH", 0.55);
  if (/\b(united states|usa|u\.s\.a\.)\b/i.test(text)) return rules("US", 0.5);
  if (iban) return rules(iban.slice(0, 2), 0.5);
  return rules("AT", 0.3);
}

function findCurrency(text: string): FieldSuggestion<string> | undefined {
  if (/\bEUR\b|€/.test(text)) return rules("EUR", 0.8);
  if (/\bUSD\b|US\$|\$\s?\d/.test(text)) return rules("USD", 0.7);
  if (/\bCHF\b/.test(text)) return rules("CHF", 0.7);
  if (/\bGBP\b|£/.test(text)) return rules("GBP", 0.7);
  return undefined;
}

const REVERSE_CHARGE_RE =
  /reverse[\s-]?charge|steuerschuldnerschaft|übergang der steuerschuld|uebergang der steuerschuld|art\.?\s*196|§\s*19\s*(abs|ustg)|autoliquidation|inversione contabile|vat to be accounted for by the recipient/i;
const IG_RE = /innergemeinschaftliche\s+lieferung|intra-?community\s+supply|art\.?\s*138|steuerfreie\s+ig/i;
const NO_VAT_RE = /kleinunternehmer|§\s*6\s*abs\.?\s*1\s*z\s*27|umsatzsteuerbefreit|nicht umsatzsteuerpflichtig|§\s*19\s*ustg\s*\(de\)/i;

function findTreatment(text: string, country: string | undefined, uid: string | undefined, taxLines: TaxLineSuggestion[]) {
  const hasTax = taxLines.some((l) => l.taxCents > 0);
  if (IG_RE.test(text) && country && country !== "AT") return rules<VatTreatment>("ig_acquisition", 0.75);
  if (REVERSE_CHARGE_RE.test(text)) return rules<VatTreatment>("reverse_charge", 0.8);
  if (NO_VAT_RE.test(text) && !hasTax) return rules<VatTreatment>("none", 0.7);
  if (!country || country === "AT") return rules<VatTreatment>("domestic", hasTax ? 0.75 : 0.55);
  return rules(defaultVatTreatment(country, uid), 0.5);
}

// Unambiguous trade / supplier terms: checked first, and at 0.7 they override the model's category unless the
// model reports ≥ 0.9 (see mergeFields).
// KFZ comes before the trades so "KFZ-Werkstätte Reparatur" stays KFZ.
const STRONG_CATEGORY_KEYWORDS: [ExpenseCategoryKey, RegExp][] = [
  ["kfz", /tankstelle|kfz[\s-]?(werkst|reparatur|service)|autowerkst|autohaus|reifen(wechsel|service|händler)|pickerl|§\s*57a|vignette/i],
  ["beratung", /steuerberat|wirtschaftstreuhand|rechtsanw|notariat|bilanzbuchhalt|lohnverrechnung/i],
  [
    "instandhaltung",
    /elektriker|elektroinstall|elektrotechni|elektromeister|elektro-?(betrieb|arbeiten|service)|installateur|installationsbetrieb|sanitär|haustechnik|heizungs?(technik|bau|service|wartung|tausch)|klima(technik|service|anlage)|tischlerei|schlosserei|malermeister|maler(betrieb|arbeiten)|anstreicher|glaserei|spenglerei|dachdecker|fliesenleger|bodenleger|reparatur|(?<!software-?)wartung|instandhaltung|instandsetzung|störungsbehebung|service-?techniker|service techniker|monteur|montagearbeiten|regiestunde|regiebericht/i,
  ],
  ["svs", /\bsvs\b|sozialversicherung der selbständigen/i],
];

const CATEGORY_KEYWORDS: [ExpenseCategoryKey, RegExp][] = [
  ["bewirtung", /gasthaus|gasthof|restaurant|wirtshaus|café|cafe|kaffeehaus|pizzeria|bistro|heuriger|trattoria|tisch\s*\d|bewirtung|speisen|getränke/i],
  ["software_abos", /software|saas|subscription|abonnement|\babo\b|hosting|cloud|domain|license|lizenz|pro plan|monthly plan|github|google workspace|microsoft 365|adobe|notion|slack|figma/i],
  ["beratung", /steuerberat|wirtschaftstreuhand|rechtsanwalt|notar|kanzlei|buchhaltung|lohnverrechnung/i],
  ["telefon_internet", /\b(a1|magenta|drei|hot|yesss|spusu)\b|mobilfunk|internet|breitband|telefon/i],
  ["kfz", /tankstelle|diesel|super\s?95|benzin|\b(omv|bp|shell|eni|jet|turmöl)\b|vignette|parkgarage|parken|kfz|werkstätte|reifen/i],
  ["reise", /hotel|übernachtung|nächtigung|öbb|\b(oebb|westbahn|flug|flughafen|airline|ryanair|taxi|uber|bolt|bahn|zugticket)\b/i],
  ["instandhaltung", /elektro|tischler|maler|handwerk|arbeitszeit|arbeitsstunde|anfahrt/i],
  ["buero", /büro|buero|papier|druckerpapier|toner|kuvert|ordner|kugelschreiber|libro|pagro|thalia|post\.at|porto|briefmarke/i],
  ["hardware_gwg", /notebook|laptop|monitor|bildschirm|tastatur|maus|smartphone|iphone|ipad|macbook|ssd|festplatte|mediamarkt|saturn|cyberport|apple store/i],
  ["fortbildung", /seminar|schulung|kurs|workshop|konferenz|conference|fachbuch|buch|weiterbildung|ticket.*(konferenz|conference)/i],
  ["werbung", /werbung|inserat|google ads|facebook ads|meta ads|linkedin ads|flyer|visitenkarten|druckerei|marketing/i],
  ["versicherung", /versicherung|polizze|prämie|uniqa|generali|allianz|wiener städtische|zurich|grawe/i],
  ["svs", /\bsvs\b|sozialversicherung der selbständigen/i],
  ["bankgebuehren", /kontoführung|kontofuehrung|bankgebühr|spesen|paypal fee|stripe fee|transaktionsgebühr/i],
  ["miete", /miete|betriebskosten|coworking|büroraum/i],
  ["wareneinkauf", /wareneinkauf|großhandel|metro|material|lieferung von waren/i],
];

export function findCategory(text: string): FieldSuggestion<ExpenseCategoryKey> | undefined {
  for (const [key, re] of STRONG_CATEGORY_KEYWORDS) if (re.test(text)) return rules(key, 0.7);
  for (const [key, re] of CATEGORY_KEYWORDS) if (re.test(text)) return rules(key, 0.45);
  return undefined;
}

/** Rule-based extraction from receipt text. */
export function extractWithRules(text: string, ctx: RulesContext = {}): { fields: ReceiptFields; warnings: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const ownUid = ctx.ownUid ? normalizeUid(ctx.ownUid) : "";
  const ownIban = ctx.ownIban ? normalizeIban(ctx.ownIban) : "";
  const fields: ReceiptFields = {};
  const warnings: string[] = [];

  fields.supplierName = findSupplierName(lines, ctx.ownName ?? "");
  fields.supplierUid = findUid(lines, ownUid);
  fields.iban = findIban(text, ownIban);
  fields.supplierCountry = findCountry(text, fields.supplierUid?.value, fields.iban?.value);
  fields.supplierInvoiceNumber = findInvoiceNumber(lines);
  Object.assign(fields, findDates(lines));
  fields.currency = findCurrency(text);
  fields.grossCents = findGross(lines);

  const { rows, derived } = findTaxLines(lines, fields.grossCents?.value, findNetTotal(lines));
  if (rows.length) fields.taxLines = rules(rows, derived ? 0.45 : 0.7);
  // without an explicit total, the tax table's sum is the best guess
  if (!fields.grossCents && rows.length) fields.grossCents = rules(rows.reduce((s, r) => s + r.grossCents, 0), 0.5);
  fields.vatTreatment = findTreatment(text, fields.supplierCountry?.value, fields.supplierUid?.value, rows);
  fields.category = findCategory(text);

  for (const k of Object.keys(fields) as (keyof ReceiptFields)[]) if (!fields[k]) delete fields[k];
  return { fields, warnings };
}
