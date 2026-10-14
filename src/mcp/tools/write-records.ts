import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { annualAfaCents, assetSchedule, formatAssetNumber, GWG_LIMIT_CENTS, isFirstHalf, MAX_USEFUL_LIFE_YEARS, MIN_USEFUL_LIFE_YEARS } from "../../shared/assets";
import { todayIso } from "../../shared/dates";
import {
  categoryLabel,
  defaultVatTreatment,
  EXPENSE_CATEGORY_KEYS,
  type ExpenseCategoryKey,
  expenseTaxCents,
  getExpenseCategory,
  VAT_TREATMENT_SHORT_LABELS,
  VAT_TREATMENTS,
  type VatTreatment,
} from "../../shared/expenses";
import { suggestedLines, type ReceiptFields } from "../../shared/receipts";
import { containedTaxCents, slotLabel } from "../../shared/recurring-expenses";
import { INTERVAL_UNITS, intervalLabel } from "../../shared/recurring";
import { CLIENT_TYPES } from "../../shared/schemas/client";
import type { ExpenseLineInput } from "../../shared/schemas/expense";
import { TAX_MODE_LABELS, TAX_MODES } from "../../shared/tax";
import { call, idParam } from "../api";
import { bullets, deDate, eur, euroAmount, isoDate, join, Money, money, percent } from "../format";
import { taxRateBp, taxRateInput } from "../inputs";
import { CHANGES_STATE, CREATES, defineTool, type ToolContext, ToolError } from "../tool";
import { ClientDetail, clientDetail } from "./clients";
import { ExpenseDetail, expenseDetail } from "./expenses";
import { lineAmounts } from "./write-expenses";

// Changes to existing records (clients, expenses, receipt suggestions), Fixkosten and assets (Anlagen).

/** One changed field, for confirmation summaries: display values before/after. */
const Change = z.object({ field: z.string(), label: z.string(), before: z.string(), after: z.string() });
type Change = z.infer<typeof Change>;

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "–" : String(v));

function changeText(changes: Change[]): string {
  return changes.length ? `Geändert:\n${bullets(changes.map((c) => `${c.label}: ${c.before} → ${c.after}`))}` : "Keine Änderung (Werte waren schon so).";
}

// ── clients ─────────────────────────────────────────────────────────────────────

const CLIENT_LABELS = {
  type: "Typ",
  name: "Name",
  contactPerson: "Ansprechperson",
  street: "Straße",
  addressExtra: "Adresszusatz",
  zip: "PLZ",
  city: "Ort",
  country: "Land",
  uid: "UID",
  email: "E-Mail",
  phone: "Telefon",
  paymentTermsDays: "Zahlungsziel (Tage)",
  defaultTaxMode: "Steuermodus",
  notes: "Notizen",
} as const;
type ClientField = keyof typeof CLIENT_LABELS;

const clientShow = (field: ClientField, v: unknown) =>
  field === "defaultTaxMode" && v ? TAX_MODE_LABELS[v as (typeof TAX_MODES)[number]] : field === "paymentTermsDays" && v === null ? "Standard" : show(v);

// ── expenses ────────────────────────────────────────────────────────────────────

type ApiLine = ExpenseLineInput;

const lineInput = z.object({
  category: z.enum(EXPENSE_CATEGORY_KEYS),
  description: z.string().trim().max(500).optional(),
  net: euroAmount.optional().describe("net in euros (give net or gross)"),
  gross: euroAmount.optional().describe("amount incl. VAT in euros (give net or gross)"),
  taxRate: taxRateInput.default(20),
  deductiblePercent: z.number().min(0).max(100).optional().describe("default: category default"),
});

/** Model lines → API lines (`gross` of self-assessed treatments = net, see lineAmounts). */
function buildLines(lines: z.output<typeof lineInput>[], treatment: VatTreatment): ApiLine[] {
  return lines.map((l, i) => {
    const where = `Zeile ${i + 1}`;
    if ((l.net === undefined) === (l.gross === undefined)) throw new ToolError(`${where}: net oder gross angeben (genau eines)`);
    const rate = treatment === "none" ? 0 : taxRateBp(l.taxRate, where);
    return {
      category: l.category,
      description: l.description ?? "",
      ...lineAmounts(l.net, l.gross, rate, treatment),
      taxRateBp: rate,
      deductibleBp: l.deductiblePercent !== undefined ? Math.round(l.deductiblePercent * 100) : (getExpenseCategory(l.category)?.defaultDeductibleBp ?? 10000),
    };
  });
}

/** Rates after a treatment switch, like the expense editor: "none" → 0 %, leaving "none" → 20 % on the net. */
function adaptLines(lines: ApiLine[], prev: VatTreatment, next: VatTreatment): ApiLine[] {
  if (prev === next) return lines;
  if (next === "none") return lines.map((l) => ({ ...l, taxRateBp: 0, taxCents: 0 }));
  if (prev !== "none") return lines;
  return lines.map((l) => {
    const rate = l.taxRateBp || 2000;
    return { ...l, taxRateBp: rate, taxCents: expenseTaxCents(l.netCents, rate) };
  });
}

/** Category for all lines (and its default deductible share), like applying a category in the editor. */
function withCategory(lines: ApiLine[], category: ExpenseCategoryKey): ApiLine[] {
  if (!lines.length) throw new ToolError("Die Ausgabe hat keine Positionen; Kategorie mit lines angeben");
  const deductibleBp = getExpenseCategory(category)?.defaultDeductibleBp ?? 10000;
  return lines.map((l) => ({ ...l, category, deductibleBp }));
}

type ExpenseRowLike = {
  supplierName: string;
  supplierCountry: string;
  supplierUid: string;
  supplierInvoiceNumber: string;
  issueDate: string;
  dueDate: string | null;
  vatTreatment: VatTreatment;
  description: string;
  notes: string;
  grossCents: number;
  lines: { category: string; description: string; netCents: number; taxRateBp: number; taxCents: number; deductibleBp: number }[];
};

const toApiLines = (e: ExpenseRowLike): ApiLine[] =>
  e.lines.map((l) => ({ category: l.category as ExpenseCategoryKey, description: l.description, netCents: l.netCents, taxRateBp: l.taxRateBp, taxCents: l.taxCents, deductibleBp: l.deductibleBp }));

const linesText = (lines: readonly { category: string; netCents: number; taxRateBp: number }[]) =>
  lines.length ? lines.map((l) => `${categoryLabel(l.category)} netto ${eur(l.netCents)} (${percent(l.taxRateBp)} %)`).join("; ") : "(keine)";

const EXPENSE_LABELS = {
  supplierName: "Lieferant",
  supplierCountry: "Land",
  supplierUid: "UID",
  supplierInvoiceNumber: "Rechnungsnr.",
  issueDate: "Datum",
  dueDate: "Fällig am",
  vatTreatment: "USt-Behandlung",
  description: "Beschreibung",
  notes: "Notizen",
} as const;
type ExpenseField = keyof typeof EXPENSE_LABELS;

function expenseShow(field: ExpenseField, v: unknown): string {
  if ((field === "issueDate" || field === "dueDate") && v) return deDate(String(v));
  if (field === "vatTreatment" && v) return VAT_TREATMENT_SHORT_LABELS[v as VatTreatment];
  return show(v);
}

/** Field and line/total changes between two versions of an expense. */
function expenseChanges(before: ExpenseRowLike, after: ExpenseRowLike): Change[] {
  const out: Change[] = [];
  for (const field of Object.keys(EXPENSE_LABELS) as ExpenseField[]) {
    if (before[field] !== after[field]) out.push({ field, label: EXPENSE_LABELS[field], before: expenseShow(field, before[field]), after: expenseShow(field, after[field]) });
  }
  const [lb, la] = [JSON.stringify(toApiLines(before)), JSON.stringify(toApiLines(after))];
  if (lb !== la) out.push({ field: "lines", label: "Positionen", before: linesText(before.lines), after: linesText(after.lines) });
  if (before.grossCents !== after.grossCents) out.push({ field: "gross", label: "Brutto (zahlbar)", before: eur(before.grossCents), after: eur(after.grossCents) });
  return out;
}

/** Fields of a receipt analysis that can be applied (as in the editor's "Erkennung" panel). */
const APPLY_FIELDS = ["supplierName", "supplierUid", "supplierCountry", "supplierInvoiceNumber", "issueDate", "dueDate", "vatTreatment", "category", "description", "lines"] as const;
type ApplyField = (typeof APPLY_FIELDS)[number];

// ── fixed costs, assets ─────────────────────────────────────────────────────────

const FixedCost = z.object({
  id: z.number().int(),
  name: z.string(),
  supplier: z.string(),
  categoryLabel: z.string(),
  interval: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  nextPaymentDate: z.string().nullable(),
  gross: Money.describe("per payment"),
  tax: Money.describe("deductible VAT contained in gross"),
  monthly: Money,
  link: z.string(),
});

const AssetCreated = z.object({
  id: z.number().int(),
  number: z.string().describe('e.g. "AV-0002"'),
  name: z.string(),
  acquisitionDate: z.string(),
  inServiceDate: z.string(),
  usefulLifeYears: z.number().int(),
  cost: Money.describe("Anschaffungskosten (net + non-deductible VAT)"),
  annualAfa: Money,
  halfYearFirst: z.boolean().describe("in service after 30.6.: half AfA in the first year"),
  gwg: z.boolean().describe("cost ≤ 1.000 € (could be expensed at once as GWG)"),
  expense: z.object({ id: z.number().int(), number: z.string().nullable(), supplier: z.string(), link: z.string() }).nullable(),
  schedule: z.array(z.object({ year: z.number().int(), bookValueStart: Money, afa: Money, bookValueEnd: Money })),
  link: z.string(),
});

export function registerRecordWriteTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "update_client",
    {
      title: "Kunde ändern",
      group: "clients",
      description:
        "Change fields of an existing client; omitted fields stay unchanged. paymentTermsDays/defaultTaxMode null = " +
        "use the settings default. Finalized documents keep their client snapshot. Returns the client and the changes.",
      input: z.object({
        id: z.number().int().positive().describe("client id"),
        type: z.enum(CLIENT_TYPES).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        contactPerson: z.string().trim().max(200).optional(),
        street: z.string().trim().max(500).optional(),
        addressExtra: z.string().trim().max(500).optional(),
        zip: z.string().trim().max(20).optional(),
        city: z.string().trim().max(500).optional(),
        country: z.string().trim().length(2).toUpperCase().optional().describe("ISO alpha-2"),
        uid: z.string().trim().max(30).optional(),
        email: z.string().trim().max(500).optional(),
        phone: z.string().trim().max(50).optional(),
        paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
        defaultTaxMode: z.enum(TAX_MODES).nullable().optional(),
        notes: z.string().max(5000).optional(),
      }),
      output: ClientDetail.extend({ changes: z.array(Change) }),
      annotations: CHANGES_STATE,
    },
    async ({ id, ...patch }) => {
      const fields = (Object.keys(patch) as ClientField[]).filter((k) => patch[k] !== undefined);
      if (!fields.length) throw new ToolError("Keine Felder zum Ändern angegeben");
      const c = await call(ctx.api.clients[":id"].$get({ param: idParam(id) }));
      const changes = fields
        .filter((f) => patch[f] !== c[f])
        .map((f) => ({ field: f, label: CLIENT_LABELS[f], before: clientShow(f, c[f]), after: clientShow(f, patch[f]) }));
      if (changes.length) {
        // the full merged object: the update schema's defaults would reset omitted fields
        const { type, name, contactPerson, street, addressExtra, zip, city, country, uid, email, phone, paymentTermsDays, defaultTaxMode, notes } = c;
        const current = { type, name, contactPerson, street, addressExtra, zip, city, country, uid, email, phone, paymentTermsDays, defaultTaxMode, notes };
        await call(ctx.api.clients[":id"].$put({ param: idParam(id), json: { ...current, ...Object.fromEntries(fields.map((f) => [f, patch[f]])) } }));
      }
      const detail = await clientDetail(ctx, id);
      return { text: `${changeText(changes)}\n${detail.text}`, data: { ...detail.data, changes } };
    },
  );

  defineTool(
    server,
    "update_expense",
    {
      title: "Ausgabe ändern",
      group: "expenses",
      description:
        "Change an existing expense; omitted fields stay unchanged. `lines` replaces all lines (net or gross per line; " +
        "for reverse_charge/ig_acquisition gross = net, the VAT is self-assessed). `category` sets the category of all " +
        "lines. Changing vatTreatment adapts the line rates like the editor. Payment: mark_expense_paid. Returns the " +
        "expense and the changes.",
      input: z.object({
        id: z.number().int().positive().describe("expense id"),
        supplierName: z.string().trim().max(200).optional(),
        supplierCountry: z.string().trim().length(2).toUpperCase().optional(),
        supplierUid: z.string().trim().max(30).optional(),
        supplierInvoiceNumber: z.string().trim().max(100).optional(),
        issueDate: isoDate.optional(),
        dueDate: isoDate.nullable().optional(),
        vatTreatment: z.enum(VAT_TREATMENTS).optional(),
        description: z.string().trim().max(500).optional(),
        notes: z.string().max(5000).optional(),
        category: z.enum(EXPENSE_CATEGORY_KEYS).optional().describe("EAR category for all lines"),
        lines: z.array(lineInput).min(1).max(200).optional(),
      }),
      output: ExpenseDetail.extend({ changes: z.array(Change) }),
      annotations: CHANGES_STATE,
    },
    async ({ id, category, lines, ...fields }) => {
      const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(given).length && !category && !lines) throw new ToolError("Keine Felder zum Ändern angegeben");
      const before = await call(ctx.api.expenses[":id"].$get({ param: idParam(id) }));
      const treatment = fields.vatTreatment ?? before.vatTreatment;
      let next: ApiLine[] | undefined = lines ? buildLines(lines, treatment) : treatment !== before.vatTreatment ? adaptLines(toApiLines(before), before.vatTreatment, treatment) : undefined;
      if (category) next = withCategory(next ?? toApiLines(before), category);
      const after = await call(ctx.api.expenses[":id"].$put({ param: idParam(id), json: { ...given, ...(next && { lines: next }) } }));
      const changes = expenseChanges(before, after);
      const hint =
        !fields.vatTreatment && (fields.supplierCountry || fields.supplierUid) && defaultVatTreatment(after.supplierCountry, after.supplierUid) !== after.vatTreatment
          ? `Hinweis: USt-Behandlung ist ${VAT_TREATMENT_SHORT_LABELS[after.vatTreatment]}, für Land/UID üblich wäre ${VAT_TREATMENT_SHORT_LABELS[defaultVatTreatment(after.supplierCountry, after.supplierUid)]}.`
          : null;
      const detail = await expenseDetail(ctx, id);
      return { text: [changeText(changes), hint, detail.text].filter(Boolean).join("\n"), data: { ...detail.data, changes } };
    },
  );

  defineTool(
    server,
    "mark_expense_paid",
    {
      title: "Ausgabe als bezahlt markieren",
      group: "expenses",
      description: "Mark an expense as paid on a date (default today), or as open again with paidAt: null. Bank payments matched in the bank import are not affected.",
      input: z.object({
        id: z.number().int().positive().describe("expense id"),
        paidAt: isoDate.nullable().optional().describe("payment date; default today; null = open again"),
      }),
      output: ExpenseDetail,
      annotations: { ...CHANGES_STATE, idempotentHint: true },
    },
    async ({ id, paidAt }) => {
      const date = paidAt === undefined ? todayIso() : paidAt;
      await call(ctx.api.expenses[":id"].paid.$post({ param: idParam(id), json: { paidAt: date } }));
      const detail = await expenseDetail(ctx, id);
      const head = date ? `Ausgabe als bezahlt am ${deDate(date)} markiert.` : "Ausgabe wieder als offen markiert.";
      return { text: `${head}\n${detail.text}`, data: detail.data };
    },
  );

  defineTool(
    server,
    "apply_receipt_analysis",
    {
      title: "Belegerkennung übernehmen",
      group: "expenses",
      description:
        "Save suggestions of the latest receipt analysis (see get_receipt_analysis) into the expense: only the listed " +
        "`fields`, which the user approved; existing values are replaced. lines = the receipt's tax breakdown as " +
        "expense lines. Pass analysisId from get_receipt_analysis so a newer analysis is not applied unseen.",
      input: z.object({
        expenseId: z.number().int().positive(),
        fields: z.array(z.enum(APPLY_FIELDS)).min(1),
        analysisId: z.number().int().positive().optional(),
      }),
      output: ExpenseDetail.extend({ analysisId: z.number().int(), applied: z.array(z.string()), changes: z.array(Change) }),
      annotations: CHANGES_STATE,
    },
    async ({ expenseId, fields: wanted, analysisId }) => {
      const { analysis: a } = await call(ctx.api.receipts.expenses[":id"].$get({ param: idParam(expenseId) }));
      if (!a) throw new ToolError(`Für Ausgabe ${expenseId} gibt es keine Belegerkennung`);
      if (analysisId && a.id !== analysisId) throw new ToolError(`Inzwischen gibt es eine neuere Belegerkennung (id ${a.id}); mit get_receipt_analysis prüfen`);
      if (a.status === "queued" || a.status === "running") throw new ToolError("Die Belegerkennung läuft noch");
      if (a.stale) throw new ToolError("Der Beleg wurde nach der Erkennung ersetzt oder zugeschnitten; erst neu analysieren");
      if (!a.result) throw new ToolError(`Die Belegerkennung hat keine Vorschläge (${a.status}${a.error ? `: ${a.error}` : ""})`);
      const f: ReceiptFields = a.result.fields;
      const before = await call(ctx.api.expenses[":id"].$get({ param: idParam(expenseId) }));

      const keys = [...new Set(wanted)];
      const missing = keys.filter((k) => (k === "lines" ? !f.taxLines && !f.grossCents : !f[k]));
      if (missing.length) {
        const available = APPLY_FIELDS.filter((k) => (k === "lines" ? f.taxLines || f.grossCents : f[k]));
        throw new ToolError(`Kein Vorschlag für: ${missing.join(", ")}. Vorhanden: ${available.join(", ") || "keine"}`);
      }
      // treatment first: the suggested lines depend on it
      const has = (k: ApplyField) => keys.includes(k);
      const json: Record<string, unknown> = {};
      const treatment = has("vatTreatment") ? f.vatTreatment!.value : before.vatTreatment;
      if (has("vatTreatment")) json.vatTreatment = treatment;
      for (const k of ["supplierName", "supplierUid", "supplierCountry", "supplierInvoiceNumber", "issueDate", "dueDate", "description"] as const) {
        if (has(k)) json[k] = k === "supplierCountry" ? f[k]!.value.toUpperCase() : f[k]!.value;
      }
      let lines: ApiLine[] | undefined;
      if (has("lines")) {
        lines = suggestedLines(f, treatment);
        if (!lines.length) throw new ToolError("Aus der Erkennung lassen sich keine Positionen ableiten");
      } else if (treatment !== before.vatTreatment) lines = adaptLines(toApiLines(before), before.vatTreatment, treatment);
      if (has("category")) lines = withCategory(lines ?? toApiLines(before), f.category!.value);
      if (lines) json.lines = lines;

      const after = await call(ctx.api.expenses[":id"].$put({ param: idParam(expenseId), json }));
      await call(ctx.api.receipts[":id"].applied.$post({ param: idParam(a.id) }));
      const changes = expenseChanges(before, after);
      const detail = await expenseDetail(ctx, expenseId);
      return {
        text: [`Belegerkennung übernommen (${keys.join(", ")}).`, changeText(changes), detail.text].join("\n"),
        data: { ...detail.data, analysisId: a.id, applied: keys, changes },
      };
    },
  );

  defineTool(
    server,
    "create_fixed_cost",
    {
      title: "Fixkosten anlegen",
      group: "expenses",
      description:
        "Create a fixed cost (Fixkosten: recurring outgoing payment such as rent, SVS, a subscription) for the " +
        "forecast. gross = amount per payment in euros, taxRate = VAT % contained in it (0 if none). Interval: " +
        "intervalCount × intervalUnit (3 × month = quarterly). startDate = first payment; later ones keep its day. " +
        "Refuses likely duplicates (same name, or same supplier and amount) unless allowDuplicate: true.",
      input: z.object({
        name: z.string().trim().min(1).max(200),
        supplierName: z.string().trim().max(200).optional(),
        category: z.enum(EXPENSE_CATEGORY_KEYS),
        gross: euroAmount,
        taxRate: taxRateInput.default(20),
        intervalUnit: z.enum(INTERVAL_UNITS).default("month"),
        intervalCount: z.number().int().min(1).max(60).default(1),
        startDate: isoDate,
        endDate: isoDate.optional(),
        notes: z.string().max(5000).optional(),
        allowDuplicate: z.boolean().default(false).describe("create even if a similar fixed cost exists"),
      }),
      output: FixedCost,
      annotations: CREATES,
    },
    async ({ gross, taxRate, supplierName, endDate, notes, allowDuplicate, ...rest }) => {
      if (gross <= 0) throw new ToolError("Betrag muss größer als 0 sein");
      const taxCents = containedTaxCents(gross, taxRateBp(taxRate, "Fixkosten"));
      if (!allowDuplicate) {
        const fold = (s: string) => s.trim().toLowerCase();
        const supplier = fold(supplierName ?? "");
        const dupes = (await call(ctx.api.recurringExpenses.index.$get())).filter(
          (r) => r.active && !r.ended && (fold(r.name) === fold(rest.name) || (supplier && fold(r.supplierName) === supplier && r.grossCents === gross)),
        );
        if (dupes.length) {
          const list = dupes.map((r) => `${r.name} (fixed cost id ${r.id}, ${eur(r.grossCents)} ${intervalLabel(r)})`).join("; ");
          throw new ToolError(`Ähnliche Fixkosten gibt es schon, nichts angelegt: ${list}. Bestehende verwenden oder mit allowDuplicate: true erneut aufrufen.`);
        }
      }
      const r = await call(
        ctx.api.recurringExpenses.index.$post({
          json: {
            ...rest,
            supplierName: supplierName ?? "",
            active: true,
            endDate: endDate ?? null,
            grossCents: gross,
            taxCents,
            notes: notes ?? "",
          },
        }),
      );
      const data = {
        id: r.id,
        name: r.name,
        supplier: r.supplierName,
        categoryLabel: categoryLabel(r.category),
        interval: intervalLabel(r),
        startDate: r.startDate,
        endDate: r.endDate,
        nextPaymentDate: r.nextPaymentDate,
        gross: money(r.grossCents),
        tax: money(r.taxCents),
        monthly: money(r.monthlyCents),
        link: ctx.webUrl("/fixed-costs"),
      };
      const text = [
        `Fixkosten angelegt: ${r.name} (fixed cost id ${r.id})`,
        join(data.supplier, data.categoryLabel, `${data.gross.formatted} ${data.interval}`, r.taxCents > 0 && `davon USt ${data.tax.formatted}`, `pro Monat ${data.monthly.formatted}`),
        join(`ab ${deDate(r.startDate)}`, r.endDate && `bis ${deDate(r.endDate)}`, r.nextPaymentDate ? `nächste Zahlung ${deDate(r.nextPaymentDate)}` : "keine weitere Zahlung"),
        `Link: ${data.link}`,
      ].join("\n");
      return { text, data };
    },
  );

  defineTool(
    server,
    "link_expense_to_fixed_cost",
    {
      title: "Ausgabe mit Fixkosten verknüpfen",
      group: "expenses",
      description:
        "Link an expense to one scheduled payment of a fixed cost; that payment then no longer counts as expected in " +
        "the forecast. Without scheduledDate the best free matching slot is used (supplier or category, amount ±5 %, " +
        "date ±10 days); fails if none fits. Replaces an existing link of the expense.",
      input: z.object({
        expenseId: z.number().int().positive(),
        fixedCostId: z.number().int().positive().optional().describe("default: best matching fixed cost"),
        scheduledDate: isoDate.optional().describe("payment date of the fixed cost; needs fixedCostId"),
      }),
      output: z.object({
        expense: z.object({ id: z.number().int(), number: z.string().nullable(), supplier: z.string(), gross: Money, link: z.string() }),
        fixedCost: z.object({ id: z.number().int(), name: z.string(), scheduledDate: z.string(), gross: Money, link: z.string() }),
        replaced: z.object({ fixedCostId: z.number().int(), name: z.string(), scheduledDate: z.string() }).nullable().describe("previous link of the expense"),
        otherSuggestions: z.array(z.object({ fixedCostId: z.number().int(), name: z.string(), scheduledDate: z.string(), gross: Money })),
      }),
      annotations: CHANGES_STATE,
    },
    async ({ expenseId, fixedCostId, scheduledDate }) => {
      if (scheduledDate && !fixedCostId) throw new ToolError("scheduledDate nur zusammen mit fixedCostId angeben");
      const e = await call(ctx.api.expenses[":id"].$get({ param: idParam(expenseId) }));
      const previous = await call(ctx.api.recurringExpenses.link.$get({ query: { expenseId: String(expenseId) } }));
      const suggestions = scheduledDate ? [] : await call(ctx.api.recurringExpenses.suggestions.$get({ query: { expenseId: String(expenseId) } }));
      let target: { recurringExpenseId: number; scheduledDate: string };
      if (fixedCostId && scheduledDate) target = { recurringExpenseId: fixedCostId, scheduledDate };
      else {
        const best = suggestions.find((s) => !fixedCostId || s.recurringExpenseId === fixedCostId);
        if (!best) {
          throw new ToolError(
            `Kein freier passender Fixkosten-Termin für Ausgabe ${e.number ?? expenseId} (Lieferant oder Kategorie, Betrag ±5 %, Datum ±10 Tage). ` +
              "fixedCostId und scheduledDate angeben (list_fixed_costs).",
          );
        }
        target = best;
      }
      const link = await call(ctx.api.recurringExpenses.links.$post({ json: { ...target, expenseId } }));
      const fc = await call(ctx.api.recurringExpenses[":id"].$get({ param: idParam(target.recurringExpenseId) }));
      const replaced =
        previous && (previous.recurringExpenseId !== link.recurringExpenseId || previous.scheduledDate !== link.scheduledDate)
          ? { fixedCostId: previous.recurringExpenseId, name: previous.name, scheduledDate: previous.scheduledDate }
          : null;
      const others = suggestions
        .filter((s) => !(s.recurringExpenseId === link.recurringExpenseId && s.scheduledDate === link.scheduledDate))
        .slice(0, 5)
        .map((s) => ({ fixedCostId: s.recurringExpenseId, name: s.name, scheduledDate: s.scheduledDate, gross: money(s.grossCents) }));
      const data = {
        expense: { id: e.id, number: e.number, supplier: e.supplierName, gross: money(e.grossCents), link: ctx.webUrl(`/expenses/${e.id}`) },
        fixedCost: { id: fc.id, name: fc.name, scheduledDate: link.scheduledDate, gross: money(fc.grossCents), link: ctx.webUrl("/fixed-costs") },
        replaced,
        otherSuggestions: others,
      };
      const text = [
        `Ausgabe ${e.number ?? ""} (expense id ${e.id}, ${eur(e.grossCents)}) mit Fixkosten ${fc.name} (fixed cost id ${fc.id}) für ${slotLabel(link.scheduledDate)} (${deDate(link.scheduledDate)}) verknüpft.`,
        replaced && `Vorherige Verknüpfung ersetzt: ${replaced.name} · ${deDate(replaced.scheduledDate)}`,
        others.length ? `Weitere passende Termine:\n${bullets(others.map((o) => join(`${o.name} (fixed cost id ${o.fixedCostId})`, deDate(o.scheduledDate), o.gross.formatted)))}` : null,
        `Link: ${data.expense.link}`,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data };
    },
  );

  defineTool(
    server,
    "create_asset",
    {
      title: "Anlage anlegen",
      group: "finance",
      description:
        "Add an asset (Anlagenverzeichnis) depreciated straight-line (AfA, half-year rule). Preferably from an expense " +
        "with lines of category anlagen (expenseId): name, dates and cost (net + non-deductible VAT, minus assets " +
        "already linked) default from it. usefulLifeYears e.g. computer 3, software 4, furniture 10, car ≥ 8. Returns " +
        "the AfA plan. A helper, not tax advice.",
      input: z.object({
        expenseId: z.number().int().positive().optional(),
        name: z.string().trim().min(1).max(300).optional(),
        cost: euroAmount.optional().describe("Anschaffungskosten in euros"),
        acquisitionDate: isoDate.optional(),
        inServiceDate: isoDate.optional().describe("default: acquisitionDate"),
        usefulLifeYears: z.number().int().min(MIN_USEFUL_LIFE_YEARS).max(MAX_USEFUL_LIFE_YEARS),
        notes: z.string().max(5000).optional(),
      }),
      output: AssetCreated,
      annotations: CREATES,
    },
    async ({ expenseId, name, cost, acquisitionDate, inServiceDate, usefulLifeYears, notes }) => {
      const pre = expenseId ? await call(ctx.api.assets["from-expense"][":id"].$get({ param: idParam(expenseId) })) : null;
      if (pre && pre.costCents === 0 && cost === undefined) {
        throw new ToolError(`Die Anlagen-Positionen von Ausgabe ${pre.expenseNumber ?? expenseId} (${eur(pre.totalCostCents)}) sind schon vollständig als Anlagen erfasst`);
      }
      const assetName = name ?? pre?.name;
      const costCents = cost ?? pre?.costCents;
      const acquired = acquisitionDate ?? pre?.acquisitionDate;
      if (assetName === undefined || costCents === undefined || acquired === undefined) {
        const missing = [assetName === undefined && "name", costCents === undefined && "cost", acquired === undefined && "acquisitionDate"].filter(Boolean);
        throw new ToolError(`Ohne expenseId fehlen: ${missing.join(", ")}`);
      }
      if (costCents <= 0) throw new ToolError("Anschaffungskosten müssen größer als 0 sein");
      const a = await call(
        ctx.api.assets.index.$post({
          json: {
            expenseId: expenseId ?? null,
            name: assetName,
            costCents,
            acquisitionDate: acquired,
            inServiceDate: inServiceDate ?? (pre && !acquisitionDate ? pre.inServiceDate : acquired),
            usefulLifeYears,
            notes: notes ?? "",
          },
        }),
      );
      const schedule = assetSchedule(a).map((y) => ({ year: y.year, bookValueStart: money(y.startCents), afa: money(y.afaCents), bookValueEnd: money(y.endCents) }));
      const data = {
        id: a.id,
        number: formatAssetNumber(a.number),
        name: a.name,
        acquisitionDate: a.acquisitionDate,
        inServiceDate: a.inServiceDate,
        usefulLifeYears: a.usefulLifeYears,
        cost: money(a.costCents),
        annualAfa: money(annualAfaCents(a)),
        halfYearFirst: !isFirstHalf(a.inServiceDate),
        gwg: a.costCents <= GWG_LIMIT_CENTS,
        expense: a.expense && { id: a.expense.id, number: a.expense.number, supplier: a.expense.supplierName, link: ctx.webUrl(`/expenses/${a.expense.id}`) },
        schedule,
        link: ctx.webUrl(`/assets/${a.id}`),
      };
      const text = [
        `Anlage angelegt: ${data.number} ${a.name} (asset id ${a.id})`,
        join(`AK ${data.cost.formatted}`, `angeschafft ${deDate(a.acquisitionDate)}`, `in Betrieb ${deDate(a.inServiceDate)}`, `${a.usefulLifeYears} Jahre`, a.expense && `aus Ausgabe ${a.expense.number ?? a.expense.id}`),
        `AfA-Plan (jährlich ${data.annualAfa.formatted}${data.halfYearFirst ? ", im ersten Jahr Halbjahres-AfA" : ""}):`,
        bullets(schedule.map((y) => `${y.year}: AfA ${y.afa.formatted}, Buchwert 31.12. ${y.bookValueEnd.formatted}`)),
        data.gwg && "Hinweis: AK ≤ 1.000 €, als geringwertiges Wirtschaftsgut auch sofort absetzbar.",
        "Hilfsrechnung, keine Steuerberatung.",
        `Link: ${data.link}`,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data };
    },
  );
}
