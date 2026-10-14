import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ARTICLE_ARCHIVED_FILTERS, ARTICLE_SORTS, formatArticleNumber } from "../../shared/schemas/article";
import { call } from "../api";
import { bullets, join, Money, money, percent } from "../format";
import { defineTool, READ_ONLY, type ToolContext } from "../tool";

// Article catalog (Artikel).

export const ArticleRow = z.object({
  id: z.number().int(),
  number: z.string().describe('e.g. "A-0001"'),
  title: z.string(),
  description: z.string(),
  unit: z.string(),
  unitPrice: Money.describe("net"),
  taxRatePercent: z.number(),
  usageCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  archived: z.boolean(),
  link: z.string(),
});

type ArticleLike = {
  id: number;
  number: number;
  title: string;
  description: string;
  unit: string;
  unitPriceCents: number;
  taxRateBp: number;
  usageCount: number;
  lastUsedAt: string | null;
  archivedAt: string | null;
};

export function articleRow(ctx: ToolContext, a: ArticleLike) {
  const number = formatArticleNumber(a.number);
  return {
    id: a.id,
    number,
    title: a.title,
    description: a.description,
    unit: a.unit,
    unitPrice: money(a.unitPriceCents),
    taxRatePercent: percent(a.taxRateBp),
    usageCount: a.usageCount,
    lastUsedAt: a.lastUsedAt,
    archived: a.archivedAt !== null,
    link: ctx.webUrl(`/articles?q=${encodeURIComponent(number)}${a.archivedAt ? "&archived=all" : ""}`),
  };
}

export function registerArticleTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "list_articles",
    {
      title: "Artikel auflisten",
      group: "clients",
      description:
        "List catalog articles (Artikel: reusable line items with unit, net unit price and tax rate). `query` matches " +
        'title, description and the article number ("A-0002"). sort=usage puts the most used first. Prices are net.',
      input: z.object({
        query: z.string().trim().max(200).optional(),
        archived: z.enum(ARTICLE_ARCHIVED_FILTERS).default("active"),
        sort: z.enum(ARTICLE_SORTS).default("title"),
        limit: z.number().int().min(1).max(500).default(50),
      }),
      output: z.object({
        total: z.number().int(),
        truncated: z.boolean(),
        articles: z.array(ArticleRow),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, archived, sort, limit }) => {
      const rows = await call(ctx.api.articles.index.$get({ query: { q: query || undefined, archived, sort } }));
      const articles = rows.slice(0, limit).map((a) => articleRow(ctx, a));
      const text = [
        `${rows.length} Artikel${rows.length > articles.length ? ` (${articles.length} gezeigt)` : ""}:`,
        bullets(
          articles.map((a) =>
            join(
              `${a.title} (article id ${a.id})`,
              a.number,
              `${a.unitPrice.formatted} netto${a.unit ? ` / ${a.unit}` : ""}`,
              `${a.taxRatePercent} % USt`,
              `${a.usageCount}× verwendet`,
              a.archived && "archiviert",
            ),
          ),
        ),
      ].join("\n");
      return { text, data: { total: rows.length, truncated: rows.length > articles.length, articles } };
    },
  );
}
