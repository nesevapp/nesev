import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { foldText } from "../../server/services/search";
import { CLIENT_TYPES, formatClientNumber } from "../../shared/schemas/client";
import { call } from "../api";
import { euroAmount } from "../format";
import { checkUnit, configuredUnits, taxRateBp, taxRateInput } from "../inputs";
import { CREATES, defineTool, type ToolContext, ToolError } from "../tool";
import { ArticleRow, articleRow } from "./articles";
import { ClientDetail, clientDetail } from "./clients";

// Write tools for master data: clients and articles.

const LEGAL_FORMS = /\b(gmbh|gesmbh|e\.?\s?u\.?|og|kg|ag|se|ltd\.?|inc\.?|llc|co\.?\s?kg|ug)\b/g;
const normalizeUid = (uid: string) => uid.replace(/[\s.\-]/g, "").toUpperCase();
/** "Alpen Software GmbH" → "alpen software" (folded, without legal form and punctuation) */
const coreName = (name: string) =>
  foldText(name, true)
    .replace(LEGAL_FORMS, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function registerMasterDataWriteTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "create_client",
    {
      title: "Kunde anlegen",
      description:
        "Create a client (Kunde). The customer number (K-0001, …) is assigned automatically. Before creating, nesev " +
        "looks for likely duplicates (same name without legal form, same UID or email); if there are any, nothing is " +
        "created and the matches are returned as an error, so use the existing client or call again with " +
        "allowDuplicate: true. Country is ISO alpha-2 (default AT); EU business clients need their UID for reverse charge.",
      input: z.object({
        type: z.enum(CLIENT_TYPES).default("company"),
        name: z.string().trim().min(1).max(200),
        contactPerson: z.string().trim().max(200).optional(),
        street: z.string().trim().max(500).optional(),
        addressExtra: z.string().trim().max(500).optional(),
        zip: z.string().trim().max(20).optional(),
        city: z.string().trim().max(500).optional(),
        country: z.string().trim().length(2).default("AT").describe("ISO alpha-2, e.g. AT, DE, CH"),
        uid: z.string().trim().max(30).optional().describe("VAT id (UID), e.g. ATU12345678, DE123456789"),
        email: z.string().trim().max(500).optional(),
        phone: z.string().trim().max(50).optional(),
        paymentTermsDays: z.number().int().min(0).max(365).optional().describe("omit to use the default from the settings"),
        notes: z.string().max(5000).optional(),
        allowDuplicate: z.boolean().default(false).describe("create even if a similar client exists"),
      }),
      output: ClientDetail,
      annotations: CREATES,
    },
    async ({ allowDuplicate, ...input }) => {
      if (!allowDuplicate) {
        const all = await call(ctx.api.clients.index.$get({ query: { archived: "all" } }));
        const core = coreName(input.name);
        const uid = input.uid ? normalizeUid(input.uid) : "";
        const email = input.email?.toLowerCase() ?? "";
        const dupes = all.filter(
          (c) =>
            (core && coreName(c.name) === core) ||
            (uid && normalizeUid(c.uid) === uid) ||
            (email && c.email.toLowerCase() === email),
        );
        if (dupes.length) {
          const list = dupes.map((c) => `${c.name} (id ${c.id}, ${formatClientNumber(c.number)}${c.archivedAt ? ", archiviert" : ""})`).join("; ");
          throw new ToolError(`Möglicher Duplikat-Kunde, nichts angelegt: ${list}. Bestehenden Kunden verwenden oder mit allowDuplicate: true erneut aufrufen.`);
        }
      }
      const created = await call(
        ctx.api.clients.index.$post({
          json: { ...input, paymentTermsDays: input.paymentTermsDays ?? null, defaultTaxMode: null },
        }),
      );
      const detail = await clientDetail(ctx, created.id);
      return { text: `Kunde angelegt.\n${detail.text}`, data: detail.data };
    },
  );

  defineTool(
    server,
    "create_article",
    {
      title: "Artikel anlegen",
      description:
        "Create a catalog article (reusable line item): title, optional description, unit (must be one of the configured " +
        "units), net unit price in euros and VAT rate (20, 13, 10 or 0 %). The article number (A-0001, …) is assigned " +
        "automatically. Articles can then be used as articleId in document items.",
      input: z.object({
        title: z.string().trim().min(1).max(500),
        description: z.string().max(5000).optional(),
        unit: z.string().trim().max(20).describe("one of the configured units, e.g. Std., Stk., Pauschal"),
        unitPrice: euroAmount.describe('net unit price in euros: 95, "95,00", "1.234,56"'),
        taxRate: taxRateInput.default(20),
        notes: z.string().max(5000).optional().describe("internal, never printed"),
      }),
      output: ArticleRow,
      annotations: CREATES,
    },
    async ({ title, description, unit, unitPrice, taxRate, notes }) => {
      const units = await configuredUnits(ctx);
      const a = await call(
        ctx.api.articles.index.$post({
          json: { title, description, unit: checkUnit(unit, units, "Artikel"), unitPriceCents: unitPrice, taxRateBp: taxRateBp(taxRate, "Artikel"), notes },
        }),
      );
      const data = articleRow(ctx, a);
      return {
        text: `Artikel angelegt: ${data.title} (article id ${data.id}, ${data.number}) · ${data.unitPrice.formatted} netto / ${data.unit} · ${data.taxRatePercent} % USt\nLink: ${data.link}`,
        data,
      };
    },
  );
}
