import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { parseResponse, tax } from "./client";
import { keys } from "./keys";

export const taxApi = {
  uva: (period: string | undefined, euIn021: boolean) =>
    parseResponse(tax.uva.$get({ query: { period, euIn021: euIn021 ? "1" : undefined } })),
  zm: (period: string | undefined) => parseResponse(tax.zm.$get({ query: { period } })),
  ear: (year: number | undefined) => parseResponse(tax.ear.$get({ query: { year: year ? String(year) : undefined } })),
};

export type UvaReport = Awaited<ReturnType<typeof taxApi.uva>>;
export type UvaLine = UvaReport["lines"][number];
export type UvaSource = UvaLine["sources"][number];
export type ZmReport = Awaited<ReturnType<typeof taxApi.zm>>;
export type EarReport = Awaited<ReturnType<typeof taxApi.ear>>;

export const uvaQuery = (period: string | undefined, euIn021: boolean) =>
  queryOptions({
    queryKey: keys.tax.uva(period, euIn021),
    queryFn: () => taxApi.uva(period, euIn021),
    placeholderData: keepPreviousData,
  });

export const zmQuery = (period: string | undefined) =>
  queryOptions({
    queryKey: keys.tax.zm(period),
    queryFn: () => taxApi.zm(period),
    placeholderData: keepPreviousData,
  });

export const earQuery = (year: number | undefined) =>
  queryOptions({
    queryKey: keys.tax.ear(year),
    queryFn: () => taxApi.ear(year),
    placeholderData: keepPreviousData,
  });

/** Download URLs (plain links, the browser handles the attachment). */
export const taxCsvUrls = {
  uva: (period: string, euIn021: boolean) =>
    `/api/tax/uva.csv?${new URLSearchParams({ period, ...(euIn021 ? { euIn021: "1" } : {}) })}`,
  zm: (period: string) => `/api/tax/zm.csv?${new URLSearchParams({ period })}`,
  ear: (year: number) => `/api/tax/ear.csv?year=${year}`,
};
