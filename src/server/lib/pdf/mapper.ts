import { COUNTRY_NAMES } from "../../../shared/countries";
import { DOCUMENT_TYPE_LABELS, type DocumentType } from "../../../shared/documents";
import { formatBp, formatCents, formatQuantity } from "../../../shared/money";
import type { PdfInput } from "../../../shared/pdf/variables";
import { type TaxMode, type TaxNoteSettings, taxNoteFor } from "../../../shared/tax";
import { formatClientNumber } from "../../../shared/schemas/client";
import { calcTotals } from "../../../shared/totals";
import type { ClientSnapshot, SellerSnapshot } from "../../../shared/types";
import type { Client, Document, DocumentItem } from "../../db/schema";

export type PdfDocumentFields = Pick<
  Document,
  | "type"
  | "number"
  | "issueDate"
  | "servicePeriodStart"
  | "servicePeriodEnd"
  | "dueDate"
  | "validUntil"
  | "taxMode"
  | "title"
  | "introText"
  | "closingText"
>;

export type PdfItemFields = Pick<
  DocumentItem,
  "title" | "description" | "quantity" | "unit" | "unitPriceCents" | "taxRateBp" | "discountBp"
>;

export interface PdfMapperInput {
  document: PdfDocumentFields;
  items: PdfItemFields[];
  client: ClientSnapshot;
  seller: SellerSnapshot;
  taxNotes: TaxNoteSettings;
  /** number of the parent document (offer for an invoice, invoice for a credit note) */
  parentNumber?: string | null;
  /** logo as data URI (PNG/JPG) or SVG markup; at most one is used */
  logo?: { dataUri?: string; svg?: string } | null;
}

/** Live client data in snapshot form, for drafts (finalized documents use documents.client_snapshot). */
export function clientToSnapshot(c: Client): ClientSnapshot {
  return {
    clientId: c.id,
    number: c.number,
    type: c.type,
    name: c.name,
    contactPerson: c.contactPerson,
    street: c.street,
    addressExtra: c.addressExtra,
    zip: c.zip,
    city: c.city,
    country: c.country,
    uid: c.uid,
    email: c.email,
  };
}

/** "2026-10-13" → "13.10.2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}.${m}.${y}` : iso;
}

/** "AT611904300234573201" → "AT61 1904 3002 3457 3201" */
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}

const lines = (...parts: (string | null | undefined | false)[]) => parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n");
const zipCity = (zip: string, city: string) => [zip, city].filter(Boolean).join(" ");

const NUMBER_LABELS: Record<DocumentType, string> = {
  offer: "Angebotsnr.",
  invoice: "Rechnungsnr.",
  credit_note: "Gutschriftsnr.",
};
const DATE_LABELS: Record<DocumentType, string> = {
  offer: "Angebotsdatum",
  invoice: "Rechnungsdatum",
  credit_note: "Datum",
};
const GROSS_LABELS: Record<DocumentType, string> = {
  offer: "Gesamtbetrag",
  invoice: "Gesamtbetrag",
  credit_note: "Gutschriftsbetrag",
};
const PARENT_LABELS: Record<DocumentType, string> = {
  offer: "Bezug",
  invoice: "Zu Angebot",
  credit_note: "Zu Rechnung",
};

function servicePeriod(doc: PdfDocumentFields): { label: string; value: string } | null {
  const start = formatDate(doc.servicePeriodStart);
  const end = formatDate(doc.servicePeriodEnd);
  if (start && end && start !== end) return { label: "Leistungszeitraum", value: `${start} – ${end}` };
  if (start || end) return { label: "Leistungsdatum", value: start || end };
  // Austrian invoices need a service date; without one it equals the invoice date.
  if (doc.type === "invoice") return { label: "Leistungsdatum", value: formatDate(doc.issueDate) };
  return null;
}

/**
 * EPC QR code payload (SEPA credit transfer, "GiroCode"), version 002 with unstructured remittance text.
 * Returns "" if the seller has no IBAN or the amount is not payable.
 */
export function epcQrPayload(args: { name: string; iban: string; bic: string; amountCents: number; reference: string }): string {
  const iban = args.iban.replace(/\s+/g, "").toUpperCase();
  if (!iban || args.amountCents <= 0 || args.amountCents > 99_999_999_999) return "";
  return [
    "BCD",
    "002",
    "1",
    "SCT",
    args.bic.replace(/\s+/g, "").toUpperCase(),
    args.name.slice(0, 70),
    iban,
    `EUR${(args.amountCents / 100).toFixed(2)}`,
    "", // purpose code
    "", // structured reference
    args.reference.slice(0, 140),
  ].join("\n");
}

/** Builds the flat pdfme input record (see PDF_VARIABLES) for a document. */
export function mapDocumentToPdfInput(src: PdfMapperInput): PdfInput {
  const { document: doc, client, seller } = src;
  const typeLabel = DOCUMENT_TYPE_LABELS[doc.type];
  const isDraft = !doc.number;
  const number = doc.number ?? "Entwurf";
  const taxMode: TaxMode = doc.taxMode;
  const totals = calcTotals(src.items, taxMode);

  // Seller
  const sellerName = seller.companyName || seller.ownerName;
  const sellerCityLine = zipCity(seller.zip, seller.city);
  const sellerCountry = seller.country && seller.country !== "AT" ? COUNTRY_NAMES[seller.country] ?? seller.country : "";
  const iban = seller.iban ? formatIban(seller.iban) : "";

  // Recipient
  const showClientCountry = client.country && client.country !== (seller.country || "AT");
  const contact = client.contactPerson && client.type === "company" ? `z. Hd. ${client.contactPerson}` : "";
  const recipientAddress = lines(
    client.name,
    contact,
    client.street,
    client.addressExtra,
    zipCity(client.zip, client.city),
    showClientCountry ? (COUNTRY_NAMES[client.country] ?? client.country).toUpperCase() : "",
  );

  // Info block (label/value columns)
  const info: [string, string][] = [
    [NUMBER_LABELS[doc.type], number],
    [DATE_LABELS[doc.type], formatDate(doc.issueDate)],
  ];
  const period = servicePeriod(doc);
  if (period) info.push([period.label, period.value]);
  if (doc.type === "offer" && doc.validUntil) info.push(["Gültig bis", formatDate(doc.validUntil)]);
  if (doc.type === "invoice" && doc.dueDate) info.push(["Fällig am", formatDate(doc.dueDate)]);
  if (src.parentNumber) info.push([PARENT_LABELS[doc.type], src.parentNumber]);
  info.push(["Kundennr.", formatClientNumber(client.number)]);
  if (client.uid) info.push(["Ihre UID", client.uid]);

  // Items table
  const items = src.items.map((item, i) => {
    const line = totals.lines[i]!;
    const desc = lines(
      item.title,
      item.description,
      item.discountBp ? `abzügl. ${formatBp(item.discountBp)} Rabatt (${formatCents(line.discountCents)})` : "",
    );
    return [
      String(i + 1),
      desc,
      [formatQuantity(item.quantity), item.unit].filter(Boolean).join(" "),
      formatCents(item.unitPriceCents),
      formatBp(line.taxRateBp),
      formatCents(line.netCents),
    ];
  });

  // Totals table
  const multipleRates = totals.taxGroups.length > 1;
  const totalsRows: string[][] = [["Summe netto", formatCents(totals.netCents)]];
  for (const g of totals.taxGroups) {
    const label = `USt ${formatBp(g.rateBp)}${multipleRates ? ` von ${formatCents(g.netCents)}` : ""}`;
    totalsRows.push([label, formatCents(g.taxCents)]);
  }
  if (totals.taxGroups.length === 0) totalsRows.push(["USt", formatCents(0)]);

  // Payment
  const isInvoice = doc.type === "invoice";
  const due = formatDate(doc.dueDate);
  const paymentInfo = isInvoice
    ? lines(
        due ? `**Zahlbar bis ${due}** ohne Abzug.` : "Zahlbar sofort ohne Abzug.",
        iban &&
          [`IBAN ${iban}`, seller.bic && `BIC ${seller.bic}`, seller.bankName].filter(Boolean).join(" · ") +
            (isDraft ? "" : `\nVerwendungszweck: ${number}`),
      )
    : "";
  const epcQr = isInvoice
    ? epcQrPayload({
        name: sellerName,
        iban: seller.iban,
        bic: seller.bic,
        amountCents: totals.grossCents,
        reference: isDraft ? "" : number,
      })
    : "";

  return {
    logo: src.logo?.dataUri ?? "",
    logoSvg: src.logo?.dataUri ? "" : (src.logo?.svg ?? ""),
    sellerName,
    sellerOwner: seller.ownerName,
    sellerAddress: lines(seller.street, sellerCityLine, sellerCountry),
    sellerLine: [sellerName, seller.street, sellerCityLine].filter(Boolean).join(" · "),
    sellerUid: seller.uid,
    sellerTaxNumber: seller.taxNumber,
    sellerCompanyRegister: seller.companyRegister,
    sellerEmail: seller.email,
    sellerPhone: seller.phone,
    sellerWebsite: seller.website,
    sellerIban: iban,
    sellerBic: seller.bic,
    sellerBank: seller.bankName,

    recipientAddress,
    clientName: client.name,
    clientContactPerson: client.contactPerson,
    clientNumber: formatClientNumber(client.number),
    clientUid: client.uid,
    clientEmail: client.email,

    heading: isDraft ? `${typeLabel} (Entwurf)` : `${typeLabel} ${number}`,
    documentType: typeLabel,
    documentNumber: number,
    subject: doc.title,
    issueDate: formatDate(doc.issueDate),
    servicePeriod: period?.value ?? "",
    dueDate: due,
    validUntil: formatDate(doc.validUntil),
    referenceNumber: src.parentNumber ?? "",
    infoLabels: info.map(([l]) => l).join("\n"),
    infoValues: info.map(([, v]) => v).join("\n"),
    introText: doc.introText,
    closingText: doc.closingText,
    taxNote: taxNoteFor(taxMode, src.taxNotes) ?? "",

    items: JSON.stringify(items),
    totals: JSON.stringify(totalsRows),
    netTotal: formatCents(totals.netCents),
    taxTotal: formatCents(totals.taxCents),
    grossTotal: formatCents(totals.grossCents),
    grossLabel: GROSS_LABELS[doc.type],

    paymentInfo,
    epcQr,
    epcQrLabel: epcQr ? "Mit Banking-App scannen" : "",

    footerCompany: lines(
      sellerName,
      seller.companyName && seller.ownerName && seller.ownerName !== seller.companyName ? `Inh. ${seller.ownerName}` : "",
      seller.street,
      [sellerCityLine, sellerCountry].filter(Boolean).join(", "),
      seller.companyRegister && `FN ${seller.companyRegister}`,
    ),
    footerContact: lines(seller.email, seller.phone && `Tel. ${seller.phone}`, seller.website),
    footerBank: lines(
      seller.bankName,
      iban && `IBAN ${iban}`,
      seller.bic && `BIC ${seller.bic}`,
      seller.uid && `UID ${seller.uid}`,
      seller.taxNumber && `St.-Nr. ${seller.taxNumber}`,
    ),
  };
}
