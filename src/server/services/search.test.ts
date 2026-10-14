import { describe, expect, test } from "bun:test";
import type { ClientSnapshot } from "../../shared/types";
import { createTestDb, type Db } from "../db/client";
import {
  articles,
  clients,
  documents,
  expenses,
  fixedAssets,
  type NewClient,
  recurringExpenses,
  reminders,
} from "../db/schema";
import { foldText, parseQuery, parseWords, search, type SearchResultType } from "./search";

let clientNo = 0;
function addClient(db: Db, over: Partial<NewClient> = {}) {
  return db
    .insert(clients)
    .values({ number: ++clientNo, name: "Muster GmbH", country: "AT", ...over })
    .returning()
    .get();
}

function addDoc(db: Db, clientId: number, over: Partial<typeof documents.$inferInsert> = {}) {
  return db
    .insert(documents)
    .values({ type: "invoice", status: "final", clientId, issueDate: "2026-03-01", taxMode: "AT_DOMESTIC", ...over })
    .returning()
    .get();
}

const snapshot = (name: string, clientId: number): ClientSnapshot => ({
  clientId,
  number: 1,
  type: "company",
  name,
  contactPerson: "",
  street: "",
  addressExtra: "",
  zip: "",
  city: "",
  country: "AT",
  uid: "",
  email: "",
});

function seed() {
  const db = createTestDb();
  const alpen = addClient(db, { name: "Alpen Hosting AG", city: "Innsbruck", email: "office@alpen.at", uid: "ATU 12345678" });
  const mueller = addClient(db, { name: "Bäckerei Müller", contactPerson: "Jörg Groß", city: "Wien" });
  const inv12 = addDoc(db, alpen.id, { number: "RE-2026-0012", grossCents: 120000, netCents: 100000, title: "Hosting März" });
  const inv12old = addDoc(db, alpen.id, { number: "RE-2025-0012", issueDate: "2025-05-01", grossCents: 5000 });
  const inv3 = addDoc(db, alpen.id, { number: "RE-2026-0003", grossCents: 123456, title: "Wartung" });
  // finalized while the client was still called differently
  const renamed = addDoc(db, mueller.id, {
    number: "RE-2026-0120",
    clientSnapshot: snapshot("Alte Firma KG", mueller.id),
    grossCents: 999,
  });
  const draft = addDoc(db, mueller.id, { status: "draft", number: null, title: "Brot 100% Bio_mix" });
  const offer12 = addDoc(db, alpen.id, { type: "offer", number: "AN-2026-0012" });
  const credit = addDoc(db, alpen.id, { type: "credit_note", number: "GS-2026-0001", parentId: inv3.id, grossCents: 1000 });
  const reminder = db
    .insert(reminders)
    .values({ invoiceId: inv3.id, level: 1, status: "final", number: "MA-2026-0002", issueDate: "2026-04-01", dueDate: "2026-04-08" })
    .returning()
    .get();
  const expense = db
    .insert(expenses)
    .values({
      number: "ER-2026-0012",
      supplierName: "A1 Telekom Austria",
      supplierInvoiceNumber: "INV-778899",
      issueDate: "2026-02-10",
      description: "Mobilfunk Februar",
      grossCents: 4790,
      netCents: 3992,
    })
    .returning()
    .get();
  const article = db.insert(articles).values({ number: 12, title: "Beratungsstunde" }).returning().get();
  const fixed = db
    .insert(recurringExpenses)
    .values({ name: "SVS Beiträge", supplierName: "SVS", startDate: "2026-01-01", grossCents: 123456 })
    .returning()
    .get();
  const asset = db
    .insert(fixedAssets)
    .values({ number: 7, name: "MacBook Pro", acquisitionDate: "2026-01-15", inServiceDate: "2026-01-15", costCents: 250000, usefulLifeYears: 3 })
    .returning()
    .get();
  return { db, alpen, mueller, inv12, inv12old, inv3, renamed, draft, offer12, credit, reminder, expense, article, fixed, asset };
}

const ids = (res: ReturnType<typeof search>, type: SearchResultType) =>
  res.groups.find((g) => g.type === type)?.results.map((r) => r.id) ?? [];
const groupTypes = (res: ReturnType<typeof search>) => res.groups.map((g) => g.type);

describe("parseQuery", () => {
  test("number spellings", () => {
    expect(parseQuery("RE-2026-0012")).toMatchObject({ prefix: "RE", year: 2026, seq: 12 });
    expect(parseQuery("re 2026 12")).toMatchObject({ prefix: "RE", year: 2026, seq: 12 });
    expect(parseQuery("2026-0012")).toMatchObject({ prefix: null, year: 2026, seq: 12 });
    expect(parseQuery("re12")).toMatchObject({ prefix: "RE", year: null, seq: 12 });
    expect(parseQuery("K-3")).toMatchObject({ prefix: "K", seq: 3 });
    expect(parseQuery("Alpen").seq).toBeNull();
  });

  test("amounts", () => {
    expect(parseQuery("1.234,56").amountCents).toBe(123456);
    expect(parseQuery("1234.56").amountCents).toBe(123456);
    expect(parseQuery("€ 1.200").amountCents).toBe(120000);
    expect(parseQuery("47,90 €").amountCents).toBe(4790);
    expect(parseQuery("RE-2026").amountCents).toBeNull();
    expect(parseQuery("0").amountCents).toBeNull();
  });

  test("folding", () => {
    expect(foldText("Bäckerei MÜLLER Groß")).toBe("backerei muller gross");
    expect(foldText("Mueller", true)).toBe("muller");
  });
});

describe("search", () => {
  test("empty query returns nothing", () => {
    const { db } = seed();
    expect(search(db, "   ").groups).toEqual([]);
  });

  test("full invoice number is an exact hit and its group comes first", () => {
    const { db, inv12 } = seed();
    const res = search(db, "RE-2026-0012");
    expect(groupTypes(res)[0]).toBe("invoice");
    expect(ids(res, "invoice")).toEqual([inv12.id]);
    expect(res.groups[0]!.results[0]).toMatchObject({ label: "RE-2026-0012", rank: 0, path: `/invoices/${inv12.id}` });
    // the prefix limits the number match to invoices
    expect(ids(res, "offer")).toEqual([]);
    expect(ids(res, "expense")).toEqual([]);
  });

  test("loose number spellings", () => {
    const { db, inv12, inv12old, offer12, expense, renamed } = seed();
    expect(ids(search(db, "RE-2026-12"), "invoice")[0]).toBe(inv12.id);
    expect(ids(search(db, "re 2026 12"), "invoice")[0]).toBe(inv12.id);
    const yearSeq = search(db, "2026-0012");
    expect(ids(yearSeq, "invoice")[0]).toBe(inv12.id);
    expect(ids(yearSeq, "offer")).toEqual([offer12.id]);
    expect(ids(yearSeq, "expense")).toEqual([expense.id]);
    // "RE12": number 12 of every year, newest first
    expect(ids(search(db, "RE12"), "invoice")).toEqual([inv12.id, inv12old.id]);
    // bare "12": seq matches across types before the substring match "RE-2026-0120"
    const bare = search(db, "12");
    expect(ids(bare, "invoice").slice(0, 2)).toEqual([inv12.id, inv12old.id]);
    expect(ids(bare, "invoice")).toContain(renamed.id);
    expect(ids(bare, "offer")).toEqual([offer12.id]);
  });

  test("client by number, name, contact, email, UID and city", () => {
    const { db, alpen, mueller } = seed();
    expect(ids(search(db, `K-${alpen.number}`), "client")).toEqual([alpen.id]);
    expect(ids(search(db, "alpen"), "client")).toEqual([alpen.id]);
    expect(ids(search(db, "office@alpen"), "client")).toEqual([alpen.id]);
    expect(ids(search(db, "ATU12345678"), "client")).toEqual([alpen.id]);
    expect(ids(search(db, "innsbruck"), "client")).toEqual([alpen.id]);
    expect(ids(search(db, "jörg"), "client")).toEqual([mueller.id]);
    const client = search(db, "alpen").groups.find((g) => g.type === "client")!.results[0]!;
    expect(client).toMatchObject({ label: "Alpen Hosting AG", path: `/clients/${alpen.id}` });
    expect(client.sublabel).toContain(`K-000${alpen.number}`);
  });

  test("umlauts, ß and ae/oe/ue spellings", () => {
    const { db, mueller } = seed();
    for (const q of ["Müller", "MÜLLER", "muller", "Mueller", "baeckerei", "backerei", "gross", "Groß"]) {
      expect(ids(search(db, q), "client")).toEqual([mueller.id]);
    }
  });

  test("documents match the live client name and the frozen snapshot name", () => {
    const { db, renamed, draft } = seed();
    expect(ids(search(db, "Alte Firma"), "invoice")).toEqual([renamed.id]);
    // the live name still finds the finalized invoice and the draft
    expect(ids(search(db, "Bäckerei"), "invoice").sort()).toEqual([renamed.id, draft.id].sort());
    const hit = search(db, "Alte Firma").groups[0]!.results[0]!;
    expect(hit.sublabel).toBe("Alte Firma KG");
  });

  test("drafts are found by title and labelled as drafts", () => {
    const { db, draft } = seed();
    const res = search(db, "brot");
    expect(ids(res, "invoice")).toEqual([draft.id]);
    expect(res.groups[0]!.results[0]!.label).toBe("Rechnung (Entwurf)");
  });

  test("% and _ are literal, not wildcards", () => {
    const { db, draft } = seed();
    expect(ids(search(db, "100%"), "invoice")).toEqual([draft.id]);
    expect(ids(search(db, "Bio_mix"), "invoice")).toEqual([draft.id]);
    expect(ids(search(db, "100%x"), "invoice")).toEqual([]);
    expect(ids(search(db, "Bio_ix"), "invoice")).toEqual([]);
    expect(search(db, "%").groups).toEqual([{ type: "invoice", label: "Rechnungen", results: expect.any(Array) }]);
    expect(search(db, "_").groups.flatMap((g) => g.results).every((r) => r.id === draft.id)).toBe(true);
  });

  test("amount search across documents, expenses, fixed costs and assets", () => {
    const { db, inv3, inv12, expense, fixed, asset } = seed();
    const res = search(db, "1.234,56");
    expect(ids(res, "invoice")).toEqual([inv3.id]);
    expect(ids(res, "fixed_cost")).toEqual([fixed.id]);
    expect(res.groups.find((g) => g.type === "invoice")!.results[0]!.rank).toBe(2);
    expect(ids(search(db, "1200"), "invoice")).toEqual([inv12.id]);
    // net amount counts too
    expect(ids(search(db, "1000,00"), "invoice")).toEqual([inv12.id]);
    expect(ids(search(db, "47,90 €"), "expense")).toEqual([expense.id]);
    expect(ids(search(db, "2500"), "asset")).toEqual([asset.id]);
  });

  test("expenses by ER number, supplier, supplier invoice number and description", () => {
    const { db, expense } = seed();
    for (const q of ["ER-2026-12", "telekom", "INV-7788", "mobilfunk"]) {
      expect(ids(search(db, q), "expense")).toEqual([expense.id]);
    }
    expect(search(db, "telekom").groups[0]!.results[0]!.path).toBe(`/expenses/${expense.id}`);
  });

  test("reminders, credit notes, articles, fixed costs and assets", () => {
    const { db, reminder, credit, article, fixed, asset, inv3 } = seed();
    expect(ids(search(db, "MA-2026-2"), "reminder")).toEqual([reminder.id]);
    // a reminder is also found via its invoice number
    expect(ids(search(db, "RE-2026-0003"), "reminder")).toEqual([reminder.id]);
    expect(ids(search(db, "RE-2026-0003"), "invoice")).toEqual([inv3.id]);
    expect(ids(search(db, "GS-2026-1"), "credit_note")).toEqual([credit.id]);
    const art = search(db, "A-12");
    expect(ids(art, "article")).toEqual([article.id]);
    expect(art.groups[0]!.results[0]!.path).toBe("/articles?q=A-0012");
    expect(ids(search(db, "beratung"), "article")).toEqual([article.id]);
    expect(ids(search(db, "beitrage"), "fixed_cost")).toEqual([fixed.id]);
    expect(ids(search(db, "AV-7"), "asset")).toEqual([asset.id]);
    expect(ids(search(db, "macbook"), "asset")).toEqual([asset.id]);
    expect(search(db, "macbook").groups[0]!.results[0]).toMatchObject({ sublabel: "AV-0007", path: `/assets/${asset.id}` });
  });

  test("single words keep the classic ranking and are never filters", () => {
    const { db, inv12, inv12old, inv3, offer12, credit, alpen } = seed();
    const res = search(db, "alpen");
    expect(groupTypes(res)).toEqual(["client", "invoice", "offer", "credit_note", "reminder"]);
    // newest first, same date → higher id first
    expect(ids(res, "invoice")).toEqual([inv3.id, inv12.id, inv12old.id]);
    expect(ids(res, "offer")).toEqual([offer12.id]);
    expect(ids(res, "credit_note")).toEqual([credit.id]);
    expect(ids(res, "client")).toEqual([alpen.id]);
    expect(res.groups.flatMap((g) => g.results).every((r) => r.rank === 3)).toBe(true);
    // a type word on its own is plain text
    expect(search(db, "Entwurf").groups).toEqual([]);
    expect(search(db, "Rechnung").groups).toEqual([]);
  });

  test("parseWords: type and state words, umlaut spellings, filler words", () => {
    expect(parseWords("offene Rechnungen für Alpen")).toEqual({ words: ["Alpen"], types: ["invoice"], statuses: ["open"] });
    expect(parseWords("Entwürfe ueberfaellige Belege")).toEqual({ words: [], types: ["expense"], statuses: ["draft", "overdue"] });
    expect(parseWords("Kundin Müller")).toEqual({ words: ["Müller"], types: ["client"], statuses: [] });
  });

  test('"Alpen Entwurf": the drafts of the client, documents only', () => {
    const { db, alpen, draft } = seed();
    const invDraft = addDoc(db, alpen.id, { status: "draft", number: null, title: "Erweiterung" });
    const offerDraft = addDoc(db, alpen.id, { type: "offer", status: "draft", number: null });
    const res = search(db, "Alpen Entwurf");
    expect(groupTypes(res)).toEqual(["invoice", "offer"]);
    expect(ids(res, "invoice")).toEqual([invDraft.id]);
    expect(ids(res, "offer")).toEqual([offerDraft.id]);
    expect(ids(res, "invoice")).not.toContain(draft.id);
    expect(ids(search(db, "Entwürfe Alpen"), "invoice")).toEqual([invDraft.id]);
  });

  test('"Adobe Ausgabe" and "Rechnung Alpen": the type word limits the groups', () => {
    const { db, alpen, inv12, inv12old, inv3 } = seed();
    const adobe = db.insert(expenses).values({ number: "ER-2026-0020", supplierName: "Adobe Systems", issueDate: "2026-03-05" }).returning().get();
    addDoc(db, alpen.id, { number: "RE-2026-0030", title: "Adobe-Schulung" });
    const exp = search(db, "Adobe Ausgabe");
    expect(groupTypes(exp)).toEqual(["expense"]);
    expect(ids(exp, "expense")).toEqual([adobe.id]);

    const inv = search(db, "Rechnung Alpen");
    expect(groupTypes(inv)).toEqual(["invoice"]);
    expect(ids(inv, "invoice")).toEqual(expect.arrayContaining([inv12.id, inv12old.id, inv3.id]));
  });

  test('"offene Rechnungen Alpen": state filter; a filter without hits falls back to the unfiltered words', () => {
    const { db, alpen, inv12, inv12old, inv3, expense } = seed();
    const paid = addDoc(db, alpen.id, { number: "RE-2026-0040", status: "paid" });
    const draft = addDoc(db, alpen.id, { status: "draft", number: null });
    const open = search(db, "offene Rechnungen Alpen");
    expect(groupTypes(open)).toEqual(["invoice"]);
    expect(ids(open, "invoice").sort()).toEqual([inv12.id, inv12old.id, inv3.id].sort());
    expect(ids(open, "invoice")).not.toContain(paid.id);
    expect(ids(open, "invoice")).not.toContain(draft.id);
    expect(ids(search(db, "bezahlte Rechnungen Alpen"), "invoice")).toEqual([paid.id]);
    // only type/state words: everything the filter allows
    expect(groupTypes(search(db, "offene Angebote"))).toEqual(["offer"]);
    // the seeded expense has no lines (unvollständig = Entwurf), so it isn't "offen"
    expect(ids(search(db, "Ausgaben Entwurf"), "expense")).toEqual([expense.id]);
    expect(search(db, "offene Ausgaben").groups).toEqual([]);
    // the Telekom expense is unpaid: "bezahlt" leaves nothing, so the plain "Telekom" hits come back
    expect(ids(search(db, "Telekom bezahlt"), "expense")).toEqual([expense.id]);
  });

  test("token fallback: every word first (across fields), then any word ranked by matches", () => {
    const { db, inv3, draft, alpen } = seed();
    // client name + title of one invoice
    const both = search(db, "Alpen Wartung");
    expect(groupTypes(both)).toEqual(["invoice"]);
    expect(ids(both, "invoice")).toEqual([inv3.id]);
    expect(both.groups[0]!.results[0]!.rank).toBe(3);
    // client name + invoice number
    expect(ids(search(db, "Alpen 0003"), "invoice")).toEqual([inv3.id]);
    // no invoice has both words: any word, each with one of two words → rank 4
    const any = search(db, "Wartung Brot");
    expect(ids(any, "invoice").sort()).toEqual([inv3.id, draft.id].sort());
    expect(any.groups[0]!.results.every((r) => r.rank === 4)).toBe(true);
    expect(ids(search(db, "Alpen Niemandsland"), "client")).toEqual([alpen.id]);
  });

  test("a query nothing matches returns no groups", () => {
    const { db } = seed();
    expect(search(db, "Xyzzy Quux").groups).toEqual([]);
    expect(search(db, "Xyzzy Rechnung").groups).toEqual([]);
    expect(search(db, "für die").groups).toEqual([]);
  });

  test("limit per group", () => {
    const { db, alpen } = seed();
    for (let i = 0; i < 10; i++) addDoc(db, alpen.id, { number: `RE-2024-${String(i + 1).padStart(4, "0")}` });
    expect(ids(search(db, "alpen", 3), "invoice")).toHaveLength(3);
    expect(ids(search(db, "alpen"), "invoice")).toHaveLength(6);
  });
});
