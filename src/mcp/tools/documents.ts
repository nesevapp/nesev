import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCUMENT_STATUSES, DOCUMENT_TYPES, type DocumentType } from "../../shared/documents";
import { TAX_MODE_LABELS, TAX_MODES } from "../../shared/tax";
import { calcTotals } from "../../shared/totals";
import { call, idParam } from "../api";
import { bullets, deDate, docStatusLabel, docTypeLabel, eur, isoDate, join, Money, money, percent, qty } from "../format";
import { defineTool, READ_ONLY, type ToolContext, type ToolOutput } from "../tool";

// Offers, invoices, credit notes and the dunning list.

const DOC_PATHS: Record<DocumentType, string> = { offer: "/offers", invoice: "/invoices", credit_note: "/credit-notes" };
export const documentPath = (type: DocumentType, id: number) => `${DOC_PATHS[type]}/${id}`;

const LIST_STATUSES = [...DOCUMENT_STATUSES, "overdue", "open"] as const;

const DocRef = z.object({
  id: z.number().int(),
  type: z.enum(DOCUMENT_TYPES),
  number: z.string().nullable(),
  status: z.enum(DOCUMENT_STATUSES),
  statusLabel: z.string(),
  link: z.string(),
});

const DocumentRow = z.object({
  id: z.number().int(),
  type: z.enum(DOCUMENT_TYPES),
  typeLabel: z.string(),
  number: z.string().nullable().describe("null for drafts"),
  clientId: z.number().int(),
  client: z.string(),
  title: z.string(),
  issueDate: z.string(),
  dueDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  paidAt: z.string().nullable(),
  net: Money,
  gross: Money,
  open: Money.nullable().describe("finalized invoices: gross − credit notes − bank payments; null otherwise"),
  status: z.enum(DOCUMENT_STATUSES),
  statusLabel: z.string(),
  overdue: z.boolean(),
  partiallyPaid: z.boolean(),
  link: z.string(),
});

/** Finalized and not settled: invoices with an open amount, offers awaiting an answer. */
function isOpen(d: { type: DocumentType; status: string; openCents: number | null }) {
  if (d.status !== "final" && d.status !== "sent") return false;
  if (d.type === "invoice") return (d.openCents ?? 0) > 0;
  return d.type === "offer";
}

/** get_document output; write tools that change a document return it too. */
export const DocumentDetail = z.object({
  ...DocumentRow.shape,
  client: z.object({ id: z.number().int(), name: z.string(), address: z.string(), uid: z.string() }),
  servicePeriodStart: z.string().nullable(),
  servicePeriodEnd: z.string().nullable(),
  sentAt: z.string().nullable(),
  finalizedAt: z.string().nullable(),
  taxMode: z.enum(TAX_MODES),
  taxModeLabel: z.string(),
  introText: z.string(),
  closingText: z.string(),
  items: z.array(
    z.object({
      position: z.number().int(),
      title: z.string(),
      description: z.string(),
      quantity: z.number(),
      unit: z.string(),
      unitPrice: Money,
      discountPercent: z.number(),
      taxRatePercent: z.number().describe("rate actually applied under the tax mode"),
      net: Money,
      articleId: z.number().int().nullable(),
    }),
  ),
  tax: Money,
  taxGroups: z.array(z.object({ ratePercent: z.number(), net: Money, tax: Money })),
  payment: z
    .object({
      credited: Money.describe("finalized credit notes"),
      paid: Money.describe("bank payments on the invoice minus refunds paid out on its credit notes"),
      open: Money.describe("gross − credited − paid; negative = overpaid"),
      payments: z.array(
        z.object({
          date: z.string(),
          amount: Money.describe("negative for a refund"),
          kind: z.enum(["payment", "refund"]).describe("refund = money paid back to the client on a credit note of this invoice"),
          account: z.string(),
          counterparty: z.string(),
          purpose: z.string(),
        }),
      ),
    })
    .nullable()
    .describe("finalized invoices only"),
  parent: DocRef.nullable(),
  children: z.array(DocRef.extend({ gross: Money })),
  pdf: z.object({ path: z.string().describe("absolute file path"), url: z.string() }).nullable(),
});

/** Full document as text + structured data (get_document and the document write tools). */
export async function documentDetail(ctx: ToolContext, id: number): Promise<ToolOutput<z.input<typeof DocumentDetail>>> {
  const d = await call(ctx.api.documents[":id"].$get({ param: idParam(id) }));
  const isFinalInvoice = d.type === "invoice" && d.status !== "draft";
  const [payments, children] = await Promise.all([
    isFinalInvoice ? call(ctx.api.bank.documents[":id"].payments.$get({ param: idParam(id) })) : null,
    Promise.all(d.children.map((c) => call(ctx.api.documents[":id"].$get({ param: idParam(c.id) })))),
  ]);
  const client = d.clientSnapshot
    ? { id: d.clientId, name: d.clientSnapshot.name, address: snapshotAddress(d.clientSnapshot), uid: d.clientSnapshot.uid ?? "" }
    : await liveClient(ctx, d.clientId);
  const totals = calcTotals(d.items, d.taxMode);
  const ref = (r: { id: number; type: DocumentType; number: string | null; status: (typeof DOCUMENT_STATUSES)[number] }) => ({
    id: r.id,
    type: r.type,
    number: r.number,
    status: r.status,
    statusLabel: docStatusLabel(r),
    link: ctx.webUrl(documentPath(r.type, r.id)),
  });
  const items = d.items.map((it, i) => ({
    position: i + 1,
    title: it.title,
    description: it.description,
    quantity: qty(it.quantity),
    unit: it.unit,
    unitPrice: money(it.unitPriceCents),
    discountPercent: percent(it.discountBp),
    taxRatePercent: percent(totals.lines[i]!.taxRateBp),
    net: money(totals.lines[i]!.netCents),
    articleId: it.articleId,
  }));
  const payment = payments && {
    credited: money(payments.creditedCents),
    paid: money(payments.paidCents),
    open: money(payments.openCents),
    payments: payments.payments.map((p) => ({
      date: p.bookingDate,
      amount: money(p.amountCents),
      kind: p.kind,
      account: p.accountName,
      counterparty: p.counterpartyName,
      purpose: p.purpose,
    })),
  };
  const pdf = d.pdfPath ? { path: ctx.dataPath(d.pdfPath), url: ctx.webUrl(`/api/files/${d.pdfPath}`) } : null;
  const data = {
    id: d.id,
    type: d.type,
    typeLabel: docTypeLabel(d.type),
    number: d.number,
    clientId: d.clientId,
    client,
    title: d.title,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    validUntil: d.validUntil,
    paidAt: d.paidAt,
    net: money(d.netCents),
    gross: money(d.grossCents),
    open: d.openCents === null ? null : money(d.openCents),
    status: d.status,
    statusLabel: docStatusLabel(d),
    overdue: d.overdue,
    partiallyPaid: d.partial,
    link: ctx.webUrl(documentPath(d.type, d.id)),
    servicePeriodStart: d.servicePeriodStart,
    servicePeriodEnd: d.servicePeriodEnd,
    sentAt: d.sentAt,
    finalizedAt: d.finalizedAt,
    taxMode: d.taxMode,
    taxModeLabel: TAX_MODE_LABELS[d.taxMode],
    introText: d.introText,
    closingText: d.closingText,
    items,
    tax: money(d.taxCents),
    taxGroups: totals.taxGroups.map((g) => ({ ratePercent: percent(g.rateBp), net: money(g.netCents), tax: money(g.taxCents) })),
    payment,
    parent: d.parent && ref(d.parent),
    children: children.map((c) => ({ ...ref(c), gross: money(c.grossCents) })),
    pdf,
  };

  const text = [
    `${docTypeLabel(d.type)} ${d.number ?? "(Entwurf, noch ohne Nummer)"} (id ${d.id}) · ${docStatusLabel(d)}`,
    join(`Kunde: ${client.name} (id ${client.id})`, client.address, client.uid && `UID ${client.uid}`),
    join(
      `Datum ${deDate(d.issueDate)}`,
      d.servicePeriodStart && `Leistung ${deDate(d.servicePeriodStart)}–${deDate(d.servicePeriodEnd)}`,
      d.dueDate && d.type !== "offer" && `fällig ${deDate(d.dueDate)}`,
      d.validUntil && `gültig bis ${deDate(d.validUntil)}`,
      d.paidAt && `bezahlt ${deDate(d.paidAt)}`,
    ),
    d.title && `Titel: ${d.title}`,
    `Steuer: ${TAX_MODE_LABELS[d.taxMode]}`,
    "Positionen:",
    bullets(
      items.map((it) =>
        join(
          `${it.position}. ${it.title}`,
          `${it.quantity} ${it.unit} × ${it.unitPrice.formatted}`,
          it.discountPercent ? `−${it.discountPercent} %` : null,
          `${it.taxRatePercent} % USt`,
          `netto ${it.net.formatted}`,
        ),
      ),
    ),
    `Netto ${eur(d.netCents)} · USt ${eur(d.taxCents)} · Brutto ${eur(d.grossCents)}`,
    payment &&
      "Zahlung: " +
        join(
        `gutgeschrieben ${payment.credited.formatted}`,
        `bezahlt ${payment.paid.formatted}`,
        `offen ${payment.open.formatted}`,
        payment.payments.length ? `${payment.payments.length} Bankbuchung(en)` : null,
      ),
    d.parent && `Bezug: ${d.parent.number ?? "Entwurf"} (${d.parent.type} id ${d.parent.id})`,
    children.length &&
      `Folgebelege: ${children.map((c) => `${c.number ?? "Entwurf"} (${c.type} id ${c.id}, ${eur(c.grossCents)}, ${docStatusLabel(c)})`).join(", ")}`,
    pdf ? `PDF: ${pdf.path}` : null,
    `Link: ${data.link}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { text, data };
}

export function registerDocumentTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "list_documents",
    {
      title: "Belege auflisten",
      group: "documents",
      description:
        "List offers (Angebote), invoices (Rechnungen) and credit notes (Gutschriften), newest issue date first. Filters: type, " +
        'status (draft|final|sent|accepted|declined|paid, or "overdue" = unpaid invoices past due date, or "open" = invoices ' +
        "with an amount still open plus offers awaiting an answer), clientId, issue date range, text query (number, client, " +
        "title). Rows contain number, client, dates, net/gross, the open amount of finalized invoices (gross − credit notes − " +
        "bank payments) and the German status label. Credit notes have positive amounts that reduce revenue. Sums: " +
        "sumByType has the gross per type; sumGross is the billed gross, i.e. invoices minus credit notes (offers are " +
        "not counted), or with a type filter simply the gross of that type.",
      input: z.object({
        type: z.enum(DOCUMENT_TYPES).optional(),
        status: z.enum(LIST_STATUSES).optional(),
        clientId: z.number().int().positive().optional(),
        query: z.string().trim().max(200).optional().describe("matches number, client name and title"),
        from: isoDate.optional().describe("issue date from (inclusive)"),
        to: isoDate.optional().describe("issue date to (inclusive)"),
        limit: z.number().int().min(1).max(200).default(25),
      }),
      output: z.object({
        total: z.number().int().describe("matching documents before the limit"),
        truncated: z.boolean(),
        sumGross: Money.describe(
          "without type filter: gross of matching invoices minus gross of matching credit notes (offers excluded); with a type filter: gross of the matching documents",
        ),
        sumByType: z
          .object({ invoices: Money, creditNotes: Money, offers: Money })
          .describe("gross of all matching documents per type (credit notes positive)"),
        sumOpen: Money.describe("open amount of all matching invoices"),
        documents: z.array(DocumentRow),
      }),
      annotations: READ_ONLY,
    },
    async ({ type, status, clientId, query, from, to, limit }) => {
      const rows = await call(
        ctx.api.documents.index.$get({
          query: {
            type,
            status: status === "open" ? undefined : status,
            clientId: clientId ? String(clientId) : undefined,
            q: query || undefined,
            from,
            to,
          },
        }),
      );
      const matching = status === "open" ? rows.filter(isOpen) : rows;
      const shown = matching.slice(0, limit);
      const documents = shown.map((d) => ({
        id: d.id,
        type: d.type,
        typeLabel: docTypeLabel(d.type),
        number: d.number,
        clientId: d.clientId,
        client: d.clientName,
        title: d.title,
        issueDate: d.issueDate,
        dueDate: d.dueDate,
        validUntil: d.validUntil,
        paidAt: d.paidAt,
        net: money(d.netCents),
        gross: money(d.grossCents),
        open: d.openCents === null ? null : money(d.openCents),
        status: d.status,
        statusLabel: docStatusLabel(d),
        overdue: d.overdue,
        partiallyPaid: d.partial,
        link: ctx.webUrl(documentPath(d.type, d.id)),
      }));
      const byType = (t: DocumentType) => matching.filter((d) => d.type === t).reduce((s, d) => s + d.grossCents, 0);
      const sums = { invoices: byType("invoice"), creditNotes: byType("credit_note"), offers: byType("offer") };
      const sumGross = type ? sums[type === "invoice" ? "invoices" : type === "credit_note" ? "creditNotes" : "offers"] : sums.invoices - sums.creditNotes;
      const typesPresent = [sums.invoices, sums.creditNotes, sums.offers].filter(Boolean).length;
      const breakdown = type || typesPresent < 2
        ? null
        : join(
            sums.invoices ? `Rechnungen ${eur(sums.invoices)}` : null,
            sums.creditNotes ? `Gutschriften −${eur(sums.creditNotes)}` : null,
            sums.offers ? `Angebote ${eur(sums.offers)} (nicht in der Summe)` : null,
          );
      const sumOpen = matching.reduce((s, d) => s + Math.max(d.openCents ?? 0, 0), 0);
      const header =
        `${matching.length} Belege` +
        (matching.length > shown.length ? ` (die neuesten ${shown.length} gezeigt)` : "") +
        (type ? `, Summe brutto ${eur(sumGross)}` : `, Summe brutto (Rechnungen − Gutschriften) ${eur(sumGross)}`) +
        (breakdown ? ` [${breakdown}]` : "") +
        (sumOpen ? `, offen ${eur(sumOpen)}` : "") +
        ":";
      const text = [
        header,
        bullets(
          shown.map((d) =>
            join(
              `${d.number ?? `${docTypeLabel(d.type)}-Entwurf`} (${d.type} id ${d.id})`,
              d.clientName,
              d.title,
              deDate(d.issueDate),
              d.dueDate && d.type !== "offer" ? `fällig ${deDate(d.dueDate)}` : null,
              `brutto ${eur(d.grossCents)}`,
              d.openCents !== null && d.status !== "paid" ? `offen ${eur(d.openCents)}` : null,
              docStatusLabel(d),
            ),
          ),
        ),
      ].join("\n");
      return {
        text,
        data: { total: matching.length, truncated: matching.length > shown.length, sumGross: money(sumGross),
          sumByType: { invoices: money(sums.invoices), creditNotes: money(sums.creditNotes), offers: money(sums.offers) },
          sumOpen: money(sumOpen),
          documents,
        },
      };
    },
  );

  defineTool(
    server,
    "get_document",
    {
      title: "Beleg anzeigen",
      group: "core",
      description:
        "Full details of one offer, invoice or credit note by id (find ids with search or list_documents): client, dates, " +
        "tax mode, line items (quantity, unit price, discount, tax rate, line net), totals per tax rate, and for finalized " +
        "invoices the payment state (credit notes, bank payments, open amount). Includes the absolute path of the frozen " +
        "PDF once finalized, linked documents (offer → invoice → credit note) and the web link.",
      input: z.object({ id: z.number().int().positive().describe("document id") }),
      output: DocumentDetail,
      annotations: READ_ONLY,
    },
    async ({ id }) => documentDetail(ctx, id),
  );

  defineTool(
    server,
    "list_reminders_due",
    {
      title: "Fällig zum Mahnen",
      group: "documents",
      description:
        "Overdue, unpaid finalized invoices with their dunning state (Mahnwesen), most overdue first: open amount, days " +
        "overdue, the highest reminder level sent so far, an existing draft reminder, and the suggested next level with its " +
        "fee (Mahnspesen). `dueForReminder` is true when no draft exists and the deadline of the last reminder has passed.",
      input: z.object({}),
      output: z.object({
        invoices: z.array(
          z.object({
            invoiceId: z.number().int(),
            number: z.string().nullable(),
            clientId: z.number().int(),
            client: z.string(),
            issueDate: z.string(),
            dueDate: z.string(),
            daysOverdue: z.number().int(),
            gross: Money,
            open: Money,
            currentLevel: z.number().int().describe("0 = no reminder yet"),
            lastReminder: z
              .object({ id: z.number().int(), number: z.string().nullable(), level: z.number().int(), status: z.string(), dueDate: z.string() })
              .nullable(),
            draftReminderId: z.number().int().nullable(),
            suggestedLevel: z.number().int(),
            suggestedLevelTitle: z.string(),
            suggestedFee: Money,
            dueForReminder: z.boolean(),
            link: z.string(),
          }),
        ),
        totalOpen: Money,
      }),
      annotations: READ_ONLY,
    },
    async () => {
      const [rows, settings] = await Promise.all([call(ctx.api.reminders.due.$get()), call(ctx.api.reminders.settings.$get())]);
      const invoices = rows.map((r) => ({
        invoiceId: r.invoiceId,
        number: r.number,
        clientId: r.clientId,
        client: r.clientName,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        daysOverdue: r.daysOverdue,
        gross: money(r.grossCents),
        open: money(r.openCents),
        currentLevel: r.currentLevel,
        lastReminder: r.lastReminder,
        draftReminderId: r.draftId,
        suggestedLevel: r.nextLevel,
        suggestedLevelTitle: r.nextLevelTitle,
        suggestedFee: money(settings.levels[Math.min(r.nextLevel, settings.levels.length) - 1]?.feeCents ?? 0),
        dueForReminder: r.due,
        link: ctx.webUrl(`/invoices/${r.invoiceId}`),
      }));
      const totalOpen = rows.reduce((s, r) => s + r.openCents, 0);
      const text = [
        `${rows.length} überfällige Rechnungen, offen gesamt ${eur(totalOpen)}:`,
        bullets(
          invoices.map((r) =>
            join(
              `${r.number} (invoice id ${r.invoiceId})`,
              r.client,
              `fällig ${deDate(r.dueDate)} (${r.daysOverdue} Tage)`,
              `offen ${r.open.formatted}`,
              r.currentLevel ? `zuletzt Stufe ${r.currentLevel}` : "noch nicht gemahnt",
              r.draftReminderId ? `Entwurf id ${r.draftReminderId} vorhanden` : null,
              `${r.dueForReminder ? "jetzt fällig" : "noch nicht fällig"}: ${r.suggestedLevelTitle} (Spesen ${r.suggestedFee.formatted})`,
            ),
          ),
          "(keine)",
        ),
      ].join("\n");
      return { text, data: { invoices, totalOpen: money(totalOpen) } };
    },
  );
}

function snapshotAddress(s: { street?: string; zip?: string; city?: string; country?: string }) {
  return join(s.street, [s.zip, s.city].filter(Boolean).join(" "), s.country);
}

async function liveClient(ctx: ToolContext, id: number) {
  const c = await call(ctx.api.clients[":id"].$get({ param: idParam(id) }));
  return { id: c.id, name: c.name, address: snapshotAddress(c), uid: c.uid };
}
