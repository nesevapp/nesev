// Template variables: the flat input record the PDF mapper produces and pdfme templates bind to.
// A schema named like a variable gets its value; read-only texts can embed `{variable}` placeholders.

/** pdfme input: every value is a string (tables are JSON-encoded string[][], images data URIs). */
export type PdfInput = Record<string, string>;

export type PdfVariableKind = "text" | "table" | "image" | "svg" | "qrcode";

export interface PdfVariable {
  name: string;
  label: string;
  group: "Absender" | "Empfänger" | "Beleg" | "Positionen & Summen" | "Zahlung" | "Mahnung" | "Fußzeile" | "Seite";
  kind: PdfVariableKind;
}

export const PDF_VARIABLES: readonly PdfVariable[] = [
  { name: "logo", label: "Logo (PNG/JPG)", group: "Absender", kind: "image" },
  { name: "logoSvg", label: "Logo (SVG)", group: "Absender", kind: "svg" },
  { name: "sellerName", label: "Firmenname", group: "Absender", kind: "text" },
  { name: "sellerOwner", label: "Inhaber:in", group: "Absender", kind: "text" },
  { name: "sellerAddress", label: "Adresse (mehrzeilig)", group: "Absender", kind: "text" },
  { name: "sellerLine", label: "Absenderzeile (Fensterkuvert)", group: "Absender", kind: "text" },
  { name: "sellerUid", label: "UID-Nummer", group: "Absender", kind: "text" },
  { name: "sellerTaxNumber", label: "Steuernummer", group: "Absender", kind: "text" },
  { name: "sellerCompanyRegister", label: "Firmenbuch", group: "Absender", kind: "text" },
  { name: "sellerEmail", label: "E-Mail", group: "Absender", kind: "text" },
  { name: "sellerPhone", label: "Telefon", group: "Absender", kind: "text" },
  { name: "sellerWebsite", label: "Website", group: "Absender", kind: "text" },

  { name: "recipientAddress", label: "Empfängeradresse (mehrzeilig)", group: "Empfänger", kind: "text" },
  { name: "clientName", label: "Kundenname", group: "Empfänger", kind: "text" },
  { name: "clientContactPerson", label: "Ansprechperson", group: "Empfänger", kind: "text" },
  { name: "clientNumber", label: "Kundennummer", group: "Empfänger", kind: "text" },
  { name: "clientUid", label: "UID des Kunden", group: "Empfänger", kind: "text" },
  { name: "clientEmail", label: "E-Mail des Kunden", group: "Empfänger", kind: "text" },

  { name: "heading", label: "Überschrift (z. B. „Rechnung RE-2026-0001“)", group: "Beleg", kind: "text" },
  { name: "documentType", label: "Belegart", group: "Beleg", kind: "text" },
  { name: "documentNumber", label: "Belegnummer", group: "Beleg", kind: "text" },
  { name: "subject", label: "Betreff", group: "Beleg", kind: "text" },
  { name: "issueDate", label: "Belegdatum", group: "Beleg", kind: "text" },
  { name: "servicePeriod", label: "Leistungszeitraum / -datum", group: "Beleg", kind: "text" },
  { name: "dueDate", label: "Fällig am", group: "Beleg", kind: "text" },
  { name: "validUntil", label: "Gültig bis", group: "Beleg", kind: "text" },
  { name: "referenceNumber", label: "Bezug (Vorgängerbeleg)", group: "Beleg", kind: "text" },
  { name: "infoLabels", label: "Infoblock – Bezeichnungen", group: "Beleg", kind: "text" },
  { name: "infoValues", label: "Infoblock – Werte", group: "Beleg", kind: "text" },
  { name: "introText", label: "Einleitungstext", group: "Beleg", kind: "text" },
  { name: "closingText", label: "Schlusstext", group: "Beleg", kind: "text" },
  { name: "taxNote", label: "Steuerhinweis", group: "Beleg", kind: "text" },

  { name: "items", label: "Positionen (Tabelle)", group: "Positionen & Summen", kind: "table" },
  { name: "totals", label: "Summen (Tabelle)", group: "Positionen & Summen", kind: "table" },
  { name: "netTotal", label: "Summe netto", group: "Positionen & Summen", kind: "text" },
  { name: "taxTotal", label: "Summe USt", group: "Positionen & Summen", kind: "text" },
  { name: "grossTotal", label: "Gesamtbetrag", group: "Positionen & Summen", kind: "text" },
  { name: "grossLabel", label: "Bezeichnung Gesamtbetrag", group: "Positionen & Summen", kind: "text" },

  { name: "paymentInfo", label: "Zahlungsinformationen", group: "Zahlung", kind: "text" },
  { name: "sellerIban", label: "IBAN", group: "Zahlung", kind: "text" },
  { name: "sellerBic", label: "BIC", group: "Zahlung", kind: "text" },
  { name: "sellerBank", label: "Bank", group: "Zahlung", kind: "text" },
  { name: "epcQr", label: "GiroCode / EPC-QR (Rechnungen, Mahnungen)", group: "Zahlung", kind: "qrcode" },
  { name: "epcQrLabel", label: "Beschriftung GiroCode", group: "Zahlung", kind: "text" },

  { name: "reminderItems", label: "Gemahnte Rechnung (Tabelle)", group: "Mahnung", kind: "table" },
  { name: "reminderLevel", label: "Mahnstufe (z. B. „1. Mahnung“)", group: "Mahnung", kind: "text" },
  { name: "invoiceNumber", label: "Rechnungsnummer", group: "Mahnung", kind: "text" },
  { name: "invoiceDate", label: "Rechnungsdatum", group: "Mahnung", kind: "text" },
  { name: "invoiceDueDate", label: "Ursprüngliche Fälligkeit", group: "Mahnung", kind: "text" },
  { name: "daysOverdue", label: "Tage überfällig", group: "Mahnung", kind: "text" },
  { name: "openAmount", label: "Offener Rechnungsbetrag", group: "Mahnung", kind: "text" },
  { name: "reminderFee", label: "Mahnspesen", group: "Mahnung", kind: "text" },
  { name: "reminderInterest", label: "Verzugszinsen", group: "Mahnung", kind: "text" },

  { name: "footerCompany", label: "Fußzeile – Unternehmen", group: "Fußzeile", kind: "text" },
  { name: "footerContact", label: "Fußzeile – Kontakt", group: "Fußzeile", kind: "text" },
  { name: "footerBank", label: "Fußzeile – Bank & Steuer", group: "Fußzeile", kind: "text" },

  { name: "currentPage", label: "Aktuelle Seite (nur in Platzhaltern)", group: "Seite", kind: "text" },
  { name: "totalPages", label: "Seitenanzahl (nur in Platzhaltern)", group: "Seite", kind: "text" },
];

/** Column headers of the `items` and `totals` tables produced by the mapper (in this order). */
export const ITEMS_TABLE_HEAD = ["Pos.", "Bezeichnung", "Menge", "Einzelpreis", "USt", "Gesamt"] as const;
export const TOTALS_TABLE_COLUMNS = 2;
/** Column headers of the `reminderItems` table (reminders only). */
export const REMINDER_ITEMS_TABLE_HEAD = ["Rechnung", "Datum", "Fällig seit", "Tage", "Betrag", "Offen"] as const;
