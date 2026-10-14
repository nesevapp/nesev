import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssetCreate, AssetDisposal, AssetUpdate } from "@shared/schemas/asset";
import { assets, idParam, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export const assetsApi = {
  /** Anlagenverzeichnis of a year (default: current year). */
  register: (year?: number) => parseResponse(assets.index.$get({ query: { year: year ? String(year) : undefined } })),
  get: (id: number) => parseResponse(assets[":id"].$get({ param: idParam(id) })),
  /** Assets bought with an expense. */
  links: () => parseResponse(assets.links.$get()),
  nextNumber: () => parseResponse(assets["next-number"].$get()),
  prefillFromExpense: (expenseId: number) => parseResponse(assets["from-expense"][":id"].$get({ param: idParam(expenseId) })),
  create: (json: AssetCreateInput) => parseResponse(assets.index.$post({ json })),
  update: (id: number, json: AssetUpdateInput) => parseResponse(assets[":id"].$put({ param: idParam(id), json })),
  dispose: (id: number, json: AssetDisposalInput) => parseResponse(assets[":id"].disposal.$post({ param: idParam(id), json })),
  undoDisposal: (id: number) => parseResponse(assets[":id"].disposal.$delete({ param: idParam(id) })),
  remove: (id: number) => parseResponse(assets[":id"].$delete({ param: idParam(id) })),
};

export type AssetRegister = Awaited<ReturnType<typeof assetsApi.register>>;
export type AssetRegisterRow = AssetRegister["rows"][number];
export type Asset = Awaited<ReturnType<typeof assetsApi.get>>;
export type AssetLink = Awaited<ReturnType<typeof assetsApi.links>>[number];
export type AssetPrefill = Awaited<ReturnType<typeof assetsApi.prefillFromExpense>>;
export type AssetCreateInput = AssetCreate;
export type AssetUpdateInput = AssetUpdate;
export type AssetDisposalInput = AssetDisposal;

export const assetRegisterQuery = (year?: number) =>
  queryOptions({
    queryKey: keys.assets.list({ year: year ?? null }),
    queryFn: () => assetsApi.register(year),
    placeholderData: keepPreviousData,
  });

export const assetQuery = (id: number) =>
  queryOptions({ queryKey: keys.assets.detail(id), queryFn: () => assetsApi.get(id) });

export const assetLinksQuery = queryOptions({ queryKey: keys.assets.list({ links: true }), queryFn: assetsApi.links });

export const nextAssetNumberQuery = queryOptions({ queryKey: keys.assets.list({ nextNumber: true }), queryFn: assetsApi.nextNumber });

export const assetPrefillQuery = (expenseId: number) =>
  queryOptions({ queryKey: keys.assets.list({ prefill: expenseId }), queryFn: () => assetsApi.prefillFromExpense(expenseId) });

/** Writes the saved asset into the detail cache and refreshes everything that depends on AfA. */
function useOnSaved() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (saved: Asset) => {
    const key = assetQuery(saved.id).queryKey;
    qc.setQueryData(key, saved);
    void invalidate("assets", key);
  };
}

export function useCreateAsset() {
  const onSaved = useOnSaved();
  return useMutation({ mutationFn: (json: AssetCreateInput) => assetsApi.create(json), onSuccess: onSaved });
}

export function useUpdateAsset() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: AssetUpdateInput }) => assetsApi.update(id, json),
    onSuccess: onSaved,
  });
}

export function useDisposeAsset() {
  const onSaved = useOnSaved();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: AssetDisposalInput }) => assetsApi.dispose(id, json),
    onSuccess: onSaved,
  });
}

export function useUndoAssetDisposal() {
  const onSaved = useOnSaved();
  return useMutation({ mutationFn: (id: number) => assetsApi.undoDisposal(id), onSuccess: onSaved });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => assetsApi.remove(id),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: assetQuery(id).queryKey });
      void invalidate("assets");
    },
  });
}

/** Download URL of the Anlagenverzeichnis CSV. */
export const assetRegisterCsvUrl = (year: number) => `/api/assets/register.csv?year=${year}`;
