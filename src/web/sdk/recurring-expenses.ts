import { queryOptions, useMutation } from "@tanstack/react-query";
import type { RecurringExpenseCreate, RecurringExpenseUpdate } from "@shared/schemas/recurring-expense";
import { idParam, parseResponse, recurringExpenses } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export const recurringExpensesApi = {
  list: () => parseResponse(recurringExpenses.index.$get()),
  create: (json: RecurringExpenseCreateInput) => parseResponse(recurringExpenses.index.$post({ json })),
  update: (id: number, json: RecurringExpenseUpdateInput) =>
    parseResponse(recurringExpenses[":id"].$put({ param: idParam(id), json })),
  remove: (id: number) => parseResponse(recurringExpenses[":id"].$delete({ param: idParam(id) })),
};

/** A Fixkosten entry incl. nextPaymentDate, monthlyCents and ended. */
export type RecurringExpense = Awaited<ReturnType<typeof recurringExpensesApi.list>>[number];
export type RecurringExpenseCreateInput = RecurringExpenseCreate;
export type RecurringExpenseUpdateInput = RecurringExpenseUpdate;

export const recurringExpensesQuery = queryOptions({
  queryKey: keys.recurringExpenses.list,
  queryFn: recurringExpensesApi.list,
});

export function useCreateRecurringExpense() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (json: RecurringExpenseCreateInput) => recurringExpensesApi.create(json),
    onSuccess: () => invalidate("recurringExpenses"),
  });
}

export function useUpdateRecurringExpense() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: RecurringExpenseUpdateInput }) => recurringExpensesApi.update(id, json),
    onSuccess: () => invalidate("recurringExpenses"),
  });
}

export function useDeleteRecurringExpense() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => recurringExpensesApi.remove(id),
    onSuccess: () => invalidate("recurringExpenses"),
  });
}
