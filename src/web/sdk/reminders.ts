import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReminderSettings } from "@shared/reminders";
import type { ReminderCreate, ReminderListQuery, ReminderUpdate } from "@shared/schemas/reminder";
import { idParam, parseResponse, reminders } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export const remindersApi = {
  list: (filter: ReminderListQuery = {}) =>
    parseResponse(
      reminders.index.$get({
        query: { invoiceId: filter.invoiceId ? String(filter.invoiceId) : undefined, status: filter.status },
      }),
    ),
  /** Overdue invoices that are due for (another) reminder. */
  due: () => parseResponse(reminders.due.$get()),
  get: (id: number) => parseResponse(reminders[":id"].$get({ param: idParam(id) })),
  settings: () => parseResponse(reminders.settings.$get()),
  create: (json: ReminderCreateInput) => parseResponse(reminders.index.$post({ json })),
  createBulk: (invoiceIds: number[]) => parseResponse(reminders.bulk.$post({ json: { invoiceIds } })),
  update: (id: number, json: ReminderUpdateInput) => parseResponse(reminders[":id"].$put({ param: idParam(id), json })),
  remove: (id: number) => parseResponse(reminders[":id"].$delete({ param: idParam(id) })),
  finalize: (id: number) => parseResponse(reminders[":id"].finalize.$post({ param: idParam(id) })),
  markSent: (id: number) => parseResponse(reminders[":id"].sent.$post({ param: idParam(id) })),
  updateSettings: (json: ReminderSettings) => parseResponse(reminders.settings.$put({ json })),
};

export type Reminder = Awaited<ReturnType<typeof remindersApi.get>>;
export type ReminderListItem = Awaited<ReturnType<typeof remindersApi.list>>[number];
export type DueInvoice = Awaited<ReturnType<typeof remindersApi.due>>[number];
export type ReminderCreateInput = ReminderCreate;
export type ReminderUpdateInput = ReminderUpdate;
export type ReminderListFilter = ReminderListQuery;

export const remindersQuery = (filter: ReminderListFilter = {}) =>
  queryOptions({
    queryKey: keys.reminders.list(filter),
    queryFn: () => remindersApi.list(filter),
  });

export const dueInvoicesQuery = queryOptions({
  queryKey: keys.reminders.due,
  queryFn: remindersApi.due,
});

export const reminderQuery = (id: number) =>
  queryOptions({
    queryKey: keys.reminders.detail(id),
    queryFn: () => remindersApi.get(id),
  });

export const reminderSettingsQuery = queryOptions({
  queryKey: keys.reminders.settings,
  queryFn: remindersApi.settings,
});

/** Write a returned reminder into its detail cache, then refresh everything else that shows reminders. */
function useOnSaved() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (saved?: Reminder) => {
    if (!saved) return invalidate("reminders");
    const detailKey = reminderQuery(saved.id).queryKey;
    qc.setQueryData(detailKey, saved);
    return invalidate("reminders", detailKey);
  };
}

export function useCreateReminder() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: ReminderCreateInput) => remindersApi.create(json),
    onSuccess: (r) => onSaved(r),
  });
}

export function useCreateReminders() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (invoiceIds: number[]) => remindersApi.createBulk(invoiceIds),
    onSuccess: () => onSaved(),
  });
}

export function useUpdateReminder() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: ReminderUpdateInput }) => remindersApi.update(id, json),
    onSuccess: (r) => onSaved(r),
  });
}

export function useDeleteReminder() {
  const qc = useQueryClient();
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => remindersApi.remove(id),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: reminderQuery(id).queryKey });
      return onSaved();
    },
  });
}

export function useFinalizeReminder() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => remindersApi.finalize(id),
    onSuccess: (r) => onSaved(r),
  });
}

export function useMarkReminderSent() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => remindersApi.markSent(id),
    onSuccess: (r) => onSaved(r),
  });
}

export function useUpdateReminderSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: ReminderSettings) => remindersApi.updateSettings(json),
    onSuccess: (data) => qc.setQueryData(reminderSettingsQuery.queryKey, data),
  });
}
