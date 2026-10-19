import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccountingExportSettings } from "@shared/accounting-export";
import { exports, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export interface ExportRange {
  from: string;
  to: string;
}

/** Steuerberatung export: range plus whether bank payments are included. */
export interface AccountingExportParams extends ExportRange {
  payments: boolean;
}

const accountingQueryParams = (p: AccountingExportParams) => ({ from: p.from, to: p.to, payments: p.payments ? ("1" as const) : undefined });

export const exportApi = {
  summary: (range: ExportRange) => parseResponse(exports.summary.$get({ query: range })),
  backups: () => parseResponse(exports.backups.$get()),
  createBackup: () => parseResponse(exports.backups.$post()),
  accountingSettings: () => parseResponse(exports["accounting-settings"].$get()),
  updateAccountingSettings: (json: AccountingExportSettings) => parseResponse(exports["accounting-settings"].$put({ json })),
  accountingSummary: (p: AccountingExportParams) => parseResponse(exports.accounting.summary.$get({ query: accountingQueryParams(p) })),
  /** "Backup einspielen": the staged restore (applied on the next start) and whether nesev can restart itself */
  restoreStatus: () => parseResponse(exports.restore.$get()),
  stageRestore: (file: File) => parseResponse(exports.restore.$post({ form: { file } })),
  confirmRestore: () => parseResponse(exports.restore.confirm.$post()),
  discardRestore: () => parseResponse(exports.restore.$delete()),
  restart: () => parseResponse(exports.restart.$post()),
};

export type ExportSummary = Awaited<ReturnType<typeof exportApi.summary>>;
export type AccountingExportSummary = Awaited<ReturnType<typeof exportApi.accountingSummary>>;
export type { AccountingExportSettings };
export type LocalBackup = Awaited<ReturnType<typeof exportApi.backups>>[number];
export type RestoreStatus = Awaited<ReturnType<typeof exportApi.restoreStatus>>;
export type BackupSummary = Awaited<ReturnType<typeof exportApi.stageRestore>>["summary"];

export const exportSummaryQuery = (range: ExportRange) =>
  queryOptions({
    queryKey: keys.export.summary(range),
    queryFn: () => exportApi.summary(range),
  });

export const localBackupsQuery = queryOptions({
  queryKey: keys.export.backups,
  queryFn: exportApi.backups,
});

export const accountingExportSettingsQuery = queryOptions({
  queryKey: keys.export.accountingSettings,
  queryFn: exportApi.accountingSettings,
});

export const accountingExportSummaryQuery = (p: AccountingExportParams) =>
  queryOptions({
    queryKey: keys.export.accountingSummary(p),
    queryFn: () => exportApi.accountingSummary(p),
  });

export function useUpdateAccountingExportSettings() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: exportApi.updateAccountingSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(keys.export.accountingSettings, data);
      invalidate("accountingExport", keys.export.accountingSettings);
    },
  });
}

export function useCreateLocalBackup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: exportApi.createBackup,
    onSuccess: () => invalidate("backups"),
  });
}

export const restoreStatusQuery = queryOptions({
  queryKey: keys.export.restore,
  queryFn: exportApi.restoreStatus,
});

/** Uploads and validates a backup (staged, not yet confirmed): answers with its summary for the confirm dialog. */
export function useStageRestore() {
  return useMutation({ mutationFn: exportApi.stageRestore });
}

/** Confirms the staged backup: nesev applies it on the next start. */
export function useConfirmRestore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: exportApi.confirmRestore,
    onSuccess: (data) => queryClient.setQueryData(keys.export.restore, data),
  });
}

export function useDiscardRestore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: exportApi.discardRestore,
    onSuccess: (data) => queryClient.setQueryData(keys.export.restore, data),
  });
}

/**
 * Only when restoreStatus says canRestart (nesev runs as a service that starts it again). Resolves once the restarted
 * server answers again (up to a minute).
 */
export function useRestartNesev() {
  return useMutation({
    mutationFn: async () => {
      await exportApi.restart();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await sleep(1500);
      for (let i = 0; i < 60; i++) {
        try {
          return await exportApi.restoreStatus();
        } catch {
          await sleep(1000);
        }
      }
      throw new Error("nesev ist nach dem Neustart nicht erreichbar. Bitte nesev manuell starten.");
    },
  });
}

/** Download URLs (plain links, the browser handles the attachment). */
export const exportUrls = {
  documentsCsv: (r: ExportRange) => `/api/export/documents.csv?${new URLSearchParams({ ...r })}`,
  documentsZip: (r: ExportRange) => `/api/export/documents.zip?${new URLSearchParams({ ...r })}`,
  clientsCsv: "/api/export/clients.csv",
  backup: "/api/export/backup",
  localBackup: (name: string) => `/api/export/backups/${encodeURIComponent(name)}`,
  accountingBmd: (p: AccountingExportParams) => `/api/export/accounting/bmd.csv?${accountingSearch(p)}`,
  accountingGeneric: (p: AccountingExportParams) => `/api/export/accounting/belege.csv?${accountingSearch(p)}`,
  accountingZip: (p: AccountingExportParams) => `/api/export/accounting.zip?${accountingSearch(p)}`,
};

function accountingSearch(p: AccountingExportParams): URLSearchParams {
  return new URLSearchParams({ from: p.from, to: p.to, ...(p.payments ? { payments: "1" } : {}) });
}
