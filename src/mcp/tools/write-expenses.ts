import type { McpServer } from "@modelcontextprotocol/server";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  defaultVatTreatment,
  EXPENSE_CATEGORY_KEYS,
  expenseTaxCents,
  netFromGross,
  RECEIPT_MAX_BYTES,
  RECEIPT_MIME_TYPES,
  VAT_TREATMENTS,
} from "../../shared/expenses";
import { ApiError, call, idParam } from "../api";
import { euroAmount, isoDate } from "../format";
import { taxRateBp, taxRateInput } from "../inputs";
import { CREATES, defineTool, type ToolContext, ToolError } from "../tool";
import { expenseDetail, ExpenseDetail } from "./expenses";

// create_expense: an expense with lines, optionally its receipt file (uploaded through the same endpoint as the UI)
// and the link to a scheduled Fixkosten payment.

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(RECEIPT_MIME_TYPES).map(([mime, ext]) => [ext, mime]));

/** first bytes of the accepted receipt types */
function sniff(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (ascii(0, 4) === "%PDF") return "pdf";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

/** Reads and checks a local receipt file like the UI does (PDF/JPG/PNG/WebP, ≤ 20 MB, not empty). */
export async function readReceiptFile(path: string): Promise<File> {
  const full = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(full)) throw new ToolError(`receiptPath muss ein absoluter Pfad sein: ${path}`);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new ToolError(`Belegdatei nicht gefunden: ${full}`);
  if (info.size === 0) throw new ToolError("Belegdatei ist leer");
  if (info.size > RECEIPT_MAX_BYTES) throw new ToolError("Belegdatei ist zu groß (max. 20 MB)");
  const extRaw = full.toLowerCase().split(".").pop() ?? "";
  const ext = extRaw === "jpeg" ? "jpg" : extRaw;
  if (!MIME_BY_EXT[ext]) throw new ToolError("Nur PDF, JPG, PNG oder WebP erlaubt");
  const bytes = new Uint8Array(await Bun.file(full).arrayBuffer());
  const actual = sniff(bytes);
  if (actual !== ext) throw new ToolError(`Der Inhalt von ${basename(full)} ist kein gültiges ${ext.toUpperCase()}`);
  return new File([bytes], basename(full), { type: MIME_BY_EXT[ext] });
}

export function registerExpenseWriteTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "create_expense",
    {
      title: "Ausgabe erfassen",
      group: "expenses",
      description:
        "Record an expense (Eingangsrechnung / Beleg). Lines carry the EAR category, net amount OR gross amount in euros, " +
        "VAT rate (20/13/10/0 %; for reverse charge / ig. Erwerb the Austrian rate that is self-assessed) and the " +
        "deductible share in % (default 100). VAT treatment defaults from supplier country and UID like in the UI " +
        "(AT → domestic, EU with UID → reverse_charge, non-EU → reverse_charge). paidAt marks it paid. Optional: " +
        "receiptPath = absolute path of a local PDF/JPG/PNG/WebP (≤ 20 MB) that is attached as the receipt; " +
        "fixedCostId + fixedCostSlot link it to a scheduled Fixkosten payment (see list_fixed_costs). Receipt analysis " +
        "(OCR) is never started automatically; use queue_receipt_analysis for that.",
      input: z.object({
        supplierName: z.string().trim().min(1).max(200),
        supplierCountry: z.string().trim().length(2).default("AT").describe("ISO alpha-2"),
        supplierUid: z.string().trim().max(30).optional(),
        supplierInvoiceNumber: z.string().trim().max(100).optional(),
        issueDate: isoDate.describe("invoice date"),
        dueDate: isoDate.optional(),
        paidAt: isoDate.optional().describe("date fully paid; omit if still open"),
        vatTreatment: z.enum(VAT_TREATMENTS).optional().describe("default from country/UID"),
        description: z.string().trim().max(500).optional().describe("short, e.g. 'Internet Oktober'"),
        notes: z.string().max(5000).optional(),
        lines: z
          .array(
            z.object({
              category: z.enum(EXPENSE_CATEGORY_KEYS).describe("EAR category key"),
              description: z.string().trim().max(500).optional(),
              net: euroAmount.optional().describe("net amount in euros (give net or gross)"),
              gross: euroAmount.optional().describe("gross amount in euros incl. VAT (give net or gross)"),
              taxRate: taxRateInput.default(20),
              tax: euroAmount.optional().describe("VAT in euros as printed on the receipt; default computed"),
              deductiblePercent: z.number().min(0).max(100).default(100).describe("deductible share of the VAT"),
            }),
          )
          .min(1)
          .max(200),
        receiptPath: z.string().trim().max(1000).optional().describe("absolute local file path of the receipt"),
        fixedCostId: z.number().int().positive().optional().describe("Fixkosten entry to link"),
        fixedCostSlot: isoDate.optional().describe("scheduled payment date of that Fixkosten entry"),
      }),
      output: ExpenseDetail,
      annotations: CREATES,
    },
    async ({ lines, receiptPath, fixedCostId, fixedCostSlot, ...fields }) => {
      if (!!fixedCostId !== !!fixedCostSlot) throw new ToolError("fixedCostId und fixedCostSlot nur gemeinsam angeben");
      // validate everything before anything is created
      const file = receiptPath ? await readReceiptFile(receiptPath) : null;
      if (fixedCostId) await call(ctx.api.recurringExpenses[":id"].$get({ param: idParam(fixedCostId) }));
      const vatTreatment = fields.vatTreatment ?? defaultVatTreatment(fields.supplierCountry, fields.supplierUid);
      const apiLines = lines.map((l, i) => {
        const where = `Zeile ${i + 1}`;
        if ((l.net === undefined) === (l.gross === undefined)) throw new ToolError(`${where}: net oder gross angeben (genau eines)`);
        const rate = vatTreatment === "none" ? 0 : taxRateBp(l.taxRate, where);
        const fromGross = l.gross !== undefined ? netFromGross(l.gross, rate) : null;
        const netCents = fromGross ? fromGross.netCents : l.net!;
        const taxCents = l.tax ?? (fromGross ? fromGross.taxCents : expenseTaxCents(netCents, rate));
        return {
          category: l.category,
          description: l.description ?? "",
          netCents,
          taxRateBp: rate,
          taxCents,
          deductibleBp: Math.round(l.deductiblePercent * 100),
        };
      });

      const e = await call(ctx.api.expenses.index.$post({ json: { ...fields, vatTreatment, lines: apiLines } }));
      const label = `Ausgabe ${e.number} (expense id ${e.id})`;
      const notes: string[] = [];
      try {
        if (file) await call(ctx.api.expenses[":id"].attachment.$post({ param: idParam(e.id), form: { file } }));
        if (fixedCostId && fixedCostSlot) {
          await call(ctx.api.recurringExpenses.links.$post({ json: { recurringExpenseId: fixedCostId, expenseId: e.id, scheduledDate: fixedCostSlot } }));
        }
      } catch (err) {
        if (err instanceof ApiError) throw new ApiError(err.status, `${label} wurde angelegt, aber: ${err.message}`);
        throw err;
      }
      if (file) notes.push(`Beleg ${file.name} angehängt.`);
      const detail = await expenseDetail(ctx, e.id);
      return { text: [`${label} angelegt.`, ...notes, detail.text].join("\n"), data: detail.data };
    },
  );
}
