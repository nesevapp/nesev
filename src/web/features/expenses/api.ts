import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExpenseCreate, ExpenseListQuery, ExpenseUpdate } from "@shared/schemas/expense";
import type { ExpenseListRow, ExpenseWithLines, SupplierSuggestion } from "@server/services/expenses";
import { api, fileUrl, parseResponse } from "@/lib/api";

export type ExpenseDTO = ExpenseWithLines;
export type ExpenseListRowDTO = ExpenseListRow;
export type SupplierSuggestionDTO = SupplierSuggestion;
export type ExpenseListSearch = Partial<ExpenseListQuery>;

export const expensesQuery = (filter: ExpenseListSearch = {}) =>
  queryOptions({
    queryKey: ["expenses", "list", filter],
    queryFn: () =>
      parseResponse(
        api.expenses.$get({
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
    placeholderData: keepPreviousData,
  });

export const expenseQuery = (id: number) =>
  queryOptions({
    queryKey: ["expenses", "detail", id],
    queryFn: () => parseResponse(api.expenses[":id"].$get({ param: { id: String(id) } })),
  });

export const supplierSuggestionsQuery = (q: string, limit = 8) =>
  queryOptions({
    queryKey: ["expenses", "suppliers", q, limit],
    queryFn: () => parseResponse(api.expenses.suppliers.$get({ query: { q: q || undefined, limit: String(limit) } })),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

export function receiptUrl(expense: { attachmentPath: string | null }): string | null {
  return expense.attachmentPath ? fileUrl(expense.attachmentPath) : null;
}

/** Writes a fresh expense into the detail cache and refetches lists (and other features' views of expenses). */
function useOnSaved() {
  const qc = useQueryClient();
  return (saved?: ExpenseDTO) => {
    if (saved) qc.setQueryData(expenseQuery(saved.id).queryKey, saved);
    void qc.invalidateQueries({ queryKey: ["expenses", "list"] });
    void qc.invalidateQueries({ queryKey: ["expenses", "suppliers"] });
  };
}

export function useCreateExpense() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (json: ExpenseCreate) => parseResponse(api.expenses.$post({ json })),
    onSuccess: onSaved,
  });
}

export function useUpdateExpense() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: ExpenseUpdate }) =>
      parseResponse(api.expenses[":id"].$put({ param: { id: String(id) }, json })),
    onSuccess: onSaved,
  });
}

export function useSetExpensePaid() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, paidAt }: { id: number; paidAt: string | null }) =>
      parseResponse(api.expenses[":id"].paid.$post({ param: { id: String(id) }, json: { paidAt } })),
    onSuccess: onSaved,
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.expenses[":id"].$delete({ param: { id: String(id) } })),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: expenseQuery(id).queryKey });
      void qc.invalidateQueries({ queryKey: ["expenses", "list"] });
      void qc.invalidateQueries({ queryKey: ["expenses", "suppliers"] });
    },
  });
}

export function useUploadReceipt() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, file }: { id: number; file: File }) =>
      parseResponse(api.expenses[":id"].attachment.$post({ param: { id: String(id) }, form: { file } })),
    onSuccess: onSaved,
  });
}

export function useRemoveReceipt() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.expenses[":id"].attachment.$delete({ param: { id: String(id) } })),
    onSuccess: onSaved,
  });
}

/** Quick capture: one draft expense per dropped receipt. */
export function useCreateDrafts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) => parseResponse(api.expenses.drafts.$post({ form: { files } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["expenses", "list"] }),
  });
}
