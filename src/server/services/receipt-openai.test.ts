import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OCR_SETTINGS, type OcrSettings } from "../../shared/receipts";
import { createTestDb } from "../db/client";
import type { FetchFn } from "./receipt-ollama";
import { extractWithOpenAi, listOpenAiModels, resolveOpenAiModel, strictSchema } from "./receipt-openai";
import { analyzeReceipt, type ReceiptTools } from "./receipt-pipeline";
import { componentStatus, updateOcrSettings } from "./receipt-settings";

const BASE = "http://127.0.0.1:8888/v1";
const KEY = "sk-unsloth-secret";
const dir = mkdtempSync(join(tmpdir(), "nesev-openai-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** fetch mock: routes by path, records calls; unknown path = connection refused */
function mockFetch(routes: Record<string, (body: Record<string, unknown> | null, call: Call) => Response>, calls: Call[] = []): FetchFn {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const call = { url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body };
    calls.push(call);
    const route = routes[new URL(url).pathname];
    if (!route) throw new TypeError("fetch failed");
    return route(body, call);
  };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const models = (...ids: string[]) => () => json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });
const completion = (content: string, finish_reason = "stop") => json({ choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }] });

const LLM_ANSWER = {
  supplierName: "Elektro Gruber GmbH",
  supplierUid: "ATU 37675002",
  supplierCountry: "AT",
  supplierInvoiceNumber: "R-2026/0815",
  issueDate: "2026-09-12",
  dueDate: "2026-09-26",
  currency: "EUR",
  grossTotal: 480,
  taxLines: [{ ratePercent: 20, net: 400, tax: 80, gross: 480 }],
  iban: "AT48 3200 0000 1234 5864",
  description: "Elektroinstallation",
  category: "instandhaltung",
  vatTreatment: "domestic",
  confidence: { supplierName: 1, grossTotal: 0.95, taxLines: 0.9, category: 0.6 },
};

const TEXT = `Elektro Gruber GmbH
UID: ATU00000000
Rechnungsnr.: R-2026/0815
Rechnungsdatum: 12.09.2026
Summe netto 400,00
zzgl. 20% USt 80,00
Gesamtbetrag EUR 480,00
IBAN: AT48 3200 0000 1234 5864`;

const OPENAI: OcrSettings = { ...DEFAULT_OCR_SETTINGS, provider: "openai", openaiUrl: BASE, openaiApiKey: KEY };

describe("OpenAI-compatible client", () => {
  test("lists loaded models with the bearer key; errors in German", async () => {
    const calls: Call[] = [];
    expect(await listOpenAiModels(BASE, KEY, mockFetch({ "/v1/models": models("gemma-4-e2b", "qwen") }, calls))).toEqual(["gemma-4-e2b", "qwen"]);
    expect(calls[0]!.url).toBe(`${BASE}/models`);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    // no key → no header
    await listOpenAiModels(BASE, "", mockFetch({ "/v1/models": models() }, calls));
    expect(calls[1]!.headers.authorization).toBeUndefined();

    await expect(listOpenAiModels(BASE, KEY, mockFetch({}))).rejects.toThrow(
      "OpenAI-kompatibler Server nicht erreichbar – Modell in Unsloth Studio laden bzw. Server starten",
    );
    const unauthorized = mockFetch({ "/v1/models": () => json({ error: { message: "Invalid API Key" } }, 401) });
    await expect(listOpenAiModels(BASE, "wrong", unauthorized)).rejects.toThrow("API-Key ungültig (Unsloth Studio → Settings → API)");
  });

  test("model resolution: configured, first loaded, none loaded", () => {
    expect(resolveOpenAiModel(["a", "b"], "")).toBe("a");
    expect(resolveOpenAiModel(["a", "b"], "b")).toBe("b");
    expect(() => resolveOpenAiModel([], "")).toThrow("Kein Modell geladen – in Unsloth Studio ein Modell laden");
    expect(() => resolveOpenAiModel(["a"], "c")).toThrow("Modell c ist nicht geladen (geladen: a)");
  });

  test("strict json_schema request (temperature 0, no thinking) and mapped fields", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch({ "/v1/chat/completions": () => completion(JSON.stringify(LLM_ANSWER)) }, calls);
    const res = await extractWithOpenAi({ baseUrl: BASE, apiKey: KEY, model: "gemma", text: TEXT, fetchFn, context: { ownName: "Mustermann" } });
    const { body, headers } = calls[0]!;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body!.model).toBe("gemma");
    expect(body!.temperature).toBe(0);
    expect(body!.stream).toBe(false);
    expect(body!.chat_template_kwargs).toEqual({ enable_thinking: false });
    const format = body!.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("receipt");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    const messages = body!.messages as { role: string; content: unknown }[];
    expect(messages[0]!.role).toBe("system");
    expect(JSON.stringify(messages)).toContain("Mustermann");
    expect(typeof messages[1]!.content).toBe("string");

    expect(res.warning).toBeUndefined();
    expect(res.fields.supplierUid?.value).toBe("ATU00000000");
    expect(res.fields.grossCents?.value).toBe(48000);
    expect(res.fields.taxLines?.value).toEqual([{ taxRateBp: 2000, netCents: 40000, taxCents: 8000, grossCents: 48000 }]);
  });

  test("strictSchema closes nested objects", () => {
    const s = strictSchema({ type: "object", properties: { a: { type: "object", properties: {} }, b: { type: "array", items: { type: "object" } } } });
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.a!.additionalProperties).toBe(false);
    expect((props.b!.items as Record<string, unknown>).additionalProperties).toBe(false);
  });

  test("vision: images as image_url data URLs", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch({ "/v1/chat/completions": () => completion(JSON.stringify(LLM_ANSWER)) }, calls);
    await extractWithOpenAi({ baseUrl: BASE, apiKey: KEY, model: "gemma", text: "", images: ["aW1n"], fetchFn });
    const content = (calls[0]!.body!.messages as { content: { type: string; image_url?: { url: string } }[] }[])[1]!.content;
    expect(content[0]!.type).toBe("text");
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } });
  });

  test("server without vision → clear German error, no schema retry", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch(
      {
        "/v1/chat/completions": () =>
          json({ error: { code: 500, message: "image input is not supported - hint: if this is unexpected, you may need to provide the mmproj", type: "server_error" } }, 500),
      },
      calls,
    );
    await expect(extractWithOpenAi({ baseUrl: BASE, apiKey: KEY, model: "gemma", text: "", images: ["aW1n"], fetchFn })).rejects.toThrow(
      "Das geladene Modell kann keine Bilder lesen",
    );
    expect(calls).toHaveLength(1);
  });

  test("response_format rejected → retried once with the schema in the prompt", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch(
      {
        "/v1/chat/completions": (body) =>
          body?.response_format
            ? json({ error: { message: "'response_format' of type 'json_schema' is not supported" } }, 400)
            : completion("```json\n" + JSON.stringify(LLM_ANSWER) + "\n```"),
      },
      calls,
    );
    const res = await extractWithOpenAi({ baseUrl: BASE, apiKey: KEY, model: "gemma", text: TEXT, fetchFn });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body!.response_format).toBeUndefined();
    expect(JSON.stringify(calls[1]!.body!.messages)).toContain("Antworte NUR mit einem JSON-Objekt");
    expect(res.fields.grossCents?.value).toBe(48000);
    expect(res.warning).toContain("response_format");
  });

  test("401 on chat → API key hint; invalid JSON → German error", async () => {
    const unauthorized = mockFetch({ "/v1/chat/completions": () => json({ error: { message: "Invalid API Key" } }, 401) });
    await expect(extractWithOpenAi({ baseUrl: BASE, apiKey: "x", model: "m", text: TEXT, fetchFn: unauthorized })).rejects.toThrow("API-Key ungültig");
    const garbage = mockFetch({ "/v1/chat/completions": () => completion("{ abgeschnitten", "length") });
    await expect(extractWithOpenAi({ baseUrl: BASE, apiKey: KEY, model: "m", text: TEXT, fetchFn: garbage })).rejects.toThrow(
      "Modell lieferte kein gültiges JSON (Antwort abgeschnitten",
    );
  });
});

describe("analyzeReceipt with provider openai", () => {
  const db = createTestDb();
  const file = join(dir, "beleg.png");
  writeFileSync(file, "not really a png");
  const tools: ReceiptTools = {
    pdfText: async () => null,
    ocr: async () => ({ text: TEXT, source: "vision", pageCount: 1, warnings: [] }),
    pageImages: async () => ["aW1n"],
  };
  const base = { file, db, tools, keepAlive: 0, context: {}, today: "2026-10-14" };

  test("first loaded model used and stored as result model", async () => {
    const fetchFn = mockFetch({ "/v1/models": models("unsloth/gemma-4-E2B-it-GGUF"), "/v1/chat/completions": () => completion(JSON.stringify(LLM_ANSWER)) });
    const out = await analyzeReceipt({ ...base, settings: OPENAI, fetchFn });
    expect(out.status).toBe("done");
    expect(out.model).toBe("unsloth/gemma-4-E2B-it-GGUF");
    expect(out.usedModel).toBe(true);
    expect(out.result.llmSkipped).toBe(false);
    expect(out.result.fields.grossCents?.value).toBe(48000);
  });

  test("server down → failed with hint, rule results kept (no crash)", async () => {
    const out = await analyzeReceipt({ ...base, settings: OPENAI, fetchFn: mockFetch({}) });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("OpenAI-kompatibler Server nicht erreichbar – Modell in Unsloth Studio laden bzw. Server starten");
    expect(out.usedModel).toBe(false);
    expect(out.result.llmSkipped).toBe(true);
    expect(out.result.fields.supplierUid?.value).toBe("ATU00000000");
  });

  test("no model loaded / wrong key → failed with hint", async () => {
    const none = await analyzeReceipt({ ...base, settings: OPENAI, fetchFn: mockFetch({ "/v1/models": models() }) });
    expect(none.error).toBe("Kein Modell geladen – in Unsloth Studio ein Modell laden");
    expect(none.result.fields.grossCents?.value).toBe(48000);
    const bad = await analyzeReceipt({ ...base, settings: OPENAI, fetchFn: mockFetch({ "/v1/models": () => json({}, 401) }) });
    expect(bad.error).toBe("API-Key ungültig (Unsloth Studio → Settings → API)");
  });

  test("vision mode on a text-only server → failed with vision hint, rules kept", async () => {
    const fetchFn = mockFetch({
      "/v1/models": models("gemma"),
      "/v1/chat/completions": () => json({ error: { message: "image input is not supported - hint: … mmproj" } }, 500),
    });
    const out = await analyzeReceipt({ ...base, settings: { ...OPENAI, mode: "vision" }, fetchFn });
    expect(out.status).toBe("failed");
    expect(out.model).toBe("gemma");
    expect(out.usedModel).toBe(true);
    expect(out.error).toContain("kann keine Bilder lesen");
    expect(out.result.fields.supplierInvoiceNumber?.value).toBe("R-2026/0815");
  });

  test("status: loaded models and active model; probe overrides the saved key", async () => {
    updateOcrSettings(db, { ...OPENAI, openaiApiKey: "saved" });
    const calls: Call[] = [];
    const fetchFn = mockFetch({ "/v1/models": models("a", "b") }, calls);
    const s = await componentStatus(db, { apiKey: "probe", model: "b" }, fetchFn);
    expect(s.provider).toBe("openai");
    expect(s.ollama).toBeNull();
    expect(s.openai).toMatchObject({ reachable: true, models: ["a", "b"], activeModel: "b", url: BASE });
    expect(calls[0]!.headers.authorization).toBe("Bearer probe");
    const down = await componentStatus(db, {}, mockFetch({}));
    expect(down.openai).toMatchObject({ reachable: false, error: expect.stringContaining("nicht erreichbar") });
    const remote = await componentStatus(db, { url: "http://192.168.1.5:8888/v1" }, fetchFn);
    expect(remote.openai!.error).toContain("Nur lokale Adressen");
  });
});
