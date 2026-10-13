import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientCreate, ClientListQuery, ClientUpdate } from "@shared/schemas/client";
import { clients, idParam, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export const clientsApi = {
  list: (filter: ClientListQuery = {}) =>
    parseResponse(
      clients.index.$get({
        query: {
          q: filter.q || undefined,
          archived: filter.archived ?? "active",
          country: filter.country || undefined,
        },
      }),
    ),
  picker: (q: string, limit: number) =>
    parseResponse(clients.picker.$get({ query: { q: q || undefined, limit: String(limit) } })),
  get: (id: number) => parseResponse(clients[":id"].$get({ param: idParam(id) })),
  nextNumber: () => parseResponse(clients["next-number"].$get()),
  create: (json: ClientCreateInput) => parseResponse(clients.index.$post({ json })),
  update: (id: number, json: ClientUpdateInput) => parseResponse(clients[":id"].$put({ param: idParam(id), json })),
  setArchived: (id: number, archived: boolean) =>
    parseResponse(
      archived ? clients[":id"].archive.$post({ param: idParam(id) }) : clients[":id"].unarchive.$post({ param: idParam(id) }),
    ),
  remove: (id: number) => parseResponse(clients[":id"].$delete({ param: idParam(id) })),
};

/** A client as returned by the API (same shape for list, picker and detail). */
export type Client = Awaited<ReturnType<typeof clientsApi.get>>;
export type ClientListItem = Awaited<ReturnType<typeof clientsApi.list>>[number];
export type ClientCreateInput = ClientCreate;
export type ClientUpdateInput = ClientUpdate;
export type ClientListFilter = ClientListQuery;

// Other features use these too (e.g. clientQuery for a document's live client).
export const clientsQuery = (filter: ClientListFilter = {}) =>
  queryOptions({
    queryKey: keys.clients.list(filter),
    queryFn: () => clientsApi.list(filter),
    placeholderData: keepPreviousData,
  });

export const clientPickerQuery = (q: string, limit = 20) =>
  queryOptions({
    queryKey: keys.clients.picker(q, limit),
    queryFn: () => clientsApi.picker(q, limit),
    placeholderData: keepPreviousData,
  });

export const clientQuery = (id: number) =>
  queryOptions({
    queryKey: keys.clients.detail(id),
    queryFn: () => clientsApi.get(id),
  });

export const nextClientNumberQuery = queryOptions({
  queryKey: keys.clients.nextNumber,
  queryFn: clientsApi.nextNumber,
});

function useOnSaved() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (saved: Client) => {
    qc.setQueryData(clientQuery(saved.id).queryKey, saved);
    return invalidate("clients");
  };
}

export function useCreateClient() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: ClientCreateInput) => clientsApi.create(json),
    onSuccess: onSaved,
  });
}

export function useUpdateClient(id: number) {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: ClientUpdateInput) => clientsApi.update(id, json),
    onSuccess: onSaved,
  });
}

export function useSetClientArchived(id: number) {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (archived: boolean) => clientsApi.setArchived(id, archived),
    onSuccess: onSaved,
  });
}

export function useDeleteClient(id: number) {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => clientsApi.remove(id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: clientQuery(id).queryKey });
      return invalidate("clients");
    },
  });
}
