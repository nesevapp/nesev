import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SettingsUpdate } from "@shared/schemas/settings";
import { parseResponse, settings } from "./client";
import { keys } from "./keys";

export const settingsApi = {
  get: () => parseResponse(settings.index.$get()),
  update: (json: SettingsUpdate) => parseResponse(settings.index.$put({ json })),
  uploadLogo: (file: File) => parseResponse(settings.logo.$post({ form: { file } })),
  deleteLogo: () => parseResponse(settings.logo.$delete()),
};

export type Settings = Awaited<ReturnType<typeof settingsApi.get>>;
export type SettingsInput = SettingsUpdate;

// Other features use settingsQuery too (e.g. for default texts / payment terms).
export const settingsQuery = queryOptions({
  queryKey: keys.settings.all,
  queryFn: settingsApi.get,
});

function useSetSettings() {
  const qc = useQueryClient();
  return (data: Settings) => qc.setQueryData(settingsQuery.queryKey, data);
}

export function useUpdateSettings() {
  const onSuccess = useSetSettings();
  return useMutation({ mutationFn: settingsApi.update, onSuccess });
}

export function useUploadLogo() {
  const onSuccess = useSetSettings();
  return useMutation({ mutationFn: settingsApi.uploadLogo, onSuccess });
}

export function useDeleteLogo() {
  const onSuccess = useSetSettings();
  return useMutation({ mutationFn: settingsApi.deleteLogo, onSuccess });
}
