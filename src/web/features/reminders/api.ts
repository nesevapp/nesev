import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReminderSettings } from "@shared/reminders";
import type { ReminderCreate, ReminderListQuery, ReminderUpdate } from "@shared/schemas/reminder";
import { api, parseResponse } from "@/lib/api";

const param = (id: number) => ({ id: String(id) });

export const remindersQuery = (filter: ReminderListQuery = {}) =>
  queryOptions({
    queryKey: ["reminders", "list", filter],
    queryFn: () =>
      parseResponse(
        api.reminders.$get({
          query: { invoiceId: filter.invoiceId ? String(filter.invoiceId) : undefined, status: filter.status },
        }),
      ),
  });

export const dueInvoicesQuery = queryOptions({
  queryKey: ["reminders", "due"],
  queryFn: () => parseResponse(api.reminders.due.$get()),
});

export const reminderQuery = (id: number) =>
  queryOptions({
    queryKey: ["reminders", "detail", id],
    queryFn: () => parseResponse(api.reminders[":id"].$get({ param: param(id) })),
  });

export const reminderSettingsQuery = queryOptions({
  queryKey: ["reminders", "settings"],
  queryFn: () => parseResponse(api.reminders.settings.$get()),
});

export type ReminderDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof reminderQuery>["queryFn"]>>>;
export type ReminderListRowDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof remindersQuery>["queryFn"]>>>[number];
export type DueInvoiceDTO = Awaited<ReturnType<NonNullable<typeof dueInvoicesQuery.queryFn>>>[number];

/** Reminders change the dunning state shown on invoices and the dashboard, so refresh those too. */
function useInvalidate() {
  const qc = useQueryClient();
  return (saved?: ReminderDTO) => {
    if (saved) qc.setQueryData(reminderQuery(saved.id).queryKey, saved);
    return Promise.all([
      qc.invalidateQueries({ queryKey: ["reminders"], predicate: (q) => !saved || q.queryKey[2] !== saved.id }),
      qc.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  };
}

export function useCreateReminder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (json: ReminderCreate) => parseResponse(api.reminders.$post({ json })),
    onSuccess: (r) => invalidate(r),
  });
}

export function useCreateReminders() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (invoiceIds: number[]) => parseResponse(api.reminders.bulk.$post({ json: { invoiceIds } })),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateReminder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: ReminderUpdate }) =>
      parseResponse(api.reminders[":id"].$put({ param: param(id), json })),
    onSuccess: (r) => invalidate(r),
  });
}

export function useDeleteReminder() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.reminders[":id"].$delete({ param: param(id) })),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: reminderQuery(id).queryKey });
      return invalidate();
    },
  });
}

export function useFinalizeReminder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.reminders[":id"].finalize.$post({ param: param(id) })),
    onSuccess: (r) => invalidate(r),
  });
}

export function useMarkReminderSent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.reminders[":id"].sent.$post({ param: param(id) })),
    onSuccess: (r) => invalidate(r),
  });
}

export function useUpdateReminderSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: ReminderSettings) => parseResponse(api.reminders.settings.$put({ json })),
    onSuccess: (data) => qc.setQueryData(reminderSettingsQuery.queryKey, data),
  });
}

export function reminderPdfUrl(id: number, download = false): string {
  return `/api/pdf/reminders/${id}${download ? "?download=1" : ""}`;
}
