import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { BankAccountInput, CsvMapping, MatchInput, TransactionListQuery } from "@shared/bank";
import { api, parseResponse } from "@/lib/api";

const param = (id: number) => ({ id: String(id) });

export const bankAccountsQuery = queryOptions({
  queryKey: ["bank", "accounts"],
  queryFn: () => parseResponse(api.bank.accounts.$get()),
});

export const accountSuggestionQuery = queryOptions({
  queryKey: ["bank", "accounts", "suggestion"],
  queryFn: () => parseResponse(api.bank.accounts.suggestion.$get()),
});

export const csvPresetsQuery = queryOptions({
  queryKey: ["bank", "presets"],
  queryFn: () => parseResponse(api.bank.presets.$get()),
  staleTime: Infinity,
});

const toQuery = (q: TransactionListQuery) => ({
  accountId: q.accountId ? String(q.accountId) : undefined,
  status: q.status,
  direction: q.direction,
  q: q.q || undefined,
  from: q.from,
  to: q.to,
});

export const transactionsQuery = (q: TransactionListQuery) =>
  queryOptions({
    queryKey: ["bank", "transactions", q],
    queryFn: () => parseResponse(api.bank.transactions.$get({ query: toQuery(q) })),
    placeholderData: keepPreviousData,
  });

export const summaryQuery = (q: Pick<TransactionListQuery, "accountId" | "from" | "to">) =>
  queryOptions({
    queryKey: ["bank", "summary", q],
    queryFn: () => parseResponse(api.bank.summary.$get({ query: toQuery(q) })),
    placeholderData: keepPreviousData,
  });

export const importsQuery = (accountId?: number) =>
  queryOptions({
    queryKey: ["bank", "imports", accountId ?? null],
    queryFn: () => parseResponse(api.bank.imports.$get({ query: { accountId: accountId ? String(accountId) : undefined } })),
  });

export const candidatesQuery = (q: { direction: "in" | "out"; q: string; transactionId?: number }) =>
  queryOptions({
    queryKey: ["bank", "candidates", q],
    queryFn: () =>
      parseResponse(
        api.bank.candidates.$get({
          query: { direction: q.direction, q: q.q || undefined, transactionId: q.transactionId ? String(q.transactionId) : undefined },
        }),
      ),
    placeholderData: keepPreviousData,
  });

export const documentPaymentsQuery = (documentId: number) =>
  queryOptions({
    queryKey: ["bank", "payments", "document", documentId],
    queryFn: () => parseResponse(api.bank.documents[":id"].payments.$get({ param: param(documentId) })),
  });

type Data<Q extends { queryFn?: unknown }> = Awaited<ReturnType<Extract<NonNullable<Q["queryFn"]>, (...args: never[]) => unknown>>>;
export type BankAccountDTO = Data<typeof bankAccountsQuery>[number];
export type TransactionDTO = Data<ReturnType<typeof transactionsQuery>>[number];
export type SuggestionDTO = TransactionDTO["suggestions"][number];
export type ImportDTO = Data<ReturnType<typeof importsQuery>>[number];
export type CsvPresetDTO = Data<typeof csvPresetsQuery>[number];

/** Matching changes invoice/expense payment states, so refresh everything that shows them. */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ["bank", "documents", "dashboard", "reminders", "forecast", "expenses", "tax"].map((k) =>
        qc.invalidateQueries({ queryKey: [k] }),
      ),
    );
}

function useInvalidateAccounts() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["bank"] });
}

export function useSaveAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({ id, json }: { id?: number; json: BankAccountInput }) =>
      id ? parseResponse(api.bank.accounts[":id"].$put({ param: param(id), json })) : parseResponse(api.bank.accounts.$post({ json })),
    onSuccess: () => invalidate(),
  });
}

export function useArchiveAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) =>
      parseResponse(
        archived
          ? api.bank.accounts[":id"].archive.$post({ param: param(id) })
          : api.bank.accounts[":id"].unarchive.$post({ param: param(id) }),
      ),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.bank.accounts[":id"].$delete({ param: param(id) })),
    onSuccess: () => invalidate(),
  });
}

export interface ImportRequest {
  accountId: number;
  file: File;
  mapping?: CsvMapping | null;
  preset?: string | null;
}

const importForm = (r: ImportRequest) => ({
  file: r.file,
  ...(r.mapping ? { mapping: JSON.stringify(r.mapping) } : {}),
  ...(r.preset && !r.mapping ? { preset: r.preset } : {}),
});

export function usePreviewImport() {
  return useMutation({
    mutationFn: (r: ImportRequest) =>
      parseResponse(api.bank.accounts[":id"].import.preview.$post({ param: param(r.accountId), form: importForm(r) })),
  });
}
export type ImportPreviewDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof usePreviewImport>["mutateAsync"]>>>;

export function useCommitImport() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (r: ImportRequest) =>
      parseResponse(api.bank.accounts[":id"].import.$post({ param: param(r.accountId), form: importForm(r) })),
    onSuccess: () => invalidate(),
  });
}

export function useUndoImport() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (importId: number) => parseResponse(api.bank.imports[":id"].$delete({ param: param(importId) })),
    onSuccess: () => invalidate(),
  });
}

export function useApplyMatch() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: ({ transactionId, json }: { transactionId: number; json: MatchInput }) =>
      parseResponse(api.bank.transactions[":id"].match.$post({ param: param(transactionId), json })),
    onSuccess: () => invalidate(),
  });
}

export function useUnmatch() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (by: { transactionId: number } | { matchId: number }) =>
      parseResponse(
        "matchId" in by
          ? api.bank.matches[":id"].$delete({ param: param(by.matchId) })
          : api.bank.transactions[":id"].match.$delete({ param: param(by.transactionId) }),
      ),
    onSuccess: () => invalidate(),
  });
}

export function useSetIgnored() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({ id, ignored }: { id: number; ignored: boolean }) =>
      parseResponse(
        ignored
          ? api.bank.transactions[":id"].ignore.$post({ param: param(id) })
          : api.bank.transactions[":id"].unignore.$post({ param: param(id) }),
      ),
    onSuccess: () => invalidate(),
  });
}

export function useAutoMatch() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: (accountId?: number) => parseResponse(api.bank["auto-match"].$post({ json: { accountId } })),
    onSuccess: () => invalidate(),
  });
}
