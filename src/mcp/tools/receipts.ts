import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { categoryLabel, VAT_TREATMENT_SHORT_LABELS, type VatTreatment } from "../../shared/expenses";
import { ANALYSIS_STATUSES, FIELD_SOURCE_LABELS, RECEIPT_FIELD_LABELS, type ReceiptFieldKey, TEXT_SOURCE_LABELS } from "../../shared/receipts";
import { ApiError, call, idParam, remoteApi } from "../api";
import { bullets, deDate, join, Money, money, percent } from "../format";
import { CREATES, defineTool, READ_ONLY, type ToolContext, ToolError } from "../tool";

// Receipt analysis (Belegerkennung). Reading results is in-process; QUEUEING goes to the running nesev server over
// HTTP, because POST /api/receipts/analyze starts the worker (OCR, llama-server) in the process that serves it, and
// that must never be the MCP process (api.ts refuses it in-process).

const STATUS_LABELS: Record<(typeof ANALYSIS_STATUSES)[number], string> = {
  queued: "in der Warteschlange",
  running: "läuft",
  done: "fertig",
  failed: "fehlgeschlagen",
  cancelled: "abgebrochen",
};

function displayValue(key: ReceiptFieldKey, value: unknown): string {
  if (key === "grossCents" && typeof value === "number") return money(value).formatted;
  if (key === "category" && typeof value === "string") return categoryLabel(value);
  if (key === "vatTreatment" && typeof value === "string") return VAT_TREATMENT_SHORT_LABELS[value as VatTreatment] ?? value;
  if (key === "issueDate" || key === "dueDate") return deDate(String(value));
  return String(value);
}

/** network failure (refused, timeout) talking to the nesev server */
function unreachable(url: string) {
  return new ToolError(
    `nesev-Server unter ${url} nicht erreichbar. Die Belegerkennung läuft nur im nesev-Server (bun run dev / bun start), ` +
      "nicht im MCP-Prozess. Server starten oder NESEV_API_URL setzen.",
  );
}

export function registerReceiptTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "get_receipt_analysis",
    {
      title: "Belegerkennung anzeigen",
      group: "expenses",
      description:
        "Latest receipt analysis (OCR + field extraction) of an expense: status, and when done the suggested fields " +
        "(supplier, UID, invoice number, dates, gross amount, category, VAT treatment, tax lines) with confidence 0..1 " +
        "and source, plus warnings. Suggestions are never applied automatically; to use them, update the expense in the " +
        "web app. `stale` means the receipt was replaced after the analysis.",
      input: z.object({ expenseId: z.number().int().positive() }),
      output: z.object({
        expenseId: z.number().int(),
        analysis: z
          .object({
            id: z.number().int(),
            status: z.enum(ANALYSIS_STATUSES),
            statusLabel: z.string(),
            textSource: z.string().nullable(),
            model: z.string(),
            error: z.string(),
            queuedAt: z.string(),
            startedAt: z.string().nullable(),
            finishedAt: z.string().nullable(),
            stale: z.boolean(),
            applied: z.boolean(),
            suggestions: z.array(
              z.object({
                field: z.string(),
                label: z.string(),
                value: z.string().describe("display value (amounts formatted, dates dd.mm.yyyy)"),
                rawValue: z.union([z.string(), z.number()]).describe("value as stored (cents, YYYY-MM-DD, keys)"),
                confidence: z.number(),
                source: z.string(),
                note: z.string().nullable(),
              }),
            ),
            taxLines: z.array(z.object({ ratePercent: z.number(), net: Money, tax: Money, gross: Money })),
            warnings: z.array(z.string()),
            modelSkipped: z.boolean(),
          })
          .nullable()
          .describe("null = never analysed"),
        link: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async ({ expenseId }) => {
      const { analysis: a } = await call(ctx.api.receipts.expenses[":id"].$get({ param: idParam(expenseId) }));
      const link = ctx.webUrl(`/expenses/${expenseId}`);
      if (!a) {
        return {
          text: `Für Ausgabe ${expenseId} gibt es noch keine Belegerkennung. Mit queue_receipt_analysis starten (nesev-Server muss laufen).\nLink: ${link}`,
          data: { expenseId, analysis: null, link },
        };
      }
      const fields = a.result?.fields ?? {};
      const suggestions = (Object.keys(fields) as ReceiptFieldKey[])
        .filter((k) => k !== "taxLines" && fields[k])
        .map((k) => {
          const f = fields[k]!;
          return {
            field: k,
            label: RECEIPT_FIELD_LABELS[k],
            value: displayValue(k, f.value),
            rawValue: f.value as string | number,
            confidence: f.confidence,
            source: FIELD_SOURCE_LABELS[f.source] ?? f.source,
            note: f.note ?? null,
          };
        });
      const taxLines = (fields.taxLines?.value ?? []).map((t) => ({
        ratePercent: percent(t.taxRateBp),
        net: money(t.netCents),
        tax: money(t.taxCents),
        gross: money(t.grossCents),
      }));
      const data = {
        expenseId,
        analysis: {
          id: a.id,
          status: a.status,
          statusLabel: STATUS_LABELS[a.status],
          textSource: a.textSource ? TEXT_SOURCE_LABELS[a.textSource] : null,
          model: a.model,
          error: a.error,
          queuedAt: a.createdAt,
          startedAt: a.startedAt,
          finishedAt: a.finishedAt,
          stale: a.stale,
          applied: a.appliedAt !== null,
          suggestions,
          taxLines,
          warnings: a.result?.warnings ?? [],
          modelSkipped: a.result?.llmSkipped ?? false,
        },
        link,
      };
      const text = [
        `Belegerkennung für Ausgabe ${expenseId}: ${STATUS_LABELS[a.status]}${a.stale ? " (veraltet: Beleg wurde ersetzt)" : ""}${a.error ? ` – ${a.error}` : ""}`,
        a.textSource && `Text aus: ${TEXT_SOURCE_LABELS[a.textSource]}${a.model ? ` · Modell ${a.model}` : ""}`,
        suggestions.length
          ? `Vorschläge (nicht übernommen):\n${bullets(suggestions.map((s) => join(`${s.label}: ${s.value}`, `Sicherheit ${Math.round(s.confidence * 100)} %`, s.source, s.note)))}`
          : null,
        taxLines.length ? `Steuerzeilen: ${taxLines.map((t) => `${t.ratePercent} %: netto ${t.net.formatted}, USt ${t.tax.formatted}`).join("; ")}` : null,
        data.analysis.warnings.length ? `Hinweise:\n${bullets(data.analysis.warnings)}` : null,
        `Link: ${link}`,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data };
    },
  );

  defineTool(
    server,
    "queue_receipt_analysis",
    {
      title: "Belegerkennung starten",
      group: "expenses",
      description:
        "Queue the local receipt analysis (OCR + field extraction, fully on this machine) for expenses that have a " +
        "receipt attached. The analysis runs in the nesev server process, so the nesev server must be running " +
        "(bun run dev or bun start; URL from NESEV_API_URL, default http://localhost:3998) – otherwise this returns an " +
        "error and nothing is queued. Results never overwrite the expense; read them later with get_receipt_analysis. " +
        "Expenses without receipt or already queued/running are skipped.",
      input: z.object({ expenseIds: z.array(z.number().int().positive()).min(1).max(500) }),
      output: z.object({
        server: z.string(),
        queued: z.array(z.number().int()),
        skipped: z.array(z.object({ expenseId: z.number().int(), reason: z.string() })),
      }),
      annotations: { ...CREATES, idempotentHint: true },
    },
    async ({ expenseIds }) => {
      const ids = [...new Set(expenseIds)];
      // inside the nesev server (assistant) the worker is right here
      const result = ctx.inServer ? await call(ctx.api.receipts.analyze.$post({ json: { expenseIds: ids } })) : await queueRemote(ids);
      const server = ctx.inServer ? "nesev-Server" : ctx.apiUrl;
      const text = [
        result.queued.length
          ? `${result.queued.length} Beleg(e) zur Erkennung eingereiht (Ausgaben ${result.queued.join(", ")}); Ergebnis später mit get_receipt_analysis abrufen.`
          : "Nichts eingereiht.",
        result.skipped.length ? `Übersprungen:\n${bullets(result.skipped.map((s) => `Ausgabe ${s.expenseId}: ${s.reason}`))}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data: { server, queued: result.queued, skipped: result.skipped } };
    },
  );

  /** Queue on the running nesev server over HTTP, after checking it works on the same data. */
  async function queueRemote(ids: number[]): Promise<{ queued: number[]; skipped: { expenseId: number; reason: string }[] }> {
    const remote = remoteApi(ctx.apiUrl);
    // the server must work on the same data as this MCP process (same NESEV_DATA_DIR)
    for (const id of ids) {
      const local = await call(ctx.api.expenses[":id"].$get({ param: idParam(id) }));
      let other: Awaited<ReturnType<typeof remoteExpense>> | null;
      try {
        other = await remoteExpense(remote, id);
      } catch (err) {
        if (err instanceof ApiError) other = null;
        else throw unreachable(ctx.apiUrl);
      }
      if (!other || other.number !== local.number || other.supplierName !== local.supplierName || other.attachmentPath !== local.attachmentPath) {
        throw new ToolError(
          `Der nesev-Server unter ${ctx.apiUrl} arbeitet mit anderen Daten als der MCP-Server (Ausgabe ${id} weicht ab). ` +
            "NESEV_DATA_DIR / NESEV_API_URL prüfen; nichts eingereiht.",
        );
      }
    }
    try {
      return await call(remote.receipts.analyze.$post({ json: { expenseIds: ids } }));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw unreachable(ctx.apiUrl);
    }
  }
}

function remoteExpense(remote: ReturnType<typeof remoteApi>, id: number) {
  return call(remote.expenses[":id"].$get({ param: idParam(id) }));
}
