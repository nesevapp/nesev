import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { dashboard, parseResponse } from "./client";
import { keys } from "./keys";

export const dashboardApi = {
  get: (year?: number) => parseResponse(dashboard.index.$get({ query: { year: year ? String(year) : undefined } })),
};

export type Dashboard = Awaited<ReturnType<typeof dashboardApi.get>>;
export type DashboardDocument = Dashboard["recent"][number];
export type OverdueDocument = Dashboard["overdue"][number];

export const dashboardQuery = (year?: number) =>
  queryOptions({
    queryKey: keys.dashboard.year(year),
    queryFn: () => dashboardApi.get(year),
    placeholderData: keepPreviousData,
  });
