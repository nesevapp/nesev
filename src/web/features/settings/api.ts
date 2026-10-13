import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SettingsUpdate } from "@shared/schemas/settings";
import { api, parseResponse } from "@/lib/api";

// Other features may import settingsQuery (e.g. for default texts / payment terms).
export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: () => parseResponse(api.settings.$get()),
});

export type SettingsData = Awaited<ReturnType<NonNullable<typeof settingsQuery.queryFn>>>;

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: SettingsUpdate) => parseResponse(api.settings.$put({ json })),
    onSuccess: (data) => qc.setQueryData(settingsQuery.queryKey, data),
  });
}

export function useUploadLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => parseResponse(api.settings.logo.$post({ form: { file } })),
    onSuccess: (data) => qc.setQueryData(settingsQuery.queryKey, data),
  });
}

export function useDeleteLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => parseResponse(api.settings.logo.$delete()),
    onSuccess: (data) => qc.setQueryData(settingsQuery.queryKey, data),
  });
}
