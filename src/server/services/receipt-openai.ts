import { modelLabel, type ReceiptFields } from "../../shared/receipts";
import {
  buildPrompt,
  EXTRACTION_SCHEMA,
  type FetchFn,
  JSON_SHAPE_HINT,
  jsonBody,
  LlmError,
  type LlmOutput,
  mapLlmOutput,
  type PromptContext,
} from "./receipt-ollama";

// Field extraction via an OpenAI-compatible server (Unsloth Studio, LM Studio, plain llama-server):
// GET {base}/models lists the loaded models, POST {base}/chat/completions with a strict JSON-schema
// response_format and temperature 0. The base URL includes /v1 and must be loopback (see ocrSettingsSchema).
// Models are loaded in the server's own UI, so there is no load/unload here. The API key is only ever sent
// as the Authorization header – never logged, never part of an error message.

export class OpenAiError extends LlmError {}

export const openaiUnreachableMessage = () =>
  "OpenAI-kompatibler Server nicht erreichbar – Modell in Unsloth Studio laden bzw. Server starten";
export const openaiUnauthorizedMessage = () => "API-Key ungültig (Unsloth Studio → Settings → API)";
export const openaiNoModelMessage = () => "Kein Modell geladen – in Unsloth Studio ein Modell laden";
export const openaiModelNotLoadedMessage = (model: string, loaded: readonly string[]) =>
  `Modell ${model} ist nicht geladen (geladen: ${loaded.map(modelLabel).join(", ")}) – in Unsloth Studio laden oder das Modellfeld leer lassen`;
export const openaiNoVisionMessage = () =>
  "Das geladene Modell kann keine Bilder lesen – ein Vision-Modell laden (llama-server: mit --mmproj) oder Modus „Text“ wählen";

function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function request(fetchFn: FetchFn, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 5_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetchFn(url, { ...rest, signal: combined });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new OpenAiError("OpenAI-kompatibler Server antwortet nicht (Zeitüberschreitung)", "unreachable");
    throw new OpenAiError(openaiUnreachableMessage(), "unreachable");
  }
}

/** Error text of a failed response: `{error:{message}}` (OpenAI / llama-server), `{error:"…"}`, `{detail}` or plain text. */
async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw) as { error?: string | { message?: string }; detail?: unknown; message?: string };
    const e = body.error;
    if (typeof e === "string") return e;
    if (e && typeof e.message === "string") return e.message;
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.message === "string") return body.message;
  } catch {
    // not JSON
  }
  return raw.slice(0, 300);
}

/** Loaded models (GET {base}/models → ids). Throws OpenAiError (unreachable / unauthorized / bad_response). */
export async function listOpenAiModels(baseUrl: string, apiKey: string, fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<string[]> {
  const res = await request(fetchFn, `${baseUrl}/models`, { signal, headers: authHeaders(apiKey) });
  if (res.status === 401 || res.status === 403) throw new OpenAiError(openaiUnauthorizedMessage(), "unauthorized");
  if (!res.ok) throw new OpenAiError(`OpenAI-kompatibler Server: HTTP ${res.status} auf /models – stimmt die Adresse (inkl. /v1)?`, "bad_response");
  let body: { data?: { id?: unknown }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new OpenAiError("OpenAI-kompatibler Server: /models lieferte kein JSON – stimmt die Adresse (inkl. /v1)?", "bad_response");
  }
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id !== "");
}

/** The configured model if loaded, else (empty setting) the first loaded one. Throws "model_missing" otherwise. */
export function resolveOpenAiModel(models: readonly string[], configured: string): string {
  if (!models.length) throw new OpenAiError(openaiNoModelMessage(), "model_missing");
  if (!configured) return models[0]!;
  if (models.includes(configured)) return configured;
  throw new OpenAiError(openaiModelNotLoadedMessage(configured, models), "model_missing");
}

type JsonSchema = { [key: string]: unknown };

/** Strict-mode schema: every object closed (`additionalProperties: false`), as OpenAI's strict mode requires. */
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

export interface OpenAiExtractOptions {
  baseUrl: string;
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

export interface OpenAiExtractResult {
  fields: ReceiptFields;
  raw: unknown;
  durationMs: number;
  /** e.g. the server could not enforce the JSON schema */
  warning?: string;
}

const IMAGE_ERROR = /image|multimodal|mmproj|vision/i;
const SCHEMA_ERROR = /response_format|json_schema|grammar|schema|structured/i;

export async function extractWithOpenAi(opts: OpenAiExtractOptions): Promise<OpenAiExtractResult> {
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
  const chat = (structured: boolean) =>
    request(fetchFn, `${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(opts.apiKey) },
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 600_000,
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        temperature: 0,
        max_tokens: 2048,
        // reasoning models (Qwen3, Gemma 4, …) would think first: slower, and the answer must be plain JSON.
        // llama-server (Unsloth Studio) passes this to the chat template; other servers ignore it.
        chat_template_kwargs: { enable_thinking: false },
        ...(structured ? { response_format: RESPONSE_FORMAT } : {}),
        messages: [
          { role: "system", content: structured ? system : `${system}\n\n${JSON_SHAPE_HINT}` },
          { role: "user", content: userContent },
        ],
      }),
    });

  let structured = true;
  let res = await chat(true);
  let error = res.ok ? "" : await errorText(res);
  if (!res.ok && res.status !== 401 && res.status !== 403 && !(withImages && IMAGE_ERROR.test(error)) && SCHEMA_ERROR.test(error)) {
    // the server can't enforce a JSON schema: ask via the prompt
    structured = false;
    res = await chat(false);
    error = res.ok ? "" : await errorText(res);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new OpenAiError(openaiUnauthorizedMessage(), "unauthorized");
    if (withImages && IMAGE_ERROR.test(error)) throw new OpenAiError(openaiNoVisionMessage(), "no_vision");
    if (res.status === 404 && /model/i.test(error)) throw new OpenAiError(`Modell ${opts.model} nicht gefunden – in Unsloth Studio laden oder das Modellfeld leer lassen`, "model_missing");
    throw new OpenAiError(`Modell-Fehler: ${error || `HTTP ${res.status}`}`, "bad_response");
  }
  const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  const choice = body.choices?.[0];
  let parsed: LlmOutput;
  try {
    parsed = JSON.parse(jsonBody(choice?.message?.content ?? "")) as LlmOutput;
  } catch {
    const cut = choice?.finish_reason === "length" ? " (Antwort abgeschnitten – Kontext/max_tokens zu klein?)" : "";
    throw new OpenAiError(`Modell lieferte kein gültiges JSON${cut}`, "bad_response");
  }
  return {
    fields: mapLlmOutput(parsed),
    raw: parsed,
    durationMs: Math.round(performance.now() - started),
    ...(structured ? {} : { warning: "Server ohne erzwungenes JSON-Schema (response_format nicht unterstützt) – Antwort per Prompt geparst" }),
  };
}
