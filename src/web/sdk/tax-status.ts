import { queryOptions, useMutation } from "@tanstack/react-query";
import type { TaxStatusInput } from "@shared/schemas/tax-status";
import { idParam, parseResponse, taxStatus } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

/** Steuerstatus history (Kleinunternehmer, Soll/Ist with valid-from dates). Writes return the whole list. */
export const taxStatusApi = {
  list: () => parseResponse(taxStatus.index.$get()),
  create: (json: TaxStatusInput) => parseResponse(taxStatus.index.$post({ json })),
  update: (id: number, json: TaxStatusInput) => parseResponse(taxStatus[":id"].$put({ param: idParam(id), json })),
  remove: (id: number) => parseResponse(taxStatus[":id"].$delete({ param: idParam(id) })),
};

export type TaxStatusList = Awaited<ReturnType<typeof taxStatusApi.list>>;
export type TaxStatusEntry = TaxStatusList["periods"][number];
export type { TaxStatusInput };

export const taxStatusQuery = queryOptions({ queryKey: keys.taxStatus.all, queryFn: taxStatusApi.list });

function useTaxStatusMutation<V>(fn: (v: V) => Promise<unknown>) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidate("taxStatus") });
}

export const useCreateTaxStatus = () => useTaxStatusMutation((json: TaxStatusInput) => taxStatusApi.create(json));
export const useUpdateTaxStatus = () => useTaxStatusMutation(({ id, json }: { id: number; json: TaxStatusInput }) => taxStatusApi.update(id, json));
export const useDeleteTaxStatus = () => useTaxStatusMutation((id: number) => taxStatusApi.remove(id));
