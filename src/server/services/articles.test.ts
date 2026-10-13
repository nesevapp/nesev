import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { articleCreateSchema, formatArticleNumber, parseArticleNumber } from "../../shared/schemas/article";
import type { DocumentItemInput } from "../../shared/schemas/document";
import { createTestDb, type Db } from "../db/client";
import { clients, documentItems } from "../db/schema";
import {
  bumpArticleUsage,
  createArticle,
  deleteArticle,
  getArticle,
  listArticles,
  nextArticleNumber,
  pickArticles,
  setArticleArchived,
  updateArticle,
} from "./articles";
import { createCreditNote, createDocument, finalizeDocument, getDocument, updateDocument } from "./documents";

const input = (data: Record<string, unknown>) =>
  articleCreateSchema.parse({ unitPriceCents: 10000, taxRateBp: 2000, ...data });

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof HTTPException) return err.status;
    throw err;
  }
  return undefined;
}

function seed(db: Db) {
  return [
    createArticle(
      db,
      input({ title: "Webdesign", description: "Gestaltung pro Stunde", unit: "h", unitPriceCents: 9500 }),
    ),
    createArticle(db, input({ title: "beratung 100% remote_", unit: "h" })),
    createArticle(
      db,
      input({ title: "Hosting", description: "Shared Hosting, monatlich", unit: "Monat", unitPriceCents: 1500 }),
    ),
  ];
}

const lineFrom = (articleId: number | null, over: Partial<DocumentItemInput> = {}): DocumentItemInput => ({
  articleId,
  title: "Zeile",
  description: "",
  quantity: 1000,
  unit: "",
  unitPriceCents: 1000,
  taxRateBp: 2000,
  discountBp: 0,
  ...over,
});

function addClient(db: Db) {
  return db.insert(clients).values({ number: 1, name: "Muster GmbH", country: "AT" }).returning().get();
}

describe("article numbers", () => {
  test("format and parse", () => {
    expect(formatArticleNumber(7)).toBe("A-0007");
    expect(formatArticleNumber(12345)).toBe("A-12345");
    for (const s of ["A-0007", "a7", "0007", "7", " a-07 "]) expect(parseArticleNumber(s)).toBe(7);
    expect(parseArticleNumber("K-0007")).toBeNull();
    expect(parseArticleNumber("Web")).toBeNull();
  });

  test("auto-assigned as max + 1, explicit numbers must be free", () => {
    const db = createTestDb();
    expect(nextArticleNumber(db)).toBe(1);
    const [a, b] = seed(db);
    expect([a!.number, b!.number]).toEqual([1, 2]);
    expect(createArticle(db, input({ title: "X", number: 50 })).number).toBe(50);
    expect(nextArticleNumber(db)).toBe(51);
    expect(statusOf(() => createArticle(db, input({ title: "Y", number: 50 })))).toBe(409);
    expect(statusOf(() => updateArticle(db, a!.id, { number: 2 }))).toBe(409);
    expect(updateArticle(db, a!.id, { number: 1 }).number).toBe(1);
  });

  test("schema rejects tax rates other than 20/13/10/0 %", () => {
    expect(articleCreateSchema.safeParse({ title: "X", unitPriceCents: 1, taxRateBp: 1300 }).success).toBe(true);
    expect(articleCreateSchema.safeParse({ title: "X", unitPriceCents: 1, taxRateBp: 550 }).success).toBe(false);
    expect(articleCreateSchema.safeParse({ title: " ", unitPriceCents: 1, taxRateBp: 0 }).success).toBe(false);
  });
});

describe("CRUD", () => {
  test("create, get, update, archive, delete", () => {
    const db = createTestDb();
    const [web] = seed(db);
    expect(getArticle(db, web!.id)).toMatchObject({
      title: "Webdesign",
      unit: "h",
      unitPriceCents: 9500,
      usageCount: 0,
    });

    const updated = updateArticle(db, web!.id, { unitPriceCents: 11000, notes: "ab 2027" });
    expect(updated).toMatchObject({ title: "Webdesign", unitPriceCents: 11000, notes: "ab 2027" });

    expect(setArticleArchived(db, web!.id, true).archivedAt).not.toBeNull();
    expect(listArticles(db).map((a) => a.title)).not.toContain("Webdesign");
    expect(listArticles(db, { archived: "archived" }).map((a) => a.title)).toEqual(["Webdesign"]);
    expect(listArticles(db, { archived: "all" })).toHaveLength(3);
    expect(setArticleArchived(db, web!.id, false).archivedAt).toBeNull();

    deleteArticle(db, web!.id);
    expect(getArticle(db, web!.id)).toBeUndefined();
    expect(statusOf(() => deleteArticle(db, web!.id))).toBe(404);
    expect(statusOf(() => updateArticle(db, 999, { title: "x" }))).toBe(404);
  });

  test("search matches title, description and number; % and _ are literal", () => {
    const db = createTestDb();
    seed(db);
    const titles = (q: string) => listArticles(db, { q }).map((a) => a.title);
    expect(titles("host")).toEqual(["Hosting"]);
    expect(titles("monatlich")).toEqual(["Hosting"]);
    expect(titles("A-0001")).toEqual(["Webdesign"]);
    expect(titles("100%")).toEqual(["beratung 100% remote_"]);
    expect(titles("_")).toEqual(["beratung 100% remote_"]);
    expect(titles("")).toEqual(["beratung 100% remote_", "Hosting", "Webdesign"]);
  });
});

describe("picker", () => {
  test("active only, ordered by usage desc then title, limited", () => {
    const db = createTestDb();
    const [web, beratung, hosting] = seed(db);
    const archived = createArticle(db, input({ title: "Alt" }));
    setArticleArchived(db, archived.id, true);
    bumpArticleUsage(db, [hosting!.id, archived.id]);
    bumpArticleUsage(db, [hosting!.id, web!.id]);

    expect(pickArticles(db, undefined).map((a) => a.id)).toEqual([hosting!.id, web!.id, beratung!.id]);
    expect(pickArticles(db, undefined, 2).map((a) => a.id)).toEqual([hosting!.id, web!.id]);
    expect(pickArticles(db, "ung").map((a) => a.id)).toEqual([web!.id, beratung!.id]);
    expect(listArticles(db, { sort: "usage" })[0]!.id).toBe(hosting!.id);
  });
});

describe("usage tracking", () => {
  test("finalizing counts each article once per document; drafts and credit notes don't count", () => {
    const db = createTestDb();
    const client = addClient(db);
    const [web, , hosting] = seed(db);
    const doc = createDocument(db, {
      type: "invoice",
      clientId: client.id,
      items: [lineFrom(web!.id), lineFrom(web!.id), lineFrom(null), lineFrom(hosting!.id)],
    });
    expect(doc.items.map((i) => i.articleId)).toEqual([web!.id, web!.id, null, hosting!.id]);
    expect(getArticle(db, web!.id)!.usageCount).toBe(0);

    finalizeDocument(db, doc.id);
    expect(getArticle(db, web!.id)).toMatchObject({ usageCount: 1, lastUsedAt: expect.any(String) });
    expect(getArticle(db, hosting!.id)!.usageCount).toBe(1);

    const credit = createCreditNote(db, doc.id);
    expect(credit.items.map((i) => i.articleId)).toEqual([web!.id, web!.id, null, hosting!.id]);
    finalizeDocument(db, credit.id);
    expect(getArticle(db, web!.id)!.usageCount).toBe(1);
  });

  test("unknown article ids on save are dropped, the line is kept", () => {
    const db = createTestDb();
    const client = addClient(db);
    const doc = createDocument(db, { type: "offer", clientId: client.id });
    const saved = updateDocument(db, doc.id, { items: [lineFrom(4711, { title: "Frei" })] });
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({ articleId: null, title: "Frei" });
  });
});

describe("delete keeps document items", () => {
  test("copied values stay, article_id becomes null; price changes don't propagate", () => {
    const db = createTestDb();
    const client = addClient(db);
    const [web] = seed(db);
    const doc = createDocument(db, {
      type: "invoice",
      clientId: client.id,
      items: [lineFrom(web!.id, { title: web!.title, unit: web!.unit, unitPriceCents: web!.unitPriceCents })],
    });
    finalizeDocument(db, doc.id);

    updateArticle(db, web!.id, { unitPriceCents: 20000, title: "Webdesign neu" });
    expect(getDocument(db, doc.id).items[0]).toMatchObject({ title: "Webdesign", unitPriceCents: 9500 });

    deleteArticle(db, web!.id);
    const rows = db.select().from(documentItems).where(eq(documentItems.documentId, doc.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ articleId: null, title: "Webdesign", unit: "h", unitPriceCents: 9500 });
    expect(getDocument(db, doc.id).netCents).toBe(9500);
  });
});
