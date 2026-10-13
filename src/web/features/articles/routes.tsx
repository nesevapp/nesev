import { createRoute } from "@tanstack/react-router";
import { ARTICLE_ARCHIVED_FILTERS } from "@shared/schemas/article";
import { rootRoute } from "@/app/root-route";
import { articlesQuery } from "@/sdk";
import { ArticlesPage } from "./articles-page";

export interface ArticlesSearch {
  q?: string;
  archived?: Exclude<typeof ARTICLE_ARCHIVED_FILTERS[number], "active">;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/articles",
  validateSearch: (s: Record<string, unknown>): ArticlesSearch => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    archived: s.archived === "archived" || s.archived === "all" ? s.archived : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(articlesQuery(deps)),
  component: ArticlesPage,
});

export const articlesRoutes = [indexRoute] as const;
