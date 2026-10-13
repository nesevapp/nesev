import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { OcrSettings } from "@shared/receipts";
import type { AnalysisDTO, QueueOverview } from "@server/services/receipt-queue";
import { api, parseResponse } from "@/lib/api";

// Belegerkennung: on-demand receipt analysis. Queries poll only while something is queued or running.

export type ReceiptAnalysisDTO = AnalysisDTO;
export type ReceiptQueueDTO = QueueOverview;

const POLL_MS = 1500;
const isActive = (status: string | undefined) => status === "queued" || status === "running";

export const receiptQueueQuery = queryOptions({
  queryKey: ["receipts", "queue"],
  queryFn: () => parseResponse(api.receipts.queue.$get()),
  refetchInterval: (q) => (q.state.data && q.state.data.queued + q.state.data.running > 0 ? POLL_MS : false),
});

export const receiptAnalysisQuery = (expenseId: number) =>
  queryOptions({
    queryKey: ["receipts", "expense", expenseId],
    queryFn: async () => (await parseResponse(api.receipts.expenses[":id"].$get({ param: { id: String(expenseId) } }))).analysis,
    refetchInterval: (q) => (isActive(q.state.data?.status) ? POLL_MS : false),
  });

export const ocrSettingsQuery = queryOptions({
  queryKey: ["receipts", "settings"],
  queryFn: () => parseResponse(api.receipts.settings.$get()),
});

export const receiptStatusQuery = (ollamaUrl?: string) =>
  queryOptions({
    queryKey: ["receipts", "status", ollamaUrl ?? ""],
    queryFn: () => parseResponse(api.receipts.status.$get({ query: { ollamaUrl } })),
    staleTime: 5_000,
  });

export function useAnalyzeReceipts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (expenseIds: number[]) => parseResponse(api.receipts.analyze.$post({ json: { expenseIds } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["receipts"] }),
  });
}

export function useCancelAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: number) => parseResponse(api.receipts[":id"].cancel.$post({ param: { id: String(analysisId) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["receipts"] }),
  });
}

export function useMarkApplied() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (analysisId: number) => parseResponse(api.receipts[":id"].applied.$post({ param: { id: String(analysisId) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["receipts"] }),
  });
}

export function useUpdateOcrSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: OcrSettings) => parseResponse(api.receipts.settings.$put({ json })),
    onSuccess: (data) => {
      qc.setQueryData(ocrSettingsQuery.queryKey, data);
      void qc.invalidateQueries({ queryKey: ["receipts", "status"] });
    },
  });
}

export function useBuildHelper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => parseResponse(api.receipts.helper.build.$post()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["receipts", "status"] }),
  });
}
