import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatAssetNumber } from "../../shared/assets";
import { PERIOD_KEY_RE, VAT_BASIS_LABELS } from "../../shared/tax-report";
import { call } from "../api";
import { bullets, deDate, eur, join, Money, money } from "../format";
import { defineTool, READ_ONLY, type ToolContext } from "../tool";
import { documentPath } from "./documents";

// Forecast, tax reports (UVA / ZM / EAR) and the asset register (Anlagenverzeichnis / AfA).

const TAX_DISCLAIMER = "Hilfsrechnung aus den in nesev erfassten Daten, keine Steuerberatung. Vor der Abgabe prüfen (Steuerberater).";

const FORECAST_SOURCE_LABELS = {
  invoice: "Offene Rechnung",
  recurring: "Serienrechnung",
  offer: "Angebot (gewichtet)",
  draft: "Entwurf",
  fixed_cost: "Fixkosten",
  expense: "Offene Ausgabe",
  vat: "Umsatzsteuer",
  income_tax: "ESt-Vorauszahlung",
} as const;
const FORECAST_SOURCES = Object.keys(FORECAST_SOURCE_LABELS) as [keyof typeof FORECAST_SOURCE_LABELS, ...(keyof typeof FORECAST_SOURCE_LABELS)[]];

const flag = (b: boolean) => (b ? "1" : "0");

export function registerFinanceTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "get_forecast",
    {
      title: "Zahlungsprognose",
      group: "finance",
      description:
        "Cash-flow forecast for the next N months (gross amounts): expected inflows (open invoices on due date + the " +
        "client's average payment delay, planned recurring invoices, optionally drafts and weighted open offers) and " +
        "outflows (fixed costs, unpaid expenses, VAT payable per UVA period, income-tax prepayments). Returns KPIs, per-month " +
        "in/out/net and projected account balance (only if a start balance is set in the settings), the overdue bucket, and " +
        "the largest expected entries.",
      input: z.object({
        months: z.number().int().min(1).max(24).default(6),
        includeDrafts: z.boolean().default(false).describe("count draft invoices as inflows"),
        includeOffers: z.boolean().default(false).describe("count open offers, weighted by offerProbability"),
        offerProbability: z.number().int().min(0).max(100).default(50).describe("percent"),
        includeOutflows: z.boolean().default(true),
        topEntries: z.number().int().min(0).max(100).default(15).describe("number of largest entries to return"),
      }),
      output: z.object({
        today: z.string(),
        horizonEnd: z.string(),
        startBalance: z.object({ amount: Money, date: z.string() }).nullable().describe("from settings; null = no balance projection"),
        kpis: z.object({
          inNext30Days: Money,
          inNext90Days: Money,
          inTotal: Money,
          inOverdue: Money,
          inOverdueCount: z.number().int(),
          inRecurring: Money,
          vatContainedInInflows: Money,
          outNext30Days: Money,
          outTotal: Money,
          outOverdue: Money,
          outFixedCosts: Money,
          net: Money,
          endBalance: Money.nullable(),
          lowestBalance: z.object({ amount: Money, date: z.string() }).nullable(),
        }),
        overdue: z.object({ in: Money, out: Money }).describe("already due, counted as today"),
        months: z.array(
          z.object({
            month: z.string().describe("YYYY-MM"),
            start: z.string(),
            end: z.string(),
            in: Money,
            out: Money,
            net: Money,
            balanceEnd: Money.nullable(),
            lowestBalance: Money.nullable(),
          }),
        ),
        topEntries: z.array(
          z.object({
            expectedDate: z.string(),
            direction: z.enum(["in", "out"]),
            source: z.enum(FORECAST_SOURCES),
            sourceLabel: z.string(),
            party: z.string(),
            label: z.string(),
            number: z.string().nullable(),
            amount: Money.describe("expected amount (weighted for offers), always positive"),
            overdue: z.boolean(),
            estimated: z.boolean().describe("VAT: period not over yet, partly estimated"),
            link: z.string().nullable(),
          }),
        ),
        link: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ months, includeDrafts, includeOffers, offerProbability, includeOutflows, topEntries }) => {
      const f = await call(
        ctx.api.forecast.index.$get({
          query: {
            months: String(months),
            drafts: flag(includeDrafts),
            offers: flag(includeOffers),
            probability: String(offerProbability),
            outflows: flag(includeOutflows),
          },
        }),
      );
      const k = f.kpis;
      const entryLink = (e: (typeof f.entries)[number]) =>
        e.documentId && e.documentType
          ? ctx.webUrl(documentPath(e.documentType, e.documentId))
          : e.expenseId
            ? ctx.webUrl(`/expenses/${e.expenseId}`)
            : e.recurringInvoiceId
              ? ctx.webUrl(`/recurring/${e.recurringInvoiceId}`)
              : e.recurringExpenseId
                ? ctx.webUrl("/fixed-costs")
                : e.source === "vat"
                  ? ctx.webUrl("/tax")
                  : null;
      const top = [...f.entries]
        .sort((a, b) => b.grossCents - a.grossCents || a.expectedDate.localeCompare(b.expectedDate))
        .slice(0, topEntries)
        .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate))
        .map((e) => ({
          expectedDate: e.expectedDate,
          direction: e.direction,
          source: e.source,
          sourceLabel: FORECAST_SOURCE_LABELS[e.source],
          party: e.partyName,
          label: e.label,
          number: e.number,
          amount: money(e.grossCents),
          overdue: e.overdue,
          estimated: e.estimated,
          link: entryLink(e),
        }));
      const monthsOut = f.monthly.map((b) => ({
        month: b.key,
        start: b.start,
        end: b.end,
        in: money(b.inCents),
        out: money(b.outCents),
        net: money(b.netCents),
        balanceEnd: b.balanceCents === null ? null : money(b.balanceCents),
        lowestBalance: b.minBalanceCents === null ? null : money(b.minBalanceCents),
      }));
      const data = {
        today: f.today,
        horizonEnd: f.horizonEnd,
        startBalance: f.balance && { amount: money(f.balance.startCents), date: f.balance.date },
        kpis: {
          inNext30Days: money(k.next30),
          inNext90Days: money(k.next90),
          inTotal: money(k.total),
          inOverdue: money(k.overdue),
          inOverdueCount: k.overdueCount,
          inRecurring: money(k.recurring),
          vatContainedInInflows: money(k.tax),
          outNext30Days: money(k.outNext30),
          outTotal: money(k.outTotal),
          outOverdue: money(k.outOverdue),
          outFixedCosts: money(k.fixedCosts),
          net: money(k.netTotal),
          endBalance: k.endBalance === null ? null : money(k.endBalance),
          lowestBalance: k.lowestBalance && { amount: money(k.lowestBalance.cents), date: k.lowestBalance.date },
        },
        overdue: { in: money(f.overdueBucket.inCents), out: money(f.overdueBucket.outCents) },
        months: monthsOut,
        topEntries: top,
        link: ctx.webUrl(`/forecast?months=${months}`),
      };
      const text = [
        `Prognose ${deDate(f.today)} bis ${deDate(f.horizonEnd)} (${months} Monate, brutto):`,
        `- Eingänge: 30 Tage ${eur(k.next30)}, 90 Tage ${eur(k.next90)}, gesamt ${eur(k.total)} (davon überfällig ${eur(k.overdue)} in ${k.overdueCount} Posten, Serienrechnungen ${eur(k.recurring)})`,
        includeOutflows ? `- Ausgänge: 30 Tage ${eur(k.outNext30)}, gesamt ${eur(k.outTotal)} (Fixkosten ${eur(k.fixedCosts)}, überfällig ${eur(k.outOverdue)})` : "- Ausgänge: nicht berücksichtigt",
        `- Bereits fällig (zählt mit heute): ein ${eur(f.overdueBucket.inCents)}, aus ${eur(f.overdueBucket.outCents)}`,
        `- Saldo ${eur(k.netTotal)}`,
        f.balance
          ? `- Kontostand: Start ${eur(f.balance.startCents)} am ${deDate(f.balance.date)}, Ende ${eur(k.endBalance ?? 0)}` +
            (k.lowestBalance ? `, Tiefststand ${eur(k.lowestBalance.cents)} am ${deDate(k.lowestBalance.date)}` : "")
          : "- Kein Startkontostand gesetzt (Einstellungen → Zahlungsprognose), daher keine Kontostandsprognose",
        "Monate (ein / aus / netto" + (f.balance ? " / Kontostand Ende" : "") + "):",
        bullets(monthsOut.map((m) => join(m.month, m.in.formatted, m.out.formatted, m.net.formatted, m.balanceEnd?.formatted))),
        top.length ? "Größte Posten:" : null,
        top.length
          ? bullets(
              top.map((e) =>
                join(
                  deDate(e.expectedDate),
                  `${e.direction === "in" ? "+" : "−"}${e.amount.formatted}`,
                  e.sourceLabel,
                  e.party,
                  e.label,
                  e.overdue && "überfällig",
                  e.estimated && "geschätzt",
                ),
              ),
            )
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data };
    },
  );

  defineTool(
    server,
    "get_tax_report",
    {
      title: "Steuerauswertung",
      group: "finance",
      description:
        "Austrian tax helper reports, computed from the data in nesev (a helper, NOT tax advice): " +
        "kind=uva → Umsatzsteuervoranmeldung (U30) Kennzahlen for a month or quarter (KZ, Bemessungsgrundlage, USt) and " +
        "the Zahllast/Gutschrift (KZ 095); kind=zm → Zusammenfassende Meldung per EU customer UID; kind=ear → " +
        "Einnahmen-Ausgaben-Rechnung for a year (cash basis) with E1a Kennzahlen and expense categories. Period format: " +
        '"2026-03" (month), "2026-Q1" (quarter); default = last completed period per the settings. For ear pass `year`. ' +
        "Always relay the warnings.",
      input: z.object({
        kind: z.enum(["uva", "zm", "ear"]),
        period: z.string().regex(PERIOD_KEY_RE, "Zeitraum JJJJ-MM, JJJJ-Qn oder JJJJ").optional().describe("uva/zm: YYYY-MM or YYYY-Qn"),
        year: z.number().int().min(2000).max(2100).optional().describe("ear: calendar year, default current year"),
        euServicesIn021: z.boolean().default(false).describe("uva: report EU B2B services in KZ 000/021 instead of ZM only"),
      }),
      output: z.object({
        kind: z.enum(["uva", "zm", "ear"]),
        period: z.object({ key: z.string(), label: z.string(), from: z.string(), to: z.string() }),
        dueDate: z.string().nullable(),
        basis: z.string().nullable().describe("uva: Soll-/Istbesteuerung"),
        summary: z.array(z.object({ label: z.string(), amount: Money })),
        lines: z
          .array(z.object({ code: z.string().describe("KZ, E1a-KZ or UID"), label: z.string(), amount: Money, tax: Money.nullable() }))
          .describe("uva: non-zero Kennzahlen; zm: one row per UID; ear: E1a Kennzahlen (income and expenses)"),
        breakdown: z
          .array(z.object({ group: z.string(), label: z.string(), code: z.string(), amount: Money }))
          .describe("uva: info lines not in the form; ear: expense categories"),
        warnings: z.array(z.string()),
        disclaimer: z.string(),
        link: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ kind, period, year, euServicesIn021 }) => {
      if (kind === "uva") {
        const r = await call(ctx.api.tax.uva.$get({ query: { period, euIn021: euServicesIn021 ? "1" : undefined } }));
        const lines = r.lines
          .filter((l) => l.amountCents !== 0 || (l.taxCents ?? 0) !== 0 || l.kz === "095")
          .map((l) => ({ code: l.kz, label: l.label, amount: money(l.amountCents), tax: l.taxCents === null ? null : money(l.taxCents) }));
        const summary = [
          { label: "Umsatzsteuer", amount: money(r.vatCents) },
          { label: "Vorsteuer", amount: money(r.inputVatCents) },
          { label: r.resultCents >= 0 ? "Zahllast (KZ 095)" : "Gutschrift (KZ 095)", amount: money(r.resultCents) },
        ];
        const breakdown = r.info.filter((i) => i.netCents !== 0).map((i) => ({ group: "Info", label: `${i.label} – ${i.hint}`, code: i.key, amount: money(i.netCents) }));
        const warnings = [...(r.empty ? ["Keine Umsätze oder Ausgaben im Zeitraum."] : []), ...(r.smallBusiness ? ["Kleinunternehmer: keine UVA nötig."] : []), ...r.warnings];
        const text = [
          `UVA ${r.period.label} · ${VAT_BASIS_LABELS[r.basis]} · fällig ${deDate(r.dueDate)}:`,
          bullets(lines.map((l) => join(`KZ ${l.code} ${l.label}`, l.amount.formatted, l.tax && `USt ${l.tax.formatted}`))),
          join(...summary.map((s) => `${s.label} ${s.amount.formatted}`)),
          breakdown.length ? `Info:\n${bullets(breakdown.map((b) => `${b.label}: ${b.amount.formatted}`))}` : null,
          warnings.length ? `Hinweise:\n${bullets(warnings)}` : null,
          TAX_DISCLAIMER,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          text,
          data: {
            kind,
            period: pick(r.period),
            dueDate: r.dueDate,
            basis: VAT_BASIS_LABELS[r.basis],
            summary,
            lines,
            breakdown,
            warnings,
            disclaimer: TAX_DISCLAIMER,
            link: ctx.webUrl(`/tax?tab=uva&period=${r.period.key}`),
          },
        };
      }

      if (kind === "zm") {
        const r = await call(ctx.api.tax.zm.$get({ query: { period } }));
        const lines = r.rows.map((row) => ({
          code: row.uid || "(keine UID)",
          label: `${row.clientNames.join(", ")} (${row.country})${row.triangular ? " · Dreiecksgeschäft" : ""}${row.services ? " · sonstige Leistungen" : ""}`,
          amount: money(row.amountCents),
          tax: null,
        }));
        const summary = [{ label: "Summe", amount: money(r.totalCents) }];
        const text = [
          `ZM ${r.period.label}, fällig ${deDate(r.dueDate)}:`,
          bullets(lines.map((l) => join(l.code, l.label, l.amount.formatted)), "(keine meldepflichtigen Umsätze)"),
          `Summe ${eur(r.totalCents)}`,
          r.warnings.length ? `Hinweise:\n${bullets(r.warnings)}` : null,
          TAX_DISCLAIMER,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          text,
          data: {
            kind,
            period: pick(r.period),
            dueDate: r.dueDate,
            basis: null,
            summary,
            lines,
            breakdown: [],
            warnings: r.warnings,
            disclaimer: TAX_DISCLAIMER,
            link: ctx.webUrl(`/tax?tab=zm&period=${r.period.key}`),
          },
        };
      }

      const y = year ?? (period ? Number(period.slice(0, 4)) : undefined);
      const r = await call(ctx.api.tax.ear.$get({ query: { year: y === undefined ? undefined : String(y) } }));
      // e1a already contains the income (KZ 9040)
      const lines = r.e1a.map((e) => ({ code: e.kz, label: e.label, amount: money(e.amountCents), tax: null }));
      const breakdown = r.groups.flatMap((g) =>
        g.categories.filter((c) => c.amountCents !== 0).map((c) => ({ group: g.group, label: c.label, code: c.e1aKz, amount: money(c.amountCents) })),
      );
      const summary = [
        { label: "Einnahmen", amount: money(r.incomeCents) },
        { label: "Ausgaben", amount: money(r.expensesCents) },
        { label: r.profitCents >= 0 ? "Gewinn" : "Verlust", amount: money(r.profitCents) },
      ];
      const unpaid = r.unpaid.reduce((s, u) => s + u.openCents, 0);
      const warnings = [...r.warnings, ...(r.unpaid.length ? [`${r.unpaid.length} Posten des Jahres zum Jahresende offen (${eur(unpaid)}), nicht in dieser EAR.`] : [])];
      const text = [
        `EAR ${r.year} (Zuflussprinzip, ${r.gross ? "brutto (Kleinunternehmer)" : "netto"}):`,
        join(...summary.map((s) => `${s.label} ${s.amount.formatted}`)),
        "E1a:",
        bullets(lines.map((l) => `KZ ${l.code} ${l.label}: ${l.amount.formatted}`)),
        breakdown.length ? `Kategorien:\n${bullets(breakdown.map((b) => `${b.group} / ${b.label} (KZ ${b.code}): ${b.amount.formatted}`))}` : null,
        warnings.length ? `Hinweise:\n${bullets(warnings)}` : null,
        TAX_DISCLAIMER,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        data: {
          kind,
          period: { key: String(r.year), label: String(r.year), from: `${r.year}-01-01`, to: `${r.year}-12-31` },
          dueDate: null,
          basis: null,
          summary,
          lines,
          breakdown,
          warnings,
          disclaimer: TAX_DISCLAIMER,
          link: ctx.webUrl(`/tax?tab=ear&year=${r.year}`),
        },
      };
    },
  );

  defineTool(
    server,
    "list_assets",
    {
      title: "Anlagenverzeichnis",
      group: "finance",
      description:
        "Asset register (Anlagenverzeichnis) for one year (default current year): per asset the cost, book value at 1.1., " +
        "straight-line AfA (depreciation) of the year, write-off on disposal, accumulated AfA and book value at 31.12., " +
        "plus totals. AfA follows the Austrian half-year rule. A helper, not tax advice.",
      input: z.object({ year: z.number().int().min(1900).max(2999).optional() }),
      output: z.object({
        year: z.number().int(),
        totals: z.object({ cost: Money, bookValueStart: Money, afa: Money, disposalWriteOff: Money, bookValueEnd: Money, disposalProceeds: Money }),
        assets: z.array(
          z.object({
            id: z.number().int(),
            number: z.string().describe('e.g. "AV-0001"'),
            name: z.string(),
            acquisitionDate: z.string(),
            inServiceDate: z.string(),
            usefulLifeYears: z.number().int(),
            cost: Money,
            bookValueStart: Money,
            afa: Money,
            disposalWriteOff: Money,
            accumulatedAfa: Money,
            bookValueEnd: Money,
            disposalDate: z.string().nullable(),
            disposedThisYear: z.boolean(),
            expense: z.object({ id: z.number().int(), number: z.string().nullable(), supplier: z.string(), link: z.string() }).nullable(),
            link: z.string(),
          }),
        ),
        notInRegisterCount: z.number().int().describe("assets put in service later or disposed earlier"),
        link: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ year }) => {
      const r = await call(ctx.api.assets.index.$get({ query: { year: year === undefined ? undefined : String(year) } }));
      const t = r.totals;
      const assets = r.rows.map((a) => ({
        id: a.id,
        number: formatAssetNumber(a.number),
        name: a.name,
        acquisitionDate: a.acquisitionDate,
        inServiceDate: a.inServiceDate,
        usefulLifeYears: a.usefulLifeYears,
        cost: money(a.costCents),
        bookValueStart: money(a.startCents),
        afa: money(a.afaCents),
        disposalWriteOff: money(a.disposalCents),
        accumulatedAfa: money(a.accumulatedCents),
        bookValueEnd: money(a.endCents),
        disposalDate: a.disposalDate,
        disposedThisYear: a.disposedThisYear,
        expense: a.expense && { id: a.expense.id, number: a.expense.number, supplier: a.expense.supplierName, link: ctx.webUrl(`/expenses/${a.expense.id}`) },
        link: ctx.webUrl(`/assets/${a.id}`),
      }));
      const text = [
        `Anlagenverzeichnis ${r.year}: ${assets.length} Anlagen, AfA ${eur(t.afaCents)}, Buchwert 1.1. ${eur(t.startCents)} → 31.12. ${eur(t.endCents)}` +
          (t.disposalCents ? `, Restbuchwert-Abgang ${eur(t.disposalCents)}` : ""),
        bullets(
          assets.map((a) =>
            join(
              `${a.number} ${a.name} (asset id ${a.id})`,
              `in Betrieb ${deDate(a.inServiceDate)}`,
              `${a.usefulLifeYears} J.`,
              `AK ${a.cost.formatted}`,
              `AfA ${a.afa.formatted}`,
              `Buchwert 31.12. ${a.bookValueEnd.formatted}`,
              a.disposalDate && `ausgeschieden ${deDate(a.disposalDate)}`,
            ),
          ),
          "(keine Anlagen in diesem Jahr)",
        ),
        r.hiddenCount ? `${r.hiddenCount} weitere Anlagen nicht in diesem Jahr (später in Betrieb oder früher ausgeschieden).` : null,
        "Hilfsrechnung, keine Steuerberatung.",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        text,
        data: {
          year: r.year,
          totals: {
            cost: money(t.costCents),
            bookValueStart: money(t.startCents),
            afa: money(t.afaCents),
            disposalWriteOff: money(t.disposalCents),
            bookValueEnd: money(t.endCents),
            disposalProceeds: money(t.proceedsCents),
          },
          assets,
          notInRegisterCount: r.hiddenCount,
          link: ctx.webUrl(`/assets?year=${r.year}`),
        },
      };
    },
  );
}

const pick = (p: { key: string; label: string; from: string; to: string }) => ({ key: p.key, label: p.label, from: p.from, to: p.to });
