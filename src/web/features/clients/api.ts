import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientCreate, ClientListQuery, ClientUpdate } from "@shared/schemas/client";
import type { Client } from "@server/db/schema";
import { api, parseResponse } from "@/lib/api";

/** A client as returned by the API (same shape for list, picker and detail). */
export type ClientDTO = Client;

// Other features may import these (e.g. clientQuery for a document's live client).
export const clientsQuery = (filter: ClientListQuery = {}) =>
  queryOptions({
    queryKey: ["clients", "list", filter],
    queryFn: () =>
      parseResponse(
        api.clients.$get({
          query: {
            q: filter.q || undefined,
            archived: filter.archived ?? "active",
            country: filter.country || undefined,
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

export const clientPickerQuery = (q: string, limit = 20) =>
  queryOptions({
    queryKey: ["clients", "picker", q, limit],
    queryFn: () => parseResponse(api.clients.picker.$get({ query: { q: q || undefined, limit: String(limit) } })),
    placeholderData: keepPreviousData,
  });

export const clientQuery = (id: number) =>
  queryOptions({
    queryKey: ["clients", "detail", id],
    queryFn: () => parseResponse(api.clients[":id"].$get({ param: { id: String(id) } })),
  });

export const nextClientNumberQuery = queryOptions({
  queryKey: ["clients", "next-number"],
  queryFn: () => parseResponse(api.clients["next-number"].$get()),
});

function useInvalidateClients() {
  const qc = useQueryClient();
  return (saved?: ClientDTO) => {
    if (saved) qc.setQueryData(clientQuery(saved.id).queryKey, saved);
    return qc.invalidateQueries({ queryKey: ["clients"] });
  };
}

export function useCreateClient() {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (json: ClientCreate) => parseResponse(api.clients.$post({ json })),
    onSuccess: (saved) => invalidate(saved),
  });
}

export function useUpdateClient(id: number) {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (json: ClientUpdate) => parseResponse(api.clients[":id"].$put({ param: { id: String(id) }, json })),
    onSuccess: (saved) => invalidate(saved),
  });
}

export function useSetClientArchived(id: number) {
  const invalidate = useInvalidateClients();
  return useMutation({
    mutationFn: (archived: boolean) => {
      const param = { id: String(id) };
      return parseResponse(
        archived
          ? api.clients[":id"].archive.$post({ param })
          : api.clients[":id"].unarchive.$post({ param }),
      );
    },
    onSuccess: (saved) => invalidate(saved),
  });
}

export function useDeleteClient(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => parseResponse(api.clients[":id"].$delete({ param: { id: String(id) } })),
    onSuccess: () => {
      qc.removeQueries({ queryKey: clientQuery(id).queryKey });
      return qc.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}
