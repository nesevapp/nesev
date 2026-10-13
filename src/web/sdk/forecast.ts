import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { forecast, parseResponse } from "./client";
import { keys } from "./keys";

export interface ForecastParams {
  months: number;
  drafts: boolean;
  offers: boolean;
  probability: number;
}

export const forecastApi = {
  get: (p: ForecastParams) =>
    parseResponse(
      forecast.index.$get({
        query: {
          months: String(p.months),
          drafts: p.drafts ? "1" : undefined,
          offers: p.offers ? "1" : undefined,
          probability: String(p.probability),
        },
      }),
    ),
};

export type Forecast = Awaited<ReturnType<typeof forecastApi.get>>;
export type ForecastEntry = Forecast["entries"][number];
export type ForecastBucket = Forecast["monthly"][number];
export type ForecastSource = ForecastEntry["source"];

export const forecastQuery = (p: ForecastParams) =>
  queryOptions({
    queryKey: keys.forecast.report(p),
    queryFn: () => forecastApi.get(p),
    placeholderData: keepPreviousData,
  });
