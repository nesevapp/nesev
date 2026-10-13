import { keepPreviousData, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArticleCreate, ArticleListQuery, ArticleUpdate } from "@shared/schemas/article";
import type { Article } from "@server/db/schema";
import { api, parseResponse } from "@/lib/api";

/** An article as returned by the API (same shape for list, picker and detail). */
export type ArticleDTO = Article;

export const articlesQuery = (filter: ArticleListQuery = {}) =>
  queryOptions({
    queryKey: ["articles", "list", filter],
    queryFn: () =>
      parseResponse(
        api.articles.$get({
          query: { q: filter.q || undefined, archived: filter.archived ?? "active", sort: filter.sort ?? "title" },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** Line-item autocomplete: active articles, most used first. */
export const articlePickerQuery = (q: string, limit = 8) =>
  queryOptions({
    queryKey: ["articles", "picker", q, limit],
    queryFn: () => parseResponse(api.articles.picker.$get({ query: { q: q || undefined, limit: String(limit) } })),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

export const nextArticleNumberQuery = queryOptions({
  queryKey: ["articles", "next-number"],
  queryFn: () => parseResponse(api.articles["next-number"].$get()),
});

function useInvalidateArticles() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["articles"] });
}

export function useCreateArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: (json: ArticleCreate) => parseResponse(api.articles.$post({ json })),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: ArticleUpdate }) =>
      parseResponse(api.articles[":id"].$put({ param: { id: String(id) }, json })),
    onSuccess: () => invalidate(),
  });
}

export function useSetArticleArchived() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) => {
      const param = { id: String(id) };
      return parseResponse(
        archived ? api.articles[":id"].archive.$post({ param }) : api.articles[":id"].unarchive.$post({ param }),
      );
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteArticle() {
  const invalidate = useInvalidateArticles();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.articles[":id"].$delete({ param: { id: String(id) } })),
    onSuccess: () => invalidate(),
  });
}
