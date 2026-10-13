import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, parseResponse } from "@/lib/api";

export interface ExportRange {
  from: string;
  to: string;
}

export const exportSummaryQuery = (range: ExportRange) =>
  queryOptions({
    queryKey: ["export", "summary", range],
    queryFn: () => parseResponse(api.export.summary.$get({ query: range })),
  });

export const localBackupsQuery = queryOptions({
  queryKey: ["export", "backups"],
  queryFn: () => parseResponse(api.export.backups.$get()),
});

export type LocalBackupDTO = Awaited<ReturnType<NonNullable<typeof localBackupsQuery.queryFn>>>[number];

export function useCreateLocalBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => parseResponse(api.export.backups.$post()),
    onSuccess: () => qc.invalidateQueries({ queryKey: localBackupsQuery.queryKey }),
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
