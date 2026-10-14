import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_KEYS, VAT_TREATMENTS, type VatTreatment } from "../../shared/expenses";
import { type FieldSuggestion, isCategoryKey, type ReceiptFields, shortDescription, type TaxLineSuggestion } from "../../shared/receipts";
import { eurToCents, parseDate } from "./receipt-parse";

// Field extraction by the local model: prompt, JSON schema, mapping of the answer to field suggestions, and the
// HTTP client for the llama-server that nesev starts itself (see receipt-llama.ts): POST {base}/chat/completions
// with a JSON-schema response_format (llama-server enforces it as a grammar, so the answer is always
// schema-shaped JSON – no prompt-only fallback needed) and temperature 0. The base URL is the loopback endpoint
// of nesev's own server; its per-process key goes in the Authorization header and never into a message.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type LlmErrorKind = "unreachable" | "model_missing" | "bad_response" | "no_vision";

/** A model step failure that degrades to rules-only results. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
  ) {
    super(message);
  }
}

export const noVisionMessage = () =>
  "Das Modell kann keine Bilder lesen – mmproj-Datei eintragen bzw. neben das Modell legen oder Modus „Text“ wählen";

async function request(fetchFn: FetchFn, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 5_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetchFn(url, { ...rest, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new LlmError("llama-server antwortet nicht (Zeitüberschreitung)", "unreachable");
    throw new LlmError("llama-server nicht erreichbar (abgestürzt?)", "unreachable");
  }
}

/** Error text of a failed response: `{error:{message}}` (llama-server), `{error:"…"}` or plain text. */
async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw) as { error?: string | { message?: string }; message?: string };
    const e = body.error;
    if (typeof e === "string") return e;
    if (e && typeof e.message === "string") return e.message;
    if (typeof body.message === "string") return body.message;
  } catch {
    // not JSON
  }
  return raw.slice(0, 300);
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

/** JSON schema of the answer (sent as `response_format.json_schema.schema`; llama-server turns it into a grammar). */
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

export interface LlmOutput {
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

type JsonSchema = { [key: string]: unknown };

/** Every object closed (`additionalProperties: false`), so the grammar allows no extra keys. */
export function strictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (out.type === "object") out.additionalProperties = false;
  if (out.properties && typeof out.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(out.properties as Record<string, JsonSchema>).map(([k, v]) => [k, strictSchema(v)]));
  }
  if (out.items && typeof out.items === "object") out.items = strictSchema(out.items as JsonSchema);
  return out;
}

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "receipt", strict: true, schema: strictSchema(EXTRACTION_SCHEMA as unknown as JsonSchema) },
};

export interface ExtractOptions {
  /** llama-server base URL incl. /v1 */
  baseUrl: string;
  /** llama-server's per-process key (Authorization header) */
  apiKey: string;
  model: string;
  text: string;
  /** base64 PNG page images (vision mode), sent as image_url data URLs */
  images?: string[];
  context?: PromptContext;
  signal?: AbortSignal;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export interface ExtractResult {
  fields: ReceiptFields;
  raw: unknown;
  durationMs: number;
}

const IMAGE_ERROR = /image|multimodal|mmproj|vision/i;

export async function extractFields(opts: ExtractOptions): Promise<ExtractResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const withImages = !!opts.images?.length;
  const { system, user } = buildPrompt(opts.text, opts.context ?? {}, withImages);
  const started = performance.now();
  const userContent = withImages
    ? [
        { type: "text", text: user },
        ...opts.images!.map((b64) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } })),
      ]
    : user;
  const res = await request(fetchFn, `${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 600_000,
    body: JSON.stringify({
      model: opts.model,
      stream: false,
      temperature: 0,
      max_tokens: 2048,
      // reasoning models (Qwen3.5, Gemma 4, …) would think first: slower, and the answer must be plain JSON.
      // llama-server also runs with `--reasoning off`; this covers chat templates that ignore that flag.
      chat_template_kwargs: { enable_thinking: false },
      response_format: RESPONSE_FORMAT,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    }),
  });
  if (!res.ok) {
    const error = await errorText(res);
    if (withImages && IMAGE_ERROR.test(error)) throw new LlmError(noVisionMessage(), "no_vision");
    throw new LlmError(`Modell-Fehler: ${error || `HTTP ${res.status}`}`, "bad_response");
  }
  const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  const choice = body.choices?.[0];
  let parsed: LlmOutput;
  try {
    parsed = JSON.parse(jsonBody(choice?.message?.content ?? "")) as LlmOutput;
  } catch {
    const cut = choice?.finish_reason === "length" ? " (Antwort abgeschnitten – Kontextgröße zu klein?)" : "";
    throw new LlmError(`Modell lieferte kein gültiges JSON${cut}`, "bad_response");
  }
  return { fields: mapLlmOutput(parsed), raw: parsed, durationMs: Math.round(performance.now() - started) };
}
