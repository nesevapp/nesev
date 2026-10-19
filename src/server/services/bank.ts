import { and, asc, desc, eq, gte, inArray, isNotNull, like, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  type BankAccountInput,
  type BankTxStatus,
  bankAccountSchema,
  type CsvMapping,
  csvMappingSchema,
  normalizeIban,
  type TransactionListQuery,
} from "../../shared/bank";
import type { DbOrTx } from "../db/client";
import {
  type BankAccount,
  bankAccounts,
  bankImports,
  bankMatches,
  bankTransactions,
  type BankTransaction,
  clients,
  documents,
  expenses,
} from "../db/schema";
import { getSettings } from "./settings";

// Bank accounts, transactions and the payment helpers other features use (paidCents*).
// Import: ./bank-import.ts. Matching + applying payments: ./bank-matching.ts. Rules: src/shared/bank.ts.

const notFound = (what = "Konto") => new HTTPException(404, { message: `${what} nicht gefunden` });
const conflict = (message: string) => new HTTPException(409, { message });

// ── Payments (used by documents, reminders, forecast, dashboard) ───────────────────

/** Sum of bank allocations to a document (invoice payments). */
export function paidCentsForDocument(db: DbOrTx, documentId: number): number {
  return paidCentsByDocument(db, [documentId]).get(documentId) ?? 0;
}

/** documentId → allocated cents. Without ids: every document that has allocations. */
export function paidCentsByDocument(db: DbOrTx, documentIds?: number[]): Map<number, number> {
  if (documentIds && documentIds.length === 0) return new Map();
  const rows = db
    .select({ id: bankMatches.documentId, cents: sql<number>`sum(${bankMatches.amountCents})` })
    .from(bankMatches)
    .where(documentIds ? inArray(bankMatches.documentId, documentIds) : isNotNull(bankMatches.documentId))
    .groupBy(bankMatches.documentId)
    .all();
  return new Map(rows.map((r) => [r.id!, r.cents]));
}

/** expenseId → allocated cents. Without ids: every expense that has allocations. */
export function paidCentsByExpense(db: DbOrTx, expenseIds?: number[]): Map<number, number> {
  if (expenseIds && expenseIds.length === 0) return new Map();
  const rows = db
    .select({ id: bankMatches.expenseId, cents: sql<number>`sum(${bankMatches.amountCents})` })
    .from(bankMatches)
    .where(expenseIds ? inArray(bankMatches.expenseId, expenseIds) : isNotNull(bankMatches.expenseId))
    .groupBy(bankMatches.expenseId)
    .all();
  return new Map(rows.map((r) => [r.id!, r.cents]));
}

/** SQL expression: allocated cents of the document in the current row (for aggregate queries). */
export const paidCentsSql = sql<number>`coalesce((select sum(${bankMatches.amountCents}) from ${bankMatches} where ${bankMatches.documentId} = ${documents.id}), 0)`;

/** SQL expression: finalized credit notes for the invoice in the current row (for aggregate queries). */
export const creditedCentsSql = sql<number>`coalesce((select sum(cn.gross_cents) from ${documents} cn where cn.parent_id = ${documents.id} and cn.type = 'credit_note' and cn.status <> 'draft'), 0)`;

/** SQL expression: refunds (outgoing bank allocations) to the credit notes of the invoice in the current row. */
export const refundedCentsSql = sql<number>`coalesce((select sum(m.amount_cents) from ${bankMatches} m inner join ${documents} cn on cn.id = m.document_id where cn.parent_id = ${documents.id} and cn.type = 'credit_note'), 0)`;

/** SQL expression: open amount of the invoice in the current row (same as PaymentState.openCents). */
export const openCentsSql = sql<number>`(${documents.grossCents} - ${creditedCentsSql} - ${paidCentsSql} + ${refundedCentsSql})`;

/** Latest booking date of the transactions allocated to a target. */
export function lastPaymentDate(db: DbOrTx, target: { documentId?: number; expenseId?: number }): string | null {
  return (
    db
      .select({ d: sql<string | null>`max(${bankTransactions.bookingDate})` })
      .from(bankMatches)
      .innerJoin(bankTransactions, eq(bankTransactions.id, bankMatches.transactionId))
      .where(target.documentId ? eq(bankMatches.documentId, target.documentId) : eq(bankMatches.expenseId, target.expenseId!))
      .get()?.d ?? null
  );
}

/** invoiceId → gross and tax of its finalized credit notes. Without ids: every invoice that has some. */
export function creditTotalsByInvoice(db: DbOrTx, invoiceIds?: number[]): Map<number, { grossCents: number; taxCents: number }> {
  if (invoiceIds && invoiceIds.length === 0) return new Map();
  const conds: SQL[] = [eq(documents.type, "credit_note"), sql`${documents.status} <> 'draft'`, isNotNull(documents.parentId)];
  if (invoiceIds) conds.push(inArray(documents.parentId, invoiceIds));
  const rows = db
    .select({
      id: documents.parentId,
      grossCents: sql<number>`sum(${documents.grossCents})`,
      taxCents: sql<number>`sum(${documents.taxCents})`,
    })
    .from(documents)
    .where(and(...conds))
    .groupBy(documents.parentId)
    .all();
  return new Map(rows.map((r) => [r.id!, { grossCents: r.grossCents, taxCents: r.taxCents }]));
}

/** invoiceId → gross of its finalized credit notes (what the client no longer owes). */
export function creditedCentsByInvoice(db: DbOrTx, invoiceIds?: number[]): Map<number, number> {
  return new Map([...creditTotalsByInvoice(db, invoiceIds)].map(([id, t]) => [id, t.grossCents]));
}

/**
 * invoiceId → refunds paid out on its credit notes (outgoing bank allocations to them). A refund gives back money
 * the client paid on the invoice, so it lowers the invoice's net paid amount.
 */
export function refundedCentsByInvoice(db: DbOrTx, invoiceIds?: number[]): Map<number, number> {
  if (invoiceIds && invoiceIds.length === 0) return new Map();
  const conds: SQL[] = [eq(documents.type, "credit_note"), isNotNull(documents.parentId)];
  if (invoiceIds) conds.push(inArray(documents.parentId, invoiceIds));
  const rows = db
    .select({ id: documents.parentId, cents: sql<number>`sum(${bankMatches.amountCents})` })
    .from(bankMatches)
    .innerJoin(documents, eq(documents.id, bankMatches.documentId))
    .where(and(...conds))
    .groupBy(documents.parentId)
    .all();
  return new Map(rows.map((r) => [r.id!, r.cents]));
}

export interface PaymentRow {
  matchId: number;
  transactionId: number;
  accountId: number;
  accountName: string;
  bookingDate: string;
  /** positive = payment on the invoice, negative = refund on one of its credit notes */
  amountCents: number;
  counterpartyName: string;
  purpose: string;
  source: string;
  kind: "payment" | "refund";
}

export interface PaymentState {
  /** what is owed before payments (gross − credited) */
  dueCents: number;
  /** bank payments on the invoice minus refunds on its credit notes */
  paidCents: number;
  /** dueCents − paidCents; negative = overpaid */
  openCents: number;
  /** 0 < paid < due */
  partial: boolean;
}

export interface PaymentsInfo extends PaymentState {
  grossCents: number;
  creditedCents: number;
  payments: PaymentRow[];
}

function paymentState(grossCents: number, creditedCents: number, paidCents: number): PaymentState {
  const dueCents = grossCents - creditedCents;
  return { dueCents, paidCents, openCents: dueCents - paidCents, partial: paidCents > 0 && paidCents < dueCents };
}

/**
 * Payment state per invoice (lists, dashboard, reminders, forecast, matching): invoiceId → due/paid/open/partial.
 * The one place that defines an invoice's open amount: gross − finalized credit notes − (bank payments − refunds
 * on its credit notes).
 */
export function invoicePaymentStates(db: DbOrTx, invoices: { id: number; grossCents: number }[]): Map<number, PaymentState> {
  const ids = invoices.map((d) => d.id);
  const credited = creditedCentsByInvoice(db, ids);
  const paid = paidCentsByDocument(db, ids);
  const refunded = refundedCentsByInvoice(db, ids);
  return new Map(
    invoices.map((d) => [d.id, paymentState(d.grossCents, credited.get(d.id) ?? 0, (paid.get(d.id) ?? 0) - (refunded.get(d.id) ?? 0))]),
  );
}

/** Payment state of one invoice (see invoicePaymentStates). */
export function invoicePaymentState(db: DbOrTx, invoice: { id: number; grossCents: number }): PaymentState {
  return invoicePaymentStates(db, [invoice]).get(invoice.id)!;
}

function paymentRows(db: DbOrTx, where: SQL, kind: PaymentRow["kind"] = "payment"): PaymentRow[] {
  const sign = kind === "refund" ? -1 : 1;
  return db
    .select({
      matchId: bankMatches.id,
      transactionId: bankTransactions.id,
      accountId: bankAccounts.id,
      accountName: bankAccounts.name,
      bookingDate: bankTransactions.bookingDate,
      amountCents: bankMatches.amountCents,
      counterpartyName: bankTransactions.counterpartyName,
      purpose: bankTransactions.purpose,
      source: bankMatches.source,
    })
    .from(bankMatches)
    .innerJoin(bankTransactions, eq(bankTransactions.id, bankMatches.transactionId))
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.accountId))
    .where(where)
    .orderBy(asc(bankTransactions.bookingDate), asc(bankMatches.id))
    .all()
    .map((r) => ({ ...r, amountCents: sign * r.amountCents, kind }));
}

function paymentsInfo(grossCents: number, creditedCents: number, payments: PaymentRow[]): PaymentsInfo {
  const paidCents = payments.reduce((s, p) => s + p.amountCents, 0);
  return { grossCents, creditedCents, ...paymentState(grossCents, creditedCents, paidCents), payments };
}

/** Payments of an invoice (document view: "Zahlungen", "teilbezahlt X von Y"), refunds on its credit notes negative. */
export function documentPayments(db: DbOrTx, documentId: number): PaymentsInfo {
  const doc = db.select({ grossCents: documents.grossCents, type: documents.type }).from(documents).where(eq(documents.id, documentId)).get();
  if (!doc) throw notFound("Beleg");
  if (doc.type !== "invoice") return paymentsInfo(doc.grossCents, 0, paymentRows(db, eq(bankMatches.documentId, documentId)));
  const credited = creditedCentsByInvoice(db, [documentId]).get(documentId) ?? 0;
  const creditNoteIds = db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.parentId, documentId), eq(documents.type, "credit_note")))
    .all()
    .map((c) => c.id);
  const rows = [
    ...paymentRows(db, eq(bankMatches.documentId, documentId)),
    ...(creditNoteIds.length ? paymentRows(db, inArray(bankMatches.documentId, creditNoteIds), "refund") : []),
  ].sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.matchId - b.matchId);
  return paymentsInfo(doc.grossCents, credited, rows);
}

export function expensePayments(db: DbOrTx, expenseId: number): PaymentsInfo {
  const exp = db.select({ grossCents: expenses.grossCents }).from(expenses).where(eq(expenses.id, expenseId)).get();
  if (!exp) throw notFound("Ausgabe");
  return paymentsInfo(exp.grossCents, 0, paymentRows(db, eq(bankMatches.expenseId, expenseId)));
}

// ── Accounts ────────────────────────────────────────────────────────────────────

export type BankAccountRow = Omit<BankAccount, "csvMapping"> & {
  hasCsvMapping: boolean;
  transactionCount: number;
  openCount: number;
  /** sum of all imported amounts */
  totalCents: number;
  lastBookingDate: string | null;
};

export function listAccounts(db: DbOrTx): BankAccountRow[] {
  const stats = db
    .select({
      accountId: bankTransactions.accountId,
      count: sql<number>`count(*)`,
      open: sql<number>`sum(case when ${bankTransactions.status} = 'open' then 1 else 0 end)`,
      total: sql<number>`coalesce(sum(${bankTransactions.amountCents}), 0)`,
      last: sql<string | null>`max(${bankTransactions.bookingDate})`,
    })
    .from(bankTransactions)
    .groupBy(bankTransactions.accountId)
    .all();
  const byId = new Map(stats.map((s) => [s.accountId, s]));
  return db
    .select()
    .from(bankAccounts)
    .orderBy(sql`${bankAccounts.archivedAt} is not null`, asc(bankAccounts.name), asc(bankAccounts.id))
    .all()
    .map(({ csvMapping, ...a }) => {
      const s = byId.get(a.id);
      return {
        ...a,
        hasCsvMapping: csvMapping != null,
        transactionCount: s?.count ?? 0,
        openCount: s?.open ?? 0,
        totalCents: s?.total ?? 0,
        lastBookingDate: s?.last ?? null,
      };
    });
}

export function requireAccount(db: DbOrTx, id: number): BankAccount {
  const row = db.select().from(bankAccounts).where(eq(bankAccounts.id, id)).get();
  if (!row) throw notFound();
  return row;
}

/** Prefill for the first account: company IBAN/bank from the settings. */
export function accountSuggestion(db: DbOrTx): { name: string; iban: string; bankName: string } {
  const s = getSettings(db);
  return { name: s.bankName || "Geschäftskonto", iban: normalizeIban(s.iban), bankName: s.bankName };
}

export function createAccount(db: DbOrTx, input: BankAccountInput): BankAccount {
  const data = bankAccountSchema.parse(input);
  return db.insert(bankAccounts).values(data).returning().get();
}

export function updateAccount(db: DbOrTx, id: number, input: BankAccountInput): BankAccount {
  requireAccount(db, id);
  const data = bankAccountSchema.parse(input);
  return db.update(bankAccounts).set(data).where(eq(bankAccounts.id, id)).returning().get();
}

export function setAccountArchived(db: DbOrTx, id: number, archived: boolean): BankAccount {
  requireAccount(db, id);
  return db
    .update(bankAccounts)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(eq(bankAccounts.id, id))
    .returning()
    .get();
}

/** Deletes the account with its transactions. Refused while payments are allocated (unmatch or archive instead). */
export function deleteAccount(db: DbOrTx, id: number): void {
  requireAccount(db, id);
  const matched = db
    .select({ n: sql<number>`count(*)` })
    .from(bankMatches)
    .innerJoin(bankTransactions, eq(bankTransactions.id, bankMatches.transactionId))
    .where(eq(bankTransactions.accountId, id))
    .get()!.n;
  if (matched > 0) throw conflict("Das Konto hat zugeordnete Zahlungen. Bitte archivieren oder Zuordnungen zuerst lösen.");
  db.delete(bankAccounts).where(eq(bankAccounts.id, id)).run();
}

export function savedCsvMapping(account: BankAccount): CsvMapping | null {
  const parsed = csvMappingSchema.safeParse(account.csvMapping);
  return parsed.success ? parsed.data : null;
}

// ── Transactions ────────────────────────────────────────────────────────────────

export interface MatchRef {
  id: number;
  amountCents: number;
  source: string;
  documentId: number | null;
  documentType: string | null;
  documentNumber: string | null;
  documentStatus: string | null;
  clientName: string | null;
  expenseId: number | null;
  expenseNumber: string | null;
  supplierName: string | null;
}

export type TransactionRow = BankTransaction & {
  status: BankTxStatus;
  accountName: string;
  allocatedCents: number;
  /** |amount| − allocated */
  remainingCents: number;
  matches: MatchRef[];
};

/** Match references for the given transactions (txId → refs). */
export function matchRefs(db: DbOrTx, transactionIds: number[]): Map<number, MatchRef[]> {
  const out = new Map<number, MatchRef[]>();
  if (transactionIds.length === 0) return out;
  const rows = db
    .select({
      transactionId: bankMatches.transactionId,
      id: bankMatches.id,
      amountCents: bankMatches.amountCents,
      source: bankMatches.source,
      documentId: bankMatches.documentId,
      documentType: documents.type,
      documentNumber: documents.number,
      documentStatus: documents.status,
      clientName: sql<string | null>`coalesce(json_extract(${documents.clientSnapshot}, '$.name'), ${clients.name})`,
      expenseId: bankMatches.expenseId,
      expenseNumber: expenses.number,
      supplierName: expenses.supplierName,
    })
    .from(bankMatches)
    .leftJoin(documents, eq(documents.id, bankMatches.documentId))
    .leftJoin(clients, eq(clients.id, documents.clientId))
    .leftJoin(expenses, eq(expenses.id, bankMatches.expenseId))
    .where(inArray(bankMatches.transactionId, transactionIds))
    .orderBy(asc(bankMatches.id))
    .all();
  for (const { transactionId, ...ref } of rows) {
    const list = out.get(transactionId) ?? [];
    list.push(ref);
    out.set(transactionId, list);
  }
  return out;
}

function toRows(db: DbOrTx, txs: (BankTransaction & { accountName: string })[]): TransactionRow[] {
  const refs = matchRefs(db, txs.map((t) => t.id));
  return txs.map((t) => {
    const matches = refs.get(t.id) ?? [];
    const allocatedCents = matches.reduce((s, m) => s + m.amountCents, 0);
    return {
      ...t,
      status: t.status as BankTxStatus,
      allocatedCents,
      remainingCents: Math.abs(t.amountCents) - allocatedCents,
      matches,
    };
  });
}

function listConditions(q: TransactionListQuery): SQL[] {
  const where: SQL[] = [];
  if (q.accountId) where.push(eq(bankTransactions.accountId, q.accountId));
  if (q.status) where.push(eq(bankTransactions.status, q.status));
  if (q.direction === "in") where.push(sql`${bankTransactions.amountCents} > 0`);
  if (q.direction === "out") where.push(lt(bankTransactions.amountCents, 0));
  if (q.from) where.push(gte(bankTransactions.bookingDate, q.from));
  if (q.to) where.push(lte(bankTransactions.bookingDate, q.to));
  const text = q.q?.trim();
  if (text) {
    const pattern = `%${text.replace(/[%_]/g, "")}%`;
    const conds = [
      like(bankTransactions.counterpartyName, pattern),
      like(bankTransactions.purpose, pattern),
      like(bankTransactions.counterpartyIban, pattern.replace(/\s/g, "")),
      like(bankTransactions.reference, pattern),
    ];
    // "120", "-34,90", "1.250,00": also search the amount
    const cents = Math.round(Number(text.replace(/\./g, "").replace(",", ".")) * 100);
    if (/^-?[\d.,]+$/.test(text) && Number.isFinite(cents)) {
      conds.push(sql`abs(${bankTransactions.amountCents}) = ${Math.abs(cents)}`);
    }
    // matched document/expense number
    conds.push(
      sql`exists (select 1 from ${bankMatches} m left join ${documents} d on d.id = m.document_id left join ${expenses} e on e.id = m.expense_id where m.transaction_id = ${bankTransactions.id} and (d.number like ${pattern} or e.number like ${pattern} or e.supplier_name like ${pattern}))`,
    );
    where.push(or(...conds)!);
  }
  return where;
}

export function listTransactions(db: DbOrTx, q: TransactionListQuery = {}): TransactionRow[] {
  const txs = db
    .select({ tx: bankTransactions, accountName: bankAccounts.name })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.accountId))
    .where(and(...listConditions(q)))
    .orderBy(desc(bankTransactions.bookingDate), desc(bankTransactions.id))
    .all()
    .map((r) => ({ ...r.tx, accountName: r.accountName }));
  return toRows(db, txs);
}

export function getTransaction(db: DbOrTx, id: number): TransactionRow {
  const row = db
    .select({ tx: bankTransactions, accountName: bankAccounts.name })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.accountId))
    .where(eq(bankTransactions.id, id))
    .get();
  if (!row) throw notFound("Buchung");
  return toRows(db, [{ ...row.tx, accountName: row.accountName }])[0]!;
}

export interface BankSummary {
  count: number;
  inCents: number;
  outCents: number;
  /** Kontostand-Differenz in the period (in + out) */
  netCents: number;
  openCount: number;
  openInCount: number;
  openOutCount: number;
  matchedCount: number;
  ignoredCount: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** Totals for the account/period (status, direction and search filters are ignored). */
export function transactionSummary(db: DbOrTx, q: Pick<TransactionListQuery, "accountId" | "from" | "to"> = {}): BankSummary {
  const r = db
    .select({
      count: sql<number>`count(*)`,
      inCents: sql<number>`coalesce(sum(case when ${bankTransactions.amountCents} > 0 then ${bankTransactions.amountCents} else 0 end), 0)`,
      outCents: sql<number>`coalesce(sum(case when ${bankTransactions.amountCents} < 0 then ${bankTransactions.amountCents} else 0 end), 0)`,
      openCount: sql<number>`coalesce(sum(case when ${bankTransactions.status} = 'open' then 1 else 0 end), 0)`,
      openInCount: sql<number>`coalesce(sum(case when ${bankTransactions.status} = 'open' and ${bankTransactions.amountCents} > 0 then 1 else 0 end), 0)`,
      openOutCount: sql<number>`coalesce(sum(case when ${bankTransactions.status} = 'open' and ${bankTransactions.amountCents} < 0 then 1 else 0 end), 0)`,
      matchedCount: sql<number>`coalesce(sum(case when ${bankTransactions.status} = 'matched' then 1 else 0 end), 0)`,
      ignoredCount: sql<number>`coalesce(sum(case when ${bankTransactions.status} = 'ignored' then 1 else 0 end), 0)`,
      firstDate: sql<string | null>`min(${bankTransactions.bookingDate})`,
      lastDate: sql<string | null>`max(${bankTransactions.bookingDate})`,
    })
    .from(bankTransactions)
    .where(and(...listConditions({ accountId: q.accountId, from: q.from, to: q.to })))
    .get()!;
  return { ...r, netCents: r.inCents + r.outCents };
}

/** "Ignorieren" (private / irrelevant). Only for transactions without allocations. */
export function setIgnored(db: DbOrTx, id: number, ignored: boolean): TransactionRow {
  const tx = getTransaction(db, id);
  if (ignored && tx.matches.length > 0) throw conflict("Die Buchung ist zugeordnet. Bitte zuerst die Zuordnung lösen.");
  if (!ignored && tx.status !== "ignored") return tx;
  db.update(bankTransactions)
    .set({ status: ignored ? "ignored" : "open" })
    .where(eq(bankTransactions.id, id))
    .run();
  return getTransaction(db, id);
}

// ── Imports list ────────────────────────────────────────────────────────────────

export function listImports(db: DbOrTx, accountId?: number) {
  const stats = db
    .select({
      importId: bankTransactions.importId,
      remaining: sql<number>`count(*)`,
      matched: sql<number>`sum(case when ${bankTransactions.status} = 'matched' or exists (select 1 from ${bankMatches} m where m.transaction_id = ${bankTransactions.id}) then 1 else 0 end)`,
      first: sql<string | null>`min(${bankTransactions.bookingDate})`,
      last: sql<string | null>`max(${bankTransactions.bookingDate})`,
    })
    .from(bankTransactions)
    .where(isNotNull(bankTransactions.importId))
    .groupBy(bankTransactions.importId)
    .all();
  const byId = new Map(stats.map((s) => [s.importId, s]));
  return db
    .select()
    .from(bankImports)
    .where(accountId ? eq(bankImports.accountId, accountId) : undefined)
    .orderBy(desc(bankImports.createdAt), desc(bankImports.id))
    .all()
    .map((imp) => {
      const s = byId.get(imp.id);
      return {
        ...imp,
        remainingCount: s?.remaining ?? 0,
        matchedCount: s?.matched ?? 0,
        firstDate: s?.first ?? null,
        lastDate: s?.last ?? null,
      };
    });
}
