import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api, parseResponse } from "@/lib/api";

export const uvaQuery = (period: string | undefined, euIn021: boolean) =>
  queryOptions({
    queryKey: ["tax", "uva", period ?? "default", euIn021],
    queryFn: () => parseResponse(api.tax.uva.$get({ query: { period, euIn021: euIn021 ? "1" : undefined } })),
    placeholderData: keepPreviousData,
  });

export const zmQuery = (period: string | undefined) =>
  queryOptions({
    queryKey: ["tax", "zm", period ?? "default"],
    queryFn: () => parseResponse(api.tax.zm.$get({ query: { period } })),
    placeholderData: keepPreviousData,
  });

export const earQuery = (year: number | undefined) =>
  queryOptions({
    queryKey: ["tax", "ear", year ?? "current"],
    queryFn: () => parseResponse(api.tax.ear.$get({ query: { year: year ? String(year) : undefined } })),
    placeholderData: keepPreviousData,
  });

export type UvaDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof uvaQuery>["queryFn"]>>>;
export type UvaLineDTO = UvaDTO["lines"][number];
export type UvaSourceDTO = UvaLineDTO["sources"][number];
export type ZmDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof zmQuery>["queryFn"]>>>;
export type EarDTO = Awaited<ReturnType<NonNullable<ReturnType<typeof earQuery>["queryFn"]>>>;

/** Download URLs (plain links, the browser handles the attachment). */
export const taxCsvUrls = {
  uva: (period: string, euIn021: boolean) =>
    `/api/tax/uva.csv?${new URLSearchParams({ period, ...(euIn021 ? { euIn021: "1" } : {}) })}`,
  zm: (period: string) => `/api/tax/zm.csv?${new URLSearchParams({ period })}`,
  ear: (year: number) => `/api/tax/ear.csv?year=${year}`,
};
