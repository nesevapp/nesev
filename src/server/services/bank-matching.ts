import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type AutoMatchMode, type MatchInput, normalizeIban } from "../../shared/bank";
import type { DbOrTx } from "../db/client";
import { bankMatches, bankTransactions, type BankTransaction, clients, documents, expenses, reminders } from "../db/schema";
import { getTransaction, invoicePaymentStates, lastPaymentDate, paidCentsByExpense, type TransactionRow } from "./bank";
import { settleInvoice } from "./documents";

// Payment matching: suggestions for open bank transactions, auto-apply, applying/reverting allocations.
//
// Incoming → open invoices (final/sent, open amount from services/bank.ts invoicePaymentStates).
// Outgoing → open expenses (paidAt null, open = gross − allocated).
// Signals (points):
//   invoice number in purpose/reference ("RE-2026-0001", "RE 2026 0001", "RE20260001")  60
//   same number without prefix ("2026/0001")                                               40
//   reminder number (MA-…) of the invoice                                                  55
//   amount = open amount                                                                   35
//   amount = open + reminder fees/interest                                                 30
//   counterparty IBAN paid this client/supplier before (learned from earlier matches)      30
//   counterparty/purpose name similarity                                                 ≤ 20
//   booked before the invoice date                                                       −40
// Auto-apply ("safe"): number + exact amount, or exact amount + learned IBAN — and only if exactly one
// candidate qualifies for the transaction and no other transaction of the run claims the same target.
// "aggressive" additionally: exact amount + name similarity ≥ 0.8, and number with a partial amount.

const conflict = (message: string) => new HTTPException(409, { message });
const unprocessable = (message: string) => new HTTPException(422, { message });

// ── Normalization ───────────────────────────────────────────────────────────────

const INVOICE_PREFIXES = new Set(["RE", "R", "RG", "RECHNUNG", "RECHNUNGSNR", "RECHNUNGSNUMMER", "INV", "INVOICE", "NR"]);

/**
 * Document numbers mentioned in a text, canonicalized: "RE 2026 0001" / "RE20260001" / "re-2026-1" →
 * "RE-2026-0001"; reminder numbers → "MA-2026-0003"; without prefix ("2026/0001") → "*-2026-0001".
 */
export function findDocumentNumbers(text: string): string[] {
  const out = new Set<string>();
  const re = /(?<![A-Z0-9])(?:(RECHNUNGSNUMMER|RECHNUNGSNR|RECHNUNG|INVOICE|INV|RE|RG|MA|NR|R)[\s.:#\-_/]*)?(20\d{2})[\s.\-_/]*(\d{1,6})(?!\d)/g;
  for (const m of text.toUpperCase().matchAll(re)) {
    const seq = Number(m[3]);
    if (seq === 0) continue;
    // "20260001" without separator: the sequence must be the 4-digit padded form
    const prefix = m[1] === "MA" ? "MA" : m[1] && INVOICE_PREFIXES.has(m[1]) ? "RE" : "*";
    out.add(`${prefix}-${m[2]}-${String(seq).padStart(4, "0")}`);
  }
  return [...out];
}

/** "RE-2026-0001" → "RE-2026-0001" canonical form (same as findDocumentNumbers output). */
export function canonicalNumber(number: string): string {
  return findDocumentNumbers(number)[0] ?? number.toUpperCase();
}

const LEGAL_FORMS = new Set([
  "gmbh", "mbh", "ag", "kg", "og", "eu", "ev", "gesbr", "co", "und", "ltd", "inc", "llc", "se", "sa", "bv", "gmbhcokg",
  "firma", "fa", "herr", "frau", "dr", "mag", "ing", "dipl", "the",
]);

function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/e\.\s?u\./g, "eu")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !LEGAL_FORMS.has(t));
}

/** 0..1 similarity of two party names (legal forms, umlauts and case ignored; prefixes count). */
export function nameSimilarity(a: string, b: string): number {
  const ta = [...new Set(nameTokens(a))];
  const tb = [...new Set(nameTokens(b))];
  if (ta.length === 0 || tb.length === 0) return 0;
  const hit = (x: string, ys: string[]) => ys.some((y) => y === x || (x.length >= 4 && y.length >= 4 && (y.startsWith(x) || x.startsWith(y))));
  const common = ta.filter((x) => hit(x, tb)).length;
  return (2 * common) / (ta.length + tb.length);
}

/** All name tokens of `name` occur in `text` (e.g. "Payment from Huber KG"). */
function nameInText(name: string, text: string): boolean {
  const tn = nameTokens(name);
  if (tn.length === 0) return false;
  const tt = new Set(nameTokens(text));
  return tn.every((t) => tt.has(t));
}

const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── Candidates ──────────────────────────────────────────────────────────────────

export interface InvoiceCandidate {
  kind: "document";
  id: number;
  number: string;
  canonical: string;
  clientId: number;
  name: string;
  issueDate: string;
  dueDate: string | null;
  grossCents: number;
  /** gross − credited */
  dueCents: number;
  paidCents: number;
  openCents: number;
  /** open + fee + interest of the latest finalized reminder */
  reminderTotalCents: number | null;
  reminderNumbers: string[];
}

export interface ExpenseCandidate {
  kind: "expense";
  id: number;
  number: string;
  supplierInvoiceNumber: string;
  name: string;
  issueDate: string;
  dueDate: string | null;
  grossCents: number;
  dueCents: number;
  paidCents: number;
  openCents: number;
  /** receipt without amounts yet (gross 0): matched by name/purpose only, never auto-applied */
  noAmount: boolean;
}

export type Candidate = InvoiceCandidate | ExpenseCandidate;

export function openInvoices(db: DbOrTx, ids?: number[]): InvoiceCandidate[] {
  const rows = db
    .select({
      id: documents.id,
      number: documents.number,
      clientId: documents.clientId,
      name: sql<string>`coalesce(json_extract(${documents.clientSnapshot}, '$.name'), ${clients.name}, '')`,
      issueDate: documents.issueDate,
      dueDate: documents.dueDate,
      grossCents: documents.grossCents,
    })
    .from(documents)
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .where(
      and(
        eq(documents.type, "invoice"),
        inArray(documents.status, ["final", "sent"]),
        ids ? inArray(documents.id, ids) : undefined,
      ),
    )
    .all();
  if (rows.length === 0) return [];
  const docIds = rows.map((r) => r.id);
  const states = invoicePaymentStates(db, rows);
  const rems = db
    .select()
    .from(reminders)
    .where(and(inArray(reminders.invoiceId, docIds), ne(reminders.status, "draft")))
    .orderBy(desc(reminders.level), desc(reminders.id))
    .all();
  const remsByInvoice = new Map<number, typeof rems>();
  for (const m of rems) {
    const list = remsByInvoice.get(m.invoiceId);
    if (list) list.push(m);
    else remsByInvoice.set(m.invoiceId, [m]);
  }
  return rows.flatMap((r): InvoiceCandidate[] => {
    const { dueCents, paidCents, openCents } = states.get(r.id)!;
    if (openCents <= 0) return [];
    const own = remsByInvoice.get(r.id) ?? [];
    const latest = own[0];
    const extra = latest ? latest.feeCents + latest.interestCents : 0;
    return [
      {
        kind: "document",
        id: r.id,
        number: r.number ?? "",
        canonical: canonicalNumber(r.number ?? ""),
        clientId: r.clientId,
        name: r.name,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        grossCents: r.grossCents,
        dueCents,
        paidCents,
        openCents,
        reminderTotalCents: extra > 0 ? openCents + extra : null,
        reminderNumbers: own.map((m) => canonicalNumber(m.number ?? "")).filter((n) => n.startsWith("MA-")),
      },
    ];
  });
}

export function openExpenses(db: DbOrTx, ids?: number[]): ExpenseCandidate[] {
  const rows = db
    .select()
    .from(expenses)
    .where(and(isNull(expenses.paidAt), ids ? inArray(expenses.id, ids) : undefined))
    .all();
  const paid = paidCentsByExpense(db, rows.map((r) => r.id));
  return rows.flatMap((r): ExpenseCandidate[] => {
    const paidCents = paid.get(r.id) ?? 0;
    const openCents = r.grossCents - paidCents;
    const noAmount = r.grossCents === 0 && paidCents === 0;
    if (openCents <= 0 && !noAmount) return [];
    return [
      {
        kind: "expense",
        noAmount,
        id: r.id,
        number: r.number ?? "",
        supplierInvoiceNumber: r.supplierInvoiceNumber,
        name: r.supplierName,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        grossCents: r.grossCents,
        dueCents: r.grossCents,
        paidCents,
        openCents,
      },
    ];
  });
}

/** Counterparty IBAN → client ids / normalized supplier names, learned from earlier allocations. */
export interface LearnedIbans {
  clients: Map<string, Set<number>>;
  suppliers: Map<string, Set<string>>;
}

const supplierKey = (name: string) => nameTokens(name).join(" ");

export function learnedIbans(db: DbOrTx): LearnedIbans {
  const rows = db
    .select({
      iban: bankTransactions.counterpartyIban,
      clientId: documents.clientId,
      supplier: expenses.supplierName,
    })
    .from(bankMatches)
    .innerJoin(bankTransactions, eq(bankTransactions.id, bankMatches.transactionId))
    .leftJoin(documents, eq(documents.id, bankMatches.documentId))
    .leftJoin(expenses, eq(expenses.id, bankMatches.expenseId))
    .where(ne(bankTransactions.counterpartyIban, ""))
    .all();
  const out: LearnedIbans = { clients: new Map(), suppliers: new Map() };
  for (const r of rows) {
    const iban = normalizeIban(r.iban);
    if (r.clientId != null) {
      const set = out.clients.get(iban) ?? new Set();
      set.add(r.clientId);
      out.clients.set(iban, set);
    }
    if (r.supplier) {
      const set = out.suppliers.get(iban) ?? new Set();
      set.add(supplierKey(r.supplier));
      out.suppliers.set(iban, set);
    }
  }
  return out;
}

// ── Scoring ─────────────────────────────────────────────────────────────────────

export type ReasonCode =
  | "number"
  | "number_weak"
  | "reminder_number"
  | "supplier_number"
  | "amount_exact"
  | "amount_reminder"
  | "partial"
  | "overpaid"
  | "iban"
  | "name"
  | "name_similar"
  | "before_issue"
  | "no_amount";

export const REASON_LABELS: Record<ReasonCode, string> = {
  number: "Rechnungsnummer im Verwendungszweck",
  number_weak: "Rechnungsnummer (ohne Präfix) im Verwendungszweck",
  reminder_number: "Mahnungsnummer im Verwendungszweck",
  supplier_number: "Belegnummer des Lieferanten im Verwendungszweck",
  amount_exact: "Betrag exakt",
  amount_reminder: "Betrag inkl. Mahnspesen",
  partial: "Teilzahlung",
  overpaid: "Überzahlung",
  iban: "IBAN aus früherer Zahlung bekannt",
  name: "Name stimmt überein",
  name_similar: "Name ähnlich",
  before_issue: "Zahlung vor Belegdatum",
  no_amount: "Beleg ohne Beträge",
};

export interface Suggestion {
  kind: "document" | "expense";
  id: number;
  number: string;
  name: string;
  issueDate: string;
  dueDate: string | null;
  grossCents: number;
  dueCents: number;
  paidCents: number;
  openCents: number;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: { code: ReasonCode; label: string }[];
  /** proposed allocation for one-click "Zuordnen" */
  amountCents: number;
  /** would be applied automatically (mode "safe" or the account's mode) */
  auto: boolean;
}

interface Scored {
  candidate: Candidate;
  score: number;
  codes: ReasonCode[];
  nameSim: number;
}

type TxLike = Pick<BankTransaction, "id" | "amountCents" | "bookingDate" | "counterpartyName" | "counterpartyIban" | "purpose" | "reference">;

function scorePair(tx: TxLike, remaining: number, c: Candidate, refs: string[], learned: LearnedIbans): Scored {
  const codes: ReasonCode[] = [];
  let score = 0;
  const text = `${tx.purpose} ${tx.reference}`;

  if (c.kind === "document") {
    const [, year, seq] = c.canonical.split("-");
    if (refs.includes(c.canonical)) {
      codes.push("number");
      score += 60;
    } else if (year && refs.includes(`*-${year}-${seq}`)) {
      codes.push("number_weak");
      score += 40;
    } else if (c.reminderNumbers.some((n) => refs.includes(n))) {
      codes.push("reminder_number");
      score += 55;
    }
  } else {
    const sin = compact(c.supplierInvoiceNumber);
    if (sin.length >= 4 && /\d/.test(sin) && compact(text).includes(sin)) {
      codes.push("supplier_number");
      score += 55;
    }
  }

  const noAmount = c.kind === "expense" && c.noAmount;
  if (noAmount) {
    codes.push("no_amount");
  } else if (remaining === c.openCents) {
    codes.push("amount_exact");
    score += 35;
  } else if (c.kind === "document" && c.reminderTotalCents === remaining) {
    codes.push("amount_reminder");
    score += 30;
  } else if (remaining < c.openCents) {
    codes.push("partial");
  } else {
    codes.push("overpaid");
  }

  const iban = normalizeIban(tx.counterpartyIban);
  if (iban) {
    const known =
      c.kind === "document" ? learned.clients.get(iban)?.has(c.clientId) : learned.suppliers.get(iban)?.has(supplierKey(c.name));
    if (known) {
      codes.push("iban");
      score += 30;
    }
  }

  let nameSim = tx.counterpartyName ? nameSimilarity(tx.counterpartyName, c.name) : 0;
  if (nameSim < 0.8 && nameInText(c.name, `${tx.counterpartyName} ${tx.purpose}`)) nameSim = 0.8;
  if (nameSim >= 0.5) {
    codes.push(nameSim >= 0.8 ? "name" : "name_similar");
    // without an amount the name is the main signal
    score += Math.round((noAmount ? 40 : 20) * nameSim);
  }

  const tolerance = c.kind === "expense" ? -30 : 0; // expenses are often paid right before the receipt is dated
  if (daysFrom(c.issueDate, tx.bookingDate) < tolerance) {
    codes.push("before_issue");
    score -= 40;
  }
  return { candidate: c, score, codes, nameSim };
}

function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const SUGGEST_MIN_SCORE = 35;
const MAX_SUGGESTIONS = 3;

function qualifiesForAuto(s: Scored, mode: AutoMatchMode): boolean {
  if (mode === "off" || s.codes.includes("before_issue") || s.codes.includes("no_amount")) return false;
  const has = (c: ReasonCode) => s.codes.includes(c);
  const number = has("number") || has("number_weak") || has("reminder_number") || has("supplier_number");
  const exact = has("amount_exact") || has("amount_reminder");
  if (number && exact) return true;
  if (has("amount_exact") && has("iban")) return true;
  if (mode === "aggressive") {
    if (has("amount_exact") && s.nameSim >= 0.8) return true;
    if ((has("number") || has("reminder_number") || has("supplier_number")) && has("partial")) return true;
  }
  return false;
}

export interface MatchContext {
  invoices: InvoiceCandidate[];
  expenses: ExpenseCandidate[];
  learned: LearnedIbans;
}

export function loadContext(db: DbOrTx): MatchContext {
  return { invoices: openInvoices(db), expenses: openExpenses(db), learned: learnedIbans(db) };
}

function scoreAll(tx: TxLike, remaining: number, ctx: MatchContext): Scored[] {
  if (remaining <= 0 || tx.amountCents === 0) return [];
  const refs = findDocumentNumbers(`${tx.purpose} ${tx.reference}`);
  const pool: Candidate[] = tx.amountCents > 0 ? ctx.invoices : ctx.expenses;
  return pool
    .map((c) => scorePair(tx, remaining, c, refs, ctx.learned))
    .filter((s) => s.score >= SUGGEST_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.candidate.issueDate.localeCompare(b.candidate.issueDate));
}

/** Allocation for a candidate: up to its open amount when the purpose names several documents (split), else all. */
function proposedAmount(remaining: number, s: Scored, numberHits: number): number {
  const c = s.candidate;
  if (remaining <= c.openCents || (c.kind === "expense" && c.noAmount)) return remaining;
  if (s.codes.includes("amount_reminder")) return remaining;
  return numberHits > 1 ? c.openCents : remaining;
}

function toSuggestion(s: Scored, remaining: number, numberHits: number, auto: boolean): Suggestion {
  const c = s.candidate;
  return {
    kind: c.kind,
    id: c.id,
    number: c.number,
    name: c.name,
    issueDate: c.issueDate,
    dueDate: c.dueDate,
    grossCents: c.grossCents,
    dueCents: c.dueCents,
    paidCents: c.paidCents,
    openCents: c.openCents,
    score: s.score,
    confidence: s.score >= 90 ? "high" : s.score >= 60 ? "medium" : "low",
    reasons: s.codes.map((code) => ({ code, label: REASON_LABELS[code] })),
    amountCents: proposedAmount(remaining, s, numberHits),
    auto,
  };
}

const numberHitCount = (scored: Scored[]) =>
  scored.filter((s) => s.codes.some((c) => c === "number" || c === "number_weak" || c === "reminder_number" || c === "supplier_number")).length;

/** Suggestions for one transaction (best first). */
export function suggestFor(tx: TxLike, remaining: number, ctx: MatchContext, mode: AutoMatchMode = "safe"): Suggestion[] {
  const scored = scoreAll(tx, remaining, ctx);
  const autoable = scored.filter((s) => qualifiesForAuto(s, mode));
  const hits = numberHitCount(scored);
  return scored
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => toSuggestion(s, remaining, hits, autoable.length === 1 && autoable[0] === s));
}

/** Suggestions for open rows of a transaction list. */
export function withSuggestions<T extends TransactionRow>(db: DbOrTx, rows: T[]): (T & { suggestions: Suggestion[] })[] {
  const open = rows.filter((r) => r.status === "open" && r.remainingCents > 0);
  const ctx = open.length ? loadContext(db) : null;
  return rows.map((r) => ({
    ...r,
    suggestions: ctx && r.status === "open" && r.remainingCents > 0 ? suggestFor(r, r.remainingCents, ctx) : [],
  }));
}

/** Search open (and, for manual matching, recently paid) targets for the manual dialog. */
export function searchCandidates(
  db: DbOrTx,
  opts: { direction: "in" | "out"; q?: string; transactionId?: number },
): Suggestion[] {
  const ctx = loadContext(db);
  const tx = opts.transactionId ? getTransaction(db, opts.transactionId) : null;
  const pool: Candidate[] = opts.direction === "in" ? ctx.invoices : ctx.expenses;
  const q = opts.q?.trim().toLowerCase() ?? "";
  const matchesQuery = (c: Candidate) =>
    !q ||
    c.number.toLowerCase().includes(q) ||
    compact(c.number).includes(compact(q)) ||
    c.name.toLowerCase().includes(q) ||
    (c.kind === "expense" && c.supplierInvoiceNumber.toLowerCase().includes(q)) ||
    String(c.openCents / 100).replace(".", ",").startsWith(q.replace(/\./g, ""));
  const remaining = tx ? tx.remainingCents : 0;
  const refs = tx ? findDocumentNumbers(`${tx.purpose} ${tx.reference}`) : [];
  return pool
    .filter(matchesQuery)
    .map((c) => (tx ? scorePair(tx, remaining, c, refs, ctx.learned) : { candidate: c, score: 0, codes: [], nameSim: 0 }))
    .sort((a, b) => b.score - a.score || b.candidate.issueDate.localeCompare(a.candidate.issueDate))
    .slice(0, 50)
    .map((s) => ({ ...toSuggestion(s, remaining, 0, false), amountCents: Math.min(remaining || s.candidate.openCents, s.candidate.openCents) }));
}

// ── Applying / reverting ────────────────────────────────────────────────────────

function sumAllocated(db: DbOrTx, transactionId: number): number {
  return (
    db
      .select({ s: sql<number>`coalesce(sum(${bankMatches.amountCents}), 0)` })
      .from(bankMatches)
      .where(eq(bankMatches.transactionId, transactionId))
      .get()?.s ?? 0
  );
}

function refreshTxStatus(db: DbOrTx, transactionId: number): void {
  const tx = db.select().from(bankTransactions).where(eq(bankTransactions.id, transactionId)).get();
  if (!tx || tx.status === "ignored") return;
  const allocated = sumAllocated(db, transactionId);
  const status = allocated >= Math.abs(tx.amountCents) ? "matched" : "open";
  if (status !== tx.status) db.update(bankTransactions).set({ status }).where(eq(bankTransactions.id, transactionId)).run();
}

function settleExpense(db: DbOrTx, expenseId: number, bankDates: Set<string>): void {
  const exp = db.select().from(expenses).where(eq(expenses.id, expenseId)).get();
  if (!exp) return;
  const paid = paidCentsByExpense(db, [expenseId]).get(expenseId) ?? 0;
  const covered = paid > 0 && paid >= exp.grossCents;
  const last = lastPaymentDate(db, { expenseId });
  let paidAt = exp.paidAt;
  if (covered && (paidAt == null || bankDates.has(paidAt))) paidAt = last;
  else if (!covered && paidAt != null && bankDates.has(paidAt)) paidAt = null;
  if (paidAt !== exp.paidAt) db.update(expenses).set({ paidAt }).where(eq(expenses.id, expenseId)).run();
}

function bookingDatesOf(db: DbOrTx, target: { documentId?: number; expenseId?: number }): Set<string> {
  const rows = db
    .select({ d: bankTransactions.bookingDate })
    .from(bankMatches)
    .innerJoin(bankTransactions, eq(bankTransactions.id, bankMatches.transactionId))
    .where(target.documentId ? eq(bankMatches.documentId, target.documentId) : eq(bankMatches.expenseId, target.expenseId!))
    .all();
  return new Set(rows.map((r) => r.d));
}

/**
 * Allocate (part of) a transaction to invoices / expenses. Incoming money goes to invoices (final, sent or
 * already paid), outgoing to expenses or credit notes (refunds). The allocations may not exceed the
 * transaction's unallocated amount; a target may be overpaid.
 */
export function applyMatch(db: DbOrTx, transactionId: number, input: MatchInput, source: "auto" | "manual" = "manual"): TransactionRow {
  db.transaction((t) => {
    const tx = t.select().from(bankTransactions).where(eq(bankTransactions.id, transactionId)).get();
    if (!tx) throw new HTTPException(404, { message: "Buchung nicht gefunden" });
    if (tx.status === "ignored") throw conflict("Die Buchung ist ignoriert");
    const incoming = tx.amountCents > 0;

    // merge duplicate targets
    const merged = new Map<string, { documentId?: number; expenseId?: number; amountCents: number }>();
    for (const a of input.allocations) {
      const key = a.documentId ? `d${a.documentId}` : `e${a.expenseId}`;
      const cur = merged.get(key) ?? { documentId: a.documentId ?? undefined, expenseId: a.expenseId ?? undefined, amountCents: 0 };
      cur.amountCents += a.amountCents;
      merged.set(key, cur);
    }
    const total = [...merged.values()].reduce((s, a) => s + a.amountCents, 0);
    const free = Math.abs(tx.amountCents) - sumAllocated(t, transactionId);
    if (total > free) throw unprocessable("Die Zuordnung übersteigt den noch offenen Buchungsbetrag");

    for (const a of merged.values()) {
      if (a.documentId) {
        const doc = t.select().from(documents).where(eq(documents.id, a.documentId)).get();
        if (!doc) throw unprocessable("Beleg nicht gefunden");
        if (doc.status === "draft") throw unprocessable("Entwürfe können nicht zugeordnet werden");
        if (incoming && doc.type !== "invoice") throw unprocessable("Zahlungseingänge können nur Rechnungen zugeordnet werden");
        if (!incoming && doc.type !== "credit_note") throw unprocessable("Zahlungsausgänge können nur Ausgaben oder Gutschriften zugeordnet werden");
      } else {
        if (incoming) throw unprocessable("Zahlungseingänge können nur Rechnungen zugeordnet werden");
        if (!t.select({ id: expenses.id }).from(expenses).where(eq(expenses.id, a.expenseId!)).get()) {
          throw unprocessable("Ausgabe nicht gefunden");
        }
      }
      t.insert(bankMatches)
        .values({ transactionId, documentId: a.documentId ?? null, expenseId: a.expenseId ?? null, amountCents: a.amountCents, source })
        .run();
    }
    refreshTxStatus(t, transactionId);
    for (const a of merged.values()) {
      if (a.documentId) settleInvoice(t, a.documentId, new Set());
      else settleExpense(t, a.expenseId!, new Set());
    }
  });
  return getTransaction(db, transactionId);
}

/** Remove allocations (one match or all of a transaction) and revert payment states set by the bank. */
export function unmatch(db: DbOrTx, by: { transactionId: number } | { matchId: number }): TransactionRow {
  const transactionId = db.transaction((t) => {
    const rows = t
      .select()
      .from(bankMatches)
      .where("matchId" in by ? eq(bankMatches.id, by.matchId) : eq(bankMatches.transactionId, by.transactionId))
      .all();
    if ("matchId" in by && rows.length === 0) throw new HTTPException(404, { message: "Zuordnung nicht gefunden" });
    const txId = "matchId" in by ? rows[0]!.transactionId : by.transactionId;
    const targets = rows.map((r) => ({ documentId: r.documentId ?? undefined, expenseId: r.expenseId ?? undefined }));
    const before = targets.map((tg) => bookingDatesOf(t, tg));
    t.delete(bankMatches)
      .where(inArray(bankMatches.id, rows.map((r) => r.id)))
      .run();
    refreshTxStatus(t, txId);
    targets.forEach((tg, i) => {
      if (tg.documentId) settleInvoice(t, tg.documentId, before[i]!);
      else if (tg.expenseId) settleExpense(t, tg.expenseId, before[i]!);
    });
    return txId;
  });
  return getTransaction(db, transactionId);
}

/**
 * Remove all bank allocations of a document ("Zahlung zurücksetzen" with removeAllocations): the transactions
 * become open again. The document status is left to the caller (changeStatus "unpaid").
 */
export function removeDocumentAllocations(db: DbOrTx, documentId: number): void {
  db.transaction((t) => {
    const rows = t.select().from(bankMatches).where(eq(bankMatches.documentId, documentId)).all();
    if (rows.length === 0) return;
    t.delete(bankMatches).where(eq(bankMatches.documentId, documentId)).run();
    for (const txId of new Set(rows.map((r) => r.transactionId))) refreshTxStatus(t, txId);
  });
}

/**
 * Apply unique high-confidence matches to open transactions (all, or the given ones).
 * Returns the number of transactions matched.
 */
export function autoMatch(db: DbOrTx, opts: { mode: AutoMatchMode; transactionIds?: number[]; accountId?: number }): number {
  if (opts.mode === "off") return 0;
  if (opts.transactionIds && opts.transactionIds.length === 0) return 0;
  const txs = db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.status, "open"),
        opts.transactionIds ? inArray(bankTransactions.id, opts.transactionIds) : undefined,
        opts.accountId ? eq(bankTransactions.accountId, opts.accountId) : undefined,
        ne(bankTransactions.amountCents, 0),
      ),
    )
    .all();
  if (txs.length === 0) return 0;
  const ctx = loadContext(db);
  const proposals: { tx: BankTransaction; s: Scored; amount: number }[] = [];
  for (const tx of txs) {
    const remaining = Math.abs(tx.amountCents) - sumAllocated(db, tx.id);
    const scored = scoreAll(tx, remaining, ctx);
    const autoable = scored.filter((s) => qualifiesForAuto(s, opts.mode));
    if (autoable.length !== 1) continue;
    proposals.push({ tx, s: autoable[0]!, amount: proposedAmount(remaining, autoable[0]!, numberHitCount(scored)) });
  }
  // a target claimed by several transactions is ambiguous → leave all of them as suggestions
  const claims = new Map<string, number>();
  const key = (p: (typeof proposals)[number]) => `${p.s.candidate.kind}-${p.s.candidate.id}`;
  for (const p of proposals) claims.set(key(p), (claims.get(key(p)) ?? 0) + 1);
  let applied = 0;
  for (const p of proposals) {
    if (claims.get(key(p))! > 1) continue;
    const c = p.s.candidate;
    applyMatch(db, p.tx.id, { allocations: [c.kind === "document" ? { documentId: c.id, amountCents: p.amount } : { expenseId: c.id, amountCents: p.amount }] }, "auto");
    applied++;
  }
  return applied;
}

