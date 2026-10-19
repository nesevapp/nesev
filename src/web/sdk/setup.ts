import { queryOptions, useMutation } from "@tanstack/react-query";
import { parseResponse, setup } from "./client";
import { keys } from "./keys";

// First-start setup (choosing the data folder) and the data folder shown in the app. The server answers /status in
// setup mode and in the normal app; every other endpoint is 503 until the setup is done.

export const setupApi = {
  status: () => parseResponse(setup.status.$get()),
  check: (path: string) => parseResponse(setup.check.$post({ json: { path } })),
  browse: () => parseResponse(setup.browse.$post()),
  complete: ({ path, updateCheck }: { path: string; updateCheck: boolean }) =>
    parseResponse(setup.complete.$post({ json: { path, updateCheck } })),
  /** restore a backup (ZIP / .db) into the chosen, new or empty folder and finish the setup */
  restore: ({ path, file, updateCheck }: { path: string; file: File; updateCheck: boolean }) =>
    parseResponse(setup.restore.$post({ form: { path, file, updateCheck: updateCheck ? "1" : "0" } })),
  reveal: () => parseResponse(setup.reveal.$post()),
};

export type SetupStatus = Awaited<ReturnType<typeof setupApi.status>>;
export type DataDirSuggestion = SetupStatus["suggestions"][number];
export type DataDirCheck = Awaited<ReturnType<typeof setupApi.check>>;

export const setupStatusQuery = queryOptions({
  queryKey: keys.setup.status,
  queryFn: setupApi.status,
  staleTime: Infinity,
});

export const dataDirCheckQuery = (path: string) =>
  queryOptions({
    queryKey: [...keys.setup.status, "check", path] as const,
    queryFn: () => setupApi.check(path),
    enabled: path.trim().length > 0,
  });

export function useBrowseFolder() {
  return useMutation({ mutationFn: setupApi.browse });
}

/** Saves the data folder; the server then loads the app, so the page reloads afterwards. */
export function useCompleteSetup() {
  return useMutation({ mutationFn: setupApi.complete });
}

/** Like useCompleteSetup, starting from a backup. */
export function useRestoreSetup() {
  return useMutation({ mutationFn: setupApi.restore });
}

export function useRevealDataDir() {
  return useMutation({ mutationFn: setupApi.reveal });
}
