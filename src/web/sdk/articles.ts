import { keepPreviousData, queryOptions, useMutation } from "@tanstack/react-query";
import type { ArticleCreate, ArticleListQuery, ArticleUpdate } from "@shared/schemas/article";
import { articles, idParam, parseResponse } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export const articlesApi = {
  list: (filter: ArticleListQuery = {}) =>
    parseResponse(
      articles.index.$get({
        query: { q: filter.q || undefined, archived: filter.archived ?? "active", sort: filter.sort ?? "title" },
      }),
    ),
  picker: (q: string, limit: number) =>
    parseResponse(articles.picker.$get({ query: { q: q || undefined, limit: String(limit) } })),
  nextNumber: () => parseResponse(articles["next-number"].$get()),
  create: (json: ArticleCreateInput) => parseResponse(articles.index.$post({ json })),
  update: (id: number, json: ArticleUpdateInput) => parseResponse(articles[":id"].$put({ param: idParam(id), json })),
  setArchived: (id: number, archived: boolean) =>
    parseResponse(
      archived ? articles[":id"].archive.$post({ param: idParam(id) }) : articles[":id"].unarchive.$post({ param: idParam(id) }),
    ),
  remove: (id: number) => parseResponse(articles[":id"].$delete({ param: idParam(id) })),
};

/** An article as returned by the API (same shape for list, picker and detail). */
export type Article = Awaited<ReturnType<typeof articlesApi.list>>[number];
export type ArticleCreateInput = ArticleCreate;
export type ArticleUpdateInput = ArticleUpdate;
export type ArticleListFilter = ArticleListQuery;

export const articlesQuery = (filter: ArticleListFilter = {}) =>
  queryOptions({
    queryKey: keys.articles.list(filter),
    queryFn: () => articlesApi.list(filter),
    placeholderData: keepPreviousData,
  });

/** Line-item autocomplete: active articles, most used first. */
export const articlePickerQuery = (q: string, limit = 8) =>
  queryOptions({
    queryKey: keys.articles.picker(q, limit),
    queryFn: () => articlesApi.picker(q, limit),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

export const nextArticleNumberQuery = queryOptions({
  queryKey: keys.articles.nextNumber,
  queryFn: articlesApi.nextNumber,
});

export function useCreateArticle() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (json: ArticleCreateInput) => articlesApi.create(json),
    onSuccess: () => invalidate("articles"),
  });
}

export function useUpdateArticle() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, json }: { id: number; json: ArticleUpdateInput }) => articlesApi.update(id, json),
    onSuccess: () => invalidate("articles"),
  });
}

export function useSetArticleArchived() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, archived }: { id: number; archived: boolean }) => articlesApi.setArchived(id, archived),
    onSuccess: () => invalidate("articles"),
  });
}

export function useDeleteArticle() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => articlesApi.remove(id),
    onSuccess: () => invalidate("articles"),
  });
}
