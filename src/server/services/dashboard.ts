import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { todayIso } from "../../shared/dates";
import type { DocumentStatus, DocumentType } from "../../shared/documents";
import { deductibleTaxCents, expenseCostCents, type VatTreatment } from "../../shared/expenses";
import type { SmallBusinessLimit } from "../../shared/small-business";
import type { DbOrTx } from "../db/client";
import { clients, documents, expenseLines, expenses, settings } from "../db/schema";
import { afaEntries, ASSET_CATEGORY, monthlyAfa } from "./assets";
import { creditedCentsSql, invoicePaymentStates, openCentsSql } from "./bank";
import { getSmallBusinessLimit } from "./small-business";
import { loadTaxStatus } from "./tax-status";
import type { TaxStatusTimeline } from "../../shared/tax-status";

// Dashboard aggregation (GET /api/dashboard?year=). All sums are integer cents.
// - Revenue = net of non-draft invoices minus net of non-draft credit notes (credit notes store
//   positive amounts), bucketed by issueDate.
// - Open invoices = final/sent invoices with something left to pay (gross − credit notes − bank payments > 0);
//   overdue = those with dueDate < today (see isOverdue). Their sums are that open amount.
// - Paid = invoices by paidAt, gross minus credit notes (an invoice settled by credit note brought in nothing).
// - Open offers = final/sent offers (neither accepted nor declined).
// - Expenses = cost of the expense lines on the EAR basis (net + non-deductible VAT, e.g. KFZ; for a
//   Kleinunternehmer net + all VAT), bucketed by issueDate like revenue. Incomplete drafts without lines add
//   nothing. (The EAR on /tax counts by payment date instead.)
//   Lines with category "anlagen" are capitalized and left out; the AfA of the year from the Anlagenverzeichnis
//   takes their place (services/assets.ts monthlyAfa): spread evenly over all 12 months of the year (annual
//   AfA / 12, cent remainder in December), also for the current year and regardless of the month the asset was
//   put in service, so the monthly result isn't distorted by a year-end lump. A disposal write-off counts in the
//   month of disposal. Same split as the EAR monthly view.

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
    /** expense costs in `year` (net + non-deductible VAT, EAR basis) */
    /** EAR costs (receipts + AfA); current year: AfA only up to the current month. receipts/afa = the split of `cents` */
    expenses: { cents: number; previousCents: number; receiptsCents: number; afaCents: number };
    /** gross received in `year` (invoices by paidAt) */
    paid: Figure;
    openOffers: Figure;
  };
  /** net revenue and expense costs per month, index 0 = January */
  monthly: { month: number; cents: number; previousCents: number; expenseCents: number; previousExpenseCents: number }[];
  overdue: OverdueRow[];
  recent: DashboardDocRow[];
  openOffers: DashboardDocRow[];
  setup: { hasClients: boolean; hasDocuments: boolean; companyMissing: boolean };
  /** Kleinunternehmer limit for `year`; only when the Steuerstatus is Kleinunternehmer on some day of `year` */
  smallBusiness: SmallBusinessLimit | null;
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

/**
 * Expense costs per month for the given years, "anlagen" lines replaced by AfA, split into receipts and AfA:
 * Map<year, { receipts, afa }> (cents[12] each). The AfA of the year whose months come after `today` is left out,
 * so the current year shows costs to date like revenue does (the EAR keeps the full annual AfA).
 */
function monthlyExpenses(db: DbOrTx, years: number[], status: TaxStatusTimeline, today: string): Map<number, { receipts: number[]; afa: number[] }> {
  const from = `${Math.min(...years)}-01-01`;
  const to = `${Math.max(...years) + 1}-01-01`;
  const lines = db
    .select({
      issueDate: expenses.issueDate,
      treatment: expenses.vatTreatment,
      netCents: expenseLines.netCents,
      taxCents: expenseLines.taxCents,
      deductibleBp: expenseLines.deductibleBp,
    })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenses.id, expenseLines.expenseId))
    .where(and(gte(expenses.issueDate, from), lt(expenses.issueDate, to), ne(expenseLines.category, ASSET_CATEGORY)))
    .all();
  const todayMonth = today.slice(0, 7);
  const out = new Map(
    years.map((y) => {
      const afa = monthlyAfa(afaEntries(db, y)).map((c, m) => (`${y}-${String(m + 1).padStart(2, "0")}` > todayMonth ? 0 : c));
      return [y, { receipts: Array<number>(12).fill(0), afa }];
    }),
  );
  for (const l of lines) {
    const bucket = out.get(Number(l.issueDate.slice(0, 4)))?.receipts;
    if (bucket) bucket[Number(l.issueDate.slice(5, 7)) - 1]! += expenseCostCents({ ...l, deductibleCents: deductibleTaxCents(l) }, l.treatment as VatTreatment, status.smallBusinessAt(l.issueDate));
  }
  return out;
}

/** Limit card; flags when the limit ends the exemption on a day the Steuerstatus still says Kleinunternehmer. */
function smallBusinessCard(db: DbOrTx, year: number, today: string, status: TaxStatusTimeline): SmallBusinessLimit {
  const limit = getSmallBusinessLimit(db, year, today);
  const endsOn = limit.previousYearExceeded ? `${year}-01-01` : limit.exceededOn;
  return { ...limit, statusEndsOn: endsOn && status.smallBusinessAt(endsOn) ? endsOn : null };
}

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
  const company = db
    .select({ name: settings.companyName, street: settings.street, city: settings.city })
    .from(settings)
    .get();
  const status = loadTaxStatus(db);
  // Kleinunternehmer by the Belegdatum of each expense (no Vorsteuer → gross cost)
  const expensesByYear = monthlyExpenses(db, [year, year - 1], status, today);
  const add = (e: { receipts: number[]; afa: number[] }) => e.receipts.map((c, m) => c + e.afa[m]!);
  const currentSplit = expensesByYear.get(year)!;
  const currentExpenses = add(currentSplit);
  const previousExpenses = add(expensesByYear.get(year - 1)!);
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

  const yearRows = [
    ...db.selectDistinct({ y: sql<string>`substr(${documents.issueDate}, 1, 4)` }).from(documents).all(),
    ...db.selectDistinct({ y: sql<string>`substr(${expenses.issueDate}, 1, 4)` }).from(expenses).all(),
  ];
  const thisYear = Number(today.slice(0, 4));
  const years = [...new Set([thisYear, year, ...yearRows.map((r) => Number(r.y))])].sort((a, b) => b - a);

  const clientCount = db.select({ n: figure }).from(clients).get()!.n;

  return {
    year,
    today,
    years,
    kpis: {
      openInvoices,
      overdue: overdueFig,
      revenue: { cents: sum(current), previousCents: sum(previous) },
      expenses: {
        cents: sum(currentExpenses),
        previousCents: sum(previousExpenses),
        receiptsCents: sum(currentSplit.receipts),
        afaCents: sum(currentSplit.afa),
      },
      paid,
      openOffers: openOffersFig,
    },
    monthly: current.map((cents, month) => ({
      month,
      cents,
      previousCents: previous[month]!,
      expenseCents: currentExpenses[month]!,
      previousExpenseCents: previousExpenses[month]!,
    })),
    overdue,
    recent,
    openOffers,
    setup: {
      hasClients: clientCount > 0,
      hasDocuments: recent.length > 0,
      companyMissing: !company || !company.name || !company.street || !company.city,
    },
    smallBusiness: status.smallBusinessSometime(`${year}-01-01`, `${year}-12-31`) ? smallBusinessCard(db, year, today, status) : null,
  };
}
