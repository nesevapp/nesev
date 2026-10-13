import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { addDays, todayIso } from "../../shared/dates";
import { addMonthsAnchored, runDatesUntil } from "../../shared/recurring";
import type { DbOrTx } from "../db/client";
import { clients, documents, recurringInvoices, settings } from "../db/schema";
import { creditedCentsByInvoice, paidCentsByDocument } from "./bank";

// Payment forecast (GET /api/forecast): expected INCOMING money (gross) per week / month.
// Sources:
// - open invoices (final/sent): expected = dueDate + the client's average payment delay. Overdue ones
//   (dueDate < today) land in the "overdue" bucket at today. Non-draft credit notes and partial bank
//   payments on an invoice reduce it.
// - recurring invoices: every future run within the horizon (active, respecting endDate); expected =
//   run date + payment terms + client delay. Drafts generated from a recurring invoice count here too.
// - optional: other invoice drafts; open offers (final/sent, not expired) weighted by a probability,
//   assumed to be invoiced today if accepted.
// Payment delay = average of (paidAt − dueDate) in days over the client's paid invoices; fallback: the
// average over all clients, else 0. Expected dates never lie before today.

export const FORECAST_SOURCES = ["invoice", "recurring", "offer", "draft"] as const;
export type ForecastSource = (typeof FORECAST_SOURCES)[number];

export interface ForecastOptions {
  months: number;
  includeDrafts: boolean;
  includeOffers: boolean;
  /** 0..100, applied to open offers */
  offerProbability: number;
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
  overdue: boolean;
  expectedDate: string;
  /** due date the expectation is based on (projected for recurring runs / offers) */
  dueDate: string;
  issueDate: string;
  clientId: number;
  clientName: string;
  documentId: number | null;
  documentType: "invoice" | "offer" | null;
  number: string | null;
  recurringInvoiceId: number | null;
  label: string;
  /** expected inflow (weighted for offers) */
  grossCents: number;
  /** VAT part of grossCents (owed to the tax office) */
  taxCents: number;
  /** unweighted amount (differs from grossCents only for offers / credited invoices) */
  fullGrossCents: number;
  probability: number;
  delay: PaymentDelay;
  daysOverdue: number;
}

export type SourceCents = Record<ForecastSource, number>;

export interface ForecastBucket {
  key: string;
  start: string;
  end: string;
  bySource: SourceCents;
  totalCents: number;
  taxCents: number;
  /** running total including the overdue bucket */
  cumulativeCents: number;
}

export interface ForecastData {
  today: string;
  horizonEnd: string;
  months: number;
  options: Required<Omit<ForecastOptions, "today">>;
  globalDelay: PaymentDelay;
  kpis: {
    next30: number;
    next90: number;
    total: number;
    overdue: number;
    overdueCount: number;
    recurring: number;
    tax: number;
    count: number;
  };
  overdueBucket: { bySource: SourceCents; totalCents: number; taxCents: number };
  monthly: ForecastBucket[];
  weekly: ForecastBucket[];
  entries: ForecastEntry[];
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2!, m2! - 1, d2!) - Date.UTC(y1!, m1! - 1, d1!)) / 86_400_000);
}

const emptySources = (): SourceCents => ({ invoice: 0, recurring: 0, offer: 0, draft: 0 });

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

function buildBuckets(
  entries: ForecastEntry[],
  periods: { key: string; start: string; end: string }[],
  overdueTotal: number,
): ForecastBucket[] {
  let running = overdueTotal;
  return periods.map((p) => {
    const bySource = emptySources();
    let taxCents = 0;
    for (const e of entries) {
      if (e.overdue || e.expectedDate < p.start || e.expectedDate > p.end) continue;
      bySource[e.source] += e.grossCents;
      taxCents += e.taxCents;
    }
    const totalCents = FORECAST_SOURCES.reduce((s, k) => s + bySource[k], 0);
    running += totalCents;
    return { ...p, bySource, totalCents, taxCents, cumulativeCents: running };
  });
}

export function buildForecast(db: DbOrTx, opts: ForecastOptions): ForecastData {
  const today = opts.today ?? todayIso();
  const months = opts.months;
  // horizon = rest of the current month + `months` − 1 full months (3 → Oct, Nov, Dec)
  const horizonEnd = addDays(addMonthsAnchored(`${today.slice(0, 7)}-01`, months), -1);
  const probability = Math.min(100, Math.max(0, opts.offerProbability));
  const s = db.select().from(settings).get();
  const defaultTerms = s?.paymentTermsDays ?? 14;
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
  const push = (e: Omit<ForecastEntry, "key" | "daysOverdue" | "overdue"> & { key: string; overdue?: boolean }) => {
    if (e.grossCents <= 0) return;
    const overdue = e.overdue ?? false;
    if (!overdue && e.expectedDate > horizonEnd) return;
    entries.push({ ...e, overdue, daysOverdue: overdue ? daysBetween(e.dueDate, today) : 0 });
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
  const credits = db
    .select({ parentId: documents.parentId, grossCents: documents.grossCents, taxCents: documents.taxCents })
    .from(documents)
    .where(and(eq(documents.type, "credit_note"), ne(documents.status, "draft"), isNotNull(documents.parentId)))
    .all();
  const creditByInvoice = new Map<number, { gross: number; tax: number }>();
  for (const c of credits) {
    const cur = creditByInvoice.get(c.parentId!) ?? { gross: 0, tax: 0 };
    cur.gross += c.grossCents;
    cur.tax += c.taxCents;
    creditByInvoice.set(c.parentId!, cur);
  }

  const paidByInvoice = paidCentsByDocument(db, invoices.map((d) => d.id));

  for (const doc of [...invoices, ...recurringDrafts]) {
    const isDraft = doc.status === "draft";
    const source: ForecastSource = isDraft ? (doc.recurringInvoiceId ? "recurring" : "draft") : "invoice";
    const credit = creditByInvoice.get(doc.id) ?? { gross: 0, tax: 0 };
    // partial bank payments reduce what is still expected (VAT part pro rata)
    const owed = doc.grossCents - credit.gross;
    const paid = Math.min(paidByInvoice.get(doc.id) ?? 0, Math.max(owed, 0));
    const owedTax = doc.taxCents - credit.tax;
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
      clientName: doc.clientSnapshot?.name ?? clientById.get(doc.clientId)?.name ?? "",
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
        clientName: clientById.get(r.clientId)?.name ?? "",
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
        clientName: o.clientSnapshot?.name ?? clientById.get(o.clientId)?.name ?? "",
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

  entries.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate) || b.grossCents - a.grossCents);

  // buckets
  const overdueBucket = { bySource: emptySources(), totalCents: 0, taxCents: 0 };
  for (const e of entries) {
    if (!e.overdue) continue;
    overdueBucket.bySource[e.source] += e.grossCents;
    overdueBucket.totalCents += e.grossCents;
    overdueBucket.taxCents += e.taxCents;
  }
  const monthPeriods = Array.from({ length: months }, (_, i) => {
    const start = addMonthsAnchored(`${today.slice(0, 7)}-01`, i);
    return { key: start.slice(0, 7), start: i === 0 ? today : start, end: addDays(addMonthsAnchored(start, 1), -1) };
  });
  const weekPeriods: { key: string; start: string; end: string }[] = [];
  for (let w = weekStart(today); w <= horizonEnd; w = addDays(w, 7)) {
    const end = addDays(w, 6);
    weekPeriods.push({ key: w, start: w < today ? today : w, end: end > horizonEnd ? horizonEnd : end });
  }

  const sumWhere = (pred: (e: ForecastEntry) => boolean) => entries.filter(pred).reduce((s, e) => s + e.grossCents, 0);
  const in30 = addDays(today, 30);
  const in90 = addDays(today, 90);

  return {
    today,
    horizonEnd,
    months,
    options: {
      months,
      includeDrafts: opts.includeDrafts,
      includeOffers: opts.includeOffers,
      offerProbability: probability,
    },
    globalDelay: global,
    kpis: {
      next30: sumWhere((e) => e.expectedDate <= in30),
      next90: sumWhere((e) => e.expectedDate <= in90),
      total: sumWhere(() => true),
      overdue: overdueBucket.totalCents,
      overdueCount: entries.filter((e) => e.overdue).length,
      recurring: sumWhere((e) => e.source === "recurring"),
      tax: entries.reduce((s, e) => s + e.taxCents, 0),
      count: entries.length,
    },
    overdueBucket,
    monthly: buildBuckets(entries, monthPeriods, overdueBucket.totalCents),
    weekly: buildBuckets(entries, weekPeriods, overdueBucket.totalCents),
    entries,
  };
}
