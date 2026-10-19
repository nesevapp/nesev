import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { addDays, todayIso } from "../../shared/dates";
import { deductibleTaxCents, type VatTreatment } from "../../shared/expenses";
import { addMonthsAnchored, runDatesUntil } from "../../shared/recurring";
import { paymentDatesBetween, slotLabel } from "../../shared/recurring-expenses";
import type { ForecastSettings } from "../../shared/schemas/recurring-expense";
import { nextWorkingDay, parsePeriod, periodKeyFor, periodKind, shiftPeriod, uvaDueDate } from "../../shared/tax-report";
import type { DbOrTx } from "../db/client";
import {
  clients,
  documents,
  expenseLines,
  expenses,
  recurringExpensePayments,
  recurringExpenses,
  recurringInvoices,
  settings,
} from "../db/schema";
import { creditedCentsByInvoice, creditTotalsByInvoice, invoicePaymentStates, paidCentsByExpense } from "./bank";
import { linkedSlotKeys } from "./recurring-expenses";
import { getSettings, updateSettings } from "./settings";
import { computeUva } from "./tax";

// Payment forecast (GET /api/forecast): expected incoming and outgoing money (gross) per week / month, plus a
// projected account balance.
// Inflow sources:
// - open invoices (final/sent): expected = dueDate + the client's average payment delay. Overdue ones
//   (dueDate < today) land in the "overdue" bucket at today. Non-draft credit notes and partial bank
//   payments on an invoice reduce it.
// - recurring invoices: every future run within the horizon (active, respecting endDate); expected =
//   run date + payment terms + client delay. Drafts generated from a recurring invoice count here too.
// - optional: other invoice drafts; open offers (final/sent, not expired) weighted by a probability,
//   assumed to be invoiced today if accepted.
// Payment delay = average of (paidAt − dueDate) in days over the client's paid invoices; fallback: the
// average over all clients, else 0. Expected dates never lie before today.
//
// Outflow sources (unless includeOutflows is off):
// - Fixkosten (recurringExpenses): every active payment date in the horizon, respecting endDate, except slots
//   linked to a booked expense (recurringExpensePayments): that expense counts instead (unpaid → outflow below,
//   paid → already gone), so a payment is never counted twice.
// - unpaid expenses (paidAt null, with lines): open = gross − bank allocations, expected on the due date; without
//   one at issue date + 14 days (UNPAID_EXPENSE_TERMS_DAYS). Overdue → today, in the overdue bucket.
// - VAT (UVA Zahllast, not for Kleinunternehmer): every UVA period whose due date (15th of the 2nd month after it,
//   uvaDueDate) lies in [today, horizonEnd]. Amount = computeUva() for what is already recorded in the period
//   (ended periods: the real figure) + an estimate for what the forecast still expects in it: output VAT of the
//   expected inflows minus the deductible input VAT of Fixkosten / unpaid expenses. Which date puts an entry's VAT
//   into a period follows the basis (vatPeriodDate below). A negative result is a refund (inflow). Periods with an
//   estimated part are flagged `estimated`. Assumes nothing has been paid before the due date.
// - income tax prepayment: settings.incomeTaxPrepaymentCents on 15.2./15.5./15.8./15.11. (next working day).
//
// Balance: with settings.cashBalanceCents/cashBalanceDate, balance = start + inflows − outflows of every entry
// expected on or after cashBalanceDate (earlier ones are assumed to be in the balance already). Overdue entries
// count at today. Buckets carry the balance at their end and their lowest day-end balance.

export const FORECAST_SOURCES = ["invoice", "recurring", "offer", "draft", "fixed_cost", "expense", "vat", "income_tax"] as const;
export type ForecastSource = (typeof FORECAST_SOURCES)[number];
export type ForecastDirection = "in" | "out";

/** Due date assumed for unpaid expenses without one: issue date + 14 days. */
export const UNPAID_EXPENSE_TERMS_DAYS = 14;

export interface ForecastOptions {
  months: number;
  includeDrafts: boolean;
  includeOffers: boolean;
  /** 0..100, applied to open offers */
  offerProbability: number;
  /** Fixkosten, unpaid expenses, VAT and income tax; default true */
  includeOutflows?: boolean;
  today?: string;
}

export interface PaymentDelay {
  days: number;
  basis: "client" | "global" | "none";
  /** paid invoices the average is based on */
  samples: number;
}

export interface ForecastEntry {
  key: string;
  source: ForecastSource;
  direction: ForecastDirection;
  overdue: boolean;
  expectedDate: string;
  /** due date the expectation is based on (projected for recurring runs / offers) */
  dueDate: string;
  issueDate: string;
  clientId: number | null;
  /** client (inflows), supplier (expenses, Fixkosten) or "Finanzamt" */
  partyName: string;
  documentId: number | null;
  documentType: "invoice" | "offer" | null;
  number: string | null;
  recurringInvoiceId: number | null;
  expenseId: number | null;
  recurringExpenseId: number | null;
  label: string;
  /** expected amount, always positive (weighted for offers); `direction` gives the sign */
  grossCents: number;
  /** VAT part of grossCents: output VAT for inflows, deductible input VAT for outflows */
  taxCents: number;
  /** unweighted amount (differs from grossCents only for offers / credited or partly paid items) */
  fullGrossCents: number;
  probability: number;
  /** client payment delay (inflows only) */
  delay: PaymentDelay | null;
  daysOverdue: number;
  /** VAT entries: the amount contains an estimate for a period that is not over yet */
  estimated: boolean;
  /** VAT entries: UVA period key ("2026-Q3", "2026-10") */
  vatPeriod: string | null;
}

export type SourceCents = Record<ForecastSource, number>;

export interface BucketSums {
  /** cents per source by direction (VAT can be a payment or a refund) */
  inBySource: SourceCents;
  outBySource: SourceCents;
  inCents: number;
  outCents: number;
  /** inCents − outCents */
  netCents: number;
  /** output VAT contained in inCents */
  taxCents: number;
}

export interface ForecastBucket extends BucketSums {
  key: string;
  start: string;
  end: string;
  /** running net including the overdue bucket */
  cumulativeCents: number;
  /** projected balance at the end of the bucket; null without a start balance */
  balanceCents: number | null;
  /** lowest day-end balance within the bucket; null without a start balance */
  minBalanceCents: number | null;
}

export interface ForecastData {
  today: string;
  horizonEnd: string;
  months: number;
  options: Required<Omit<ForecastOptions, "today">>;
  globalDelay: PaymentDelay;
  /** start balance from the settings; null = not set */
  balance: { startCents: number; date: string } | null;
  /** the VAT rows are skipped (Kleinunternehmer) */
  smallBusiness: boolean;
  kpis: {
    /** inflows */
    next30: number;
    next90: number;
    total: number;
    overdue: number;
    overdueCount: number;
    recurring: number;
    tax: number;
    count: number;
    /** outflows */
    outNext30: number;
    outTotal: number;
    outOverdue: number;
    fixedCosts: number;
    netTotal: number;
    /** balance (null without a start balance) */
    endBalance: number | null;
    lowestBalance: { cents: number; date: string } | null;
  };
  overdueBucket: BucketSums;
  monthly: ForecastBucket[];
  weekly: ForecastBucket[];
  entries: ForecastEntry[];
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000);
}

const emptySources = (): SourceCents => ({
  invoice: 0,
  recurring: 0,
  offer: 0,
  draft: 0,
  fixed_cost: 0,
  expense: 0,
  vat: 0,
  income_tax: 0,
});

const signed = (e: ForecastEntry) => (e.direction === "in" ? e.grossCents : -e.grossCents);

/** Average payment delay per client (paidAt − dueDate over paid invoices) plus the global fallback. */
export function paymentDelays(db: DbOrTx): { byClient: Map<number, PaymentDelay>; global: PaymentDelay } {
  const rows = db
    .select({ id: documents.id, grossCents: documents.grossCents, clientId: documents.clientId, dueDate: documents.dueDate, paidAt: documents.paidAt })
    .from(documents)
    .where(
      and(
        eq(documents.type, "invoice"),
        eq(documents.status, "paid"),
        isNotNull(documents.paidAt),
        isNotNull(documents.dueDate),
      ),
    )
    .all();
  // settled by credit note alone: nothing was paid, so it says nothing about the client's payment habits
  const credited = creditedCentsByInvoice(db, rows.map((r) => r.id));
  const paid = rows.filter((r) => (credited.get(r.id) ?? 0) < r.grossCents);
  const sums = new Map<number, { sum: number; n: number }>();
  let sum = 0;
  for (const p of paid) {
    const d = daysBetween(p.dueDate!, p.paidAt!.slice(0, 10));
    sum += d;
    const s = sums.get(p.clientId) ?? { sum: 0, n: 0 };
    s.sum += d;
    s.n += 1;
    sums.set(p.clientId, s);
  }
  const byClient = new Map<number, PaymentDelay>();
  for (const [clientId, s] of sums) byClient.set(clientId, { days: Math.round(s.sum / s.n), basis: "client", samples: s.n });
  const global: PaymentDelay = paid.length
    ? { days: Math.round(sum / paid.length), basis: "global", samples: paid.length }
    : { days: 0, basis: "none", samples: 0 };
  return { byClient, global };
}

/** Monday of the week containing `iso`. */
function weekStart(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = (new Date(y!, m! - 1, d!).getDay() + 6) % 7;
  return addDays(iso, -dow);
}

function sumUp(entries: ForecastEntry[]): BucketSums {
  const sums: BucketSums = { inBySource: emptySources(), outBySource: emptySources(), inCents: 0, outCents: 0, netCents: 0, taxCents: 0 };
  for (const e of entries) {
    if (e.direction === "in") {
      sums.inBySource[e.source] += e.grossCents;
      sums.inCents += e.grossCents;
      sums.taxCents += e.taxCents;
    } else {
      sums.outBySource[e.source] += e.grossCents;
      sums.outCents += e.grossCents;
    }
  }
  sums.netCents = sums.inCents - sums.outCents;
  return sums;
}

/** Day-end balances (sorted by date) from the start balance; entries before its date are ignored. */
export function balanceSeries(entries: ForecastEntry[], start: { startCents: number; date: string }): { date: string; cents: number }[] {
  const byDate = new Map<string, number>();
  for (const e of entries) {
    if (e.expectedDate < start.date) continue;
    byDate.set(e.expectedDate, (byDate.get(e.expectedDate) ?? 0) + signed(e));
  }
  let cents = start.startCents;
  return [...byDate.keys()].sort().map((date) => ({ date, cents: (cents += byDate.get(date)!) }));
}

function buildBuckets(
  entries: ForecastEntry[],
  periods: { key: string; start: string; end: string }[],
  overdueNet: number,
  series: { date: string; cents: number }[] | null,
  startCents: number,
): ForecastBucket[] {
  let running = overdueNet;
  let si = 0;
  let balance = startCents;
  return periods.map((p) => {
    const sums = sumUp(entries.filter((e) => !e.overdue && e.expectedDate >= p.start && e.expectedDate <= p.end));
    running += sums.netCents;
    let balanceCents: number | null = null;
    let minBalanceCents: number | null = null;
    if (series) {
      // overdue entries sit at today, i.e. inside the first bucket's range
      minBalanceCents = balance;
      for (; si < series.length && series[si]!.date <= p.end; si++) {
        balance = series[si]!.cents;
        minBalanceCents = Math.min(minBalanceCents, balance);
      }
      balanceCents = balance;
    }
    return { ...p, ...sums, cumulativeCents: running, balanceCents, minBalanceCents };
  });
}

type EntryInput = Partial<ForecastEntry> &
  Pick<ForecastEntry, "key" | "source" | "expectedDate" | "dueDate" | "issueDate" | "partyName" | "label" | "grossCents" | "taxCents" | "fullGrossCents">;

const ENTRY_DEFAULTS = {
  direction: "in",
  clientId: null,
  documentId: null,
  documentType: null,
  number: null,
  recurringInvoiceId: null,
  expenseId: null,
  recurringExpenseId: null,
  probability: 100,
  delay: null,
  estimated: false,
  vatPeriod: null,
} satisfies Partial<ForecastEntry>;

/**
 * Date on which an entry's VAT lands in a UVA period if computeUva() does not know it yet; null = already
 * recorded (or no VAT effect). Cash basis: payment date. Accrual basis: invoice date — finalized invoices and
 * existing expenses are recorded already; projected runs, drafts and offers (assumed invoiced today) are not.
 * Fixkosten count at the payment date under both bases.
 */
export function vatPeriodDate(e: ForecastEntry, basis: "accrual" | "cash", today: string): string | null {
  if (e.taxCents === 0) return null;
  if (basis === "cash" || e.source === "fixed_cost") return e.expectedDate;
  switch (e.source) {
    case "recurring":
    case "draft":
      return e.issueDate < today ? today : e.issueDate;
    case "offer":
      return today;
    default:
      return null;
  }
}

export function buildForecast(db: DbOrTx, opts: ForecastOptions): ForecastData {
  const today = opts.today ?? todayIso();
  const months = opts.months;
  // horizon = rest of the current month + `months` − 1 full months (3 → Oct, Nov, Dec)
  const horizonEnd = addDays(addMonthsAnchored(`${today.slice(0, 7)}-01`, months), -1);
  const probability = Math.min(100, Math.max(0, opts.offerProbability));
  const includeOutflows = opts.includeOutflows ?? true;
  const s = getSettings(db);
  const defaultTerms = s.paymentTermsDays;
  const clientRows = db
    .select({ id: clients.id, name: clients.name, paymentTermsDays: clients.paymentTermsDays })
    .from(clients)
    .all();
  const clientById = new Map(clientRows.map((c) => [c.id, c]));
  const { byClient, global } = paymentDelays(db);
  const delayFor = (clientId: number): PaymentDelay => byClient.get(clientId) ?? global;
  const termsFor = (clientId: number) => clientById.get(clientId)?.paymentTermsDays ?? defaultTerms;
  const notBefore = (d: string) => (d < today ? today : d);

  const entries: ForecastEntry[] = [];
  const push = (e: EntryInput) => {
    if (e.grossCents <= 0) return;
    const overdue = e.overdue ?? false;
    if (!overdue && e.expectedDate > horizonEnd) return;
    entries.push({ ...ENTRY_DEFAULTS, ...e, overdue, daysOverdue: overdue ? daysBetween(e.dueDate, today) : 0 });
  };

  // a) open invoices (+ drafts when enabled)
  const docStatuses = opts.includeDrafts ? ["final", "sent", "draft"] : ["final", "sent"];
  const invoices = db
    .select()
    .from(documents)
    .where(and(eq(documents.type, "invoice"), inArray(documents.status, docStatuses as ("final" | "sent" | "draft")[])))
    .all();
  // recurring drafts always count (they're the scheduled money, awaiting review)
  const recurringDrafts = opts.includeDrafts
    ? []
    : db
        .select()
        .from(documents)
        .where(and(eq(documents.type, "invoice"), eq(documents.status, "draft"), isNotNull(documents.recurringInvoiceId)))
        .all();
  const all = [...invoices, ...recurringDrafts];
  const states = invoicePaymentStates(db, all);
  const creditTax = creditTotalsByInvoice(db, all.map((d) => d.id));

  for (const doc of all) {
    const isDraft = doc.status === "draft";
    const source: ForecastSource = isDraft ? (doc.recurringInvoiceId ? "recurring" : "draft") : "invoice";
    // credit notes and partial bank payments (net of refunds) reduce what is still expected (VAT part pro rata)
    const state = states.get(doc.id)!;
    const owed = state.dueCents;
    const paid = Math.min(Math.max(state.paidCents, 0), Math.max(owed, 0));
    const owedTax = doc.taxCents - (creditTax.get(doc.id)?.taxCents ?? 0);
    const openTax = owed > 0 ? Math.round((owedTax * (owed - paid)) / owed) : owedTax;
    const delay = delayFor(doc.clientId);
    const dueDate = doc.dueDate ?? addDays(doc.issueDate, termsFor(doc.clientId));
    const overdue = !isDraft && dueDate < today;
    push({
      key: `doc-${doc.id}`,
      source,
      overdue,
      expectedDate: overdue ? today : notBefore(addDays(dueDate, delay.days)),
      dueDate,
      issueDate: doc.issueDate,
      clientId: doc.clientId,
      partyName: doc.clientSnapshot?.name ?? clientById.get(doc.clientId)?.name ?? "",
      documentId: doc.id,
      documentType: "invoice",
      number: doc.number,
      recurringInvoiceId: doc.recurringInvoiceId,
      label: doc.title,
      grossCents: owed - paid,
      taxCents: openTax,
      fullGrossCents: doc.grossCents,
      probability: 100,
      delay,
    });
  }

  // b) projected runs of active recurring invoices
  const recurring = db.select().from(recurringInvoices).where(eq(recurringInvoices.active, true)).all();
  for (const r of recurring) {
    const delay = delayFor(r.clientId);
    const terms = termsFor(r.clientId);
    // runs paid after the horizon are dropped by push()
    for (const runDate of runDatesUntil(r, r.nextRunDate, horizonEnd)) {
      const dueDate = addDays(runDate, terms);
      push({
        key: `rec-${r.id}-${runDate}`,
        source: "recurring",
        expectedDate: notBefore(addDays(dueDate, delay.days)),
        dueDate,
        issueDate: runDate,
        clientId: r.clientId,
        partyName: clientById.get(r.clientId)?.name ?? "",
        documentId: null,
        documentType: null,
        number: null,
        recurringInvoiceId: r.id,
        label: r.name,
        grossCents: r.grossCents,
        taxCents: r.grossCents - r.netCents,
        fullGrossCents: r.grossCents,
        probability: 100,
        delay,
      });
    }
  }

  // c) open offers, weighted
  if (opts.includeOffers && probability > 0) {
    const offers = db
      .select()
      .from(documents)
      .where(and(eq(documents.type, "offer"), inArray(documents.status, ["final", "sent"])))
      .all()
      .filter((o) => !o.validUntil || o.validUntil >= today);
    for (const o of offers) {
      const delay = delayFor(o.clientId);
      const dueDate = addDays(today, termsFor(o.clientId));
      push({
        key: `offer-${o.id}`,
        source: "offer",
        expectedDate: notBefore(addDays(dueDate, delay.days)),
        dueDate,
        issueDate: o.issueDate,
        clientId: o.clientId,
        partyName: o.clientSnapshot?.name ?? clientById.get(o.clientId)?.name ?? "",
        documentId: o.id,
        documentType: "offer",
        number: o.number,
        recurringInvoiceId: null,
        label: o.title,
        grossCents: Math.round((o.grossCents * probability) / 100),
        taxCents: Math.round((o.taxCents * probability) / 100),
        fullGrossCents: o.grossCents,
        probability,
        delay,
      });
    }
  }

  if (includeOutflows) {
    pushFixedCosts(db, today, horizonEnd, push);
    pushUnpaidExpenses(db, today, push);
    const prepayment = s.incomeTaxPrepaymentCents;
    if (prepayment > 0) {
      for (let y = Number(today.slice(0, 4)); y <= Number(horizonEnd.slice(0, 4)); y++) {
        for (const [m, q] of [["02", 1], ["05", 2], ["08", 3], ["11", 4]] as const) {
          const due = nextWorkingDay(`${y}-${m}-15`);
          if (due < today) continue;
          push({
            key: `est-${y}-${q}`,
            source: "income_tax",
            direction: "out",
            expectedDate: due,
            dueDate: due,
            issueDate: due,
            partyName: "Finanzamt",
            label: `ESt-Vorauszahlung ${q}. Quartal ${y}`,
            grossCents: prepayment,
            taxCents: 0,
            fullGrossCents: prepayment,
          });
        }
      }
    }
    // VAT last: its estimate is built from the entries above
    if (!s.smallBusiness) {
      for (const v of vatEntries(db, entries, s.vatPeriod, s.vatBasis, today, horizonEnd)) push(v);
    }
  }

  entries.sort(
    (a, b) => a.expectedDate.localeCompare(b.expectedDate) || a.direction.localeCompare(b.direction) || b.grossCents - a.grossCents,
  );

  // buckets
  const overdueBucket = sumUp(entries.filter((e) => e.overdue));
  const monthPeriods = Array.from({ length: months }, (_, i) => {
    const start = addMonthsAnchored(`${today.slice(0, 7)}-01`, i);
    return { key: start.slice(0, 7), start: i === 0 ? today : start, end: addDays(addMonthsAnchored(start, 1), -1) };
  });
  const weekPeriods: { key: string; start: string; end: string }[] = [];
  for (let w = weekStart(today); w <= horizonEnd; w = addDays(w, 7)) {
    const end = addDays(w, 6);
    weekPeriods.push({ key: w, start: w < today ? today : w, end: end > horizonEnd ? horizonEnd : end });
  }

  const balance = s.cashBalanceCents != null && s.cashBalanceDate ? { startCents: s.cashBalanceCents, date: s.cashBalanceDate } : null;
  const series = balance ? balanceSeries(entries, balance) : null;
  let lowestBalance: { cents: number; date: string } | null = null;
  if (balance && series) {
    lowestBalance = { cents: balance.startCents, date: balance.date > today ? balance.date : today };
    for (const p of series) if (p.cents < lowestBalance.cents) lowestBalance = { cents: p.cents, date: p.date };
  }

  const sumWhere = (pred: (e: ForecastEntry) => boolean) => entries.filter(pred).reduce((s, e) => s + e.grossCents, 0);
  const isIn = (e: ForecastEntry) => e.direction === "in";
  const isOut = (e: ForecastEntry) => e.direction === "out";
  const in30 = addDays(today, 30);
  const in90 = addDays(today, 90);
  const total = sumWhere(isIn);
  const outTotal = sumWhere(isOut);

  return {
    today,
    horizonEnd,
    months,
    options: {
      months,
      includeDrafts: opts.includeDrafts,
      includeOffers: opts.includeOffers,
      offerProbability: probability,
      includeOutflows,
    },
    globalDelay: global,
    balance,
    smallBusiness: s.smallBusiness,
    kpis: {
      next30: sumWhere((e) => isIn(e) && e.expectedDate <= in30),
      next90: sumWhere((e) => isIn(e) && e.expectedDate <= in90),
      total,
      overdue: overdueBucket.inCents,
      overdueCount: entries.filter((e) => isIn(e) && e.overdue).length,
      recurring: sumWhere((e) => isIn(e) && e.source === "recurring"),
      tax: entries.reduce((s, e) => s + (isIn(e) ? e.taxCents : 0), 0),
      count: entries.length,
      outNext30: sumWhere((e) => isOut(e) && e.expectedDate <= in30),
      outTotal,
      outOverdue: overdueBucket.outCents,
      fixedCosts: sumWhere((e) => e.source === "fixed_cost"),
      netTotal: total - outTotal,
      endBalance: balance ? (series!.at(-1)?.cents ?? balance.startCents) : null,
      lowestBalance,
    },
    overdueBucket,
    monthly: buildBuckets(entries, monthPeriods, overdueBucket.netCents, series, balance?.startCents ?? 0),
    weekly: buildBuckets(entries, weekPeriods, overdueBucket.netCents, series, balance?.startCents ?? 0),
    entries,
  };
}

// ── Outflows ────────────────────────────────────────────────────────────────────

function pushFixedCosts(db: DbOrTx, today: string, horizonEnd: string, push: (e: EntryInput) => void) {
  const rows = db.select().from(recurringExpenses).where(eq(recurringExpenses.active, true)).all();
  const linked = linkedSlotKeys(db);
  for (const r of rows) {
    for (const date of paymentDatesBetween(r, today, horizonEnd)) {
      if (linked.has(`${r.id}:${date}`)) continue;
      push({
        key: `fix-${r.id}-${date}`,
        source: "fixed_cost",
        direction: "out",
        expectedDate: date,
        dueDate: date,
        issueDate: date,
        partyName: r.supplierName || r.name,
        recurringExpenseId: r.id,
        label: r.name,
        grossCents: r.grossCents,
        taxCents: r.taxCents,
        fullGrossCents: r.grossCents,
      });
    }
  }
}

/** Unpaid expenses (with lines): open = gross − bank allocations; deductible domestic VAT pro rata. */
function pushUnpaidExpenses(db: DbOrTx, today: string, push: (e: EntryInput) => void) {
  const rows = db.select().from(expenses).where(isNull(expenses.paidAt)).all();
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const lines = db.select().from(expenseLines).where(inArray(expenseLines.expenseId, ids)).all();
  const deductibleBy = new Map<number, number>();
  for (const l of lines) deductibleBy.set(l.expenseId, (deductibleBy.get(l.expenseId) ?? 0) + deductibleTaxCents(l));
  const paid = paidCentsByExpense(db, ids);
  const links = new Map(
    db
      .select({ expenseId: recurringExpensePayments.expenseId, recurringExpenseId: recurringExpensePayments.recurringExpenseId, date: recurringExpensePayments.scheduledDate, name: recurringExpenses.name })
      .from(recurringExpensePayments)
      .innerJoin(recurringExpenses, eq(recurringExpensePayments.recurringExpenseId, recurringExpenses.id))
      .where(inArray(recurringExpensePayments.expenseId, ids))
      .all()
      .map((l) => [l.expenseId, l]),
  );
  for (const x of rows) {
    if (!deductibleBy.has(x.id)) continue; // incomplete draft without lines
    const open = x.grossCents - (paid.get(x.id) ?? 0);
    if (open <= 0) continue;
    // only domestic VAT is paid to the supplier; self-assessed VAT is owed and deducted in the same UVA
    const deductible = (x.vatTreatment as VatTreatment) === "domestic" ? deductibleBy.get(x.id)! : 0;
    const dueDate = x.dueDate ?? addDays(x.issueDate, UNPAID_EXPENSE_TERMS_DAYS);
    const overdue = dueDate < today;
    const link = links.get(x.id);
    push({
      key: `exp-${x.id}`,
      source: "expense",
      direction: "out",
      overdue,
      expectedDate: overdue ? today : dueDate,
      dueDate,
      issueDate: x.issueDate,
      partyName: x.supplierName,
      expenseId: x.id,
      recurringExpenseId: link?.recurringExpenseId ?? null,
      number: x.number,
      label: x.description || x.supplierInvoiceNumber || (link ? `${link.name} ${slotLabel(link.date)}` : ""),
      grossCents: open,
      taxCents: x.grossCents > 0 ? Math.round((deductible * open) / x.grossCents) : 0,
      fullGrossCents: x.grossCents,
    });
  }
}

/**
 * UVA payments / refunds whose due date lies in [today, horizonEnd]: recorded figure (computeUva) + the VAT of
 * forecast entries that land in the period but are not recorded yet (see vatPeriodDate).
 */
export function vatEntries(
  db: DbOrTx,
  entries: ForecastEntry[],
  vatPeriod: "monthly" | "quarterly",
  basis: "accrual" | "cash",
  today: string,
  horizonEnd: string,
): EntryInput[] {
  const kind = periodKind(vatPeriod);
  const out: EntryInput[] = [];
  // two periods back covers every period that is over but not yet due
  for (let key = shiftPeriod(periodKeyFor(today, kind), -2); ; key = shiftPeriod(key, 1)) {
    const p = parsePeriod(key)!;
    if (p.from > horizonEnd) break;
    const due = uvaDueDate(p);
    if (due < today || due > horizonEnd) continue;
    let estimate = 0;
    for (const e of entries) {
      const d = vatPeriodDate(e, basis, today);
      if (d && d >= p.from && d <= p.to) estimate += e.direction === "in" ? e.taxCents : -e.taxCents;
    }
    const recorded = computeUva(db, p).resultCents;
    const result = recorded + estimate;
    if (result === 0) continue;
    out.push({
      key: `vat-${key}`,
      source: "vat",
      direction: result > 0 ? "out" : "in",
      expectedDate: due,
      dueDate: due,
      issueDate: p.to,
      partyName: "Finanzamt",
      label: `${result > 0 ? "USt-Zahllast" : "USt-Gutschrift"} ${p.label}`,
      grossCents: Math.abs(result),
      taxCents: 0,
      fullGrossCents: Math.abs(result),
      estimated: p.to >= today,
      vatPeriod: key,
    });
  }
  return out;
}

// ── Settings ────────────────────────────────────────────────────────────────────

export function getForecastSettings(db: DbOrTx): ForecastSettings {
  const s = getSettings(db);
  return { cashBalanceCents: s.cashBalanceCents, cashBalanceDate: s.cashBalanceDate, incomeTaxPrepaymentCents: s.incomeTaxPrepaymentCents };
}

export function updateForecastSettings(db: DbOrTx, input: ForecastSettings): ForecastSettings {
  getSettings(db);
  db.update(settings).set(input).run();
  return getForecastSettings(db);
}
