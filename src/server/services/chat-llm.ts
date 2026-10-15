// Streaming client for llama-server's OpenAI-compatible POST /v1/chat/completions with tools. Parses the SSE
// chunks: content deltas, reasoning deltas (only with reasoning on) and tool calls, whose id/name/argument pieces
// arrive split over several chunks keyed by `index`. Aborting the signal ends the stream and returns what arrived
// (aborted: true), so the caller can keep the partial text.

export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: LlmToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface LlmTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  /** per request via the chat template (Qwen: enable_thinking); the server runs with --reasoning off */
  reasoning: boolean;
  /** "required": the model must call a tool (first step of a data question, see chat.ts) */
  toolChoice?: "auto" | "required";
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** first reasoning token of this response */
  onThinking?: () => void;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface StreamResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string | null;
  aborted: boolean;
  /** prompt tokens as reported by llama-server (timings.prompt_n + cache_n), if any */
  promptTokens: number | null;
  completionTokens: number | null;
  /** ms until the first content / tool-call token */
  firstTokenMs: number | null;
  totalMs: number;
}

/** German message for the user (context too long, server error, …). */
export class ChatLlmError extends Error {}

/** Qwen's recommended non-thinking sampling, a bit cooler for reliable tool arguments. */
const SAMPLING = { temperature: 0.4, top_p: 0.8, top_k: 20, min_p: 0 };

/** temperature from NESEV_CHAT_TEMPERATURE (0–2, for experiments such as the eval's --temperature), else 0.4 */
export function samplingTemperature(env: Record<string, string | undefined> = process.env): number {
  const raw = env.NESEV_CHAT_TEMPERATURE?.trim();
  const t = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(t) && t >= 0 && t <= 2 ? t : SAMPLING.temperature;
}

export async function streamChat(o: StreamOptions): Promise<StreamResult> {
  const t0 = performance.now();
  const fetchFn = o.fetchFn ?? ((url, init) => fetch(url, init));
  const body = {
    model: o.model,
    messages: o.messages,
    ...(o.tools.length ? { tools: o.tools, tool_choice: o.toolChoice ?? "auto", parallel_tool_calls: false } : {}),
    stream: true,
    max_tokens: o.maxTokens ?? (o.reasoning ? 8192 : 2048),
    chat_template_kwargs: { enable_thinking: o.reasoning },
    ...SAMPLING,
    temperature: samplingTemperature(),
  };
  const result: StreamResult = {
    content: "",
    toolCalls: [],
    finishReason: null,
    aborted: false,
    promptTokens: null,
    completionTokens: null,
    firstTokenMs: null,
    totalMs: 0,
  };
  // stops a degenerate loop (small models sometimes repeat the closing paragraphs until max_tokens)
  const loopStop = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, loopStop.signal]) : loopStop.signal;
  let checkedAt = 0;
  let res: Response;
  try {
    res = await fetchFn(`${o.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (o.signal?.aborted) return { ...result, aborted: true, totalMs: performance.now() - t0 };
    throw new ChatLlmError(`Modellserver nicht erreichbar: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ChatLlmError(httpErrorMessage(res.status, await res.text().catch(() => "")));
  if (!res.body) throw new ChatLlmError("Modellserver lieferte keine Antwort");

  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let thinking = false;
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (data: string) => {
    if (data === "[DONE]") return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new ChatLlmError(httpErrorMessage(500, JSON.stringify(chunk)));
    if (chunk.timings) {
      result.promptTokens = (chunk.timings.prompt_n ?? 0) + (chunk.timings.cache_n ?? 0);
      result.completionTokens = chunk.timings.predicted_n ?? null;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason && result.finishReason !== "repetition") result.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content && !thinking) {
      thinking = true;
      o.onThinking?.();
    }
    if (typeof delta.content === "string" && delta.content && !loopStop.signal.aborted) {
      result.firstTokenMs ??= performance.now() - t0;
      result.content += delta.content;
      o.onDelta?.(delta.content);
      if (result.content.length - checkedAt >= 100) {
        checkedAt = result.content.length;
        const cut = repetitionCut(result.content);
        if (cut !== null) {
          result.content = cut;
          result.finishReason = "repetition";
          loopStop.abort();
        }
      }
    }
    for (const tc of delta.tool_calls ?? []) {
      result.firstTokenMs ??= performance.now() - t0;
      const index = typeof tc.index === "number" ? tc.index : calls.size;
      const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") call.arguments += tc.function.arguments;
      calls.set(index, call);
    }
  };
  try {
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
    if (buffer.startsWith("data:")) handle(buffer.slice(5).trim());
  } catch (err) {
    if (loopStop.signal.aborted && !o.signal?.aborted) {
      // stopped by the loop guard: a normal end
    } else if (!o.signal?.aborted) {
      if (err instanceof ChatLlmError) throw err;
      throw new ChatLlmError(`Verbindung zum Modellserver abgebrochen: ${(err as Error).message}`);
    } else result.aborted = true;
  }
  if (o.signal?.aborted) result.aborted = true;
  result.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c).filter((c) => c.name);
  result.totalMs = performance.now() - t0;
  return result;
}

/**
 * The text ends in a block repeated 3+ times (≥ 60 chars, e.g. the same two closing sentences over and over): the
 * text up to the end of the block's first occurrence, else null.
 */
export function repetitionCut(text: string): string | null {
  const tail = text.slice(-60);
  if (tail.trim().length < 30) return null;
  const hits: number[] = [];
  for (let i = text.indexOf(tail); i !== -1; i = text.indexOf(tail, i + 1)) hits.push(i);
  if (hits.length < 3) return null;
  const period = hits.at(-1)! - hits.at(-2)!;
  if (period < 60 || hits.at(-2)! - hits.at(-3)! !== period) return null;
  // where the periodic part begins: keep everything before it plus one copy of the block
  let start = text.length - period;
  while (start > 0 && text[start - 1] === text[start - 1 + period]) start--;
  // the block's phase may cut a sentence end ("Bescheid|.") – finish the word
  let end = start + period;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return text.slice(0, end).trimEnd();
}

function httpErrorMessage(status: number, text: string): string {
  let message = text;
  try {
    const body = JSON.parse(text);
    message = body?.error?.message ?? body?.error ?? text;
  } catch {
    // plain text
  }
  if (/exceed|context size|context length|too long/i.test(String(message))) {
    return "Die Unterhaltung ist zu lang für das Kontextfenster des Modells – eine neue Unterhaltung beginnen oder die Kontextgröße in den Einstellungen erhöhen";
  }
  return `Modellserver-Fehler ${status}: ${String(message).slice(0, 300)}`;
}
