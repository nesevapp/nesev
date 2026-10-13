import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecurringCreate, RecurringUpdate } from "@shared/schemas/recurring";
import { api, parseResponse } from "@/lib/api";

const param = (id: number) => ({ id: String(id) });

export const recurringListQuery = queryOptions({
  queryKey: ["recurring", "list"],
  queryFn: () => parseResponse(api.recurring.$get()),
});

export const recurringQuery = (id: number) =>
  queryOptions({
    queryKey: ["recurring", "detail", id],
    queryFn: () => parseResponse(api.recurring[":id"].$get({ param: param(id) })),
  });

export type RecurringListRowDTO = Awaited<ReturnType<NonNullable<typeof recurringListQuery.queryFn>>>[number];
export type RecurringDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof recurringQuery>["queryFn"]>>>;

/** Generated invoices change documents, the forecast and the dashboard too. */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [["recurring"], ["documents"], ["forecast"], ["dashboard"]].map((queryKey) => qc.invalidateQueries({ queryKey })),
    );
}

export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: RecurringCreate) => parseResponse(api.recurring.$post({ json })),
    onSuccess: (r) => {
      qc.setQueryData(recurringQuery(r.id).queryKey, r);
      return qc.invalidateQueries({ queryKey: ["recurring", "list"] });
    },
  });
}

export function useUpdateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: RecurringUpdate }) =>
      parseResponse(api.recurring[":id"].$put({ param: param(id), json })),
    onSuccess: (r) => {
      qc.setQueryData(recurringQuery(r.id).queryKey, r);
      return Promise.all([
        qc.invalidateQueries({ queryKey: ["recurring", "list"] }),
        qc.invalidateQueries({ queryKey: ["forecast"] }),
      ]);
    },
  });
}

export function useDeleteRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.recurring[":id"].$delete({ param: param(id) })),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: recurringQuery(id).queryKey });
      return qc.invalidateQueries({ queryKey: ["recurring"] });
    },
  });
}

/** "Jetzt ausführen": generate all due invoices. */
export function useRunRecurring() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: () => parseResponse(api.recurring.run.$post()),
    onSuccess: invalidate,
  });
}

/** "Rechnung jetzt erstellen" for one recurring invoice. */
export function useGenerateNow() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.recurring[":id"].generate.$post({ param: param(id) })),
    onSuccess: invalidate,
  });
}
