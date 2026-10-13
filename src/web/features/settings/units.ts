import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, parseResponse } from "@/lib/api";

export const unitsQuery = queryOptions({
  queryKey: ["units"],
  queryFn: async () => (await parseResponse(api.units.$get())).units,
  staleTime: 60_000,
});

export function useUpdateUnits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (units: string[]) => (await parseResponse(api.units.$put({ json: { units } }))).units,
    onSuccess: (units) => qc.setQueryData(unitsQuery.queryKey, units),
  });
}
