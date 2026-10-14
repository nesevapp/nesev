import { queryOptions, useMutation } from "@tanstack/react-query";
import type { RecurringExpenseCreate, RecurringExpenseLink, RecurringExpenseUpdate } from "@shared/schemas/recurring-expense";
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

// --- links: expense ↔ scheduled payment ---------------------------------------------------------

export const recurringExpenseLinksApi = {
  schedule: (id: number) => parseResponse(recurringExpenses[":id"].schedule.$get({ param: idParam(id) })),
  candidates: (id: number, date: string) =>
    parseResponse(recurringExpenses[":id"].candidates.$get({ param: idParam(id), query: { date } })),
  linkOf: (expenseId: number) => parseResponse(recurringExpenses.link.$get({ query: { expenseId: String(expenseId) } })),
  suggestions: (expenseId: number) =>
    parseResponse(recurringExpenses.suggestions.$get({ query: { expenseId: String(expenseId) } })),
  link: (json: RecurringExpenseLinkInput) => parseResponse(recurringExpenses.links.$post({ json })),
  unlink: (expenseId: number) =>
    parseResponse(recurringExpenses.links[":expenseId"].$delete({ param: { expenseId: String(expenseId) } })),
};

export type RecurringExpenseSchedule = Awaited<ReturnType<typeof recurringExpenseLinksApi.schedule>>;
export type RecurringExpenseSlot = RecurringExpenseSchedule["slots"][number];
export type RecurringExpenseCandidate = Awaited<ReturnType<typeof recurringExpenseLinksApi.candidates>>[number];
export type RecurringExpenseSuggestion = Awaited<ReturnType<typeof recurringExpenseLinksApi.suggestions>>[number];
export type RecurringExpenseLinkInput = RecurringExpenseLink;

export const recurringExpenseScheduleQuery = (id: number) =>
  queryOptions({ queryKey: keys.recurringExpenses.schedule(id), queryFn: () => recurringExpenseLinksApi.schedule(id) });

export const recurringExpenseCandidatesQuery = (id: number, date: string) =>
  queryOptions({ queryKey: keys.recurringExpenses.candidates(id, date), queryFn: () => recurringExpenseLinksApi.candidates(id, date) });

/** The Fixkosten slot an expense is linked to (null = none). */
export const expenseFixedCostLinkQuery = (expenseId: number) =>
  queryOptions({ queryKey: keys.recurringExpenses.expenseLink(expenseId), queryFn: () => recurringExpenseLinksApi.linkOf(expenseId) });

export const fixedCostSuggestionsQuery = (expenseId: number) =>
  queryOptions({ queryKey: keys.recurringExpenses.suggestions(expenseId), queryFn: () => recurringExpenseLinksApi.suggestions(expenseId) });

export function useLinkFixedCostPayment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (json: RecurringExpenseLinkInput) => recurringExpenseLinksApi.link(json),
    onSuccess: () => invalidate("recurringExpenseLinks"),
  });
}

export function useUnlinkFixedCostPayment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (expenseId: number) => recurringExpenseLinksApi.unlink(expenseId),
    onSuccess: () => invalidate("recurringExpenseLinks"),
  });
}
