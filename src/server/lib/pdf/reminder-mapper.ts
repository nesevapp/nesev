import { formatCents } from "../../../shared/money";
import type { PdfInput } from "../../../shared/pdf/variables";
import { fillPlaceholders, REMINDER_TAX_NOTE, reminderPlaceholderValues, reminderTotalCents } from "../../../shared/reminders";
import { formatClientNumber } from "../../../shared/schemas/client";
import type { TaxNoteSettings } from "../../../shared/tax";
import type { ClientSnapshot, SellerSnapshot } from "../../../shared/types";
import type { Reminder } from "../../db/schema";
import { EPC_QR_LABEL, epcQrPayload, formatDate, formatIban, mapDocumentToPdfInput } from "./mapper";

export type PdfReminderFields = Pick<
  Reminder,
  "level" | "number" | "issueDate" | "dueDate" | "openCents" | "feeCents" | "interestCents" | "title" | "introText" | "closingText"
>;

export interface ReminderMapperInput {
  reminder: PdfReminderFields;
  invoice: { number: string | null; issueDate: string; dueDate: string | null; grossCents: number };
  client: ClientSnapshot;
  seller: SellerSnapshot;
  taxNotes: TaxNoteSettings;
  logo?: { dataUri?: string; svg?: string } | null;
  /** settings.paymentQr (default true) */
  paymentQr?: boolean;
}

const lines = (...parts: (string | null | undefined | false)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n");

/**
 * pdfme input for a reminder. Seller, recipient and footer fields are the same as for documents
 * (taken from the document mapper); the rest describes the overdue invoice and the amount due.
 * Fees and interest carry no VAT (see src/shared/reminders.ts), hence the tax note.
 */
export function mapReminderToPdfInput(src: ReminderMapperInput): PdfInput {
  const { reminder: r, invoice, client, seller } = src;
  const base = mapDocumentToPdfInput({
    document: {
      type: "invoice",
      number: invoice.number,
      issueDate: invoice.issueDate,
      servicePeriodStart: null,
      servicePeriodEnd: null,
      dueDate: invoice.dueDate,
      validUntil: null,
      taxMode: "AT_DOMESTIC",
      title: "",
      introText: "",
      closingText: "",
    },
    items: [],
    client,
    seller,
    taxNotes: src.taxNotes,
    logo: src.logo,
  });

  const isDraft = !r.number;
  const number = r.number ?? "Entwurf";
  const title = r.title.trim() || "Mahnung";
  const invoiceNumber = invoice.number ?? "";
  const total = reminderTotalCents(r);
  const sellerName = seller.companyName || seller.ownerName;
  const values = reminderPlaceholderValues(r, invoice, client.name);
  const daysOverdue = values.daysOverdue;

  const info: [string, string][] = [
    ["Mahnungsnr.", number],
    ["Datum", formatDate(r.issueDate)],
    ["Rechnungsnr.", invoiceNumber],
    ["Rechnungsdatum", formatDate(invoice.issueDate)],
    ["Kundennr.", formatClientNumber(client.number)],
  ];
  if (client.uid) info.push(["Ihre UID", client.uid]);

  const reminderItems = [
    [
      invoiceNumber,
      formatDate(invoice.issueDate),
      formatDate(invoice.dueDate),
      daysOverdue,
      formatCents(invoice.grossCents),
      formatCents(r.openCents),
    ],
  ];
  const totalsRows: string[][] = [["Offener Rechnungsbetrag", formatCents(r.openCents)]];
  if (r.feeCents) totalsRows.push(["Mahnspesen", formatCents(r.feeCents)]);
  if (r.interestCents) totalsRows.push(["Verzugszinsen", formatCents(r.interestCents)]);

  const iban = seller.iban ? formatIban(seller.iban) : "";
  const deadline = formatDate(r.dueDate);
  const paymentInfo = lines(
    `**Bitte überweisen Sie ${formatCents(total)} bis ${deadline}.**`,
    iban &&
      [`IBAN ${iban}`, seller.bic && `BIC ${seller.bic}`, seller.bankName].filter(Boolean).join(" · ") +
        (invoiceNumber ? `\nVerwendungszweck: ${invoiceNumber}` : ""),
  );
  // amount = open invoice amount + fees + interest (what the reminder asks for)
  const epcQr =
    src.paymentQr === false
      ? ""
      : epcQrPayload({ name: sellerName, iban: seller.iban, bic: seller.bic, amountCents: total, reference: invoiceNumber });

  return {
    ...base,
    heading: isDraft ? `${title} (Entwurf)` : `${title} ${number}`,
    documentType: title,
    documentNumber: number,
    subject: invoiceNumber ? `Rechnung ${invoiceNumber} vom ${formatDate(invoice.issueDate)}` : "",
    issueDate: formatDate(r.issueDate),
    servicePeriod: "",
    dueDate: deadline,
    validUntil: "",
    referenceNumber: invoiceNumber,
    infoLabels: info.map(([l]) => l).join("\n"),
    infoValues: info.map(([, v]) => v).join("\n"),
    introText: fillPlaceholders(r.introText, values),
    closingText: fillPlaceholders(r.closingText, values),
    taxNote: r.feeCents || r.interestCents ? REMINDER_TAX_NOTE : "",

    items: "[]",
    totals: JSON.stringify(totalsRows),
    netTotal: formatCents(total),
    taxTotal: formatCents(0),
    grossTotal: formatCents(total),
    grossLabel: "Zu zahlen",

    paymentInfo,
    epcQr,
    epcQrLabel: epcQr ? EPC_QR_LABEL : "",

    reminderLevel: title,
    reminderItems: JSON.stringify(reminderItems),
    invoiceNumber,
    invoiceDate: values.invoiceDate,
    invoiceDueDate: values.invoiceDueDate,
    daysOverdue: values.daysOverdue,
    openAmount: values.openAmount,
    reminderFee: values.fee,
    reminderInterest: values.interest,
  };
}
