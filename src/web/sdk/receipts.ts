import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { OcrProvider, OcrSettings } from "@shared/receipts";
import { idParam, parseResponse, receipts } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

// Belegerkennung: on-demand receipt analysis. Queries poll only while something is queued or running.

export const receiptsApi = {
  queue: () => parseResponse(receipts.queue.$get()),
  /** Latest analysis of an expense's receipt (null if never analysed). */
  analysis: async (expenseId: number) =>
    (await parseResponse(receipts.expenses[":id"].$get({ param: idParam(expenseId) }))).analysis,
  settings: () => parseResponse(receipts.settings.$get()),
  /** Status of the OCR components (Vision helper, Tesseract, active model server); `probe` tests unsaved form values. */
  status: (probe: OcrStatusProbe = {}) => parseResponse(receipts.status.$get({ query: probe })),
  analyze: (expenseIds: number[]) => parseResponse(receipts.analyze.$post({ json: { expenseIds } })),
  cancel: (analysisId: number) => parseResponse(receipts[":id"].cancel.$post({ param: idParam(analysisId) })),
  markApplied: (analysisId: number) => parseResponse(receipts[":id"].applied.$post({ param: idParam(analysisId) })),
  updateSettings: (json: OcrSettings) => parseResponse(receipts.settings.$put({ json })),
  buildHelper: () => parseResponse(receipts.helper.build.$post()),
};

/** unsaved settings-form values to test ("Verbindung testen"); missing → saved settings */
export interface OcrStatusProbe {
  provider?: OcrProvider;
  url?: string;
  apiKey?: string;
  model?: string;
}

export type ReceiptAnalysis = NonNullable<Awaited<ReturnType<typeof receiptsApi.analysis>>>;
export type ReceiptQueue = Awaited<ReturnType<typeof receiptsApi.queue>>;
export type ReceiptEngineStatus = Awaited<ReturnType<typeof receiptsApi.status>>;

const POLL_MS = 1500;
const isActive = (status: string | undefined) => status === "queued" || status === "running";

export const receiptQueueQuery = queryOptions({
  queryKey: keys.receipts.queue,
  queryFn: receiptsApi.queue,
  refetchInterval: (q) => (q.state.data && q.state.data.queued + q.state.data.running > 0 ? POLL_MS : false),
});

export const receiptAnalysisQuery = (expenseId: number) =>
  queryOptions({
    queryKey: keys.receipts.expense(expenseId),
    queryFn: () => receiptsApi.analysis(expenseId),
    refetchInterval: (q) => (isActive(q.state.data?.status) ? POLL_MS : false),
  });

export const ocrSettingsQuery = queryOptions({
  queryKey: keys.receipts.settings,
  queryFn: receiptsApi.settings,
});

export const receiptStatusQuery = (probe: OcrStatusProbe = {}) =>
  queryOptions({
    queryKey: keys.receipts.status(probe),
    queryFn: () => receiptsApi.status(probe),
    staleTime: 5_000,
  });

export function useAnalyzeReceipts() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (expenseIds: number[]) => receiptsApi.analyze(expenseIds),
    onSuccess: () => void invalidate("receipts"),
  });
}

export function useCancelAnalysis() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (analysisId: number) => receiptsApi.cancel(analysisId),
    onSuccess: () => void invalidate("receipts"),
  });
}

export function useMarkAnalysisApplied() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (analysisId: number) => receiptsApi.markApplied(analysisId),
    onSuccess: () => void invalidate("receipts"),
  });
}

export function useUpdateOcrSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: OcrSettings) => receiptsApi.updateSettings(json),
    onSuccess: (data) => {
      qc.setQueryData(ocrSettingsQuery.queryKey, data);
      void qc.invalidateQueries({ queryKey: keys.receipts.statusAll });
    },
  });
}

export function useBuildOcrHelper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => receiptsApi.buildHelper(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.receipts.statusAll }),
  });
}
