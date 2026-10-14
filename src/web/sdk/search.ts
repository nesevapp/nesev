import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { parseResponse, search } from "./client";
import { keys } from "./keys";

export const searchApi = {
  query: (q: string, limit?: number) =>
    parseResponse(search.index.$get({ query: { q, limit: limit ? String(limit) : undefined } })),
};

export type SearchResponse = Awaited<ReturnType<typeof searchApi.query>>;
export type SearchGroup = SearchResponse["groups"][number];
export type SearchResult = SearchGroup["results"][number];
export type SearchResultType = SearchResult["type"];

/** Global search (command palette). Keeps the previous results while the next query loads. */
export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: keys.search.query(q),
    queryFn: () => searchApi.query(q),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
