import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { createTestDb, type Db } from "../db/client";
import { bankTransactions, clients, documentItems, documents, expenses, type NewBankTransaction } from "../db/schema";
import {
  createAccount,
  documentPayments,
  getTransaction,
  listImports,
  listTransactions,
  paidCentsByDocument,
  paidCentsForDocument,
  setIgnored,
  transactionSummary,
} from "./bank";
import { commitImport, previewImport, undoImport } from "./bank-import";
import { applyMatch, autoMatch, findDocumentNumbers, nameSimilarity, removeDocumentAllocations, searchCandidates, suggestFor, loadContext, unmatch, withSuggestions } from "./bank-matching";
import { changeStatus, createCreditNote, createDocument, finalizeDocument, getDocument, listDocuments } from "./documents";
import { getDashboard } from "./dashboard";
import { buildForecast } from "./forecast";
import { createReminder, listDueInvoices } from "./reminders";
import { updateSettings } from "./settings";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "../lib/bank-parsers/fixtures", name)));

function setup() {
  const db = createTestDb();
  updateSettings(db, { companyName: "Muster e.U.", iban: "AT611904300234573201", bic: "GIBAATWWXXX" });
  const account = createAccount(db, { name: "Geschäftskonto", iban: "AT611904300234573201", bankName: "Erste Bank" });
  const client = (name: string) => db.insert(clients).values({ number: Math.floor(Math.random() * 1e6), name, country: "AT" }).returning().get();
  return { db, account, client };
}

/** Finalized invoice over `grossCents` (one line, 20 % VAT; gross must be divisible by 1.2). */
function invoice(db: Db, clientId: number, grossCents: number, issueDate = "2026-03-01") {
  const doc = createDocument(db, {
    type: "invoice",
    clientId,
    issueDate,
    dueDate: "2026-03-15",
    items: [{ title: "Leistung", description: "", quantity: 1000, unit: "", unitPriceCents: Math.round(grossCents / 1.2), taxRateBp: 2000, discountBp: 0 }],
  });
  const fin = finalizeDocument(db, doc.id);
  expect(fin.grossCents).toBe(grossCents);
  return fin;
}

let seq = 0;
function tx(db: Db, accountId: number, t: Partial<NewBankTransaction> & { amountCents: number }) {
  return db
    .insert(bankTransactions)
    .values({ accountId, bookingDate: "2026-03-20", importHash: `h${++seq}`, ...t })
    .returning()
    .get();
}

function expense(db: Db, data: { supplierName: string; grossCents: number; supplierInvoiceNumber?: string; issueDate?: string }) {
  return db
    .insert(expenses)
    .values({ number: `ER-2026-${String(++seq).padStart(4, "0")}`, issueDate: "2026-03-01", ...data })
    .returning()
    .get();
}

function expectHttp(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status as number).toBe(status);
    return;
  }
  throw new Error(`expected HTTP ${status}`);
}

describe("invoice number detection", () => {
  test("normalizes common spellings", () => {
    expect(findDocumentNumbers("RE-2026-0001")).toEqual(["RE-2026-0001"]);
    expect(findDocumentNumbers("Rechnung RE 2026 0001 danke")).toEqual(["RE-2026-0001"]);
    expect(findDocumentNumbers("re20260001")).toEqual(["RE-2026-0001"]);
    expect(findDocumentNumbers("Rechnungsnr. 2026/12")).toEqual(["RE-2026-0012"]);
    expect(findDocumentNumbers("Zahlung 2026-0007")).toEqual(["*-2026-0007"]);
    expect(findDocumentNumbers("MA-2026-0003")).toEqual(["MA-2026-0003"]);
    expect(findDocumentNumbers("RE-2026-0001 und RE-2026-0002")).toEqual(["RE-2026-0001", "RE-2026-0002"]);
    // not part of a longer number
    expect(findDocumentNumbers("AT61190430023457320120260001")).toEqual([]);
  });

  test("name similarity ignores legal forms and umlauts", () => {
    expect(nameSimilarity("MUELLER UND SOEHNE GMBH", "Müller & Söhne GmbH")).toBe(1);
    expect(nameSimilarity("Huber", "Huber KG")).toBe(1);
    expect(nameSimilarity("Anna Beispiel", "Berta Beispiel")).toBe(0.5);
    expect(nameSimilarity("SPAR", "Müller GmbH")).toBe(0);
  });
});

describe("import", () => {
  test("camt.053 preview + commit, duplicates skipped on re-import", () => {
    const { db, account } = setup();
    const preview = previewImport(db, account.id, fixture("camt053.xml"), "maerz.xml");
    expect(preview.format).toBe("camt053");
    expect(preview.ibanMismatch).toBe(false);
    expect(preview.counts).toEqual({ total: 5, new: 4, duplicate: 0, skipped: 1, errors: 0 });
    expect(preview.inCents).toBe(150000);
    expect(preview.outCents).toBe(-9460);

    const first = commitImport(db, account.id, fixture("camt053.xml"), "maerz.xml");
    expect(first.importedCount).toBe(4);
    const again = commitImport(db, account.id, fixture("camt053.xml"), "maerz.xml");
    expect(again).toMatchObject({ import: null, importedCount: 0, skippedCount: 5 });
    expect(listTransactions(db, { accountId: account.id })).toHaveLength(4);
    expect(transactionSummary(db, { accountId: account.id })).toMatchObject({ count: 4, netCents: 140540, openCount: 4 });
  });

  test("overlapping CSV exports only add the new rows (identical same-day rows kept apart)", () => {
    const { db, account } = setup();
    const csv = readFileSync(join(import.meta.dir, "../lib/bank-parsers/fixtures/n26.csv"), "utf8");
    const lines = csv.trim().split("\n");
    const older = new TextEncoder().encode(lines.slice(0, 3).join("\n")); // header + 2 rows (one SPAR)
    commitImport(db, account.id, older, "jan.csv");
    expect(listTransactions(db, { accountId: account.id })).toHaveLength(2);
    // the full export overlaps: the first SPAR row exists, the second identical one is new
    const r = commitImport(db, account.id, new TextEncoder().encode(csv), "feb.csv");
    expect(r).toMatchObject({ importedCount: 1, skippedCount: 2 });
    expect(listTransactions(db, { accountId: account.id }).filter((t) => t.amountCents === -2345)).toHaveLength(2);
  });

  test("remembers the CSV mapping per account", () => {
    const { db, account } = setup();
    const first = previewImport(db, account.id, fixture("generic-1252.csv"), "a.csv");
    const custom = { ...first.csv!.mapping, purpose: [4, 2] };
    commitImport(db, account.id, fixture("generic-1252.csv"), "a.csv", { mapping: custom });
    const again = previewImport(db, account.id, fixture("generic-1252.csv"), "a.csv");
    expect(again.csv?.usedSavedMapping).toBe(true);
    expect(again.csv?.mapping.purpose).toEqual([4, 2]);
    expect(again.counts.duplicate).toBe(2);
  });

  test("warns when the statement belongs to another IBAN", () => {
    const { db } = setup();
    const other = createAccount(db, { name: "Privat", iban: "AT483200000012345864", bankName: "" });
    const p = previewImport(db, other.id, fixture("camt053.xml"), "x.xml");
    expect(p.ibanMismatch).toBe(true);
    expect(p.warnings.join(" ")).toContain("AT611904300234573201");
  });

  test("undo deletes unmatched transactions and keeps allocated ones", () => {
    const { db, account, client } = setup();
    const c = client("Müller & Söhne GmbH");
    invoice(db, c.id, 120000);
    const r = commitImport(db, account.id, fixture("camt053.xml"), "maerz.xml");
    expect(r.autoMatched).toBe(1);
    const res = undoImport(db, r.import!.id);
    expect(res).toEqual({ deleted: 3, kept: 1 });
    expect(listImports(db, account.id)[0]).toMatchObject({ remainingCount: 1, matchedCount: 1 });
    expect(listTransactions(db, { accountId: account.id })).toHaveLength(1);
  });
});

describe("matching", () => {
  test("auto-applies number + exact amount on import and marks the invoice paid", () => {
    const { db, account, client } = setup();
    const c = client("Müller & Söhne GmbH");
    const inv = invoice(db, c.id, 120000);
    expect(inv.number).toBe("RE-2026-0001");
    const r = commitImport(db, account.id, fixture("camt053.xml"), "maerz.xml");
    expect(r.autoMatched).toBe(1);
    const doc = getDocument(db, inv.id);
    expect(doc.status).toBe("paid");
    expect(doc.paidAt).toBe("2026-03-05");
    const t = listTransactions(db, { accountId: account.id, status: "matched" });
    expect(t).toHaveLength(1);
    expect(t[0]!.matches[0]).toMatchObject({ documentNumber: "RE-2026-0001", source: "auto", amountCents: 120000 });
  });

  test("suggestions carry reasons; partial payments are not auto-applied in safe mode", () => {
    const { db, account, client } = setup();
    const anna = client("Anna Beispiel");
    const inv = invoice(db, anna.id, 24000); // RE-2026-0001
    const t = tx(db, account.id, { amountCents: 10000, counterpartyName: "Anna Beispiel", purpose: "RE-2026-0001 Teilzahlung" });
    expect(autoMatch(db, { mode: "safe" })).toBe(0);
    const [row] = withSuggestions(db, [getTransaction(db, t.id)]);
    const s = row!.suggestions[0]!;
    expect(s).toMatchObject({ kind: "document", id: inv.id, amountCents: 10000, auto: false, openCents: 24000 });
    expect(s.reasons.map((r) => r.label)).toEqual(["Rechnungsnummer im Verwendungszweck", "Teilzahlung", "Name stimmt überein"]);
    // aggressive mode takes number + partial
    expect(autoMatch(db, { mode: "aggressive" })).toBe(1);
    expect(getDocument(db, inv.id).status).toBe("final");
  });

  test("partial payments: stays open until covered, paidAt = last covering payment", () => {
    const { db, account, client } = setup();
    const c = client("Anna Beispiel");
    const inv = invoice(db, c.id, 24000);
    const t1 = tx(db, account.id, { amountCents: 10000, bookingDate: "2026-03-10" });
    const t2 = tx(db, account.id, { amountCents: 14000, bookingDate: "2026-03-25" });
    applyMatch(db, t1.id, { allocations: [{ documentId: inv.id, amountCents: 10000 }] });
    expect(getDocument(db, inv.id).status).toBe("final");
    expect(documentPayments(db, inv.id)).toMatchObject({ dueCents: 24000, paidCents: 10000, openCents: 14000, partial: true });
    expect(paidCentsForDocument(db, inv.id)).toBe(10000);

    // the remaining amount is now the "exact" amount
    const s = suggestFor(getTransaction(db, t2.id), 14000, loadContext(db));
    expect(s[0]?.reasons.map((r) => r.code)).toContain("amount_exact");

    applyMatch(db, t2.id, { allocations: [{ documentId: inv.id, amountCents: 14000 }] });
    expect(getDocument(db, inv.id)).toMatchObject({ status: "paid", paidAt: "2026-03-25" });
    expect(documentPayments(db, inv.id)).toMatchObject({ partial: false, openCents: 0 });

    // removing the later payment reverts to "final"; credit notes reduce what is owed
    unmatch(db, { transactionId: t2.id });
    expect(getDocument(db, inv.id)).toMatchObject({ status: "final", paidAt: null });
    expect(getTransaction(db, t2.id).status).toBe("open");
    const cn = createCreditNote(db, inv.id);
    finalizeDocument(db, cn.id);
    db.update(documents).set({ grossCents: 14000 }).where(eq(documents.id, cn.id)).run();
    expect(documentPayments(db, inv.id)).toMatchObject({ dueCents: 24000 - 14000, paidCents: 10000, openCents: 0 });
  });

  test("split payment: one transaction pays two invoices", () => {
    const { db, account, client } = setup();
    const c = client("Kunde AG");
    const a = invoice(db, c.id, 30000);
    const b = invoice(db, c.id, 18000);
    const t = tx(db, account.id, { amountCents: 48000, purpose: `${a.number} ${b.number}` });
    // purpose names both invoices → each suggestion proposes the invoice's open amount
    const sugg = withSuggestions(db, [getTransaction(db, t.id)])[0]!.suggestions;
    expect(sugg.map((s) => [s.number, s.amountCents]).sort()).toEqual([
      ["RE-2026-0001", 30000],
      ["RE-2026-0002", 18000],
    ]);
    expectHttp(
      () => applyMatch(db, t.id, { allocations: [{ documentId: a.id, amountCents: 30000 }, { documentId: b.id, amountCents: 18001 }] }),
      422,
    );
    const row = applyMatch(db, t.id, { allocations: [{ documentId: a.id, amountCents: 30000 }, { documentId: b.id, amountCents: 18000 }] });
    expect(row).toMatchObject({ status: "matched", remainingCents: 0 });
    expect(getDocument(db, a.id).status).toBe("paid");
    expect(getDocument(db, b.id).status).toBe("paid");
    // unmatch a single allocation
    unmatch(db, { matchId: row.matches[1]!.id });
    expect(getDocument(db, b.id).status).toBe("final");
    expect(getDocument(db, a.id).status).toBe("paid");
    expect(getTransaction(db, t.id)).toMatchObject({ status: "open", remainingCents: 18000 });
  });

  test("overpayment is allowed and shown as negative open amount", () => {
    const { db, account, client } = setup();
    const inv = invoice(db, client("X").id, 12000);
    const t = tx(db, account.id, { amountCents: 12050, purpose: "RE-2026-0001" });
    const s = withSuggestions(db, [getTransaction(db, t.id)])[0]!.suggestions[0]!;
    expect(s.reasons.map((r) => r.code)).toContain("overpaid");
    expect(s.amountCents).toBe(12050);
    applyMatch(db, t.id, { allocations: [{ documentId: inv.id, amountCents: 12050 }] });
    expect(getDocument(db, inv.id).status).toBe("paid");
    expect(documentPayments(db, inv.id).openCents).toBe(-50);
  });

  test("unmatch keeps a manually set paid status; sent invoices go back to sent", () => {
    const { db, account, client } = setup();
    const c = client("X");
    const manual = invoice(db, c.id, 12000);
    changeStatus(db, manual.id, { action: "paid", paidAt: "2026-02-01" });
    const t = tx(db, account.id, { amountCents: 12000 });
    applyMatch(db, t.id, { allocations: [{ documentId: manual.id, amountCents: 12000 }] });
    unmatch(db, { transactionId: t.id });
    expect(getDocument(db, manual.id)).toMatchObject({ status: "paid", paidAt: "2026-02-01" });

    const sent = invoice(db, c.id, 6000);
    changeStatus(db, sent.id, { action: "sent" });
    const t2 = tx(db, account.id, { amountCents: 6000, bookingDate: "2026-03-21" });
    applyMatch(db, t2.id, { allocations: [{ documentId: sent.id, amountCents: 6000 }] });
    expect(getDocument(db, sent.id)).toMatchObject({ status: "paid", paidAt: "2026-03-21" });
    unmatch(db, { transactionId: t2.id });
    expect(getDocument(db, sent.id)).toMatchObject({ status: "sent", paidAt: null });
  });

  test("learned IBAN: exact amount from a known payer is auto-applied, ambiguity is not", () => {
    const { db, account, client } = setup();
    const c = client("Huber KG");
    const first = invoice(db, c.id, 6000);
    const t1 = tx(db, account.id, { amountCents: 6000, counterpartyIban: "AT483200000012345864" });
    applyMatch(db, t1.id, { allocations: [{ documentId: first.id, amountCents: 6000 }] });

    const second = invoice(db, c.id, 9000);
    const t2 = tx(db, account.id, { amountCents: 9000, counterpartyIban: "AT48 3200 0000 1234 5864", purpose: "Danke" });
    expect(autoMatch(db, { mode: "safe" })).toBe(1);
    expect(getDocument(db, second.id).status).toBe("paid");
    expect(getTransaction(db, t2.id).matches[0]!.source).toBe("auto");

    // two open invoices of the same amount → only suggestions
    invoice(db, c.id, 3600);
    invoice(db, c.id, 3600);
    const t3 = tx(db, account.id, { amountCents: 3600, counterpartyIban: "AT483200000012345864" });
    expect(autoMatch(db, { mode: "safe" })).toBe(0);
    expect(withSuggestions(db, [getTransaction(db, t3.id)])[0]!.suggestions).toHaveLength(2);
  });

  test("two transactions claiming the same invoice are left for review", () => {
    const { db, account, client } = setup();
    invoice(db, client("X").id, 12000);
    tx(db, account.id, { amountCents: 12000, purpose: "RE-2026-0001" });
    tx(db, account.id, { amountCents: 12000, purpose: "RE-2026-0001 nochmal" });
    expect(autoMatch(db, { mode: "safe" })).toBe(0);
  });

  test("reminder total (invoice + fee) counts as a match", () => {
    const { db, account, client } = setup();
    const inv = invoice(db, client("X").id, 12000);
    db.$client.run(
      `insert into reminders (invoice_id, level, status, number, issue_date, due_date, open_cents, fee_cents, interest_cents, created_at, updated_at)
       values (${inv.id}, 2, 'final', 'MA-2026-0004', '2026-03-20', '2026-03-27', 12000, 1000, 0, '', '')`,
    );
    tx(db, account.id, { amountCents: 13000, purpose: "MA-2026-0004", bookingDate: "2026-03-25" });
    expect(autoMatch(db, { mode: "safe" })).toBe(1);
    expect(getDocument(db, inv.id).status).toBe("paid");
    expect(documentPayments(db, inv.id).openCents).toBe(-1000);
  });

  test("payments dated before the invoice are penalized and never auto-applied", () => {
    const { db, account, client } = setup();
    invoice(db, client("X").id, 12000, "2026-04-01");
    const t = tx(db, account.id, { amountCents: 12000, purpose: "RE-2026-0001", bookingDate: "2026-03-01" });
    expect(autoMatch(db, { mode: "aggressive" })).toBe(0);
    const s = withSuggestions(db, [getTransaction(db, t.id)])[0]!.suggestions[0]!;
    expect(s.reasons.map((r) => r.code)).toContain("before_issue");
  });

  test("outgoing transactions match expenses (supplier number + amount) and set paidAt", () => {
    const { db, account } = setup();
    const e = expense(db, { supplierName: "A1 Telekom Austria AG", grossCents: 9460, supplierInvoiceNumber: "RF18 5390 0754 7034" });
    const other = expense(db, { supplierName: "Hofer", grossCents: 9460 });
    const r = commitImport(db, account.id, fixture("camt053.xml"), "maerz.xml");
    expect(r.autoMatched).toBe(1);
    expect(db.select().from(expenses).where(eq(expenses.id, e.id)).get()!.paidAt).toBe("2026-03-10");
    expect(db.select().from(expenses).where(eq(expenses.id, other.id)).get()!.paidAt).toBeNull();
    const t = listTransactions(db, { direction: "out" })[0]!;
    expect(t.matches[0]).toMatchObject({ expenseId: e.id, supplierName: "A1 Telekom Austria AG" });
    unmatch(db, { transactionId: t.id });
    expect(db.select().from(expenses).where(eq(expenses.id, e.id)).get()!.paidAt).toBeNull();
  });

  test("expenses without amounts (incomplete drafts): suggestion by name only, never auto-applied", () => {
    const { db, account } = setup();
    const e = expense(db, { supplierName: "Wiener Stadtwerke", grossCents: 0 });
    const t = tx(db, account.id, { amountCents: -8850, counterpartyName: "WIENER STADTWERKE GMBH", purpose: "Strom" });
    expect(autoMatch(db, { mode: "aggressive" })).toBe(0);
    const s = withSuggestions(db, [getTransaction(db, t.id)])[0]!.suggestions[0]!;
    expect(s).toMatchObject({ kind: "expense", id: e.id, amountCents: 8850, auto: false });
    expect(s.reasons.map((r) => r.code)).toEqual(["no_amount", "name"]);
    applyMatch(db, t.id, { allocations: [{ expenseId: e.id, amountCents: 8850 }] });
    expect(db.select().from(expenses).where(eq(expenses.id, e.id)).get()!.paidAt).toBe("2026-03-20");
    unmatch(db, { transactionId: t.id });
    expect(db.select().from(expenses).where(eq(expenses.id, e.id)).get()!.paidAt).toBeNull();
  });

  test("direction rules, ignore", () => {
    const { db, account, client } = setup();
    const inv = invoice(db, client("X").id, 12000);
    const e = expense(db, { supplierName: "Y", grossCents: 500 });
    const out = tx(db, account.id, { amountCents: -500 });
    const inc = tx(db, account.id, { amountCents: 12000 });
    expectHttp(() => applyMatch(db, out.id, { allocations: [{ documentId: inv.id, amountCents: 500 }] }), 422);
    expectHttp(() => applyMatch(db, inc.id, { allocations: [{ expenseId: e.id, amountCents: 500 }] }), 422);

    setIgnored(db, out.id, true);
    expect(getTransaction(db, out.id).status).toBe("ignored");
    expectHttp(() => applyMatch(db, out.id, { allocations: [{ expenseId: e.id, amountCents: 500 }] }), 409);
    setIgnored(db, out.id, false);
    applyMatch(db, inc.id, { allocations: [{ documentId: inv.id, amountCents: 12000 }] });
    expectHttp(() => setIgnored(db, inc.id, true), 409);
  });

  test("manual candidate search scores against the transaction", () => {
    const { db, account, client } = setup();
    invoice(db, client("Alpha GmbH").id, 12000);
    invoice(db, client("Beta OG").id, 6000);
    const t = tx(db, account.id, { amountCents: 6000, counterpartyName: "BETA OG" });
    const all = searchCandidates(db, { direction: "in", transactionId: t.id });
    expect(all.map((c) => c.name)).toEqual(["Beta OG", "Alpha GmbH"]);
    expect(searchCandidates(db, { direction: "in", q: "alpha" }).map((c) => c.number)).toEqual(["RE-2026-0001"]);
    expect(searchCandidates(db, { direction: "in", q: "RE20260002" }).map((c) => c.name)).toEqual(["Beta OG"]);
  });

  test("batch paid helper", () => {
    const { db, account, client } = setup();
    const a = invoice(db, client("X").id, 12000);
    const t = tx(db, account.id, { amountCents: 5000 });
    applyMatch(db, t.id, { allocations: [{ documentId: a.id, amountCents: 5000 }] });
    expect(paidCentsByDocument(db, [a.id, 999])).toEqual(new Map([[a.id, 5000]]));
    expect(paidCentsByDocument(db).get(a.id)).toBe(5000);
  });
});

describe("partial payments in other features", () => {
  test("reminders, forecast and dashboard use the open amount after payments", () => {
    const { db, account, client } = setup();
    const inv = invoice(db, client("X").id, 24000); // due 2026-03-15, VAT 4000
    const t = tx(db, account.id, { amountCents: 6000, bookingDate: "2026-03-10" });
    applyMatch(db, t.id, { allocations: [{ documentId: inv.id, amountCents: 6000 }] });

    const due = listDueInvoices(db, "2026-04-01");
    expect(due.map((d) => d.openCents)).toEqual([18000]);
    expect(createReminder(db, { invoiceId: inv.id }, "2026-04-01").openCents).toBe(18000);

    const forecast = buildForecast(db, { months: 3, includeDrafts: false, includeOffers: false, offerProbability: 50, today: "2026-04-01" });
    const entry = forecast.entries.find((e) => e.documentId === inv.id)!;
    expect(entry).toMatchObject({ grossCents: 18000, taxCents: 3000, fullGrossCents: 24000, overdue: true });

    const dash = getDashboard(db, 2026, "2026-04-01");
    expect(dash.kpis.openInvoices).toEqual({ count: 1, cents: 18000 });
    expect(dash.kpis.overdue).toEqual({ count: 1, cents: 18000 });
  });
});


describe("payment status vs. allocations and credit notes", () => {
  test("resetting a bank-paid invoice needs the allocations removed too", () => {
    const { db, account, client } = setup();
    const inv = invoice(db, client("X").id, 12000);
    changeStatus(db, inv.id, { action: "sent" });
    const t = tx(db, account.id, { amountCents: 12000 });
    applyMatch(db, t.id, { allocations: [{ documentId: inv.id, amountCents: 12000 }] });
    expect(getDocument(db, inv.id).status).toBe("paid");

    expectHttp(() => changeStatus(db, inv.id, { action: "unpaid" }), 409);
    expect(getDocument(db, inv.id).status).toBe("paid");

    // what the route does with removeAllocations: true
    db.transaction((t2) => {
      removeDocumentAllocations(t2, inv.id);
      changeStatus(t2, inv.id, { action: "unpaid" });
    });
    expect(getDocument(db, inv.id)).toMatchObject({ status: "sent", paidAt: null });
    expect(getTransaction(db, t.id)).toMatchObject({ status: "open", allocatedCents: 0 });
    expect(paidCentsForDocument(db, inv.id)).toBe(0);

    // manually paid without allocations: reset works as before
    changeStatus(db, inv.id, { action: "paid", paidAt: "2026-03-30" });
    expect(changeStatus(db, inv.id, { action: "unpaid" }).status).toBe("sent");
  });

  test("a finalized credit note that (with payments) covers the invoice marks it paid", () => {
    const { db, account, client } = setup();
    const c = client("X");
    // full credit note → paid at its issue date
    const a = invoice(db, c.id, 12000);
    const cnA = createCreditNote(db, a.id);
    db.update(documents).set({ issueDate: "2026-03-05" }).where(eq(documents.id, cnA.id)).run();
    finalizeDocument(db, cnA.id);
    expect(getDocument(db, a.id)).toMatchObject({ status: "paid", paidAt: "2026-03-05" });

    // partial credit note alone → stays open
    const b = invoice(db, c.id, 24000);
    const cnB = createCreditNote(db, b.id);
    db.update(documentItems).set({ unitPriceCents: 10000 }).where(eq(documentItems.documentId, cnB.id)).run();
    db.update(documents).set({ issueDate: "2026-03-05" }).where(eq(documents.id, cnB.id)).run();
    finalizeDocument(db, cnB.id); // 12000 gross
    expect(getDocument(db, b.id)).toMatchObject({ status: "final", openCents: 12000, partial: false });
    // the bank pays the rest later → paid at the payment date
    const t = tx(db, account.id, { amountCents: 12000, bookingDate: "2026-03-28" });
    applyMatch(db, t.id, { allocations: [{ documentId: b.id, amountCents: 12000 }] });
    expect(getDocument(db, b.id)).toMatchObject({ status: "paid", paidAt: "2026-03-28" });
    // removing that payment reverts it (paidAt came from the bank)
    unmatch(db, { transactionId: t.id });
    expect(getDocument(db, b.id)).toMatchObject({ status: "final", paidAt: null });

    // dashboard: credit-settled invoices are neither open nor "received"
    const dash = getDashboard(db, 2026, "2026-04-01");
    expect(dash.kpis.openInvoices).toEqual({ count: 1, cents: 12000 });
    expect(dash.kpis.paid).toEqual({ count: 0, cents: 0 });
    // forecast/reminders skip it
    expect(listDueInvoices(db, "2026-04-01").map((d) => d.invoiceId)).toEqual([b.id]);
    const forecast = buildForecast(db, { months: 3, includeDrafts: false, includeOffers: false, offerProbability: 50, today: "2026-04-01" });
    expect(forecast.entries.map((e) => e.documentId)).toEqual([b.id]);
  });

  test("a manually set payment is not moved by a credit note", () => {
    const { db, client } = setup();
    const inv = invoice(db, client("X").id, 12000);
    changeStatus(db, inv.id, { action: "paid", paidAt: "2026-03-02" });
    finalizeDocument(db, createCreditNote(db, inv.id).id);
    expect(getDocument(db, inv.id)).toMatchObject({ status: "paid", paidAt: "2026-03-02" });
  });

  test("lists and dashboard show partially paid invoices", () => {
    const { db, account, client } = setup();
    const c = client("X");
    const inv = invoice(db, c.id, 24000);
    const other = invoice(db, c.id, 12000);
    const t = tx(db, account.id, { amountCents: 6000 });
    applyMatch(db, t.id, { allocations: [{ documentId: inv.id, amountCents: 6000 }] });

    const rows = listDocuments(db, { type: "invoice" });
    expect(rows.find((r) => r.id === inv.id)).toMatchObject({ partial: true, openCents: 18000 });
    expect(rows.find((r) => r.id === other.id)).toMatchObject({ partial: false, openCents: 12000 });

    const dash = getDashboard(db, 2026, "2026-04-01");
    expect(dash.overdue.map((r) => [r.id, r.partial, r.openCents])).toEqual([
      [inv.id, true, 18000],
      [other.id, false, 12000],
    ]);
  });
});
