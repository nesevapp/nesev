import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse, units } from "./client";
import { keys } from "./keys";

export const unitsApi = {
  list: async () => (await parseResponse(units.index.$get())).units,
  update: async (list: string[]) => (await parseResponse(units.index.$put({ json: { units: list } }))).units,
};

export const unitsQuery = queryOptions({
  queryKey: keys.units.all,
  queryFn: unitsApi.list,
  staleTime: 60_000,
});

export function useUpdateUnits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: unitsApi.update,
    onSuccess: (list) => qc.setQueryData(unitsQuery.queryKey, list),
  });
}
