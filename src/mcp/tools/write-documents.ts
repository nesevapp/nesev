import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { DocumentType } from "../../shared/documents";
import { REMINDER_STATUS_LABELS } from "../../shared/reminders";
import type { DocumentUpdate } from "../../shared/schemas/document";
import { TAX_MODES } from "../../shared/tax";
import { call, idParam } from "../api";
import { deDate, euroAmount, isoDate, join, Money, money, toMilli } from "../format";
import { buildItems, clientRefInput, itemInput, resolveClientId } from "../inputs";
import { CHANGES_STATE, CREATES, defineTool, type ToolContext, ToolError } from "../tool";
import { DocumentDetail, documentDetail } from "./documents";

// Write tools for offers, invoices, credit notes and reminders. Everything goes through the documents/reminders
// routes, so the invariants hold: drafts only are editable, finalize assigns the gapless number and freezes the PDF,
// corrections only via credit notes.

const IRREVERSIBLE = "IRREVERSIBLE: ";

const documentFields = {
  issueDate: isoDate.optional().describe("default today"),
  servicePeriodStart: isoDate.optional().describe("Leistungszeitraum start"),
  servicePeriodEnd: isoDate.optional().describe("Leistungszeitraum end"),
  title: z.string().trim().max(200).optional().describe("short subject shown on the document"),
  introText: z.string().max(5000).optional().describe("default from the settings"),
  closingText: z.string().max(5000).optional().describe("default from the settings"),
  taxMode: z.enum(TAX_MODES).optional().describe("default derived from the client (country, UID) like in the UI; override only on request"),
};

/** detail of the document plus a first line saying what happened */
async function withDetail(ctx: ToolContext, id: number, headline: string) {
  const d = await documentDetail(ctx, id);
  return { text: `${headline}\n${d.text}`, data: d.data };
}

export function registerDocumentWriteTools(server: McpServer, ctx: ToolContext) {
  const draftTool = (type: Extract<DocumentType, "invoice" | "offer">) => {
    const invoice = type === "invoice";
    defineTool(
      server,
      invoice ? "create_invoice_draft" : "create_offer_draft",
      {
        title: invoice ? "Rechnungsentwurf anlegen" : "Angebotsentwurf anlegen",
        description:
          `Create a${invoice ? "n invoice" : "n offer"} DRAFT (no number yet, freely editable, nothing is sent). Client by ` +
          "clientId or clientName (must match exactly one active client, otherwise an error lists the candidates). Items: " +
          "quantity as plain number, unit from the configured units (the error lists them), unitPrice NET in euros " +
          '(95, "95,00", "1.234,56"), taxRate 20/13/10/0 %, optional articleId to take defaults from the catalog. Tax mode, ' +
          `texts${invoice ? " and due date" : " and valid-until date"} default from the client and settings like in the UI. ` +
          "Returns the draft with totals. Finalize separately with finalize_document.",
        input: z.object({
          ...clientRefInput,
          items: z.array(itemInput).min(1).max(200),
          ...documentFields,
          ...(invoice
            ? { dueDate: isoDate.optional().describe("default issue date + payment terms") }
            : { validUntil: isoDate.optional().describe("default issue date + offer validity from the settings") }),
        }),
        output: DocumentDetail,
        annotations: CREATES,
      },
      async ({ clientId, clientName, items, ...fields }) => {
        const resolved = await resolveClientId(ctx, { clientId, clientName });
        const doc = await call(
          ctx.api.documents.index.$post({ json: { type, clientId: resolved, items: await buildItems(ctx, items), ...fields } }),
        );
        return withDetail(ctx, doc.id, `${invoice ? "Rechnungsentwurf" : "Angebotsentwurf"} angelegt (noch ohne Nummer).`);
      },
    );
  };
  draftTool("invoice");
  draftTool("offer");

  defineTool(
    server,
    "update_document_draft",
    {
      title: "Entwurf bearbeiten",
      description:
        "Change a DRAFT offer, invoice or credit note. Only the given fields change; `items` replaces ALL line items " +
        "(same item format as create_invoice_draft). Finalized documents cannot be changed (the API refuses; corrections " +
        "of invoices go through create_credit_note). Dates can be cleared with null.",
      input: z.object({
        id: z.number().int().positive().describe("document id of the draft"),
        ...clientRefInput,
        items: z.array(itemInput).max(200).optional(),
        issueDate: isoDate.optional(),
        servicePeriodStart: isoDate.nullable().optional(),
        servicePeriodEnd: isoDate.nullable().optional(),
        dueDate: isoDate.nullable().optional().describe("invoices"),
        validUntil: isoDate.nullable().optional().describe("offers"),
        title: documentFields.title,
        introText: documentFields.introText,
        closingText: documentFields.closingText,
        taxMode: documentFields.taxMode,
      }),
      output: DocumentDetail,
      annotations: { ...CREATES, idempotentHint: true },
    },
    async ({ id, clientId, clientName, items, ...fields }) => {
      const json: DocumentUpdate = { ...fields };
      if (clientId || clientName) json.clientId = await resolveClientId(ctx, { clientId, clientName });
      if (items) json.items = await buildItems(ctx, items);
      if (Object.keys(json).length === 0) throw new ToolError("Keine Änderungen angegeben");
      await call(ctx.api.documents[":id"].$put({ param: idParam(id), json }));
      return withDetail(ctx, id, "Entwurf gespeichert.");
    },
  );

  defineTool(
    server,
    "finalize_document",
    {
      title: "Beleg finalisieren",
      description:
        IRREVERSIBLE +
        "finalizes a draft offer, invoice or credit note: assigns the next gapless number (AN-/RE-/GS-YYYY-NNNN), freezes " +
        "client and seller data, locks the document for good and renders the PDF. Cannot be undone; an invoice can then " +
        "only be corrected with a credit note. Check the draft with get_document and get the user's confirmation first. " +
        "Returns the number and the absolute PDF path.",
      input: z.object({ id: z.number().int().positive().describe("document id of the draft") }),
      output: DocumentDetail,
      annotations: CHANGES_STATE,
    },
    async ({ id }) => {
      const doc = await call(ctx.api.documents[":id"].finalize.$post({ param: idParam(id) }));
      const pdfNote = doc.pdfPath ? "" : " Achtung: Das PDF konnte nicht erzeugt werden (in der Web-App erneut öffnen).";
      return withDetail(ctx, id, `Finalisiert: ${doc.number}.${pdfNote}`);
    },
  );

  defineTool(
    server,
    "mark_document_sent",
    {
      title: "Als versendet markieren",
      description:
        "Mark a finalized offer or invoice as sent (status Versendet, sets the sent timestamp). It does not send anything " +
        "itself. Cannot be reverted from here.",
      input: z.object({ id: z.number().int().positive() }),
      output: DocumentDetail,
      annotations: CHANGES_STATE,
    },
    async ({ id }) => {
      await call(ctx.api.documents[":id"].status.$post({ param: idParam(id), json: { action: "sent" } }));
      return withDetail(ctx, id, "Als versendet markiert.");
    },
  );

  defineTool(
    server,
    "mark_invoice_paid",
    {
      title: "Rechnung als bezahlt markieren",
      description:
        "Mark a finalized invoice as paid by hand on a date (default today). Use it for payments that are not matched " +
        "from a bank import (bank matches settle invoices automatically). Pass expectedAmount (euros) to make sure the " +
        "open amount is what the user says was paid; a mismatch is refused, because partial payments must be recorded " +
        "through the bank import. Reverting is only possible in the web app.",
      input: z.object({
        id: z.number().int().positive().describe("invoice id"),
        paidAt: isoDate.optional().describe("payment date, default today"),
        expectedAmount: euroAmount.optional().describe("amount the user received; must equal the open amount"),
      }),
      output: DocumentDetail,
      annotations: CHANGES_STATE,
    },
    async ({ id, paidAt, expectedAmount }) => {
      if (expectedAmount !== undefined) {
        const d = await call(ctx.api.documents[":id"].$get({ param: idParam(id) }));
        const open = d.openCents ?? d.grossCents;
        if (open !== expectedAmount) {
          throw new ToolError(
            `Offener Betrag ist ${money(open).formatted}, nicht ${money(expectedAmount).formatted}. Teilzahlungen bitte über den Bankimport zuordnen; nichts geändert.`,
          );
        }
      }
      await call(ctx.api.documents[":id"].status.$post({ param: idParam(id), json: { action: "paid", paidAt } }));
      return withDetail(ctx, id, "Als bezahlt markiert.");
    },
  );

  defineTool(
    server,
    "convert_offer_to_invoice",
    {
      title: "Angebot in Rechnung umwandeln",
      description:
        "Create an invoice DRAFT from an offer (same client, tax mode, title, service period and items) and mark a " +
        "finalized/sent offer as accepted. The invoice is a draft: review it, then finalize_document.",
      input: z.object({ offerId: z.number().int().positive() }),
      output: DocumentDetail,
      annotations: CHANGES_STATE,
    },
    async ({ offerId }) => {
      const invoice = await call(ctx.api.documents[":id"]["convert-to-invoice"].$post({ param: idParam(offerId) }));
      return withDetail(ctx, invoice.id, `Rechnungsentwurf aus Angebot (id ${offerId}) erstellt; das Angebot ist angenommen.`);
    },
  );

  defineTool(
    server,
    "create_credit_note",
    {
      title: "Gutschrift erstellen",
      description:
        "Create a credit note (Gutschrift) DRAFT for a finalized invoice, the only way to correct an invoice. Without " +
        "`items` it credits the whole invoice; with `items` only the listed invoice positions (1-based, as in " +
        "get_document), optionally with a smaller quantity or unit price (net euros). Amounts are positive; they reduce " +
        "the invoice's open amount once the credit note is finalized with finalize_document.",
      input: z.object({
        invoiceId: z.number().int().positive(),
        items: z
          .array(
            z.object({
              position: z.number().int().min(1).describe("invoice position, 1-based"),
              quantity: z.number().optional().describe("default: the invoice quantity"),
              unitPrice: euroAmount.optional().describe("net euros, default: the invoice price"),
            }),
          )
          .min(1)
          .optional(),
        title: z.string().trim().max(200).optional(),
      }),
      output: DocumentDetail,
      annotations: CHANGES_STATE,
    },
    async ({ invoiceId, items, title }) => {
      if (items) {
        // check the selection before anything is created
        const invoice = await call(ctx.api.documents[":id"].$get({ param: idParam(invoiceId) }));
        for (const sel of items) {
          if (!invoice.items[sel.position - 1]) throw new ToolError(`Position ${sel.position} gibt es auf der Rechnung nicht (1–${invoice.items.length})`);
        }
      }
      const cn = await call(ctx.api.documents[":id"]["credit-note"].$post({ param: idParam(invoiceId) }));
      const json: DocumentUpdate = {};
      if (title) json.title = title;
      if (items) {
        json.items = items.map((sel) => {
          const src = cn.items[sel.position - 1]!;
          return {
            articleId: src.articleId,
            title: src.title,
            description: src.description,
            quantity: sel.quantity !== undefined ? toMilli(sel.quantity) : src.quantity,
            unit: src.unit,
            unitPriceCents: sel.unitPrice ?? src.unitPriceCents,
            taxRateBp: src.taxRateBp,
            discountBp: src.discountBp,
          };
        });
      }
      if (Object.keys(json).length) await call(ctx.api.documents[":id"].$put({ param: idParam(cn.id), json }));
      return withDetail(ctx, cn.id, `Gutschrift-Entwurf zu Rechnung (id ${invoiceId}) erstellt. Mit finalize_document finalisieren.`);
    },
  );

  defineTool(
    server,
    "create_reminder",
    {
      title: "Mahnung erstellen",
      description:
        "Create a payment reminder (Mahnung) for an overdue, unpaid, finalized invoice (see list_reminders_due). Level " +
        "defaults to the next one (Zahlungserinnerung, 1. Mahnung, …) with its fee and default interest from the " +
        "settings. With finalize (default true) it is IRREVERSIBLY finalized right away: gapless MA- number and frozen " +
        "PDF (absolute path returned). With finalize: false a draft " +
        "is left for review in the web app (an existing draft is reused). Does not send anything.",
      input: z.object({
        invoiceId: z.number().int().positive(),
        level: z.number().int().min(1).max(5).optional().describe("1 = Zahlungserinnerung; default next level"),
        issueDate: isoDate.optional().describe("default today"),
        finalize: z.boolean().default(true),
      }),
      output: z.object({
        id: z.number().int(),
        invoiceId: z.number().int(),
        invoiceNumber: z.string().nullable(),
        client: z.string(),
        level: z.number().int(),
        title: z.string(),
        number: z.string().nullable(),
        status: z.string(),
        statusLabel: z.string(),
        issueDate: z.string(),
        dueDate: z.string().describe("new payment deadline"),
        open: Money,
        fee: Money,
        interest: Money,
        total: Money,
        pdf: z.object({ path: z.string(), url: z.string() }).nullable(),
        link: z.string(),
      }),
      annotations: CHANGES_STATE,
    },
    async ({ invoiceId, level, issueDate, finalize }) => {
      let r = await call(ctx.api.reminders.index.$post({ json: { invoiceId, level, issueDate, reuseDraft: !finalize } }));
      if (finalize) {
        await call(ctx.api.reminders[":id"].finalize.$post({ param: idParam(r.id) }));
        r = await call(ctx.api.reminders[":id"].$get({ param: idParam(r.id) }));
      }
      const pdfPath = r.pdfPath;
      const data = {
        id: r.id,
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        client: r.clientName,
        level: r.level,
        title: r.title,
        number: r.number,
        status: r.status,
        statusLabel: REMINDER_STATUS_LABELS[r.status],
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        open: money(r.openCents),
        fee: money(r.feeCents),
        interest: money(r.interestCents),
        total: money(r.totalCents),
        pdf: pdfPath ? { path: ctx.dataPath(pdfPath), url: ctx.webUrl(`/api/files/${pdfPath}`) } : null,
        link: ctx.webUrl(`/reminders/${r.id}`),
      };
      const text = [
        `${finalize ? "Mahnung finalisiert" : "Mahnungsentwurf angelegt"}: ${join(data.number ?? "Entwurf", data.title, `Stufe ${data.level}`)} (reminder id ${data.id})`,
        join(`Rechnung ${data.invoiceNumber} (invoice id ${data.invoiceId})`, data.client),
        join(`Datum ${deDate(data.issueDate)}`, `neue Frist ${deDate(data.dueDate)}`),
        join(`offen ${data.open.formatted}`, `Spesen ${data.fee.formatted}`, `Zinsen ${data.interest.formatted}`, `gesamt ${data.total.formatted}`),
        data.pdf ? `PDF: ${data.pdf.path}` : finalize ? "Achtung: Das PDF konnte nicht erzeugt werden." : null,
        `Link: ${data.link}`,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data };
    },
  );
}
