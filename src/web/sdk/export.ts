import { queryOptions, useMutation } from "@tanstack/react-query";
import { exports, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export interface ExportRange {
  from: string;
  to: string;
}

export const exportApi = {
  summary: (range: ExportRange) => parseResponse(exports.summary.$get({ query: range })),
  backups: () => parseResponse(exports.backups.$get()),
  createBackup: () => parseResponse(exports.backups.$post()),
};

export type ExportSummary = Awaited<ReturnType<typeof exportApi.summary>>;
export type LocalBackup = Awaited<ReturnType<typeof exportApi.backups>>[number];

export const exportSummaryQuery = (range: ExportRange) =>
  queryOptions({
    queryKey: keys.export.summary(range),
    queryFn: () => exportApi.summary(range),
  });

export const localBackupsQuery = queryOptions({
  queryKey: keys.export.backups,
  queryFn: exportApi.backups,
});

export function useCreateLocalBackup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: exportApi.createBackup,
    onSuccess: () => invalidate("backups"),
  });
}

/** Download URLs (plain links, the browser handles the attachment). */
export const exportUrls = {
  documentsCsv: (r: ExportRange) => `/api/export/documents.csv?${new URLSearchParams({ ...r })}`,
  documentsZip: (r: ExportRange) => `/api/export/documents.zip?${new URLSearchParams({ ...r })}`,
  clientsCsv: "/api/export/clients.csv",
  backup: "/api/export/backup",
  localBackup: (name: string) => `/api/export/backups/${encodeURIComponent(name)}`,
};
