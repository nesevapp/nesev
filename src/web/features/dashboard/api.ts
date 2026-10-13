import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api, parseResponse } from "@/lib/api";

export const dashboardQuery = (year?: number) =>
  queryOptions({
    queryKey: ["dashboard", year ?? "current"],
    queryFn: () => parseResponse(api.dashboard.$get({ query: { year: year ? String(year) : undefined } })),
    placeholderData: keepPreviousData,
  });

export type DashboardDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof dashboardQuery>["queryFn"]>>>;
export type DashboardDocDTO = DashboardDTO["recent"][number];
export type OverdueDocDTO = DashboardDTO["overdue"][number];
