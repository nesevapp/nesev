import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { DocumentType } from "@shared/documents";
import type { DocumentFormValues } from "@shared/schemas/document";
import { Skeleton } from "@/components/ui/skeleton";
import { documentQuery, fetchDocumentDefaults } from "./api";
import { newItem } from "./components/line-items-editor";
import { docLink } from "./config";
import { DocumentEditor, toFormValues } from "./document-editor";
import { DocumentView } from "./document-view";

/** /offers/$id etc.: drafts open in the editor, finalized documents read-only. */
export function DocumentDetailPage({ type, id }: { type: DocumentType; id: number }) {
  const { data: doc } = useSuspenseQuery(documentQuery(id));
  if (doc.type !== type) return <Navigate {...docLink(doc.type, doc.id)} replace />;
  if (doc.status === "draft") {
    return <DocumentEditor key={doc.id} type={type} doc={doc} initialValues={toFormValues(doc)} />;
  }
  return <DocumentView doc={doc} />;
}

/** /offers/new etc. (optional ?clientId=): unsaved draft prefilled from settings/client defaults. */
export function NewDocumentPage({ type, clientId }: { type: DocumentType; clientId?: number }) {
  const defaults = useQuery({
    queryKey: ["document-defaults", type, clientId ?? null],
    queryFn: () => fetchDocumentDefaults(type, clientId),
    staleTime: 0,
    gcTime: 0,
  });
  if (!defaults.data) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-8 py-8">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const d = defaults.data;
  const initialValues: DocumentFormValues = {
    clientId: clientId ?? 0,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    validUntil: d.validUntil,
    servicePeriodStart: null,
    servicePeriodEnd: null,
    taxMode: d.taxMode,
    title: "",
    introText: d.introText,
    closingText: d.closingText,
    templateId: null,
    items: [newItem()],
  };
  return <DocumentEditor key={`${type}-${clientId ?? ""}`} type={type} initialValues={initialValues} />;
}
