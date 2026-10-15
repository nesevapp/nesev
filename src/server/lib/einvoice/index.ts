import type { EInvoiceFormat } from "../../../shared/einvoice";
import { buildFacturX } from "./cii";
import { buildEbInterface } from "./ebinterface";
import type { EInvoiceInput } from "./model";
import { buildXRechnung } from "./ubl";

// E-invoice generators: pure functions from a finalized document (EInvoiceInput) to XML.
// ZUGFeRD's XML is embedded into the PDF afterwards (facturx-pdf.ts); the service in
// services/einvoice.ts collects the input and serves the files.

export { eInvoiceProblems, type EInvoiceInput, type EInvoiceItem } from "./model";
export { embedFacturX, FACTURX_FILE_NAME } from "./facturx-pdf";

/** The XML for a format (for ZUGFeRD: the CII XML that goes into the PDF). */
export function buildEInvoiceXml(input: EInvoiceInput, format: EInvoiceFormat): string {
  switch (format) {
    case "ebinterface":
      return buildEbInterface(input);
    case "xrechnung":
      return buildXRechnung(input);
    case "zugferd":
      return buildFacturX(input);
  }
}

/** "RE-2026-0001_ebinterface.xml", "RE-2026-0001_xrechnung.xml", "RE-2026-0001_zugferd.pdf" */
export function eInvoiceFileName(number: string, format: EInvoiceFormat): string {
  const base = number.replace(/[^\w.-]+/g, "_");
  switch (format) {
    case "ebinterface":
      return `${base}_ebinterface.xml`;
    case "xrechnung":
      return `${base}_xrechnung.xml`;
    case "zugferd":
      return `${base}_zugferd.pdf`;
  }
}
