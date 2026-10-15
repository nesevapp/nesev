import { queryOptions } from "@tanstack/react-query";
import type { EInvoiceFormat } from "@shared/einvoice";
import { einvoice, idParam, parseResponse } from "./client";
import { keys } from "./keys";

export const einvoiceApi = {
  /** The client's default format and what is missing per format (finalized invoices / credit notes only). */
  status: (documentId: number) => parseResponse(einvoice.documents[":id"].status.$get({ param: idParam(documentId) })),
};

export type EInvoiceStatus = Awaited<ReturnType<typeof einvoiceApi.status>>;

export const einvoiceStatusQuery = (documentId: number) =>
  queryOptions({
    queryKey: keys.documents.einvoice(documentId),
    queryFn: () => einvoiceApi.status(documentId),
    // depends on client and settings data, which other views change
    staleTime: 0,
  });

/** Download link: XML (ebInterface, XRechnung) or the PDF with embedded XML (ZUGFeRD). */
export function einvoiceDownloadUrl(documentId: number, format: EInvoiceFormat): string {
  return `/api/einvoice/documents/${documentId}?format=${format}`;
}
