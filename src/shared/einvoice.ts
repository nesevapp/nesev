// E-invoice formats a client can receive next to (or embedded in) the PDF. Generation lives in
// src/server/lib/einvoice/; the client's choice is clients.eInvoiceFormat (null = PDF only).
//   ebinterface – Austrian standard (ebInterface 6.1), required for the Bund (via USP / e-Rechnung.gv.at)
//   xrechnung   – German public sector, UBL; buyer reference = Leitweg-ID
//   zugferd     – Factur-X/ZUGFeRD: CII XML embedded in the invoice PDF
export const EINVOICE_FORMATS = ["ebinterface", "xrechnung", "zugferd"] as const;
export type EInvoiceFormat = (typeof EINVOICE_FORMATS)[number];

export const EINVOICE_FORMAT_LABELS: Record<EInvoiceFormat, string> = {
  ebinterface: "ebInterface (Österreich)",
  xrechnung: "XRechnung (Deutschland)",
  zugferd: "ZUGFeRD / Factur-X (PDF mit XML)",
};
