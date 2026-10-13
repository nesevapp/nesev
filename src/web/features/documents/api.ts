import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DocumentType } from "@shared/documents";
import type {
  DocumentCreate,
  DocumentListQuery,
  DocumentStatusInput,
  DocumentUpdate,
} from "@shared/schemas/document";
import { api, parseResponse } from "@/lib/api";

const param = (id: number) => ({ id: String(id) });

// Other features may import these (e.g. documentsQuery({ clientId }) on the client detail page).
export const documentsQuery = (filter: DocumentListQuery = {}) =>
  queryOptions({
    queryKey: ["documents", "list", filter],
    queryFn: () =>
      parseResponse(
        api.documents.$get({
          query: {
            type: filter.type,
            status: filter.status,
            clientId: filter.clientId ? String(filter.clientId) : undefined,
            q: filter.q || undefined,
            from: filter.from,
            to: filter.to,
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

export const documentQuery = (id: number) =>
  queryOptions({
    queryKey: ["documents", "detail", id],
    queryFn: () => parseResponse(api.documents[":id"].$get({ param: param(id) })),
  });

export function fetchDocumentDefaults(type: DocumentType, clientId?: number, issueDate?: string) {
  return parseResponse(
    api.documents.defaults.$get({
      query: { type, clientId: clientId ? String(clientId) : undefined, issueDate },
    }),
  );
}

export type DocumentDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof documentQuery>["queryFn"]>>>;
export type DocumentListRowDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof documentsQuery>["queryFn"]>>>[number];

/** Store the returned document in the detail cache and refresh lists (and the parent's children). */
function useOnSaved() {
  const qc = useQueryClient();
  return (doc: DocumentDTO) => {
    qc.setQueryData(documentQuery(doc.id).queryKey, doc);
    return qc.invalidateQueries({ queryKey: ["documents"], predicate: (q) => q.queryKey[2] !== doc.id });
  };
}

export function useCreateDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: DocumentCreate) => parseResponse(api.documents.$post({ json })),
    onSuccess: onSaved,
  });
}

export function useUpdateDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: DocumentUpdate }) =>
      parseResponse(api.documents[":id"].$put({ param: param(id), json })),
    onSuccess: onSaved,
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.documents[":id"].$delete({ param: param(id) })),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: documentQuery(id).queryKey });
      return qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

export function useFinalizeDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.documents[":id"].finalize.$post({ param: param(id) })),
    onSuccess: onSaved,
  });
}

export function useChangeStatus() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: DocumentStatusInput }) =>
      parseResponse(api.documents[":id"].status.$post({ param: param(id), json })),
    onSuccess: onSaved,
  });
}

export type DeriveKind = "convert-to-invoice" | "credit-note" | "duplicate";

/** Offer → invoice, invoice → credit note, duplicate: each returns the new draft. */
export function useDeriveDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, kind }: { id: number; kind: DeriveKind }) => {
      const route = api.documents[":id"];
      const req =
        kind === "convert-to-invoice"
          ? route["convert-to-invoice"].$post({ param: param(id) })
          : kind === "credit-note"
            ? route["credit-note"].$post({ param: param(id) })
            : route.duplicate.$post({ param: param(id) });
      return parseResponse(req);
    },
    onSuccess: onSaved,
  });
}

export function pdfUrl(id: number, download = false): string {
  return `/api/pdf/documents/${id}${download ? "?download=1" : ""}`;
}
