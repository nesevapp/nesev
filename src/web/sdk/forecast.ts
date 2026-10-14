import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ForecastSettings } from "@shared/schemas/recurring-expense";
import { forecast, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export interface ForecastParams {
  months: number;
  drafts: boolean;
  offers: boolean;
  probability: number;
  /** Fixkosten, unpaid expenses, VAT and income tax */
  outflows: boolean;
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
          outflows: p.outflows ? undefined : "0",
        },
      }),
    ),
  settings: () => parseResponse(forecast.settings.$get()),
  updateSettings: (json: ForecastSettingsInput) => parseResponse(forecast.settings.$put({ json })),
};

export type Forecast = Awaited<ReturnType<typeof forecastApi.get>>;
export type ForecastEntry = Forecast["entries"][number];
export type ForecastBucket = Forecast["monthly"][number];
export type ForecastSource = ForecastEntry["source"];
export type ForecastSettingsInput = ForecastSettings;

export const forecastQuery = (p: ForecastParams) =>
  queryOptions({
    queryKey: keys.forecast.report(p),
    queryFn: () => forecastApi.get(p),
    placeholderData: keepPreviousData,
  });

export const forecastSettingsQuery = queryOptions({
  queryKey: keys.forecast.settings,
  queryFn: forecastApi.settings,
});

export function useUpdateForecastSettings() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (json: ForecastSettingsInput) => forecastApi.updateSettings(json),
    onSuccess: (saved) => {
      qc.setQueryData(keys.forecast.settings, saved);
      return invalidate("forecastSettings", keys.forecast.settings);
    },
  });
}
