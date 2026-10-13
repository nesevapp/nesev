import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExpenseCreate, ExpenseListQuery, ExpenseUpdate } from "@shared/schemas/expense";
import { expenses, idParam, parseResponse } from "./client";
import { fileUrl } from "./files";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export type ExpenseListFilter = Partial<ExpenseListQuery>;

export const expensesApi = {
  list: (filter: ExpenseListFilter = {}) =>
    parseResponse(
      expenses.index.$get({
        query: {
          q: filter.q || undefined,
          from: filter.from,
          to: filter.to,
          category: filter.category,
          status: filter.status,
          attachment: filter.attachment,
        },
      }),
    ),
  get: (id: number) => parseResponse(expenses[":id"].$get({ param: idParam(id) })),
  /** Supplier autocomplete: previous suppliers with their latest uid/country/treatment/category. */
  suppliers: (q: string, limit: number) =>
    parseResponse(expenses.suppliers.$get({ query: { q: q || undefined, limit: String(limit) } })),
  create: (json: ExpenseCreateInput) => parseResponse(expenses.index.$post({ json })),
  update: (id: number, json: ExpenseUpdateInput) => parseResponse(expenses[":id"].$put({ param: idParam(id), json })),
  setPaid: (id: number, paidAt: string | null) =>
    parseResponse(expenses[":id"].paid.$post({ param: idParam(id), json: { paidAt } })),
  remove: (id: number) => parseResponse(expenses[":id"].$delete({ param: idParam(id) })),
  uploadReceipt: (id: number, file: File) =>
    parseResponse(expenses[":id"].attachment.$post({ param: idParam(id), form: { file } })),
  removeReceipt: (id: number) => parseResponse(expenses[":id"].attachment.$delete({ param: idParam(id) })),
  /** Quick capture: one draft expense per receipt file. */
  createDrafts: (files: File[]) => parseResponse(expenses.drafts.$post({ form: { files } })),
};

export type Expense = Awaited<ReturnType<typeof expensesApi.get>>;
export type ExpenseListItem = Awaited<ReturnType<typeof expensesApi.list>>[number];
export type SupplierSuggestion = Awaited<ReturnType<typeof expensesApi.suppliers>>[number];
export type ExpenseCreateInput = ExpenseCreate;
export type ExpenseUpdateInput = ExpenseUpdate;

export const expensesQuery = (filter: ExpenseListFilter = {}) =>
  queryOptions({
    queryKey: keys.expenses.list(filter),
    queryFn: () => expensesApi.list(filter),
    placeholderData: keepPreviousData,
  });

export const expenseQuery = (id: number) =>
  queryOptions({
    queryKey: keys.expenses.detail(id),
    queryFn: () => expensesApi.get(id),
  });

export const supplierSuggestionsQuery = (q: string, limit = 8) =>
  queryOptions({
    queryKey: keys.expenses.suppliers(q, limit),
    queryFn: () => expensesApi.suppliers(q, limit),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

export function receiptUrl(expense: { attachmentPath: string | null }): string | null {
  return expense.attachmentPath ? fileUrl(expense.attachmentPath) : null;
}

/** Writes a fresh expense into the detail cache and refetches lists (and other features' views of expenses). */
function useOnSaved(change: "expenses" | "expenseReceipt" = "expenses") {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (saved?: Expense) => {
    if (saved) qc.setQueryData(expenseQuery(saved.id).queryKey, saved);
    void invalidate(change);
  };
}

export function useCreateExpense() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: ExpenseCreateInput) => expensesApi.create(json),
    onSuccess: onSaved,
  });
}

export function useUpdateExpense() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: ExpenseUpdateInput }) => expensesApi.update(id, json),
    onSuccess: onSaved,
  });
}

export function useSetExpensePaid() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, paidAt }: { id: number; paidAt: string | null }) => expensesApi.setPaid(id, paidAt),
    onSuccess: onSaved,
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => expensesApi.remove(id),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: expenseQuery(id).queryKey });
      onSaved();
    },
  });
}

/** Upload or replace the receipt; a replaced receipt also invalidates earlier analysis results. */
export function useUploadReceipt() {
  const onSaved = useOnSaved("expenseReceipt");
  return useMutation({
    mutationFn: ({ id, file }: { id: number; file: File }) => expensesApi.uploadReceipt(id, file),
    onSuccess: onSaved,
  });
}

export function useRemoveReceipt() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => expensesApi.removeReceipt(id),
    onSuccess: onSaved,
  });
}

/** Quick capture: one draft expense per dropped receipt. */
export function useCreateExpenseDrafts() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (files: File[]) => expensesApi.createDrafts(files),
    onSuccess: () => onSaved(),
  });
}
