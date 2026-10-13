import { Hono } from "hono";
import { z } from "zod";
import {
  articleCreateSchema,
  articleListQuerySchema,
  articlePickerQuerySchema,
  articleUpdateSchema,
} from "../../shared/schemas/article";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  createArticle,
  deleteArticle,
  listArticles,
  nextArticleNumber,
  pickArticles,
  requireArticle,
  setArticleArchived,
  updateArticle,
} from "../services/articles";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", validate("query", articleListQuerySchema), (c) => c.json(listArticles(db, c.req.valid("query"))))
  /** Line-item autocomplete: active articles, most used first. */
  .get("/picker", validate("query", articlePickerQuerySchema), (c) => {
    const { q, limit } = c.req.valid("query");
    return c.json(pickArticles(db, q, limit));
  })
  .get("/next-number", (c) => c.json({ number: nextArticleNumber(db) }))
  .get("/:id", idParam, (c) => c.json(requireArticle(db, c.req.valid("param").id)))
  .post("/", validate("json", articleCreateSchema), (c) => c.json(createArticle(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", articleUpdateSchema), (c) =>
    c.json(updateArticle(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/archive", idParam, (c) => c.json(setArticleArchived(db, c.req.valid("param").id, true)))
  .post("/:id/unarchive", idParam, (c) => c.json(setArticleArchived(db, c.req.valid("param").id, false)))
  .delete("/:id", idParam, (c) => {
    deleteArticle(db, c.req.valid("param").id);
    return c.json({ ok: true });
  });

export default app;
