import { ClientDocumentsList } from "@/features/documents/components/client-documents-list";

/** "Dokumente" section on the client detail page: the client's offers, invoices and credit notes. */
export function ClientDocuments({ clientId }: { clientId: number }) {
  return <ClientDocumentsList clientId={clientId} />;
}
