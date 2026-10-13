import { and, asc, desc, eq, inArray, isNotNull, isNull, max, ne, or, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import {
  type ArticleCreate,
  type ArticleUpdate,
  ARTICLE_ARCHIVED_FILTERS,
  ARTICLE_SORTS,
  formatArticleNumber,
  parseArticleNumber,
} from "../../shared/schemas/article";
import type { DbOrTx } from "../db/client";
import { type Article, articles, documentItems } from "../db/schema";

// Article catalog. Document lines copy an article's values when it is picked (later price changes
// don't touch existing documents); document_items.article_id only records the origin and is set
// null when the article is deleted.

export interface ArticleListFilter {
  q?: string;
  archived?: typeof ARTICLE_ARCHIVED_FILTERS[number];
  sort?: typeof ARTICLE_SORTS[number];
  limit?: number;
}

/** Case-insensitive (ASCII) substring match with %/_ escaped. */
function contains(column: AnySQLiteColumn, term: string): SQL {
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}

function searchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const conditions = [contains(articles.title, term), contains(articles.description, term)];
  const number = parseArticleNumber(term);
  if (number !== null) conditions.push(eq(articles.number, number));
  return or(...conditions);
}

const titleOrder = sql`${articles.title} COLLATE NOCASE`;
const ORDER: Record<typeof ARTICLE_SORTS[number], SQL[]> = {
  title: [titleOrder, asc(articles.number)],
  number: [asc(articles.number)],
  usage: [desc(articles.usageCount), titleOrder, asc(articles.number)],
};

/** Articles, by default active ones sorted by title. */
export function listArticles(db: DbOrTx, filter: ArticleListFilter = {}): Article[] {
  const archived = filter.archived ?? "active";
  const where = and(
    filter.q ? searchCondition(filter.q) : undefined,
    archived === "active"
      ? isNull(articles.archivedAt)
      : archived === "archived"
      ? isNotNull(articles.archivedAt)
      : undefined,
  );
  const query = db
    .select()
    .from(articles)
    .where(where)
    .orderBy(...ORDER[filter.sort ?? "title"]);
  return filter.limit ? query.limit(filter.limit).all() : query.all();
}

/** Line-item autocomplete: active articles only, most used first. */
export function pickArticles(db: DbOrTx, q: string | undefined, limit = 10): Article[] {
  return listArticles(db, { q, archived: "active", sort: "usage", limit });
}

export function getArticle(db: DbOrTx, id: number): Article | undefined {
  return db.select().from(articles).where(eq(articles.id, id)).get();
}

/** Like getArticle, but throws a 404 HTTPException when missing. */
export function requireArticle(db: DbOrTx, id: number): Article {
  const article = getArticle(db, id);
  if (!article) throw new HTTPException(404, { message: "Artikel nicht gefunden" });
  return article;
}

/** max(number) + 1 — article numbers are unique, not gapless. */
export function nextArticleNumber(db: DbOrTx): number {
  const row = db
    .select({ last: max(articles.number) })
    .from(articles)
    .get();
  return (row?.last ?? 0) + 1;
}

function assertNumberFree(db: DbOrTx, number: number, exceptId?: number) {
  const taken = db
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.number, number), exceptId ? ne(articles.id, exceptId) : undefined))
    .get();
  if (taken)
    throw new HTTPException(409, { message: `Artikelnummer ${formatArticleNumber(number)} ist bereits vergeben` });
}

export function createArticle(db: DbOrTx, data: ArticleCreate): Article {
  return db.transaction((tx) => {
    const { number, ...rest } = data;
    if (number !== undefined) assertNumberFree(tx, number);
    return tx
      .insert(articles)
      .values({ ...rest, number: number ?? nextArticleNumber(tx) })
      .returning()
      .get();
  });
}

export function updateArticle(db: DbOrTx, id: number, data: ArticleUpdate): Article {
  return db.transaction((tx) => {
    requireArticle(tx, id);
    if (data.number !== undefined) assertNumberFree(tx, data.number, id);
    if (Object.keys(data).length === 0) return requireArticle(tx, id);
    return tx.update(articles).set(data).where(eq(articles.id, id)).returning().get();
  });
}

export function setArticleArchived(db: DbOrTx, id: number, archived: boolean): Article {
  const article = requireArticle(db, id);
  if (archived === (article.archivedAt !== null)) return article;
  return db
    .update(articles)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(eq(articles.id, id))
    .returning()
    .get();
}

/** Always allowed: document lines keep their copied values, only their article_id becomes null. */
export function deleteArticle(db: DbOrTx, id: number): void {
  db.transaction((tx) => {
    requireArticle(tx, id);
    // explicit: the ALTER TABLE that added document_items.article_id could not declare ON DELETE SET NULL
    tx.update(documentItems).set({ articleId: null }).where(eq(documentItems.articleId, id)).run();
    tx.delete(articles).where(eq(articles.id, id)).run();
  });
}

/** Of the given ids, those that still exist (lines may reference deleted articles). */
export function existingArticleIds(db: DbOrTx, ids: (number | null | undefined)[]): Set<number> {
  const unique = [...new Set(ids.filter((id): id is number => typeof id === "number"))];
  if (unique.length === 0) return new Set();
  const rows = db.select({ id: articles.id }).from(articles).where(inArray(articles.id, unique)).all();
  return new Set(rows.map((r) => r.id));
}

/**
 * Count one use per article per document (called when a document is finalized).
 * Missing ids are ignored.
 */
export function bumpArticleUsage(db: DbOrTx, ids: (number | null | undefined)[], at = new Date().toISOString()): void {
  const unique = [...existingArticleIds(db, ids)];
  if (unique.length === 0) return;
  db.update(articles)
    .set({ usageCount: sql`${articles.usageCount} + 1`, lastUsedAt: at })
    .where(inArray(articles.id, unique))
    .run();
}
