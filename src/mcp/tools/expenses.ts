import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { categoryLabel, EXPENSE_CATEGORY_KEYS, VAT_TREATMENT_LABELS, VAT_TREATMENT_SHORT_LABELS, VAT_TREATMENTS } from "../../shared/expenses";
import { intervalLabel } from "../../shared/recurring";
import { EXPENSE_ATTACHMENT_FILTERS, EXPENSE_STATUS_FILTERS } from "../../shared/schemas/expense";
import { call, idParam } from "../api";
import { bullets, deDate, eur, isoDate, join, Money, money, percent } from "../format";
import { defineTool, READ_ONLY, type ToolContext, type ToolOutput } from "../tool";

// Expenses (Ausgaben / Belege) and fixed costs (Fixkosten).

const expenseStatusLabel = (e: { incomplete: boolean; paidAt: string | null }) =>
  e.incomplete ? "unvollständig" : e.paidAt ? "bezahlt" : "offen";

const ExpenseRow = z.object({
  id: z.number().int(),
  number: z.string().nullable().describe('internal receipt number, e.g. "ER-2026-0001"'),
  supplier: z.string(),
  supplierCountry: z.string(),
  supplierUid: z.string(),
  supplierInvoiceNumber: z.string(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  paidAt: z.string().nullable(),
  description: z.string(),
  vatTreatment: z.enum(VAT_TREATMENTS),
  vatTreatmentLabel: z.string(),
  net: Money,
  tax: Money.describe("VAT (self-assessed for reverse charge / ig. Erwerb)"),
  gross: Money.describe("amount payable to the supplier"),
  incomplete: z.boolean().describe("draft without lines; excluded from reports"),
  hasReceipt: z.boolean(),
  statusLabel: z.string(),
  link: z.string(),
});

type ExpenseLike = {
  id: number;
  number: string | null;
  supplierName: string;
  supplierCountry: string;
  supplierUid: string;
  supplierInvoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  paidAt: string | null;
  description: string;
  vatTreatment: (typeof VAT_TREATMENTS)[number];
  netCents: number;
  taxCents: number;
  grossCents: number;
  incomplete: boolean;
  attachmentPath: string | null;
};

function expenseRow(ctx: ToolContext, e: ExpenseLike) {
  return {
    id: e.id,
    number: e.number,
    supplier: e.supplierName,
    supplierCountry: e.supplierCountry,
    supplierUid: e.supplierUid,
    supplierInvoiceNumber: e.supplierInvoiceNumber,
    issueDate: e.issueDate,
    dueDate: e.dueDate,
    paidAt: e.paidAt,
    description: e.description,
    vatTreatment: e.vatTreatment,
    vatTreatmentLabel: VAT_TREATMENT_SHORT_LABELS[e.vatTreatment],
    net: money(e.netCents),
    tax: money(e.taxCents),
    gross: money(e.grossCents),
    incomplete: e.incomplete,
    hasReceipt: e.attachmentPath !== null,
    statusLabel: expenseStatusLabel(e),
    link: ctx.webUrl(`/expenses/${e.id}`),
  };
}

/** get_expense output; create_expense returns it too. */
export const ExpenseDetail = z.object({
  ...ExpenseRow.shape,
  vatTreatmentDescription: z.string(),
  notes: z.string(),
  lines: z.array(
    z.object({
      category: z.string(),
      categoryLabel: z.string(),
      description: z.string(),
      net: Money,
      taxRatePercent: z.number(),
      tax: Money,
      deductiblePercent: z.number().describe("share of the VAT deductible as Vorsteuer"),
    }),
  ),
  payment: z.object({
    paid: Money.describe("bank payments"),
    open: Money.describe("gross − bank payments; an expense marked paid by hand (paidAt) can still show an amount here"),
    payments: z.array(z.object({ date: z.string(), amount: Money, account: z.string(), counterparty: z.string(), purpose: z.string() })),
  }),
  fixedCost: z.object({ id: z.number().int(), name: z.string(), scheduledDate: z.string(), link: z.string() }).nullable(),
  receipt: z.object({ path: z.string().describe("absolute file path"), fileName: z.string(), url: z.string() }).nullable(),
});

/** Expense with lines, payments, Fixkosten link and receipt as text + structured data. */
export async function expenseDetail(ctx: ToolContext, id: number): Promise<ToolOutput<z.input<typeof ExpenseDetail>>> {
  const e = await call(ctx.api.expenses[":id"].$get({ param: idParam(id) }));
  const [payments, link] = await Promise.all([
    call(ctx.api.bank.expenses[":id"].payments.$get({ param: idParam(id) })),
    call(ctx.api.recurringExpenses.link.$get({ query: { expenseId: String(id) } })),
  ]);
  const lines = e.lines.map((l) => ({
    category: l.category,
    categoryLabel: categoryLabel(l.category),
    description: l.description,
    net: money(l.netCents),
    taxRatePercent: percent(l.taxRateBp),
    tax: money(l.taxCents),
    deductiblePercent: percent(l.deductibleBp),
  }));
  const data = {
    ...expenseRow(ctx, e),
    vatTreatmentDescription: VAT_TREATMENT_LABELS[e.vatTreatment],
    notes: e.notes,
    lines,
    payment: {
      paid: money(payments.paidCents),
      open: money(payments.openCents),
      payments: payments.payments.map((p) => ({
        date: p.bookingDate,
        amount: money(p.amountCents),
        account: p.accountName,
        counterparty: p.counterpartyName,
        purpose: p.purpose,
      })),
    },
    fixedCost: link && { id: link.recurringExpenseId, name: link.name, scheduledDate: link.scheduledDate, link: ctx.webUrl("/fixed-costs") },
    receipt: e.attachmentPath
      ? { path: ctx.dataPath(e.attachmentPath), fileName: e.attachmentName, url: ctx.webUrl(`/api/files/${e.attachmentPath}`) }
      : null,
  };
  const text = [
    `Ausgabe ${e.number ?? ""} (expense id ${e.id}) · ${data.statusLabel}`,
    join(`Lieferant: ${e.supplierName || "(leer)"}`, e.supplierCountry, e.supplierUid && `UID ${e.supplierUid}`, e.supplierInvoiceNumber && `Rechnungsnr. ${e.supplierInvoiceNumber}`),
    join(`Datum ${deDate(e.issueDate)}`, e.dueDate && `fällig ${deDate(e.dueDate)}`, e.paidAt && `bezahlt ${deDate(e.paidAt)}`),
    e.description && `Beschreibung: ${e.description}`,
    `USt-Behandlung: ${VAT_TREATMENT_LABELS[e.vatTreatment]}`,
    "Zeilen:",
    bullets(
      lines.map((l) =>
        join(l.categoryLabel, l.description, `netto ${l.net.formatted}`, `${l.taxRatePercent} % = ${l.tax.formatted}`, l.deductiblePercent !== 100 && `abzugsfähig ${l.deductiblePercent} %`),
      ),
      "(keine – unvollständig)",
    ),
    `Netto ${eur(e.netCents)} · USt ${eur(e.taxCents)} · Brutto (zahlbar) ${eur(e.grossCents)}`,
    payments.payments.length ? `Bank: bezahlt ${eur(payments.paidCents)}, offen ${eur(payments.openCents)}` : null,
    link && `Fixkosten: ${link.name} · ${deDate(link.scheduledDate)}`,
    e.notes && `Notizen: ${e.notes}`,
    data.receipt ? `Beleg: ${data.receipt.path}` : "Kein Beleg angehängt",
    `Link: ${data.link}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { text, data };
}

export function registerExpenseTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "list_expenses",
    {
      title: "Ausgaben auflisten",
      group: "expenses",
      description:
        "List expenses (Ausgaben / Eingangsrechnungen), newest first. Filters: issue date range, `query` (supplier, " +
        "description, receipt number, supplier invoice number, notes), status (open = unpaid and complete, paid, " +
        "incomplete = draft without lines, e.g. a dropped receipt), category, receipt attached or not. Amounts: net, VAT and gross (= amount payable to the supplier; " +
        "equals net for reverse charge / ig. Erwerb, where the VAT is self-assessed).",
      input: z.object({
        query: z.string().trim().max(200).optional().describe("e.g. supplier name"),
        from: isoDate.optional().describe("issue date from (inclusive)"),
        to: isoDate.optional().describe("issue date to (inclusive)"),
        status: z.enum(EXPENSE_STATUS_FILTERS).optional(),
        category: z.enum(EXPENSE_CATEGORY_KEYS).optional(),
        receipt: z.enum(EXPENSE_ATTACHMENT_FILTERS).optional().describe("with/without an attached receipt file"),
        limit: z.number().int().min(1).max(500).default(25),
      }),
      output: z.object({
        total: z.number().int(),
        truncated: z.boolean(),
        sumNet: Money,
        sumGross: Money,
        expenses: z.array(ExpenseRow.extend({ categories: z.array(z.string()) })),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, from, to, status, category, receipt, limit }) => {
      const all = await call(
        ctx.api.expenses.index.$get({ query: { q: query || undefined, from, to, status, category, attachment: receipt } }),
      );
      // the API's "open" also contains incomplete drafts; here they only come with status "incomplete"
      const rows = status === "open" ? all.filter((e) => !e.incomplete) : all;
      const expenses = rows.slice(0, limit).map((e) => ({ ...expenseRow(ctx, e), categories: e.categories.map(categoryLabel) }));
      const sumNet = rows.reduce((s, e) => s + e.netCents, 0);
      const sumGross = rows.reduce((s, e) => s + e.grossCents, 0);
      const text = [
        `${rows.length} Ausgaben${rows.length > expenses.length ? ` (die neuesten ${expenses.length} gezeigt)` : ""}, netto ${eur(sumNet)}, brutto ${eur(sumGross)}:`,
        bullets(
          expenses.map((e) =>
            join(
              `${e.number ?? "ohne Nummer"} (expense id ${e.id})`,
              e.supplier || "(kein Lieferant)",
              e.description,
              deDate(e.issueDate),
              `brutto ${e.gross.formatted}`,
              e.vatTreatment !== "domestic" && e.vatTreatmentLabel,
              e.categories.join(", "),
              e.statusLabel,
            ),
          ),
        ),
      ].join("\n");
      return { text, data: { total: rows.length, truncated: rows.length > expenses.length, sumNet: money(sumNet), sumGross: money(sumGross), expenses } };
    },
  );

  defineTool(
    server,
    "get_expense",
    {
      title: "Ausgabe anzeigen",
      group: "expenses",
      description:
        "Details of one expense by id: supplier, dates, VAT treatment, lines (EAR category, net, rate, VAT, deductible " +
        "share), totals, bank payments and open amount, the linked fixed-cost payment (Fixkosten) and the absolute path " +
        "of the attached receipt file.",
      input: z.object({ id: z.number().int().positive().describe("expense id") }),
      output: ExpenseDetail,
      annotations: READ_ONLY,
    },
    async ({ id }) => expenseDetail(ctx, id),
  );

  defineTool(
    server,
    "list_fixed_costs",
    {
      title: "Fixkosten auflisten",
      group: "expenses",
      description:
        "List fixed costs (Fixkosten: recurring outgoing payments such as rent, SVS, subscriptions) with interval, gross " +
        "per payment, contained deductible VAT, monthly equivalent, next payment date and how many past payments of the " +
        "last 90 days have no linked expense. Used by the forecast only; nothing is booked automatically.",
      input: z.object({ includeInactive: z.boolean().default(true) }),
      output: z.object({
        monthlyTotal: Money.describe("sum of the monthly equivalents of active, not ended entries"),
        fixedCosts: z.array(
          z.object({
            id: z.number().int(),
            name: z.string(),
            supplier: z.string(),
            category: z.string(),
            categoryLabel: z.string(),
            active: z.boolean(),
            ended: z.boolean(),
            interval: z.string(),
            startDate: z.string(),
            endDate: z.string().nullable(),
            nextPaymentDate: z.string().nullable(),
            gross: Money.describe("per payment"),
            tax: Money.describe("deductible VAT contained in gross"),
            monthly: Money,
            missingReceipts: z.number().int().describe("past payments (last 90 days) without a linked expense"),
            notes: z.string(),
          }),
        ),
        link: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ includeInactive }) => {
      const rows = (await call(ctx.api.recurringExpenses.index.$get())).filter((r) => includeInactive || r.active);
      const fixedCosts = rows.map((r) => ({
        id: r.id,
        name: r.name,
        supplier: r.supplierName,
        category: r.category,
        categoryLabel: categoryLabel(r.category),
        active: r.active,
        ended: r.ended,
        interval: intervalLabel(r),
        startDate: r.startDate,
        endDate: r.endDate,
        nextPaymentDate: r.nextPaymentDate,
        gross: money(r.grossCents),
        tax: money(r.taxCents),
        monthly: money(r.monthlyCents),
        missingReceipts: r.missingCount,
        notes: r.notes,
      }));
      const monthlyTotal = rows.filter((r) => r.active && !r.ended).reduce((s, r) => s + r.monthlyCents, 0);
      const text = [
        `${rows.length} Fixkosten, aktiv pro Monat ${eur(monthlyTotal)}:`,
        bullets(
          fixedCosts.map((f) =>
            join(
              `${f.name} (fixed cost id ${f.id})`,
              f.supplier,
              `${f.gross.formatted} ${f.interval}`,
              f.nextPaymentDate ? `nächste ${deDate(f.nextPaymentDate)}` : "beendet",
              !f.active && "inaktiv",
              f.missingReceipts > 0 && `${f.missingReceipts} ohne Beleg`,
            ),
          ),
        ),
      ].join("\n");
      return { text, data: { monthlyTotal: money(monthlyTotal), fixedCosts, link: ctx.webUrl("/fixed-costs") } };
    },
  );
}
