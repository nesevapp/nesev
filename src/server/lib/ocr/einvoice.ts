import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
} from "@pdfme/pdf-lib";
import { Unzlib } from "fflate";
import type { ReceiptFields, TaxLineSuggestion } from "../../../shared/receipts";
import { parseDate, uidCountry } from "../../services/receipt-parse";

// E-invoices embedded in PDFs: ZUGFeRD / Factur-X (UN/CEFACT CII) and XRechnung (CII or UBL).
// The XML carries exact values, so no OCR or model is needed for these.

// --- embedded files --------------------------------------------------------------------------------------

export interface EmbeddedFile {
  name: string;
  data: Uint8Array;
}

function decodeName(obj: unknown): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return "";
}

/** decoded size cap of one embedded file (an e-invoice XML is a few hundred KB; guards against deflate bombs) */
export const MAX_EMBEDDED_BYTES = 10 * 1024 * 1024;
const INFLATE_CHUNK = 16 * 1024;

/** zlib-inflates `data` in chunks; null when the output would exceed `max` bytes or the data is broken. */
export function inflateCapped(data: Uint8Array, max: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  const inflater = new Unzlib((chunk) => {
    total += chunk.length;
    if (total > max) over = true;
    else chunks.push(chunk);
  });
  try {
    for (let i = 0; i < data.length && !over; i += INFLATE_CHUNK) {
      inflater.push(data.subarray(i, i + INFLATE_CHUNK), i + INFLATE_CHUNK >= data.length);
    }
  } catch {
    return null;
  }
  if (over) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Decoded bytes of an embedded file stream, at most MAX_EMBEDDED_BYTES. Only unfiltered and plain FlateDecode streams
 * (what ZUGFeRD / Factur-X writers produce) are decoded, with a size cap; other filters (LZW, predictors …) and
 * larger files are skipped, since pdf-lib's decoder would inflate them without a limit.
 */
function streamBytes(stream: unknown): Uint8Array | null {
  if (stream instanceof PDFRawStream) {
    const filter = stream.dict.lookup(PDFName.of("Filter"));
    const filters = filter instanceof PDFArray ? filter.asArray().map((f) => stream.dict.context.lookup(f)) : filter ? [filter] : [];
    const raw = stream.getContents();
    if (filters.length === 0) return raw.length <= MAX_EMBEDDED_BYTES ? raw : null;
    if (filters.length === 1 && filters[0] === PDFName.of("FlateDecode") && !stream.dict.lookup(PDFName.of("DecodeParms"))) {
      return inflateCapped(raw, MAX_EMBEDDED_BYTES);
    }
    return null;
  }
  if (stream instanceof PDFStream) {
    const raw = stream.getContents();
    return raw.length <= MAX_EMBEDDED_BYTES ? raw : null;
  }
  return null;
}

/** All files in the PDF's EmbeddedFiles name tree (and the PDF/A-3 /AF array). */
export async function pdfEmbeddedFiles(bytes: Uint8Array): Promise<EmbeddedFile[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;
  const files: EmbeddedFile[] = [];
  const seen = new Set<unknown>();

  const addFileSpec = (specRef: unknown, fallbackName = "") => {
    const spec = ctx.lookup(specRef as never);
    if (!(spec instanceof PDFDict) || seen.has(spec)) return;
    seen.add(spec);
    const name = decodeName(spec.lookup(PDFName.of("UF"))) || decodeName(spec.lookup(PDFName.of("F"))) || fallbackName;
    const ef = spec.lookup(PDFName.of("EF"));
    if (!(ef instanceof PDFDict)) return;
    const data = streamBytes(ef.lookup(PDFName.of("F")) ?? ef.lookup(PDFName.of("UF")));
    if (data) files.push({ name, data });
  };

  const walkNameTree = (node: unknown, depth = 0) => {
    if (!(node instanceof PDFDict) || depth > 10) return;
    const names = node.lookup(PDFName.of("Names"));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) addFileSpec(names.get(i + 1), decodeName(names.lookup(i)));
    }
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walkNameTree(kids.lookup(i), depth + 1);
  };

  const catalog = doc.catalog;
  const names = catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) walkNameTree(names.lookup(PDFName.of("EmbeddedFiles")));
  const af = catalog.lookup(PDFName.of("AF"));
  if (af instanceof PDFArray) for (let i = 0; i < af.size(); i++) addFileSpec(af.get(i));
  return files;
}

const EINVOICE_NAMES = /^(factur-x|zugferd-invoice|zugferd_invoice|xrechnung|order-x)\.xml$/i;

/** The e-invoice XML embedded in a PDF, if any. */
export async function extractEmbeddedInvoiceXml(bytes: Uint8Array): Promise<string | null> {
  let files: EmbeddedFile[];
  try {
    files = await pdfEmbeddedFiles(bytes);
  } catch {
    return null;
  }
  const xmlFiles = files
    .filter((f) => f.name.toLowerCase().endsWith(".xml"))
    .map((f) => ({ name: f.name, xml: new TextDecoder().decode(f.data) }));
  const match =
    xmlFiles.find((f) => EINVOICE_NAMES.test(f.name)) ??
    xmlFiles.find((f) => /CrossIndustryInvoice|urn:oasis:names:specification:ubl:schema:xsd:(Invoice|CreditNote)/.test(f.xml));
  return match?.xml ?? null;
}

// --- minimal XML tree ---------------------------------------------------------------------------------------

export interface XmlNode {
  /** local name without namespace prefix */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      // only Unicode scalar values: fromCodePoint throws above 0x10FFFF, lone surrogates aren't text
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e] ?? all;
  });
}

const localName = (qname: string) => qname.slice(qname.indexOf(":") + 1);

/** Small non-validating XML parser (elements, attributes, text, CDATA). Enough for invoice XML. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[localName(a[1]!)] = unescapeXml(a[2] ?? a[3] ?? "");
      }
      const node: XmlNode = { name: localName(m[3]), attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += unescapeXml(m[6]);
  }
  return root;
}

/** First descendant along a path of local names, e.g. find(root, "SellerTradeParty", "Name"). */
export function find(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  if (!node) return undefined;
  if (!path.length) return node;
  const [head, ...rest] = path;
  for (const child of node.children) {
    if (child.name === head) {
      const hit = find(child, ...rest);
      if (hit) return hit;
    }
  }
  // descend (path does not have to start at a direct child)
  for (const child of node.children) {
    const hit = find(child, ...path);
    if (hit) return hit;
  }
  return undefined;
}

export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

const textOf = (node: XmlNode | undefined) => node?.text.trim() ?? "";
const children = (node: XmlNode | undefined, name: string) => node?.children.filter((c) => c.name === name) ?? [];

function amountCents(node: XmlNode | undefined): number | null {
  const t = textOf(node);
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

function rateBp(node: XmlNode | undefined): number | null {
  const t = textOf(node);
  return t && /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t) * 100) : null;
}

// --- mapping ---------------------------------------------------------------------------------------------

export interface EInvoiceResult {
  format: "cii" | "ubl";
  fields: ReceiptFields;
  warnings: string[];
  /** a readable summary for the "Text" view */
  summary: string;
}

const xml = <T>(value: T, confidence = 0.98) => ({ value, confidence, source: "xml" as const });

/** VAT category codes: AE = reverse charge, K = intra-community supply, E/O/Z = exempt / not taxable. */
function treatmentFromCategories(codes: string[], country: string | undefined) {
  if (codes.includes("AE")) return "reverse_charge" as const;
  if (codes.includes("K")) return "ig_acquisition" as const;
  if (codes.length && codes.every((c) => c === "E" || c === "O" || c === "Z")) {
    return country && country !== "AT" ? ("reverse_charge" as const) : ("none" as const);
  }
  return country && country !== "AT" ? undefined : ("domestic" as const);
}

function parseCii(root: XmlNode): EInvoiceResult {
  const warnings: string[] = [];
  const fields: ReceiptFields = {};
  const doc = find(root, "ExchangedDocument");
  const seller = find(root, "SellerTradeParty");
  const settlement = find(root, "ApplicableHeaderTradeSettlement");
  const typeCode = textOf(find(doc, "TypeCode"));
  if (typeCode === "381") warnings.push("E-Rechnung ist eine Gutschrift (TypeCode 381)");

  const name = textOf(find(seller, "Name"));
  if (name) fields.supplierName = xml(name);
  const reg = children(seller, "SpecifiedTaxRegistration").map((r) => find(r, "ID"));
  const uid = textOf(reg.find((r) => r?.attrs.schemeID === "VA") ?? undefined);
  if (uid) fields.supplierUid = xml(uid.replace(/\s+/g, ""));
  const country = textOf(find(seller, "PostalTradeAddress", "CountryID")) || (uid ? (uidCountry(uid) ?? "") : "");
  if (country) fields.supplierCountry = xml(country.toUpperCase());
  const number = textOf(find(doc, "ID"));
  if (number) fields.supplierInvoiceNumber = xml(number);
  const issue = parseDate(textOf(find(doc, "IssueDateTime", "DateTimeString")));
  if (issue) fields.issueDate = xml(issue);
  const due = parseDate(textOf(find(settlement, "SpecifiedTradePaymentTerms", "DueDateDateTime", "DateTimeString")));
  if (due) fields.dueDate = xml(due);
  const currency = textOf(find(settlement, "InvoiceCurrencyCode"));
  if (currency) fields.currency = xml(currency);
  const iban = textOf(find(settlement, "PayeePartyCreditorFinancialAccount", "IBANID"));
  if (iban) fields.iban = xml(iban.replace(/\s+/g, ""));

  const sums = find(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const gross = amountCents(find(sums, "GrandTotalAmount")) ?? amountCents(find(sums, "DuePayableAmount"));
  if (gross != null) fields.grossCents = xml(gross);

  const codes: string[] = [];
  const lines: TaxLineSuggestion[] = [];
  for (const t of children(settlement, "ApplicableTradeTax")) {
    const net = amountCents(find(t, "BasisAmount"));
    const tax = amountCents(find(t, "CalculatedAmount")) ?? 0;
    const rate = rateBp(find(t, "RateApplicablePercent")) ?? 0;
    codes.push(textOf(find(t, "CategoryCode")));
    if (net != null) lines.push({ taxRateBp: rate, netCents: net, taxCents: tax, grossCents: net + tax });
  }
  if (lines.length) fields.taxLines = xml(lines);
  const treatment = treatmentFromCategories(codes, fields.supplierCountry?.value);
  if (treatment) fields.vatTreatment = xml(treatment, 0.9);

  const firstItem = textOf(find(root, "IncludedSupplyChainTradeLineItem", "SpecifiedTradeProduct", "Name"));
  if (firstItem) fields.description = xml(firstItem.slice(0, 120), 0.6);
  return { format: "cii", fields, warnings, summary: "" };
}

function parseUbl(root: XmlNode): EInvoiceResult {
  const warnings: string[] = [];
  const fields: ReceiptFields = {};
  const top = root.children[0]!;
  if (top.name === "CreditNote") warnings.push("E-Rechnung ist eine Gutschrift");
  const party = find(top, "AccountingSupplierParty", "Party");
  const name = textOf(find(party, "PartyName", "Name")) || textOf(find(party, "PartyLegalEntity", "RegistrationName"));
  if (name) fields.supplierName = xml(name);
  const uid = textOf(find(party, "PartyTaxScheme", "CompanyID"));
  if (uid) fields.supplierUid = xml(uid.replace(/\s+/g, ""));
  const country = textOf(find(party, "PostalAddress", "Country", "IdentificationCode")) || (uid ? (uidCountry(uid) ?? "") : "");
  if (country) fields.supplierCountry = xml(country.toUpperCase());
  const number = textOf(children(top, "ID")[0]);
  if (number) fields.supplierInvoiceNumber = xml(number);
  const issue = parseDate(textOf(children(top, "IssueDate")[0]));
  if (issue) fields.issueDate = xml(issue);
  const due = parseDate(textOf(children(top, "DueDate")[0]) || textOf(find(top, "PaymentMeans", "PaymentDueDate")));
  if (due) fields.dueDate = xml(due);
  const currency = textOf(children(top, "DocumentCurrencyCode")[0]);
  if (currency) fields.currency = xml(currency);
  const iban = textOf(find(top, "PaymentMeans", "PayeeFinancialAccount", "ID"));
  if (iban) fields.iban = xml(iban.replace(/\s+/g, ""));
  const totals = find(top, "LegalMonetaryTotal");
  const gross = amountCents(find(totals, "TaxInclusiveAmount")) ?? amountCents(find(totals, "PayableAmount"));
  if (gross != null) fields.grossCents = xml(gross);

  const codes: string[] = [];
  const lines: TaxLineSuggestion[] = [];
  for (const sub of findAll(children(top, "TaxTotal")[0] ?? top, "TaxSubtotal")) {
    const net = amountCents(find(sub, "TaxableAmount"));
    const tax = amountCents(find(sub, "TaxAmount")) ?? 0;
    const rate = rateBp(find(sub, "TaxCategory", "Percent")) ?? 0;
    codes.push(textOf(find(sub, "TaxCategory", "ID")));
    if (net != null) lines.push({ taxRateBp: rate, netCents: net, taxCents: tax, grossCents: net + tax });
  }
  if (lines.length) fields.taxLines = xml(lines);
  const treatment = treatmentFromCategories(codes, fields.supplierCountry?.value);
  if (treatment) fields.vatTreatment = xml(treatment, 0.9);
  const firstItem = textOf(find(top, "InvoiceLine", "Item", "Name") ?? find(top, "CreditNoteLine", "Item", "Name"));
  if (firstItem) fields.description = xml(firstItem.slice(0, 120), 0.6);
  return { format: "ubl", fields, warnings, summary: "" };
}

/** Parses CII (ZUGFeRD/Factur-X/XRechnung) or UBL invoice XML; null for other XML. */
export function parseEInvoiceXml(text: string): EInvoiceResult | null {
  const root = parseXml(text);
  const top = root.children[0];
  if (!top) return null;
  const result =
    top.name === "CrossIndustryInvoice" ? parseCii(root) : top.name === "Invoice" || top.name === "CreditNote" ? parseUbl(root) : null;
  if (!result) return null;
  const f = result.fields;
  result.summary = [
    `E-Rechnung (${result.format === "cii" ? "ZUGFeRD / Factur-X / XRechnung CII" : "XRechnung UBL"})`,
    f.supplierName && `Lieferant: ${f.supplierName.value}`,
    f.supplierUid && `UID: ${f.supplierUid.value}`,
    f.supplierInvoiceNumber && `Rechnungsnummer: ${f.supplierInvoiceNumber.value}`,
    f.issueDate && `Datum: ${f.issueDate.value}`,
    f.dueDate && `Fällig: ${f.dueDate.value}`,
    f.grossCents && `Gesamt: ${(f.grossCents.value / 100).toFixed(2)} ${f.currency?.value ?? ""}`.trim(),
    ...(f.taxLines?.value ?? []).map(
      (l) => `  ${l.taxRateBp / 100} %: netto ${(l.netCents / 100).toFixed(2)}, Steuer ${(l.taxCents / 100).toFixed(2)}`,
    ),
    f.iban && `IBAN: ${f.iban.value}`,
  ]
    .filter(Boolean)
    .join("\n");
  return result;
}
