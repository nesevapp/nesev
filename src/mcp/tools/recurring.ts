import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { todayIso } from "../../shared/dates";
import { intervalLabel } from "../../shared/recurring";
import { call, idParam } from "../api";
import { bullets, deDate, join, Money, money } from "../format";
import { CHANGES_STATE, defineTool, READ_ONLY, type ToolContext } from "../tool";
import { DocumentDetail, documentDetail } from "./documents";

// Recurring invoices (Serienrechnungen): list, pause/resume, invoice the next period now. Creating and editing
// templates stays in the web app.

const RecurringRow = z.object({
  id: z.number().int(),
  name: z.string(),
  clientId: z.number().int(),
  client: z.string(),
  active: z.boolean(),
  interval: z.string().describe('German label, e.g. "monatlich"'),
  nextRunDate: z.string().describe("issue date of the next invoice"),
  endDate: z.string().nullable(),
  ended: z.boolean().describe("past its end date, nothing more is generated"),
  autoFinalize: z.boolean().describe("generated invoices are finalized right away (else drafts)"),
  net: Money.describe("per invoice"),
  gross: Money.describe("per invoice"),
  invoiceCount: z.number().int(),
  lastInvoiceDate: z.string().nullable(),
  link: z.string(),
});
type RecurringRow = z.input<typeof RecurringRow>;

interface ApiRecurring {
  id: number;
  name: string;
  clientId: number;
  clientName: string;
  active: boolean;
  intervalUnit: "month" | "year";
  intervalCount: number;
  nextRunDate: string;
  endDate: string | null;
  autoFinalize: boolean;
  netCents: number;
  grossCents: number;
}

function row(ctx: ToolContext, r: ApiRecurring, stats: { invoiceCount: number; lastInvoiceDate: string | null }): RecurringRow {
  return {
    id: r.id,
    name: r.name,
    clientId: r.clientId,
    client: r.clientName,
    active: r.active,
    interval: intervalLabel(r),
    nextRunDate: r.nextRunDate,
    endDate: r.endDate,
    ended: r.endDate != null && r.nextRunDate > r.endDate,
    autoFinalize: r.autoFinalize,
    net: money(r.netCents),
    gross: money(r.grossCents),
    invoiceCount: stats.invoiceCount,
    lastInvoiceDate: stats.lastInvoiceDate,
    link: ctx.webUrl(`/recurring/${r.id}`),
  };
}

const rowLine = (r: RecurringRow) =>
  join(
    `${r.name} (id ${r.id})`,
    r.client,
    r.interval,
    `${r.gross.formatted} brutto`,
    r.ended ? "beendet" : r.active ? `nächste ${deDate(r.nextRunDate)}` : "pausiert",
    r.autoFinalize ? "finalisiert automatisch" : "als Entwurf",
    `${r.invoiceCount} Rechnungen`,
  );

async function getRow(ctx: ToolContext, id: number): Promise<RecurringRow> {
  const r = await call(ctx.api.recurring[":id"].$get({ param: idParam(id) }));
  return row(ctx, r, { invoiceCount: r.invoices.length, lastInvoiceDate: r.invoices[0]?.issueDate ?? null });
}

export function registerRecurringTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "list_recurring_invoices",
    {
      title: "Serienrechnungen auflisten",
      group: "documents",
      description:
        "List recurring invoices (Serienrechnungen): client, interval, next issue date, amount per invoice, active or " +
        "paused, and whether generated invoices are finalized automatically or stay drafts. Active ones are generated " +
        "by the app on their date.",
      input: z.object({
        active: z.boolean().optional().describe("only active (true) or paused (false)"),
        clientId: z.number().int().positive().optional(),
      }),
      output: z.object({ count: z.number().int(), monthlyGross: Money.describe("active, converted to per month"), recurring: z.array(RecurringRow) }),
      annotations: READ_ONLY,
    },
    async ({ active, clientId }) => {
      const matching = (await call(ctx.api.recurring.index.$get())).filter(
        (r) => (active === undefined || r.active === active) && (!clientId || r.clientId === clientId),
      );
      const rows = matching.map((r) => row(ctx, r, r));
      const monthly = matching
        .filter((r) => r.active && !(r.endDate && r.nextRunDate > r.endDate))
        .reduce((s, r) => s + Math.round(r.grossCents / ((r.intervalUnit === "year" ? 12 : 1) * r.intervalCount)), 0);
      const text = [`${rows.length} Serienrechnungen, aktiv ${money(monthly).formatted} brutto pro Monat:`, bullets(rows.map(rowLine))].join("\n");
      return { text, data: { count: rows.length, monthlyGross: money(monthly), recurring: rows } };
    },
  );

  defineTool(
    server,
    "set_recurring_invoice_active",
    {
      title: "Serienrechnung pausieren/fortsetzen",
      group: "documents",
      description:
        "Pause (active: false) or resume (active: true) a recurring invoice. Paused ones generate nothing; on resume, " +
        "missed periods since the next issue date are caught up by the app's next run (each as its own invoice).",
      input: z.object({ id: z.number().int().positive(), active: z.boolean() }),
      output: RecurringRow,
      annotations: { ...CHANGES_STATE, idempotentHint: true },
    },
    async ({ id, active }) => {
      await call(ctx.api.recurring[":id"].$put({ param: idParam(id), json: { active } }));
      const data = await getRow(ctx, id);
      const catchUp = active && !data.ended && data.nextRunDate < todayIso() ? ` Achtung: Der nächste Termin ${deDate(data.nextRunDate)} liegt in der Vergangenheit; versäumte Perioden werden nachgeholt.` : "";
      return { text: `${active ? "Fortgesetzt" : "Pausiert"}: ${rowLine(data)}${catchUp}\nLink: ${data.link}`, data };
    },
  );

  defineTool(
    server,
    "generate_recurring_invoice",
    {
      title: "Serienrechnung jetzt erstellen",
      group: "documents",
      description:
        "Create the invoice for the next period of a recurring invoice now (issue date = the scheduled date, or today " +
        "when billing early) and advance its schedule by one interval. If the recurring invoice has autoFinalize, the " +
        "invoice is IRREVERSIBLY finalized (number, PDF); otherwise it is a draft. Confirm with the user first.",
      input: z.object({ id: z.number().int().positive().describe("recurring invoice id") }),
      output: DocumentDetail,
      annotations: CHANGES_STATE,
    },
    async ({ id }) => {
      const created = await call(ctx.api.recurring[":id"].generate.$post({ param: idParam(id) }));
      const r = await getRow(ctx, id);
      const d = await documentDetail(ctx, created.documentId);
      const state = created.finalized
        ? `finalisiert als ${d.data.number}`
        : created.error
          ? `bleibt Entwurf, Finalisieren fehlgeschlagen: ${created.error}`
          : "als Entwurf (mit finalize_document finalisieren)";
      return { text: `Rechnung aus Serienrechnung „${r.name}“ erstellt, ${state}. Nächster Termin ${deDate(r.nextRunDate)}.\n${d.text}`, data: d.data };
    },
  );
}
