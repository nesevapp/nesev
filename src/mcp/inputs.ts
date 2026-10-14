import { z } from "zod";
import type { DocumentItemInput } from "../shared/schemas/document";
import { formatClientNumber } from "../shared/schemas/client";
import { foldText } from "../server/services/search";
import { AT_TAX_RATES_BP, DEFAULT_TAX_RATE_BP } from "../shared/tax";
import { call, idParam } from "./api";
import { euroAmount, toMilli } from "./format";
import { type ToolContext, ToolError } from "./tool";

// Input helpers shared by the write tools: client resolution, units, tax rates and document line items.

// ── clients ─────────────────────────────────────────────────────────────────────

export const clientRefInput = {
  clientId: z.number().int().positive().optional().describe("client id (preferred)"),
  clientName: z.string().trim().min(1).max(200).optional().describe("client name, resolved via search when no clientId is given"),
};

/** clientId, or a clientName that matches exactly one active client (an exact name match wins over partial ones). */
export async function resolveClientId(ctx: ToolContext, ref: { clientId?: number; clientName?: string }): Promise<number> {
  if (ref.clientId) return ref.clientId;
  const name = ref.clientName?.trim();
  if (!name) throw new ToolError("clientId oder clientName angeben");
  const rows = await call(ctx.api.clients.index.$get({ query: { q: name, archived: "active" } }));
  const exact = rows.filter((c) => foldText(c.name, true).trim() === foldText(name, true).trim());
  const hits = exact.length ? exact : rows;
  if (hits.length === 1) return hits[0]!.id;
  if (hits.length === 0) throw new ToolError(`Kein aktiver Kunde „${name}“ gefunden. Mit search suchen oder mit create_client anlegen.`);
  const list = hits
    .slice(0, 10)
    .map((c) => `${c.name} (id ${c.id}, ${formatClientNumber(c.number)}${c.city ? `, ${c.city}` : ""})`)
    .join("; ");
  throw new ToolError(`„${name}“ ist nicht eindeutig (${hits.length} Kunden): ${list}. Bitte clientId angeben.`);
}

// ── units, tax rates ────────────────────────────────────────────────────────────

export async function configuredUnits(ctx: ToolContext): Promise<string[]> {
  return (await call(ctx.api.units.index.$get())).units;
}

/** The unit as configured (case-insensitive match), or a ToolError listing the allowed units. */
export function checkUnit(unit: string, units: string[], where: string): string {
  const match = units.find((u) => u.toLowerCase() === unit.trim().toLowerCase());
  if (!match) throw new ToolError(`${where}: Einheit „${unit}“ ist nicht konfiguriert. Erlaubt: ${units.join(", ")}`);
  return match;
}

export const taxRateInput = z.number().describe("VAT rate in percent: 20, 13, 10 or 0");

/** percent → basis points; only the Austrian rates offered in the UI. */
export function taxRateBp(ratePercent: number, where: string): number {
  const bp = Math.round(ratePercent * 100);
  if (!(AT_TAX_RATES_BP as readonly number[]).includes(bp)) {
    throw new ToolError(`${where}: Steuersatz ${ratePercent} % ist nicht erlaubt (20, 13, 10 oder 0)`);
  }
  return bp;
}

// ── document items ──────────────────────────────────────────────────────────────

export const itemInput = z.object({
  articleId: z.number().int().positive().optional().describe("catalog article: title, unit, price and rate default from it"),
  title: z.string().trim().max(500).describe('line title, e.g. "Beratung" ("" = the article\'s title when articleId is given)'),
  description: z.string().max(5000).optional(),
  quantity: z.number().describe("plain number, e.g. 1.5 (hours, pieces, …)"),
  unit: z.string().trim().max(20).optional().describe("one of the configured units (e.g. Std., Stk., Pauschal)"),
  unitPrice: euroAmount.optional().describe('net unit price in euros: 95, "95,00" or "1.234,56"'),
  taxRate: taxRateInput.optional().describe("VAT % (20, 13, 10, 0); default 20 or the article's rate"),
  discount: z.number().min(0).max(100).optional().describe("discount in percent"),
});
export type ItemInput = z.output<typeof itemInput>;

/** Model items → API items (milli-units, cents, basis points), with article defaults and unit/rate checks. */
export async function buildItems(ctx: ToolContext, items: ItemInput[]): Promise<DocumentItemInput[]> {
  const units = await configuredUnits(ctx);
  const out: DocumentItemInput[] = [];
  for (const [i, it] of items.entries()) {
    const where = `Position ${i + 1}`;
    const article = it.articleId ? await call(ctx.api.articles[":id"].$get({ param: idParam(it.articleId) })) : null;
    const title = it.title || article?.title || "";
    if (!title.trim()) throw new ToolError(`${where}: Bezeichnung fehlt – jede Position in items braucht "title" (z. B. "Beratung"), außer sie hat eine articleId`);
    const unitPriceCents = it.unitPrice ?? article?.unitPriceCents;
    if (unitPriceCents === undefined) throw new ToolError(`${where}: Einzelpreis (unitPrice, netto in Euro) fehlt`);
    const unit = it.unit ?? article?.unit;
    if (!unit) throw new ToolError(`${where}: Einheit (unit) fehlt. Erlaubt: ${units.join(", ")}`);
    const quantity = toMilli(it.quantity);
    if (quantity === 0) throw new ToolError(`${where}: Menge darf nicht 0 sein`);
    out.push({
      articleId: article?.id ?? null,
      title,
      description: it.description ?? article?.description ?? "",
      quantity,
      unit: checkUnit(unit, units, where),
      unitPriceCents,
      taxRateBp: it.taxRate !== undefined ? taxRateBp(it.taxRate, where) : (article?.taxRateBp ?? DEFAULT_TAX_RATE_BP),
      discountBp: Math.round((it.discount ?? 0) * 100),
    });
  }
  return out;
}
