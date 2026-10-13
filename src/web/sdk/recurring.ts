import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { RecurringCreate, RecurringUpdate } from "@shared/schemas/recurring";
import { idParam, parseResponse, recurring } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export const recurringApi = {
  list: () => parseResponse(recurring.index.$get()),
  get: (id: number) => parseResponse(recurring[":id"].$get({ param: idParam(id) })),
  create: (json: RecurringCreateInput) => parseResponse(recurring.index.$post({ json })),
  update: (id: number, json: RecurringUpdateInput) => parseResponse(recurring[":id"].$put({ param: idParam(id), json })),
  remove: (id: number) => parseResponse(recurring[":id"].$delete({ param: idParam(id) })),
  /** Generate all due invoices. */
  run: () => parseResponse(recurring.run.$post()),
  /** Generate the next invoice of one recurring invoice now. */
  generate: (id: number) => parseResponse(recurring[":id"].generate.$post({ param: idParam(id) })),
};

export type Recurring = Awaited<ReturnType<typeof recurringApi.get>>;
export type RecurringListItem = Awaited<ReturnType<typeof recurringApi.list>>[number];
export type RecurringCreateInput = RecurringCreate;
export type RecurringUpdateInput = RecurringUpdate;

export const recurringListQuery = queryOptions({
  queryKey: keys.recurring.list,
  queryFn: recurringApi.list,
});

export const recurringQuery = (id: number) =>
  queryOptions({
    queryKey: keys.recurring.detail(id),
    queryFn: () => recurringApi.get(id),
  });

function useOnSaved() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (saved: Recurring) => {
    const detailKey = recurringQuery(saved.id).queryKey;
    qc.setQueryData(detailKey, saved);
    return invalidate("recurring", detailKey);
  };
}

export function useCreateRecurring() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: RecurringCreateInput) => recurringApi.create(json),
    onSuccess: onSaved,
  });
}

export function useUpdateRecurring() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: RecurringUpdateInput }) => recurringApi.update(id, json),
    onSuccess: onSaved,
  });
}

export function useDeleteRecurring() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => recurringApi.remove(id),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: recurringQuery(id).queryKey });
      return invalidate("recurring");
    },
  });
}

/** "Jetzt ausführen": generate all due invoices. */
export function useRunRecurring() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => recurringApi.run(),
    onSuccess: () => invalidate("recurringRun"),
  });
}

/** "Rechnung jetzt erstellen" for one recurring invoice. */
export function useGenerateRecurringNow() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => recurringApi.generate(id),
    onSuccess: () => invalidate("recurringRun"),
  });
}
