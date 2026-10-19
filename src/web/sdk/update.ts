import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse, update } from "./client";
import { keys } from "./keys";

// Update hint: is a newer nesev release out (checked by the server at most once a day, if enabled).

export const updateApi = {
  status: (force = false) => parseResponse(update.index.$get({ query: force ? { force: "1" } : {} })),
  setEnabled: (enabled: boolean) => parseResponse(update.index.$put({ json: { enabled } })),
};

export type UpdateStatus = Awaited<ReturnType<typeof updateApi.status>>;

export const updateStatusQuery = queryOptions({
  queryKey: keys.update.status,
  queryFn: () => updateApi.status(),
  staleTime: 60 * 60 * 1000,
  refetchInterval: 6 * 60 * 60 * 1000,
  retry: false,
});

/** "Jetzt prüfen": asks the server to check right away. */
export function useCheckForUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => updateApi.status(true),
    onSuccess: (data) => qc.setQueryData(updateStatusQuery.queryKey, data),
  });
}

export function useSetUpdateCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateApi.setEnabled,
    onSuccess: (data) => qc.setQueryData(updateStatusQuery.queryKey, data),
  });
}
