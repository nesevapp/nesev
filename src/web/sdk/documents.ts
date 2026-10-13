import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DocumentType } from "@shared/documents";
import type { DocumentCreate, DocumentListQuery, DocumentStatusInput, DocumentUpdate } from "@shared/schemas/document";
import { documents, idParam, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export type DeriveKind = "convert-to-invoice" | "credit-note" | "duplicate";

export const documentsApi = {
  list: (filter: DocumentListQuery = {}) =>
    parseResponse(
      documents.index.$get({
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
  get: (id: number) => parseResponse(documents[":id"].$get({ param: idParam(id) })),
  /** Prefill values for a new document (dates, tax mode, texts) from settings and the client. */
  defaults: (type: DocumentType, clientId?: number, issueDate?: string) =>
    parseResponse(
      documents.defaults.$get({ query: { type, clientId: clientId ? String(clientId) : undefined, issueDate } }),
    ),
  create: (json: DocumentCreateInput) => parseResponse(documents.index.$post({ json })),
  update: (id: number, json: DocumentUpdateInput) => parseResponse(documents[":id"].$put({ param: idParam(id), json })),
  remove: (id: number) => parseResponse(documents[":id"].$delete({ param: idParam(id) })),
  finalize: (id: number) => parseResponse(documents[":id"].finalize.$post({ param: idParam(id) })),
  changeStatus: (id: number, json: DocumentStatusInput) =>
    parseResponse(documents[":id"].status.$post({ param: idParam(id), json })),
  /** Offer → invoice, invoice → credit note, duplicate: each returns the new draft. */
  derive: (id: number, kind: DeriveKind) => {
    const route = documents[":id"];
    const param = idParam(id);
    return parseResponse(
      kind === "convert-to-invoice"
        ? route["convert-to-invoice"].$post({ param })
        : kind === "credit-note"
          ? route["credit-note"].$post({ param })
          : route.duplicate.$post({ param }),
    );
  },
};

export type Document = Awaited<ReturnType<typeof documentsApi.get>>;
export type DocumentListItem = Awaited<ReturnType<typeof documentsApi.list>>[number];
export type DocumentDefaults = Awaited<ReturnType<typeof documentsApi.defaults>>;
export type DocumentCreateInput = DocumentCreate;
export type DocumentUpdateInput = DocumentUpdate;
export type DocumentListFilter = DocumentListQuery;

// Other features use these too (e.g. documentsQuery({ clientId }) on the client detail page).
export const documentsQuery = (filter: DocumentListFilter = {}) =>
  queryOptions({
    queryKey: keys.documents.list(filter),
    queryFn: () => documentsApi.list(filter),
    placeholderData: keepPreviousData,
  });

export const documentQuery = (id: number) =>
  queryOptions({
    queryKey: keys.documents.detail(id),
    queryFn: () => documentsApi.get(id),
  });

/** Defaults for the "new document" page: always fetched fresh, never kept. */
export const documentDraftDefaultsQuery = (type: DocumentType, clientId?: number) =>
  queryOptions({
    queryKey: keys.documentDraftDefaults(type, clientId ?? null),
    queryFn: () => documentsApi.defaults(type, clientId),
    staleTime: 0,
    gcTime: 0,
  });

/** Invoice defaults (texts, tax mode) for a new recurring invoice. */
export const invoiceDefaultsQuery = (clientId?: number) =>
  queryOptions({
    queryKey: keys.documents.defaults("invoice", clientId ?? null),
    queryFn: () => documentsApi.defaults("invoice", clientId),
    staleTime: Infinity,
  });

/** Store the returned document in the detail cache and refresh everything that shows documents. */
function useOnSaved() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (doc: Document) => {
    const detailKey = documentQuery(doc.id).queryKey;
    qc.setQueryData(detailKey, doc);
    return invalidate("documents", detailKey);
  };
}

export function useCreateDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: DocumentCreateInput) => documentsApi.create(json),
    onSuccess: onSaved,
  });
}

export function useUpdateDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: DocumentUpdateInput }) => documentsApi.update(id, json),
    onSuccess: onSaved,
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => documentsApi.remove(id),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: documentQuery(id).queryKey });
      return invalidate("documents");
    },
  });
}

export function useFinalizeDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => documentsApi.finalize(id),
    onSuccess: onSaved,
  });
}

export function useChangeDocumentStatus() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: DocumentStatusInput }) => documentsApi.changeStatus(id, json),
    onSuccess: onSaved,
  });
}

export function useDeriveDocument() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, kind }: { id: number; kind: DeriveKind }) => documentsApi.derive(id, kind),
    onSuccess: onSaved,
  });
}
