import { keepPreviousData, queryOptions, useMutation } from "@tanstack/react-query";
import type { BankAccountInput, CsvMapping, MatchInput, TransactionListQuery } from "@shared/bank";
import { bank, idParam, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export type BankTransactionFilter = TransactionListQuery;
export type BankSummaryFilter = Pick<TransactionListQuery, "accountId" | "from" | "to">;
export interface MatchCandidateFilter {
  direction: "in" | "out";
  q: string;
  transactionId?: number;
}

export interface BankImportRequest {
  accountId: number;
  file: File;
  mapping?: CsvMapping | null;
  preset?: string | null;
}

const toQuery = (q: BankTransactionFilter) => ({
  accountId: q.accountId ? String(q.accountId) : undefined,
  status: q.status,
  direction: q.direction,
  q: q.q || undefined,
  from: q.from,
  to: q.to,
});

const importForm = (r: BankImportRequest) => ({
  file: r.file,
  ...(r.mapping ? { mapping: JSON.stringify(r.mapping) } : {}),
  ...(r.preset && !r.mapping ? { preset: r.preset } : {}),
});

export const bankApi = {
  accounts: () => parseResponse(bank.accounts.$get()),
  /** Prefill for the first account: company IBAN/bank from the settings. */
  accountSuggestion: () => parseResponse(bank.accounts.suggestion.$get()),
  createAccount: (json: BankAccountInput) => parseResponse(bank.accounts.$post({ json })),
  updateAccount: (id: number, json: BankAccountInput) =>
    parseResponse(bank.accounts[":id"].$put({ param: idParam(id), json })),
  setAccountArchived: (id: number, archived: boolean) =>
    parseResponse(
      archived
        ? bank.accounts[":id"].archive.$post({ param: idParam(id) })
        : bank.accounts[":id"].unarchive.$post({ param: idParam(id) }),
    ),
  removeAccount: (id: number) => parseResponse(bank.accounts[":id"].$delete({ param: idParam(id) })),
  csvPresets: () => parseResponse(bank.presets.$get()),
  transactions: (q: BankTransactionFilter) => parseResponse(bank.transactions.$get({ query: toQuery(q) })),
  summary: (q: BankSummaryFilter) => parseResponse(bank.summary.$get({ query: toQuery(q) })),
  imports: (accountId?: number) =>
    parseResponse(bank.imports.$get({ query: { accountId: accountId ? String(accountId) : undefined } })),
  /** Open invoices (in) or expenses (out) a transaction could be matched to. */
  candidates: (q: MatchCandidateFilter) =>
    parseResponse(
      bank.candidates.$get({
        query: { direction: q.direction, q: q.q || undefined, transactionId: q.transactionId ? String(q.transactionId) : undefined },
      }),
    ),
  documentPayments: (documentId: number) => parseResponse(bank.documents[":id"].payments.$get({ param: idParam(documentId) })),
  previewImport: (r: BankImportRequest) =>
    parseResponse(bank.accounts[":id"].import.preview.$post({ param: idParam(r.accountId), form: importForm(r) })),
  commitImport: (r: BankImportRequest) =>
    parseResponse(bank.accounts[":id"].import.$post({ param: idParam(r.accountId), form: importForm(r) })),
  undoImport: (importId: number) => parseResponse(bank.imports[":id"].$delete({ param: idParam(importId) })),
  match: (transactionId: number, json: MatchInput) =>
    parseResponse(bank.transactions[":id"].match.$post({ param: idParam(transactionId), json })),
  /** Remove one allocation (matchId) or all matches of a transaction. */
  unmatch: (by: { transactionId: number } | { matchId: number }) =>
    parseResponse(
      "matchId" in by
        ? bank.matches[":id"].$delete({ param: idParam(by.matchId) })
        : bank.transactions[":id"].match.$delete({ param: idParam(by.transactionId) }),
    ),
  setIgnored: (id: number, ignored: boolean) =>
    parseResponse(
      ignored
        ? bank.transactions[":id"].ignore.$post({ param: idParam(id) })
        : bank.transactions[":id"].unignore.$post({ param: idParam(id) }),
    ),
  autoMatch: (accountId?: number) => parseResponse(bank["auto-match"].$post({ json: { accountId } })),
};

export type BankAccount = Awaited<ReturnType<typeof bankApi.accounts>>[number];
export type BankTransaction = Awaited<ReturnType<typeof bankApi.transactions>>[number];
export type MatchSuggestion = BankTransaction["suggestions"][number];
export type MatchCandidate = Awaited<ReturnType<typeof bankApi.candidates>>[number];
export type BankImport = Awaited<ReturnType<typeof bankApi.imports>>[number];
export type BankImportPreview = Awaited<ReturnType<typeof bankApi.previewImport>>;
export type CsvPreset = Awaited<ReturnType<typeof bankApi.csvPresets>>[number];

export const bankAccountsQuery = queryOptions({
  queryKey: keys.bank.accounts,
  queryFn: bankApi.accounts,
});

export const bankAccountSuggestionQuery = queryOptions({
  queryKey: keys.bank.accountSuggestion,
  queryFn: bankApi.accountSuggestion,
});

export const csvPresetsQuery = queryOptions({
  queryKey: keys.bank.presets,
  queryFn: bankApi.csvPresets,
  staleTime: Infinity,
});

export const bankTransactionsQuery = (q: BankTransactionFilter) =>
  queryOptions({
    queryKey: keys.bank.transactions(q),
    queryFn: () => bankApi.transactions(q),
    placeholderData: keepPreviousData,
  });

export const bankSummaryQuery = (q: BankSummaryFilter) =>
  queryOptions({
    queryKey: keys.bank.summary(q),
    queryFn: () => bankApi.summary(q),
    placeholderData: keepPreviousData,
  });

export const bankImportsQuery = (accountId?: number) =>
  queryOptions({
    queryKey: keys.bank.imports(accountId),
    queryFn: () => bankApi.imports(accountId),
  });

export const matchCandidatesQuery = (q: MatchCandidateFilter) =>
  queryOptions({
    queryKey: keys.bank.candidates(q),
    queryFn: () => bankApi.candidates(q),
    placeholderData: keepPreviousData,
  });

export const documentPaymentsQuery = (documentId: number) =>
  queryOptions({
    queryKey: keys.bank.documentPayments(documentId),
    queryFn: () => bankApi.documentPayments(documentId),
  });

export function useSaveBankAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, json }: { id?: number; json: BankAccountInput }) =>
      id ? bankApi.updateAccount(id, json) : bankApi.createAccount(json),
    onSuccess: () => invalidate("bank"),
  });
}

export function useSetBankAccountArchived() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) => bankApi.setAccountArchived(id, archived),
    onSuccess: () => invalidate("bank"),
  });
}

export function useDeleteBankAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => bankApi.removeAccount(id),
    onSuccess: () => invalidate("bank"),
  });
}

export function usePreviewBankImport() {
  return useMutation({ mutationFn: (r: BankImportRequest) => bankApi.previewImport(r) });
}

export function useCommitBankImport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (r: BankImportRequest) => bankApi.commitImport(r),
    onSuccess: () => invalidate("bankMatches"),
  });
}

export function useUndoBankImport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (importId: number) => bankApi.undoImport(importId),
    onSuccess: () => invalidate("bankMatches"),
  });
}

export function useApplyMatch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ transactionId, json }: { transactionId: number; json: MatchInput }) => bankApi.match(transactionId, json),
    onSuccess: () => invalidate("bankMatches"),
  });
}

export function useUnmatch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (by: { transactionId: number } | { matchId: number }) => bankApi.unmatch(by),
    onSuccess: () => invalidate("bankMatches"),
  });
}

export function useSetTransactionIgnored() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ignored }: { id: number; ignored: boolean }) => bankApi.setIgnored(id, ignored),
    onSuccess: () => invalidate("bank"),
  });
}

export function useAutoMatch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (accountId?: number) => bankApi.autoMatch(accountId),
    onSuccess: () => invalidate("bankMatches"),
  });
}
