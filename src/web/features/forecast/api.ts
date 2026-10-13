import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api, parseResponse } from "@/lib/api";

export interface ForecastParams {
  months: number;
  drafts: boolean;
  offers: boolean;
  probability: number;
}

export const forecastQuery = (p: ForecastParams) =>
  queryOptions({
    queryKey: ["forecast", p],
    queryFn: () =>
      parseResponse(
        api.forecast.$get({
          query: {
            months: String(p.months),
            drafts: p.drafts ? "1" : undefined,
            offers: p.offers ? "1" : undefined,
            probability: String(p.probability),
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

export type ForecastDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof forecastQuery>["queryFn"]>>>;
export type ForecastEntryDTO = ForecastDTO["entries"][number];
export type ForecastBucketDTO = ForecastDTO["monthly"][number];
export type ForecastSource = ForecastEntryDTO["source"];
