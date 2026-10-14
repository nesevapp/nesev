import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { formatAssetNumber } from "../../shared/assets";
import { formatArticleNumber, parseArticleNumber } from "../../shared/schemas/article";
import { formatClientNumber, parseClientNumber } from "../../shared/schemas/client";
import { formatDate, todayIso } from "../../shared/dates";
import {
  DOCUMENT_NUMBER_PREFIX,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
  isOverdue,
  type NumberedType,
  OVERDUE_LABEL,
} from "../../shared/documents";
import { formatCents, parseMoneyToCents } from "../../shared/money";
import type { DbOrTx } from "../db/client";
import {
  articles,
  clients,
  documents,
  expenseLines,
  expenses,
  fixedAssets,
  recurringExpenses,
  recurringInvoices,
  reminders,
} from "../db/schema";

// Global search (Cmd+K palette): one query over every entity, grouped by type.
// - Text matches are substring LIKEs (wildcards escaped) over a folded form of column and term:
//   lower-case, German umlauts/ß and a few accents stripped. A second variant also folds "ae/oe/ue",
//   so "Mueller", "Müller" and "muller" find each other.
// - Numbers accept loose spellings: "RE-2026-0012", "RE-2026-12", "2026-0012", "re12", "12" (any year).
//   A letter prefix limits the number match to its type (RE, AN, GS, MA, ER, K, A, AV).
// - Inputs that parse as money ("1.234,56", "1234.56", "500 €") also match gross/net amounts.
// - Rank per group: exact number (0) → number of any year (1) → amount (2) → text (3), then newest first.
// - Multi-word queries without a hit as a whole are read word by word (see "multi-word queries" below).

export const SEARCH_RESULT_TYPES = [
  "client",
  "invoice",
  "offer",
  "credit_note",
  "reminder",
  "recurring",
  "expense",
  "fixed_cost",
  "asset",
  "article",
] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const SEARCH_GROUP_LABELS: Record<SearchResultType, string> = {
  client: "Kunden",
  invoice: "Rechnungen",
  offer: "Angebote",
  credit_note: "Gutschriften",
  reminder: "Mahnungen",
  recurring: "Serienrechnungen",
  expense: "Ausgaben",
  fixed_cost: "Fixkosten",
  asset: "Anlagen",
  article: "Artikel",
};

export interface SearchResult {
  type: SearchResultType;
  id: number;
  /** primary line, usually the number (or the name when there is none) */
  label: string;
  /** secondary text, e.g. client or supplier name */
  sublabel: string;
  /** right-aligned details, e.g. "14.10.2026 · € 1.200,00 · Bezahlt" */
  meta: string;
  /** frontend route (href) that opens the result */
  path: string;
  /** 0 = exact number, 1 = number of any year, 2 = amount, 3 = text; 3 + n = n words of the query not matched */
  rank: number;
}

export interface SearchGroup {
  type: SearchResultType;
  label: string;
  results: SearchResult[];
}

export interface SearchResponse {
  q: string;
  groups: SearchGroup[];
}

// ── folding ────────────────────────────────────────────────────────────────────

// Kept short on purpose: every pair is one nested replace(), and SQLite's parser stack overflows
// at ~28 levels (17 used incl. the digraphs).
const FOLD_PAIRS: [string, string][] = [
  ["ä", "a"], ["Ä", "a"], ["ö", "o"], ["Ö", "o"], ["ü", "u"], ["Ü", "u"], ["ß", "ss"],
  ["é", "e"], ["è", "e"], ["á", "a"], ["ó", "o"], ["š", "s"], ["č", "c"], ["ž", "z"],
];
const UMLAUT_DIGRAPHS: [string, string][] = [["ae", "a"], ["oe", "o"], ["ue", "u"]];

/** Mirrors foldSql: ASCII lower-case (like SQLite lower()) plus FOLD_PAIRS. */
export function foldText(s: string, digraphs = false): string {
  let out = s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  for (const [from, to] of FOLD_PAIRS) out = out.replaceAll(from, to);
  if (digraphs) for (const [from, to] of UMLAUT_DIGRAPHS) out = out.replaceAll(from, to);
  return out;
}

function foldSql(expr: unknown, digraphs: boolean): SQL {
  let out = sql`lower(coalesce(${expr}, ''))`;
  const pairs = digraphs ? [...FOLD_PAIRS, ...UMLAUT_DIGRAPHS] : FOLD_PAIRS;
  // constants only (no quotes), so inlining them keeps the statement small
  for (const [from, to] of pairs) out = sql`replace(${out}, ${sql.raw(`'${from}'`)}, ${sql.raw(`'${to}'`)})`;
  return out;
}

const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** Folded, wildcard-escaped substring match of `term` in any of `exprs`. */
function textMatch(term: string, exprs: unknown[]): SQL {
  const plain = likePattern(foldText(term));
  const loose = likePattern(foldText(term, true));
  const parts = exprs.flatMap((e) => [
    sql`${foldSql(e, false)} LIKE ${plain} ESCAPE '\\'`,
    sql`${foldSql(e, true)} LIKE ${loose} ESCAPE '\\'`,
  ]);
  return or(...parts)!;
}

/** Plain (unfolded) substring match, for number columns. */
function rawContains(term: string, expr: unknown): SQL {
  return sql`${expr} LIKE ${likePattern(term)} ESCAPE '\\'`;
}

// ── query parsing ──────────────────────────────────────────────────────────────

export interface ParsedQuery {
  term: string;
  /** upper-case letter prefix of a number query ("RE", "K", "AV"), if any */
  prefix: string | null;
  year: number | null;
  seq: number | null;
  amountCents: number | null;
}

export function parseQuery(q: string): ParsedQuery {
  const term = q.trim().replace(/\s+/g, " ");
  const num = /^(?:([a-z]{1,2})[\s.-]*)?(?:(\d{4})[\s./-]+)?(\d{1,6})$/i.exec(term);
  const looksLikeAmount = /^-?(?:€\s*)?[\d.,\s]*\d(?:[.,]\d{1,2})?\s*(?:€|eur)?$/i.test(term) && /\d/.test(term);
  const amount = looksLikeAmount ? parseMoneyToCents(term.replace(/eur$/i, "")) : null;
  return {
    term,
    prefix: num?.[1]?.toUpperCase() ?? null,
    year: num?.[2] ? Number(num[2]) : null,
    seq: num ? Number(num[3]) : null,
    amountCents: amount !== null && amount > 0 ? amount : null,
  };
}

const pad4 = (n: number) => String(n).padStart(4, "0");

/** Exact / any-year conditions for "XX-YYYY-NNNN" numbers, or null when the query isn't one for this type. */
function yearNumberMatch(p: ParsedQuery, type: NumberedType, column: unknown): { exact: SQL; seq: SQL } | null {
  const prefix = DOCUMENT_NUMBER_PREFIX[type];
  if (p.seq === null || (p.prefix !== null && p.prefix !== prefix)) return null;
  const suffix = `-${pad4(p.seq)}`;
  if (p.year !== null) {
    const exact = sql`${column} = ${`${prefix}-${p.year}${suffix}`}`;
    return { exact, seq: exact };
  }
  const seq = sql`${column} LIKE ${`${prefix}-____${suffix}`}`;
  // "RE-12" names one type explicitly; a bare "12" is only a candidate across years and types
  return { exact: p.prefix !== null ? seq : sql`0`, seq };
}

/** Integer numbers shown as "K-0001" / "A-0001" / "AV-0001". */
function intNumberMatch(p: ParsedQuery, prefix: string, column: unknown): SQL | null {
  if (p.seq === null || p.year !== null || (p.prefix !== null && p.prefix !== prefix)) return null;
  return sql`${column} = ${p.seq}`;
}

function rankSql(exact: SQL | null, seq: SQL | null, amount: SQL | null): SQL<number> {
  return sql<number>`case when ${exact ?? sql`0`} then 0 when ${seq ?? sql`0`} then 1 when ${amount ?? sql`0`} then 2 else 3 end`;
}

const amountMatch = (p: ParsedQuery, ...columns: unknown[]): SQL | null =>
  p.amountCents === null ? null : or(...columns.map((c) => sql`${c} = ${p.amountCents}`))!;

const joinMeta = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

// ── multi-word queries ─────────────────────────────────────────────────────────
// A query with several words that finds nothing as a whole ("Alpen Entwurf", "offene Rechnungen Alpen") is
// read word by word: words naming a record type or state filter the results, the rest is matched as a phrase,
// then with every word (each may hit another field), then with any word (ranked by how many matched).

export const SEARCH_STATUSES = ["draft", "open", "paid", "overdue"] as const;
export type SearchStatus = (typeof SEARCH_STATUSES)[number];

/** Folded (with digraphs) type and state words → filter. */
const FILTER_WORDS: Record<string, { type?: SearchResultType; status?: SearchStatus }> = {};
const addWords = (words: string, f: { type?: SearchResultType; status?: SearchStatus }) => {
  for (const w of words.split(" ")) FILTER_WORDS[foldText(w, true)] = f;
};
addWords("entwurf entwürfe entwurfs", { status: "draft" });
addWords("offen offene offenen offener offenes unbezahlt unbezahlte unbezahlten", { status: "open" });
addWords("bezahlt bezahlte bezahlten beglichen", { status: "paid" });
addWords("überfällig überfällige überfälligen überfälliger", { status: "overdue" });
addWords("rechnung rechnungen", { type: "invoice" });
addWords("angebot angebote angeboten", { type: "offer" });
addWords("gutschrift gutschriften", { type: "credit_note" });
addWords("mahnung mahnungen", { type: "reminder" });
addWords("serienrechnung serienrechnungen", { type: "recurring" });
addWords("ausgabe ausgaben beleg belege eingangsrechnung eingangsrechnungen", { type: "expense" });
addWords("fixkosten", { type: "fixed_cost" });
addWords("anlage anlagen anlagegut", { type: "asset" });
addWords("kunde kunden kundin", { type: "client" });
addWords("artikel", { type: "article" });

/** Filler words dropped from multi-word queries ("Rechnungen für Alpen"). */
const STOP_WORDS = new Set(
  "für von vom mit und oder der die das den dem des ein eine einer einen im in an am zu zum zur bei alle aller meine mein".split(" ").map((w) => foldText(w, true)),
);

export interface QueryWords {
  /** words left for the text match */
  words: string[];
  types: SearchResultType[];
  statuses: SearchStatus[];
}

export function parseWords(term: string): QueryWords {
  const out: QueryWords = { words: [], types: [], statuses: [] };
  for (const word of term.split(" ")) {
    const folded = foldText(word, true);
    const f = FILTER_WORDS[folded];
    if (f?.type && !out.types.includes(f.type)) out.types.push(f.type);
    if (f?.status && !out.statuses.includes(f.status)) out.statuses.push(f.status);
    if (!f && !STOP_WORDS.has(folded)) out.words.push(word);
  }
  return out;
}

/**
 * How one search runs: `phrase` matches parts[0] as a whole (the classic search), `all` needs every part to match
 * (each in any field), `any` at least one, `list` matches everything (only with a status/type filter).
 */
interface TermQuery {
  mode: "phrase" | "all" | "any" | "list";
  parts: ParsedQuery[];
  statuses: SearchStatus[];
}

interface Match {
  where: SQL;
  rank: SQL<number>;
}
type Cond = (p: ParsedQuery) => Match;

/** where + rank of a query: per-part conditions combined by mode. `any` ranks 3 + the number of words missed. */
function combine(q: TermQuery, cond: Cond): Match {
  if (q.mode === "list") return { where: sql`1`, rank: sql<number>`3` };
  const ms = q.parts.map(cond);
  if (q.mode === "phrase" || ms.length === 1) return ms[0]!;
  if (q.mode === "all") return { where: and(...ms.map((m) => m.where))!, rank: sql<number>`min(${sql.join(ms.map((m) => m.rank), sql`, `)})` };
  const hits = sql.join(ms.map((m) => sql`(case when ${m.where} then 1 else 0 end)`), sql` + `);
  return { where: or(...ms.map((m) => m.where))!, rank: sql<number>`${3 + ms.length} - (${hits})` };
}

/** Status filter of a type: undefined = none requested, null = the type has none of the requested states. */
type StatusFilter = SQL | undefined | null;
function statusFilter(statuses: SearchStatus[], conds: Partial<Record<SearchStatus, SQL>>): StatusFilter {
  if (!statuses.length) return undefined;
  const parts = statuses.map((s) => conds[s]).filter((c): c is SQL => !!c);
  return parts.length ? or(...parts)! : null;
}

// ── per-type searches ──────────────────────────────────────────────────────────

const DOC_PATHS: Record<DocumentType, string> = { offer: "/offers", invoice: "/invoices", credit_note: "/credit-notes" };
const docSnapshotName = sql`json_extract(${documents.clientSnapshot}, '$.name')`;

const docCond =
  (type: DocumentType): Cond =>
  (p) => {
    const nums = yearNumberMatch(p, type, documents.number);
    const amount = amountMatch(p, documents.grossCents, documents.netCents);
    return {
      where: or(rawContains(p.term, documents.number), textMatch(p.term, [documents.title, clients.name, docSnapshotName]), nums?.seq, amount ?? undefined)!,
      rank: rankSql(nums?.exact ?? null, nums?.seq ?? null, amount),
    };
  };

function docStatus(type: DocumentType, statuses: SearchStatus[], today: string): StatusFilter {
  const issued = sql`${documents.status} in ('final', 'sent')`;
  return statusFilter(statuses, {
    draft: eq(documents.status, "draft"),
    open: type === "credit_note" ? undefined : issued,
    paid: type === "invoice" ? eq(documents.status, "paid") : undefined,
    overdue: type === "invoice" ? sql`${issued} and ${documents.dueDate} < ${today}` : undefined,
  });
}

function searchDocuments(db: DbOrTx, q: TermQuery, type: DocumentType, limit: number): SearchResult[] | null {
  const today = todayIso();
  const status = docStatus(type, q.statuses, today);
  if (status === null) return null;
  const { where, rank } = combine(q, docCond(type));
  const rows = db
    .select({
      id: documents.id,
      number: documents.number,
      status: documents.status,
      title: documents.title,
      issueDate: documents.issueDate,
      dueDate: documents.dueDate,
      grossCents: documents.grossCents,
      clientName: clients.name,
      snapshotName: sql<string | null>`${docSnapshotName}`,
      rank,
    })
    .from(documents)
    .innerJoin(clients, eq(clients.id, documents.clientId))
    .where(and(eq(documents.type, type), where, status))
    .orderBy(rank, sql`${documents.issueDate} desc`, sql`${documents.id} desc`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    type,
    id: r.id,
    label: r.number ?? `${DOCUMENT_TYPE_LABELS[type]} (Entwurf)`,
    sublabel: joinMeta(r.snapshotName || r.clientName, r.title),
    meta: joinMeta(
      formatDate(r.issueDate),
      formatCents(r.grossCents),
      isOverdue({ type, status: r.status, dueDate: r.dueDate }, today) ? OVERDUE_LABEL : DOCUMENT_STATUS_LABELS[r.status],
    ),
    path: `${DOC_PATHS[type]}/${r.id}`,
    rank: r.rank,
  }));
}

const clientCond: Cond = (p) => {
  const number = p.prefix === null || p.prefix === "K" ? parseClientNumber(p.term) : null;
  const exact = number !== null && p.year === null ? sql`${clients.number} = ${number}` : null;
  const uidCompact = sql`replace(${clients.uid}, ' ', '')`;
  return {
    where: or(
      textMatch(p.term, [clients.name, clients.contactPerson, clients.email, clients.city]),
      rawContains(p.term.replace(/\s/g, ""), uidCompact),
      exact ?? undefined,
    )!,
    rank: rankSql(exact, null, null),
  };
};

function searchClients(db: DbOrTx, q: TermQuery, limit: number): SearchResult[] | null {
  if (q.statuses.length) return null;
  const { where, rank } = combine(q, clientCond);
  const rows = db
    .select({
      id: clients.id,
      number: clients.number,
      name: clients.name,
      contactPerson: clients.contactPerson,
      city: clients.city,
      email: clients.email,
      archivedAt: clients.archivedAt,
      rank,
    })
    .from(clients)
    .where(where)
    // active first, then by name
    .orderBy(rank, sql`${clients.archivedAt} is not null`, sql`${clients.name} collate nocase`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    type: "client" as const,
    id: r.id,
    label: r.name,
    sublabel: joinMeta(formatClientNumber(r.number), r.contactPerson, r.city),
    meta: joinMeta(r.email, r.archivedAt && "archiviert"),
    path: `/clients/${r.id}`,
    rank: r.rank,
  }));
}

const expenseCond: Cond = (p) => {
  const nums = yearNumberMatch(p, "expense", expenses.number);
  const amount = amountMatch(p, expenses.grossCents, expenses.netCents);
  return {
    where: or(
      rawContains(p.term, expenses.number),
      rawContains(p.term, expenses.supplierInvoiceNumber),
      textMatch(p.term, [expenses.supplierName, expenses.description]),
      nums?.seq,
      amount ?? undefined,
    )!,
    rank: rankSql(nums?.exact ?? null, nums?.seq ?? null, amount),
  };
};

function searchExpenses(db: DbOrTx, q: TermQuery, limit: number): SearchResult[] | null {
  // "Entwurf" = unvollständig (no supplier or no lines), like the expense list
  const incomplete = sql`(${expenses.supplierName} = '' or not exists (select 1 from ${expenseLines} where ${expenseLines.expenseId} = ${expenses.id}))`;
  const status = statusFilter(q.statuses, {
    draft: incomplete,
    open: sql`${expenses.paidAt} is null and not ${incomplete}`,
    paid: sql`${expenses.paidAt} is not null`,
    overdue: sql`${expenses.paidAt} is null and ${expenses.dueDate} < ${todayIso()}`,
  });
  if (status === null) return null;
  const { where, rank } = combine(q, expenseCond);
  const rows = db
    .select({
      id: expenses.id,
      number: expenses.number,
      supplierName: expenses.supplierName,
      supplierInvoiceNumber: expenses.supplierInvoiceNumber,
      description: expenses.description,
      issueDate: expenses.issueDate,
      paidAt: expenses.paidAt,
      grossCents: expenses.grossCents,
      rank,
    })
    .from(expenses)
    .where(and(where, status))
    .orderBy(rank, sql`${expenses.issueDate} desc`, sql`${expenses.id} desc`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    type: "expense" as const,
    id: r.id,
    label: r.number ?? r.supplierName,
    sublabel: joinMeta(r.supplierName || "Ohne Lieferant", r.supplierInvoiceNumber && `Nr. ${r.supplierInvoiceNumber}`, r.description),
    meta: joinMeta(formatDate(r.issueDate), formatCents(r.grossCents), r.paidAt ? "Bezahlt" : "Offen"),
    path: `/expenses/${r.id}`,
    rank: r.rank,
  }));
}

const reminderSnapshotName = sql`json_extract(${reminders.clientSnapshot}, '$.name')`;

const reminderCond: Cond = (p) => {
  const nums = yearNumberMatch(p, "reminder", reminders.number);
  return {
    where: or(rawContains(p.term, reminders.number), rawContains(p.term, documents.number), textMatch(p.term, [clients.name, reminderSnapshotName]), nums?.seq)!,
    rank: rankSql(nums?.exact ?? null, nums?.seq ?? null, null),
  };
};

function searchReminders(db: DbOrTx, q: TermQuery, limit: number): SearchResult[] | null {
  const status = statusFilter(q.statuses, { draft: eq(reminders.status, "draft") });
  if (status === null) return null;
  const { where, rank } = combine(q, reminderCond);
  const rows = db
    .select({
      id: reminders.id,
      number: reminders.number,
      level: reminders.level,
      issueDate: reminders.issueDate,
      totalCents: sql<number>`${reminders.openCents} + ${reminders.feeCents} + ${reminders.interestCents}`,
      invoiceNumber: documents.number,
      clientName: clients.name,
      snapshotName: sql<string | null>`${reminderSnapshotName}`,
      rank,
    })
    .from(reminders)
    .innerJoin(documents, eq(documents.id, reminders.invoiceId))
    .innerJoin(clients, eq(clients.id, documents.clientId))
    .where(and(where, status))
    .orderBy(rank, sql`${reminders.issueDate} desc`, sql`${reminders.id} desc`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    type: "reminder" as const,
    id: r.id,
    label: r.number ?? "Mahnung (Entwurf)",
    sublabel: joinMeta(r.snapshotName || r.clientName, r.invoiceNumber, `Stufe ${r.level}`),
    meta: joinMeta(formatDate(r.issueDate), formatCents(r.totalCents)),
    path: `/reminders/${r.id}`,
    rank: r.rank,
  }));
}

const recurringCond: Cond = (p) => ({ where: textMatch(p.term, [recurringInvoices.name, clients.name]), rank: sql<number>`3` });

function searchRecurring(db: DbOrTx, q: TermQuery, limit: number): SearchResult[] | null {
  if (q.statuses.length) return null;
  const { where, rank } = combine(q, recurringCond);
  const rows = db
    .select({
      id: recurringInvoices.id,
      name: recurringInvoices.name,
      active: recurringInvoices.active,
      nextRunDate: recurringInvoices.nextRunDate,
      clientName: clients.name,
      rank,
    })
    .from(recurringInvoices)
    .innerJoin(clients, eq(clients.id, recurringInvoices.clientId))
    .where(where)
    .orderBy(rank, sql`${recurringInvoices.active} desc`, sql`${recurringInvoices.name} collate nocase`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    type: "recurring" as const,
    id: r.id,
    label: r.name,
    sublabel: r.clientName,
    meta: r.active ? joinMeta(r.nextRunDate && `nächste ${formatDate(r.nextRunDate)}`) : "pausiert",
    path: `/recurring/${r.id}`,
    rank: r.rank,
  }));
}

const fixedCostCond: Cond = (p) => {
  const amount = amountMatch(p, recurringExpenses.grossCents);
  return {
    where: or(textMatch(p.term, [recurringExpenses.name, recurringExpenses.supplierName]), amount ?? undefined)!,
    rank: rankSql(null, null, amount),
  };
};

function searchFixedCosts(db: DbOrTx, q: TermQuery, limit: number): SearchResult[] | null {
  if (q.statuses.length) return null;
  const { where, rank } = combine(q, fixedCostCond);
  const rows = db
    .select({
      id: recurringExpenses.id,
      name: recurringExpenses.name,
      supplierName: recurringExpenses.supplierName,
      active: recurringExpenses.active,
      grossCents: recurringExpenses.grossCents,
      rank,
    })
    .from(recurringExpenses)
    .where(where)
    .orderBy(rank, sql`${recurringExpenses.active} desc`, sql`${recurringExpenses.name} collate nocase`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    type: "fixed_cost" as const,
    id: r.id,
    label: r.name,
    sublabel: r.supplierName,
    meta: joinMeta(formatCents(r.grossCents), !r.active && "inaktiv"),
    path: "/fixed-costs",
    rank: r.rank,
  }));
}

const assetCond: Cond = (p) => {
  const exact = intNumberMatch(p, "AV", fixedAssets.number);
  const amount = amountMatch(p, fixedAssets.costCents);
  return { where: or(textMatch(p.term, [fixedAssets.name]), exact ?? undefined, amount ?? undefined)!, rank: rankSql(exact, null, amount) };
};

function searchAssets(db: DbOrTx, q: TermQuery, limit: number): SearchResult[] | null {
  if (q.statuses.length) return null;
  const { where, rank } = combine(q, assetCond);
  const rows = db
    .select({
      id: fixedAssets.id,
      number: fixedAssets.number,
      name: fixedAssets.name,
      acquisitionDate: fixedAssets.acquisitionDate,
      costCents: fixedAssets.costCents,
      disposalDate: fixedAssets.disposalDate,
      rank,
    })
    .from(fixedAssets)
    .where(where)
    .orderBy(rank, sql`${fixedAssets.acquisitionDate} desc`)
    .limit(limit)
    .all();
  return rows.map((r) => ({
    type: "asset" as const,
    id: r.id,
    label: r.name,
    sublabel: formatAssetNumber(r.number),
    meta: joinMeta(formatDate(r.acquisitionDate), formatCents(r.costCents), r.disposalDate && "ausgeschieden"),
    path: `/assets/${r.id}`,
    rank: r.rank,
  }));
}

const articleCond: Cond = (p) => {
  const number = p.prefix === null || p.prefix === "A" ? parseArticleNumber(p.term) : null;
  const exact = number !== null && p.year === null ? sql`${articles.number} = ${number}` : null;
  return { where: or(textMatch(p.term, [articles.title]), exact ?? undefined)!, rank: rankSql(exact, null, null) };
};

function searchArticles(db: DbOrTx, q: TermQuery, limit: number): SearchResult[] | null {
  if (q.statuses.length) return null;
  const { where, rank } = combine(q, articleCond);
  const rows = db
    .select({
      id: articles.id,
      number: articles.number,
      title: articles.title,
      unit: articles.unit,
      unitPriceCents: articles.unitPriceCents,
      archivedAt: articles.archivedAt,
      rank,
    })
    .from(articles)
    .where(where)
    .orderBy(rank, sql`${articles.archivedAt} is not null`, sql`${articles.usageCount} desc`, sql`${articles.title} collate nocase`)
    .limit(limit)
    .all();
  return rows.map((r) => {
    const number = formatArticleNumber(r.number);
    return {
      type: "article" as const,
      id: r.id,
      label: r.title,
      sublabel: number,
      meta: joinMeta(`${formatCents(r.unitPriceCents)}${r.unit ? ` / ${r.unit}` : ""}`, r.archivedAt && "archiviert"),
      path: `/articles?q=${encodeURIComponent(number)}${r.archivedAt ? "&archived=all" : ""}`,
      rank: r.rank,
    };
  });
}

// ── entry point ────────────────────────────────────────────────────────────────

/** All groups of one query, optionally limited to some types; groups with a number/amount hit first. */
function runGroups(db: DbOrTx, q: TermQuery, types: SearchResultType[], limit: number): SearchGroup[] {
  const byType: Record<SearchResultType, () => SearchResult[] | null> = {
    client: () => searchClients(db, q, limit),
    invoice: () => searchDocuments(db, q, "invoice", limit),
    offer: () => searchDocuments(db, q, "offer", limit),
    credit_note: () => searchDocuments(db, q, "credit_note", limit),
    reminder: () => searchReminders(db, q, limit),
    recurring: () => searchRecurring(db, q, limit),
    expense: () => searchExpenses(db, q, limit),
    fixed_cost: () => searchFixedCosts(db, q, limit),
    asset: () => searchAssets(db, q, limit),
    article: () => searchArticles(db, q, limit),
  };
  return SEARCH_RESULT_TYPES.filter((type) => !types.length || types.includes(type))
    .map((type) => ({ type, label: SEARCH_GROUP_LABELS[type], results: byType[type]() ?? [] }))
    .filter((g) => g.results.length > 0)
    .map((g, index) => ({ g, index, best: g.results[0]!.rank }))
    // groups holding a number/amount hit come first; otherwise the fixed order above
    .sort((a, b) => a.best - b.best || a.index - b.index)
    .map(({ g }) => g);
}

/** Text words under a filter: phrase, then every word, then any word; no words = everything the filter allows. */
function wordSearch(db: DbOrTx, words: string[], types: SearchResultType[], statuses: SearchStatus[], limit: number, skipPhrase = false): SearchGroup[] {
  if (!words.length) return types.length || statuses.length ? runGroups(db, { mode: "list", parts: [], statuses }, types, limit) : [];
  const phrase = skipPhrase ? [] : runGroups(db, { mode: "phrase", parts: [parseQuery(words.join(" "))], statuses }, types, limit);
  if (phrase.length || words.length === 1) return phrase;
  const parts = words.map(parseQuery);
  const all = runGroups(db, { mode: "all", parts, statuses }, types, limit);
  return all.length ? all : runGroups(db, { mode: "any", parts, statuses }, types, limit);
}

export function search(db: DbOrTx, q: string, limit = 6): SearchResponse {
  const p = parseQuery(q);
  if (!p.term) return { q, groups: [] };
  const groups = runGroups(db, { mode: "phrase", parts: [p], statuses: [] }, [], limit);
  // single words, numbers and amounts ("re 2026 12", "€ 1.200") stay whole
  if (groups.length || !p.term.includes(" ") || p.seq !== null || p.amountCents !== null) return { q, groups };

  const { words, types, statuses } = parseWords(p.term);
  if (types.length || statuses.length) {
    const filtered = wordSearch(db, words, types, statuses, limit);
    if (filtered.length) return { q, groups: filtered };
    // the filter left nothing: the same words unfiltered
    const unfiltered = wordSearch(db, words, [], [], limit);
    if (unfiltered.length) return { q, groups: unfiltered };
  }
  // the type words may be part of a name after all
  const all = p.term.split(" ").filter((w) => !STOP_WORDS.has(foldText(w, true)));
  return { q, groups: wordSearch(db, all, [], [], limit, all.join(" ") === p.term) };
}
