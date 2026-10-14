import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { call } from "../api";
import { bullets, deDate, eur, join, Money, money } from "../format";
import { defineTool, READ_ONLY, type ToolContext } from "../tool";

// Entry points: global search and the dashboard.

const SEARCH_TYPES = [
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

const MONTHS = ["Jän", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export function registerOverviewTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "search",
    {
      title: "Suchen",
      group: "core",
      description:
        "Global search across nesev: clients, invoices, offers, credit notes, reminders (Mahnungen), recurring invoices, " +
        "expenses, fixed costs (Fixkosten), assets (Anlagen) and articles. Use it first to find ids for the get_* tools. " +
        "Matches names/text (umlaut-insensitive), numbers in any spelling (RE-2026-0012, re12, 12, K-0003) and amounts " +
        '("1.234,56", "500 €"). Returns results grouped by type with id, label, details and a web link.',
      input: z.object({
        query: z.string().trim().min(1).max(200).describe("search text, number or amount"),
        limit: z.number().int().min(1).max(20).default(6).describe("max results per group (default 6)"),
      }),
      output: z.object({
        query: z.string(),
        results: z.array(
          z.object({
            type: z.enum(SEARCH_TYPES),
            typeLabel: z.string(),
            id: z.number().int(),
            label: z.string(),
            sublabel: z.string(),
            meta: z.string(),
            link: z.string(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const res = await call(ctx.api.search.index.$get({ query: { q: query, limit: String(limit) } }));
      const results = res.groups.flatMap((g) =>
        g.results.map((r) => ({
          type: r.type,
          typeLabel: g.label,
          id: r.id,
          label: r.label,
          sublabel: r.sublabel,
          meta: r.meta,
          link: ctx.webUrl(r.path),
        })),
      );
      const text = res.groups.length
        ? res.groups
            .map((g) => `${g.label}:\n${bullets(g.results.map((r) => join(`${r.label} (${r.type} id ${r.id})`, r.sublabel, r.meta)))}`)
            .join("\n")
        : `Keine Treffer für „${query}“.`;
      return { text, data: { query, results } };
    },
  );

  defineTool(
    server,
    "get_dashboard",
    {
      title: "Dashboard",
      group: "core",
      description:
        "Business overview for one calendar year (default: current year): KPIs (net revenue and net expenses vs. previous " +
        "year, result, received payments, open and overdue invoices, open offers), net revenue/expenses/result per month, " +
        "and the overdue invoices with their open amounts. Revenue is net of credit notes; expenses count by document date.",
      input: z.object({
        year: z.number().int().min(2000).max(2100).optional().describe("calendar year, default current year"),
      }),
      output: z.object({
        year: z.number().int(),
        today: z.string(),
        kpis: z.object({
          revenue: Money,
          revenuePreviousYear: Money,
          expenses: Money,
          expensesPreviousYear: Money,
          result: Money,
          paid: z.object({ count: z.number().int(), amount: Money }),
          openInvoices: z.object({ count: z.number().int(), amount: Money }),
          overdue: z.object({ count: z.number().int(), amount: Money }),
          openOffers: z.object({ count: z.number().int(), amount: Money }),
        }),
        monthly: z.array(
          z.object({ month: z.string().describe("YYYY-MM"), revenue: Money, expenses: Money, result: Money }),
        ),
        overdueInvoices: z.array(
          z.object({
            id: z.number().int(),
            number: z.string().nullable(),
            client: z.string(),
            dueDate: z.string().nullable(),
            daysOverdue: z.number().int(),
            gross: Money,
            open: Money,
            partiallyPaid: z.boolean(),
            link: z.string(),
          }),
        ),
        link: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ year }) => {
      const d = await call(ctx.api.dashboard.index.$get({ query: { year: year === undefined ? undefined : String(year) } }));
      const k = d.kpis;
      const figure = (f: { count: number; cents: number }) => ({ count: f.count, amount: money(f.cents) });
      const monthly = d.monthly.map((m) => ({
        month: `${d.year}-${String(m.month + 1).padStart(2, "0")}`,
        revenue: money(m.cents),
        expenses: money(m.expenseCents),
        result: money(m.cents - m.expenseCents),
      }));
      const overdueInvoices = d.overdue.map((o) => ({
        id: o.id,
        number: o.number,
        client: o.clientName,
        dueDate: o.dueDate,
        daysOverdue: o.daysOverdue,
        gross: money(o.grossCents),
        open: money(o.openCents),
        partiallyPaid: o.partial,
        link: ctx.webUrl(`/invoices/${o.id}`),
      }));
      const result = k.revenue.cents - k.expenses.cents;
      const text = [
        `Dashboard ${d.year} (Stand ${deDate(d.today)}):`,
        `- Umsatz netto ${eur(k.revenue.cents)} (Vorjahr ${eur(k.revenue.previousCents)}), Ausgaben netto ${eur(k.expenses.cents)} (Vorjahr ${eur(k.expenses.previousCents)}), Ergebnis ${eur(result)}`,
        `- Bezahlt: ${k.paid.count} Rechnungen, ${eur(k.paid.cents)}`,
        `- Offene Rechnungen: ${k.openInvoices.count}, ${eur(k.openInvoices.cents)}; davon überfällig: ${k.overdue.count}, ${eur(k.overdue.cents)}`,
        `- Offene Angebote: ${k.openOffers.count}, ${eur(k.openOffers.cents)}`,
        `Monate (Umsatz / Ausgaben / Ergebnis): ${d.monthly
          .filter((m) => m.cents || m.expenseCents)
          .map((m) => `${MONTHS[m.month]} ${eur(m.cents)} / ${eur(m.expenseCents)} / ${eur(m.cents - m.expenseCents)}`)
          .join("; ") || "keine Buchungen"}`,
        `Überfällige Rechnungen:`,
        bullets(
          d.overdue.map((o) =>
            join(`${o.number} (id ${o.id})`, o.clientName, `fällig ${deDate(o.dueDate)}`, `${o.daysOverdue} Tage`, `offen ${eur(o.openCents)}`),
          ),
          "(keine)",
        ),
      ].join("\n");
      return {
        text,
        data: {
          year: d.year,
          today: d.today,
          kpis: {
            revenue: money(k.revenue.cents),
            revenuePreviousYear: money(k.revenue.previousCents),
            expenses: money(k.expenses.cents),
            expensesPreviousYear: money(k.expenses.previousCents),
            result: money(result),
            paid: figure(k.paid),
            openInvoices: figure(k.openInvoices),
            overdue: figure(k.overdue),
            openOffers: figure(k.openOffers),
          },
          monthly,
          overdueInvoices,
          link: ctx.webUrl(`/?year=${d.year}`),
        },
      };
    },
  );
}
