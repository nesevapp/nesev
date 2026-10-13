import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_KEYS, VAT_TREATMENTS, type VatTreatment } from "../../shared/expenses";
import { type FieldSuggestion, isCategoryKey, type ReceiptFields, shortDescription, type TaxLineSuggestion } from "../../shared/receipts";
import { eurToCents, parseDate } from "./receipt-parse";

// Local field extraction via Ollama's HTTP API (structured outputs: `format` = JSON schema, temperature 0).
// Only loopback URLs are configurable (see ocrSettingsSchema), so receipts never leave the machine.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type OllamaErrorKind = "unreachable" | "model_missing" | "bad_response";

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: OllamaErrorKind,
  ) {
    super(message);
  }
}

export const ollamaUnreachableMessage = () => "Ollama läuft nicht – starte es mit `ollama serve`";
export const modelMissingMessage = (model: string) =>
  `Modell ${model} fehlt – \`ollama pull ${model}\` (meldet der Download „requires a newer version of Ollama“: zuerst \`brew upgrade ollama\`)`;
export const ollamaTooOldMessage = (model: string) =>
  `${model} benötigt eine neuere Ollama-Version – \`brew upgrade ollama\`, dann \`ollama pull ${model}\``;

export interface OllamaModel {
  name: string;
  size: number;
}

async function request(fetchFn: FetchFn, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 5_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetchFn(url, { ...rest, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new OllamaError("Ollama antwortet nicht (Zeitüberschreitung)", "unreachable");
    throw new OllamaError(ollamaUnreachableMessage(), "unreachable");
  }
}

/** Installed models (GET /api/tags). Throws OllamaError("unreachable") when Ollama isn't running. */
export async function listModels(baseUrl: string, fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<OllamaModel[]> {
  const res = await request(fetchFn, `${baseUrl}/api/tags`, { signal });
  if (!res.ok) throw new OllamaError(`Ollama: HTTP ${res.status}`, "bad_response");
  const body = (await res.json()) as { models?: { name: string; size?: number }[] };
  return (body.models ?? []).map((m) => ({ name: m.name, size: m.size ?? 0 }));
}

/** Ollama version (GET /api/version), or null. */
export async function ollamaVersion(baseUrl: string, fetchFn: FetchFn = fetch): Promise<string | null> {
  try {
    const res = await request(fetchFn, `${baseUrl}/api/version`);
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** "qwen3.5:4b" matches "qwen3.5:4b"; "llama3.2" matches "llama3.2:latest". */
export function hasModel(models: readonly OllamaModel[], model: string): boolean {
  const want = model.includes(":") ? model : `${model}:latest`;
  return models.some((m) => m.name === want || m.name === model);
}

/** Unloads a model if it is currently loaded (POST /api/generate with keep_alive 0 and no prompt). */
export async function unloadModel(baseUrl: string, model: string, fetchFn: FetchFn = fetch): Promise<boolean> {
  try {
    const ps = await request(fetchFn, `${baseUrl}/api/ps`);
    const loaded = ((await ps.json()) as { models?: { name: string; model?: string }[] }).models ?? [];
    const want = model.includes(":") ? model : `${model}:latest`;
    if (!loaded.some((m) => m.name === want || m.model === want || m.name === model)) return false;
    await request(fetchFn, `${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
    return true;
  } catch {
    return false;
  }
}

// --- extraction ------------------------------------------------------------------------------------

const nullable = (type: string) => ({ type: [type, "null"] });

const CONFIDENCE_KEYS = [
  "supplierName",
  "supplierUid",
  "supplierCountry",
  "supplierInvoiceNumber",
  "issueDate",
  "dueDate",
  "grossTotal",
  "taxLines",
  "iban",
  "category",
  "vatTreatment",
] as const;

/** JSON schema passed as Ollama `format`. */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    supplierName: nullable("string"),
    supplierUid: nullable("string"),
    supplierCountry: nullable("string"),
    supplierInvoiceNumber: nullable("string"),
    issueDate: nullable("string"),
    dueDate: nullable("string"),
    currency: nullable("string"),
    grossTotal: nullable("number"),
    taxLines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ratePercent: { type: "number" },
          net: nullable("number"),
          tax: nullable("number"),
          gross: nullable("number"),
        },
        required: ["ratePercent", "net", "tax", "gross"],
      },
    },
    iban: nullable("string"),
    description: nullable("string"),
    category: { type: "string", enum: EXPENSE_CATEGORY_KEYS },
    vatTreatment: { type: "string", enum: VAT_TREATMENTS },
    confidence: {
      type: "object",
      properties: Object.fromEntries(CONFIDENCE_KEYS.map((k) => [k, { type: "number" }])),
      required: CONFIDENCE_KEYS,
    },
  },
  required: [
    "supplierName",
    "supplierUid",
    "supplierCountry",
    "supplierInvoiceNumber",
    "issueDate",
    "dueDate",
    "currency",
    "grossTotal",
    "taxLines",
    "iban",
    "description",
    "category",
    "vatTreatment",
    "confidence",
  ],
} as const;

export interface PromptContext {
  /** our own company (the recipient), so the model doesn't take it for the supplier */
  ownName?: string;
  ownUid?: string;
}

export function buildPrompt(text: string, ctx: PromptContext, withImages: boolean): { system: string; user: string } {
  const categories = EXPENSE_CATEGORIES.map((c) => `${c.key} = ${c.label}`).join("; ");
  const own = [ctx.ownName, ctx.ownUid].filter(Boolean).join(", ");
  const system = [
    "Du liest österreichische und internationale Rechnungen und Kassenbelege aus und antwortest ausschließlich mit JSON nach dem vorgegebenen Schema.",
    "Regeln:",
    "- supplierName: Aussteller/Verkäufer des Belegs (Firmenname wie gedruckt), NICHT der Rechnungsempfänger." +
      (own ? ` Der Empfänger sind wir: ${own} – diese Daten nie als Lieferant verwenden.` : ""),
    "- supplierUid: UID/VAT-Nummer des Ausstellers ohne Leerzeichen (z. B. ATU12345678, IE6388047V).",
    "- supplierCountry: ISO-Ländercode des Ausstellers (AT, DE, IE, …).",
    "- supplierInvoiceNumber: Rechnungs- oder Belegnummer.",
    "- issueDate/dueDate: Rechnungsdatum und Fälligkeit im Format YYYY-MM-DD.",
    "- Beträge als Zahl mit Punkt als Dezimaltrennzeichen in Rechnungswährung (z. B. 17.11), keine Tausendertrennzeichen.",
    "- grossTotal: zu zahlender Gesamtbetrag (brutto).",
    "- taxLines: USt-/MwSt-Aufschlüsselung je Steuersatz (ratePercent z. B. 20, 10, 13, 0) mit net, tax, gross. Bei Reverse Charge ein Eintrag mit ratePercent 0. Ohne Aufschlüsselung, aber mit einem Steuersatz: ein Eintrag.",
    "- iban: IBAN des Ausstellers ohne Leerzeichen.",
    "- description: kurze Beschreibung der Leistung (max. 6 Wörter, deutsch), z. B. „Hosting Oktober 2026“.",
    `- category: eine von: ${categories}.`,
    "- vatTreatment: domestic = Inland mit österreichischer USt; reverse_charge = Leistung aus dem Ausland ohne USt (Reverse Charge, Steuerschuld geht über); ig_acquisition = Waren aus einem EU-Land ohne USt (innergemeinschaftlicher Erwerb); import = Einfuhr mit EUSt; none = ohne USt (Kleinunternehmer, Versicherung, Gebühren).",
    "- confidence: deine Sicherheit je Feld zwischen 0 und 1.",
    "- Was nicht auf dem Beleg steht: null. Nichts erfinden.",
  ].join("\n");
  const body = text.length > 12_000 ? `${text.slice(0, 12_000)}\n[…gekürzt]` : text;
  const user = withImages
    ? `Lies den Beleg auf den Bildern aus.${body.trim() ? `\n\nZusätzlich erkannter Text (kann Fehler enthalten):\n${body}` : ""}`
    : `Belegtext:\n"""\n${body}\n"""`;
  return { system, user };
}

interface LlmOutput {
  supplierName?: string | null;
  supplierUid?: string | null;
  supplierCountry?: string | null;
  supplierInvoiceNumber?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  currency?: string | null;
  grossTotal?: number | string | null;
  taxLines?: { ratePercent?: number; net?: number | null; tax?: number | null; gross?: number | null }[];
  iban?: string | null;
  description?: string | null;
  category?: string | null;
  vatTreatment?: string | null;
  confidence?: Partial<Record<(typeof CONFIDENCE_KEYS)[number], number>>;
}

/** Model output → field suggestions (normalized, model confidences capped at 0.9). */
export function mapLlmOutput(out: LlmOutput): ReceiptFields {
  const conf = out.confidence ?? {};
  const llm = <T>(value: T, key: (typeof CONFIDENCE_KEYS)[number]): FieldSuggestion<T> => {
    const c = conf[key];
    return { value, confidence: typeof c === "number" && c >= 0 && c <= 1 ? Math.min(0.9, c) : 0.7, source: "llm" };
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null);
  const fields: ReceiptFields = {};

  const name = str(out.supplierName);
  if (name) fields.supplierName = llm(name, "supplierName");
  const uid = str(out.supplierUid);
  if (uid) fields.supplierUid = llm(uid.toUpperCase().replace(/[\s.-]/g, ""), "supplierUid");
  const country = str(out.supplierCountry)?.toUpperCase();
  if (country && /^[A-Z]{2}$/.test(country)) fields.supplierCountry = llm(country === "EL" ? "GR" : country, "supplierCountry");
  const number = str(out.supplierInvoiceNumber);
  if (number) fields.supplierInvoiceNumber = llm(number, "supplierInvoiceNumber");
  const issue = str(out.issueDate) && parseDate(str(out.issueDate)!);
  if (issue) fields.issueDate = llm(issue, "issueDate");
  const due = str(out.dueDate) && parseDate(str(out.dueDate)!);
  if (due) fields.dueDate = llm(due, "dueDate");
  const currency = str(out.currency)?.toUpperCase();
  if (currency && /^[A-Z]{3}$/.test(currency)) fields.currency = { value: currency, confidence: 0.8, source: "llm" };
  const gross = eurToCents(out.grossTotal);
  if (gross != null && gross !== 0) fields.grossCents = llm(gross, "grossTotal");
  const iban = str(out.iban);
  if (iban) fields.iban = llm(iban.toUpperCase().replace(/\s+/g, ""), "iban");
  const description = str(out.description);
  const short = description && shortDescription(description);
  if (short) fields.description = { value: short, confidence: 0.6, source: "llm" };
  if (isCategoryKey(out.category)) fields.category = llm(out.category, "category");
  if (out.vatTreatment && (VAT_TREATMENTS as readonly string[]).includes(out.vatTreatment)) {
    fields.vatTreatment = llm(out.vatTreatment as VatTreatment, "vatTreatment");
  }

  const rows: TaxLineSuggestion[] = [];
  for (const r of out.taxLines ?? []) {
    const rate = typeof r.ratePercent === "number" ? Math.round(r.ratePercent * 100) : null;
    if (rate == null || rate < 0 || rate > 10000) continue;
    let net = eurToCents(r.net);
    let tax = eurToCents(r.tax);
    let grossRow = eurToCents(r.gross);
    if (net == null && grossRow != null && tax != null) net = grossRow - tax;
    if (tax == null && net != null && grossRow != null) tax = grossRow - net;
    if (tax == null && net != null) tax = Math.round((net * rate) / 10000);
    if (net == null || tax == null) continue;
    grossRow ??= net + tax;
    if (rows.some((x) => x.taxRateBp === rate)) continue;
    rows.push({ taxRateBp: rate, netCents: net, taxCents: tax, grossCents: grossRow });
  }
  if (rows.length) fields.taxLines = llm(rows.sort((a, b) => a.taxRateBp - b.taxRateBp), "taxLines");
  return fields;
}

/** The JSON object of an answer (tolerates code fences or a leading <think> block from reasoning models). */
export function jsonBody(content: string): string {
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

export interface OllamaExtractOptions {
  baseUrl: string;
  model: string;
  text: string;
  /** base64 PNG page images (vision mode) */
  images?: string[];
  context?: PromptContext;
  /** e.g. 0 to unload right after the answer, "5m" while a batch continues */
  keepAlive: number | string;
  signal?: AbortSignal;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export interface OllamaExtractResult {
  fields: ReceiptFields;
  raw: unknown;
  durationMs: number;
  /** e.g. the runner could not enforce the JSON schema */
  warning?: string;
}

/** Shape the model has to answer with when the runner cannot enforce the schema (prompt-only fallback). */
const JSON_SHAPE_HINT = `Antworte NUR mit einem JSON-Objekt genau dieser Form (null wo unbekannt):
{"supplierName": string|null, "supplierUid": string|null, "supplierCountry": string|null, "supplierInvoiceNumber": string|null,
 "issueDate": "YYYY-MM-DD"|null, "dueDate": "YYYY-MM-DD"|null, "currency": string|null, "grossTotal": number|null,
 "taxLines": [{"ratePercent": number, "net": number|null, "tax": number|null, "gross": number|null}],
 "iban": string|null, "description": string|null, "category": string, "vatTreatment": string,
 "confidence": {${CONFIDENCE_KEYS.map((k) => `"${k}": number`).join(", ")}}}`;

export async function extractWithOllama(opts: OllamaExtractOptions): Promise<OllamaExtractResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const { system, user } = buildPrompt(opts.text, opts.context ?? {}, !!opts.images?.length);
  const started = performance.now();
  const chat = (structured: boolean) =>
    request(fetchFn, `${opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 600_000,
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        // Qwen3-family models would otherwise "think" first: slower, and the answer must be plain JSON
        think: false,
        ...(structured ? { format: EXTRACTION_SCHEMA } : {}),
        keep_alive: opts.keepAlive,
        options: { temperature: 0, num_ctx: 8192 },
        messages: [
          { role: "system", content: structured ? system : `${system}\n\n${JSON_SHAPE_HINT}` },
          { role: "user", content: user, ...(opts.images?.length ? { images: opts.images } : {}) },
        ],
      }),
    });

  let structured = true;
  let res = await chat(true);
  let error = res.ok ? "" : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
  // Some runners (e.g. Ollama's MLX engine without xgrammar) can't enforce a JSON schema: ask via the prompt
  if (!res.ok && /structured output|format/i.test(error)) {
    structured = false;
    res = await chat(false);
    error = res.ok ? "" : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "";
  }
  if (!res.ok) {
    if (res.status === 412 || /newer version/i.test(error)) {
      throw new OllamaError(ollamaTooOldMessage(opts.model), "model_missing");
    }
    if (res.status === 404 || /not found|pull/i.test(error)) {
      throw new OllamaError(modelMissingMessage(opts.model), "model_missing");
    }
    throw new OllamaError(`Ollama-Fehler: ${error || `HTTP ${res.status}`}`, "bad_response");
  }
  const body = (await res.json()) as { message?: { content?: string } };
  let parsed: LlmOutput;
  try {
    parsed = JSON.parse(jsonBody(body.message?.content ?? "")) as LlmOutput;
  } catch {
    throw new OllamaError("Ollama lieferte kein gültiges JSON", "bad_response");
  }
  return {
    fields: mapLlmOutput(parsed),
    raw: parsed,
    durationMs: Math.round(performance.now() - started),
    ...(structured ? {} : { warning: "Modell ohne erzwungenes JSON-Schema (Structured Output nicht verfügbar) – Antwort per Prompt geparst" }),
  };
}
