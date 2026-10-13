import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { todayIso } from "../../shared/dates";
import type { DocumentStatus, DocumentType } from "../../shared/documents";
import type { DbOrTx } from "../db/client";
import { clients, documents, settings } from "../db/schema";
import { creditedCentsSql, invoicePaymentStates, paidCentsSql } from "./bank";

// Dashboard aggregation (GET /api/dashboard?year=). All sums are integer cents.
// - Revenue = net of non-draft invoices minus net of non-draft credit notes (credit notes store
//   positive amounts), bucketed by issueDate.
// - Open invoices = final/sent invoices with something left to pay (gross − credit notes − bank payments > 0);
//   overdue = those with dueDate < today (see isOverdue). Their sums are that open amount.
// - Paid = invoices by paidAt, gross minus credit notes (an invoice settled by credit note brought in nothing).
// - Open offers = final/sent offers (neither accepted nor declined).

export interface DashboardDocRow {
  id: number;
  type: DocumentType;
  status: DocumentStatus;
  number: string | null;
  clientName: string;
  title: string;
  issueDate: string;
  dueDate: string | null;
  validUntil: string | null;
  grossCents: number;
  updatedAt: string;
}

export interface OverdueRow extends DashboardDocRow {
  daysOverdue: number;
  /** gross − credit notes − bank payments */
  openCents: number;
  /** bank payments cover part of it ("teilbezahlt") */
  partial: boolean;
}

export interface Figure {
  count: number;
  cents: number;
}

export interface DashboardData {
  year: number;
  today: string;
  /** years that have documents, plus the current year, descending */
  years: number[];
  kpis: {
    openInvoices: Figure;
    overdue: Figure;
    /** net revenue in `year` */
    revenue: { cents: number; previousCents: number };
    /** gross received in `year` (invoices by paidAt) */
    paid: Figure;
    openOffers: Figure;
  };
  /** net revenue per month, index 0 = January */
  monthly: { month: number; cents: number; previousCents: number }[];
  overdue: OverdueRow[];
  recent: DashboardDocRow[];
  openOffers: DashboardDocRow[];
  setup: { hasClients: boolean; hasDocuments: boolean; companyMissing: boolean };
}

const LIST_LIMIT = 8;
const OVERDUE_LIMIT = 10;
const OPEN_STATUSES: DocumentStatus[] = ["final", "sent"];

const clientName = sql<string>`coalesce(json_extract(${documents.clientSnapshot}, '$.name'), ${clients.name}, '')`;
const rowColumns = {
  id: documents.id,
  type: documents.type,
  status: documents.status,
  number: documents.number,
  clientName,
  title: documents.title,
  issueDate: documents.issueDate,
  dueDate: documents.dueDate,
  validUntil: documents.validUntil,
  grossCents: documents.grossCents,
  updatedAt: documents.updatedAt,
};

const figure = sql<number>`count(*)`;
const sumOf = (col: typeof documents.grossCents | typeof documents.netCents) =>
  sql<number>`coalesce(sum(${col}), 0)`;

/** Whole days between two "YYYY-MM-DD" dates (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Net revenue per month for the given years: Map<year, cents[12]>. */
function monthlyRevenue(db: DbOrTx, years: number[]): Map<number, number[]> {
  const from = `${Math.min(...years)}-01-01`;
  const to = `${Math.max(...years) + 1}-01-01`;
  const signed = sql<number>`coalesce(sum(case when ${documents.type} = 'credit_note' then -${documents.netCents} else ${documents.netCents} end), 0)`;
  const ym = sql<string>`substr(${documents.issueDate}, 1, 7)`;
  const rows = db
    .select({ ym, cents: signed })
    .from(documents)
    .where(
      and(
        inArray(documents.type, ["invoice", "credit_note"]),
        ne(documents.status, "draft"),
        gte(documents.issueDate, from),
        lt(documents.issueDate, to),
      ),
    )
    .groupBy(ym)
    .all();
  const out = new Map(years.map((y) => [y, Array<number>(12).fill(0)]));
  for (const r of rows) {
    const [y, m] = r.ym.split("-").map(Number);
    const bucket = out.get(y!);
    if (bucket) bucket[m! - 1] = r.cents;
  }
  return out;
}

/** gross − credit notes − bank payments of the invoice in the current row */
const openCentsSql = sql<number>`(${documents.grossCents} - ${creditedCentsSql} - ${paidCentsSql})`;

export function getDashboard(db: DbOrTx, year: number, today = todayIso()): DashboardData {
  const yearFrom = `${year}-01-01`;
  const yearTo = `${year + 1}-01-01`;
  const isOpenInvoice = and(eq(documents.type, "invoice"), inArray(documents.status, OPEN_STATUSES), sql`${openCentsSql} > 0`);
  const isOverdueInvoice = and(isOpenInvoice, lt(documents.dueDate, today));
  const isOpenOffer = and(eq(documents.type, "offer"), inArray(documents.status, OPEN_STATUSES));

  const fig = (where: ReturnType<typeof and>): Figure =>
    db.select({ count: figure, cents: sumOf(documents.grossCents) }).from(documents).where(where).get()!;

  // open/overdue amounts net of credit notes and partial bank payments
  const openFig = (where: ReturnType<typeof and>): Figure =>
    db
      .select({ count: figure, cents: sql<number>`coalesce(sum(${openCentsSql}), 0)` })
      .from(documents)
      .where(where)
      .get()!;
  const openInvoices = openFig(isOpenInvoice);
  const overdueFig = openFig(isOverdueInvoice);
  const openOffersFig = fig(isOpenOffer);
  const received = sql<number>`(${documents.grossCents} - ${creditedCentsSql})`;
  const paid = db
    .select({ count: figure, cents: sql<number>`coalesce(sum(${received}), 0)` })
    .from(documents)
    .where(
      and(
        eq(documents.type, "invoice"),
        eq(documents.status, "paid"),
        gte(documents.paidAt, yearFrom),
        lt(documents.paidAt, yearTo),
        sql`${received} > 0`,
      ),
    )
    .get()!;

  const monthlyByYear = monthlyRevenue(db, [year, year - 1]);
  const current = monthlyByYear.get(year)!;
  const previous = monthlyByYear.get(year - 1)!;
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

  const base = () => db.select(rowColumns).from(documents).leftJoin(clients, eq(clients.id, documents.clientId));

  const overdueRows = base().where(isOverdueInvoice).orderBy(asc(documents.dueDate), asc(documents.id)).limit(OVERDUE_LIMIT).all();
  const states = invoicePaymentStates(db, overdueRows);
  const overdue = overdueRows.map((r) => {
    const state = states.get(r.id)!;
    return { ...r, daysOverdue: daysBetween(r.dueDate!, today), openCents: state.openCents, partial: state.partial };
  });
  const recent = base().orderBy(desc(documents.updatedAt), desc(documents.id)).limit(LIST_LIMIT).all();
  const openOffers = base()
    .where(isOpenOffer)
    .orderBy(sql`${documents.validUntil} is null`, asc(documents.validUntil), asc(documents.id))
    .limit(LIST_LIMIT)
    .all();

  const yearRows = db
    .selectDistinct({ y: sql<string>`substr(${documents.issueDate}, 1, 4)` })
    .from(documents)
    .all();
  const thisYear = Number(today.slice(0, 4));
  const years = [...new Set([thisYear, year, ...yearRows.map((r) => Number(r.y))])].sort((a, b) => b - a);

  const clientCount = db.select({ n: figure }).from(clients).get()!.n;
  const company = db.select({ name: settings.companyName, street: settings.street, city: settings.city }).from(settings).get();

  return {
    year,
    today,
    years,
    kpis: {
      openInvoices,
      overdue: overdueFig,
      revenue: { cents: sum(current), previousCents: sum(previous) },
      paid,
      openOffers: openOffersFig,
    },
    monthly: current.map((cents, month) => ({ month, cents, previousCents: previous[month]! })),
    overdue,
    recent,
    openOffers,
    setup: {
      hasClients: clientCount > 0,
      hasDocuments: recent.length > 0,
      companyMissing: !company || !company.name || !company.street || !company.city,
    },
  };
}
