import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCUMENT_TYPES } from "../../shared/documents";
import { CLIENT_ARCHIVED_FILTERS, CLIENT_TYPES, formatClientNumber } from "../../shared/schemas/client";
import { TAX_MODE_LABELS } from "../../shared/tax";
import { call, idParam } from "../api";
import { bullets, deDate, docStatusLabel, eur, join, Money, money } from "../format";
import { defineTool, READ_ONLY, type ToolContext, type ToolOutput } from "../tool";
import { documentPath } from "./documents";

// Clients (Kunden).

const ClientRow = z.object({
  id: z.number().int(),
  number: z.string().describe('customer number, e.g. "K-0001"'),
  type: z.enum(CLIENT_TYPES),
  name: z.string(),
  contactPerson: z.string(),
  city: z.string(),
  country: z.string().describe("ISO alpha-2"),
  uid: z.string().describe("VAT id (UID)"),
  email: z.string(),
  archived: z.boolean(),
  link: z.string(),
});

type ClientLike = {
  id: number;
  number: number;
  type: (typeof CLIENT_TYPES)[number];
  name: string;
  contactPerson: string;
  city: string;
  country: string;
  uid: string;
  email: string;
  archivedAt: string | null;
};

function clientRow(ctx: ToolContext, c: ClientLike) {
  return {
    id: c.id,
    number: formatClientNumber(c.number),
    type: c.type,
    name: c.name,
    contactPerson: c.contactPerson,
    city: c.city,
    country: c.country,
    uid: c.uid,
    email: c.email,
    archived: c.archivedAt !== null,
    link: ctx.webUrl(`/clients/${c.id}`),
  };
}

/** get_client output; create_client returns it too. */
export const ClientDetail = z.object({
  ...ClientRow.shape,
  street: z.string(),
  addressExtra: z.string(),
  zip: z.string(),
  phone: z.string(),
  paymentTermsDays: z.number().int().nullable().describe("null = default from settings"),
  defaultTaxMode: z.string().nullable(),
  defaultTaxModeLabel: z.string().nullable(),
  notes: z.string(),
  documentCounts: z.object({ offer: z.number().int(), invoice: z.number().int(), credit_note: z.number().int() }),
  openInvoices: z.object({
    count: z.number().int(),
    open: Money,
    overdueCount: z.number().int(),
    overdueOpen: Money,
    invoices: z.array(
      z.object({
        id: z.number().int(),
        number: z.string().nullable(),
        issueDate: z.string(),
        dueDate: z.string().nullable(),
        gross: Money,
        open: Money,
        overdue: z.boolean(),
        statusLabel: z.string(),
        link: z.string(),
      }),
    ),
  }),
});

/** Client with document counts and open invoices as text + structured data. */
export async function clientDetail(ctx: ToolContext, id: number): Promise<ToolOutput<z.input<typeof ClientDetail>>> {
  const [c, docs] = await Promise.all([
    call(ctx.api.clients[":id"].$get({ param: idParam(id) })),
    call(ctx.api.documents.index.$get({ query: { clientId: String(id) } })),
  ]);
  const counts = Object.fromEntries(DOCUMENT_TYPES.map((t) => [t, docs.filter((d) => d.type === t).length])) as Record<
    (typeof DOCUMENT_TYPES)[number],
    number
  >;
  const open = docs.filter((d) => d.type === "invoice" && (d.status === "final" || d.status === "sent") && (d.openCents ?? 0) > 0);
  const overdue = open.filter((d) => d.overdue);
  const sum = (rows: typeof open) => rows.reduce((s, d) => s + (d.openCents ?? 0), 0);
  const invoices = open.map((d) => ({
    id: d.id,
    number: d.number,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    gross: money(d.grossCents),
    open: money(d.openCents ?? 0),
    overdue: d.overdue,
    statusLabel: docStatusLabel(d),
    link: ctx.webUrl(documentPath("invoice", d.id)),
  }));
  const data = {
    ...clientRow(ctx, c),
    street: c.street,
    addressExtra: c.addressExtra,
    zip: c.zip,
    phone: c.phone,
    paymentTermsDays: c.paymentTermsDays,
    defaultTaxMode: c.defaultTaxMode,
    defaultTaxModeLabel: c.defaultTaxMode ? TAX_MODE_LABELS[c.defaultTaxMode] : null,
    notes: c.notes,
    documentCounts: counts,
    openInvoices: { count: open.length, open: money(sum(open)), overdueCount: overdue.length, overdueOpen: money(sum(overdue)), invoices },
  };
  const text = [
    `${c.name} (client id ${c.id}, ${data.number})${data.archived ? " · archiviert" : ""}`,
    join(c.contactPerson, c.street, c.addressExtra, [c.zip, c.city].filter(Boolean).join(" "), c.country),
    join(c.uid && `UID ${c.uid}`, c.email, c.phone, c.paymentTermsDays !== null && `Zahlungsziel ${c.paymentTermsDays} Tage`),
    data.defaultTaxModeLabel && `Steuermodus: ${data.defaultTaxModeLabel}`,
    c.notes && `Notizen: ${c.notes}`,
    `Belege: ${counts.offer} Angebote, ${counts.invoice} Rechnungen, ${counts.credit_note} Gutschriften`,
    `Offene Rechnungen: ${open.length}, ${eur(sum(open))}` + (overdue.length ? ` (davon überfällig ${overdue.length}, ${eur(sum(overdue))})` : ""),
    open.length
      ? bullets(invoices.map((i) => join(`${i.number} (invoice id ${i.id})`, `fällig ${deDate(i.dueDate)}`, `offen ${i.open.formatted}`, i.statusLabel)))
      : null,
    `Link: ${data.link}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { text, data };
}

export function registerClientTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "list_clients",
    {
      title: "Kunden auflisten",
      description:
        "List clients (Kunden) sorted by name. `query` matches name, contact person, email, city and the customer number " +
        '("K-0003" or "3"). By default only active clients; archived=all includes archived ones. Returns id, number, ' +
        "name, location, UID, email and the web link; use get_client for details and open invoices.",
      input: z.object({
        query: z.string().trim().max(200).optional(),
        archived: z.enum(CLIENT_ARCHIVED_FILTERS).default("active"),
        country: z.string().trim().length(2).optional().describe("ISO alpha-2, e.g. AT, DE"),
        limit: z.number().int().min(1).max(500).default(50),
      }),
      output: z.object({ total: z.number().int(), truncated: z.boolean(), clients: z.array(ClientRow) }),
      annotations: READ_ONLY,
    },
    async ({ query, archived, country, limit }) => {
      const rows = await call(ctx.api.clients.index.$get({ query: { q: query || undefined, archived, country } }));
      const clients = rows.slice(0, limit).map((c) => clientRow(ctx, c));
      const text = [
        `${rows.length} Kunden${rows.length > clients.length ? ` (${clients.length} gezeigt)` : ""}:`,
        bullets(
          clients.map((c) =>
            join(`${c.name} (client id ${c.id})`, c.number, [c.city, c.country].filter(Boolean).join(", "), c.uid && `UID ${c.uid}`, c.email, c.archived && "archiviert"),
          ),
        ),
      ].join("\n");
      return { text, data: { total: rows.length, truncated: rows.length > clients.length, clients } };
    },
  );

  defineTool(
    server,
    "get_client",
    {
      title: "Kunde anzeigen",
      description:
        "Details of one client by id: address, contact, UID, payment terms, default tax mode, notes, the number of " +
        "offers/invoices/credit notes, and the open invoices (open amount = gross − credit notes − bank payments) with " +
        "the overdue ones flagged.",
      input: z.object({ id: z.number().int().positive().describe("client id") }),
      output: ClientDetail,
      annotations: READ_ONLY,
    },
    async ({ id }) => clientDetail(ctx, id),
  );
}
