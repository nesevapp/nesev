import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OCR_SETTINGS } from "../../shared/receipts";
import { createTestDb } from "../db/client";
import { createExpense } from "./expenses";
import { extractWithOllama, type FetchFn, hasModel, jsonBody, listModels, unloadModel } from "./receipt-ollama";
import { analyzeReceipt, type ReceiptTools } from "./receipt-pipeline";

const BASE = "http://127.0.0.1:11434";
const dir = mkdtempSync(join(tmpdir(), "nesev-ollama-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

/** fetch mock: routes by path, records calls */
function mockFetch(routes: Record<string, (body: Record<string, unknown> | null) => Response>, calls: Call[] = []): FetchFn {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    const route = routes[new URL(url).pathname];
    if (!route) throw new TypeError("fetch failed");
    return route(body);
  };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

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

describe("Ollama client", () => {
  test("lists models; unreachable → German hint", async () => {
    const fetchFn = mockFetch({ "/api/tags": () => json({ models: [{ name: "qwen3.5:4b", size: 4_700_000_000 }] }) });
    const models = await listModels(BASE, fetchFn);
    expect(hasModel(models, "qwen3.5:4b")).toBe(true);
    expect(hasModel(models, "llama3.2")).toBe(false);
    expect(hasModel([{ name: "llama3.2:latest", size: 1 }], "llama3.2")).toBe(true);
    await expect(listModels(BASE, mockFetch({}))).rejects.toThrow("Ollama läuft nicht – starte es mit `ollama serve`");
  });

  test("structured request (schema, temperature 0, keep_alive) and mapped fields", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch({ "/api/chat": () => json({ message: { content: JSON.stringify(LLM_ANSWER) } }) }, calls);
    const res = await extractWithOllama({ baseUrl: BASE, model: "qwen3.5:4b", text: TEXT, keepAlive: 0, fetchFn, context: { ownName: "Mustermann" } });
    const body = calls[0]!.body!;
    expect(body.model).toBe("qwen3.5:4b");
    expect(body.keep_alive).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect((body.options as { temperature: number }).temperature).toBe(0);
    expect((body.format as { type: string }).type).toBe("object");
    expect(JSON.stringify(body.messages)).toContain("Mustermann");

    const f = res.fields;
    expect(f.supplierUid?.value).toBe("ATU00000000");
    expect(f.iban?.value).toBe("AT483200000012345864");
    expect(f.grossCents?.value).toBe(48000);
    expect(f.taxLines?.value).toEqual([{ taxRateBp: 2000, netCents: 40000, taxCents: 8000, grossCents: 48000 }]);
    expect(f.category?.value).toBe("instandhaltung");
    // model confidences are capped
    expect(f.supplierName?.confidence).toBe(0.9);
    expect(f.category?.confidence).toBe(0.6);
  });

  test("answer JSON is extracted from fences or a think block", () => {
    expect(JSON.parse(jsonBody('<think>hmm {x}</think>\n```json\n{"a":1}\n```'))).toEqual({ a: 1 });
    expect(jsonBody('{"a":{"b":2}}')).toBe('{"a":{"b":2}}');
  });

  test("missing model → German pull hint", async () => {
    const fetchFn = mockFetch({ "/api/chat": () => json({ error: 'model "qwen3.5:4b" not found, try pulling it first' }, 404) });
    await expect(extractWithOllama({ baseUrl: BASE, model: "qwen3.5:4b", text: TEXT, keepAlive: 0, fetchFn })).rejects.toThrow(
      "Modell qwen3.5:4b fehlt – `ollama pull qwen3.5:4b`",
    );
  });

  test("runner without structured output → retried with the schema in the prompt", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch(
      {
        "/api/chat": (body) =>
          body?.format
            ? json({ error: "structured output is unavailable" }, 500)
            : json({ message: { content: "```json\n" + JSON.stringify(LLM_ANSWER) + "\n```" } }),
      },
      calls,
    );
    const res = await extractWithOllama({ baseUrl: BASE, model: "qwen3.5:4b", text: TEXT, keepAlive: 0, fetchFn });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body!.think).toBe(false);
    expect(JSON.stringify(calls[1]!.body!.messages)).toContain("Antworte NUR mit einem JSON-Objekt");
    expect(res.fields.grossCents?.value).toBe(48000);
    expect(res.warning).toContain("Structured Output");
  });

  test("too old Ollama (412) → upgrade hint", async () => {
    const fetchFn = mockFetch({ "/api/chat": () => json({ error: "requires a newer version of Ollama" }, 412) });
    await expect(extractWithOllama({ baseUrl: BASE, model: "qwen3.5:4b", text: TEXT, keepAlive: 0, fetchFn })).rejects.toThrow(
      "qwen3.5:4b benötigt eine neuere Ollama-Version – `brew upgrade ollama`, dann `ollama pull qwen3.5:4b`",
    );
  });

  test("unload only when the model is loaded", async () => {
    const calls: Call[] = [];
    const routes = { "/api/ps": () => json({ models: [{ name: "qwen3.5:4b" }] }), "/api/generate": () => json({}) };
    expect(await unloadModel(BASE, "qwen3.5:4b", mockFetch(routes, calls))).toBe(true);
    expect(calls[1]!.body).toEqual({ model: "qwen3.5:4b", keep_alive: 0 });
    expect(await unloadModel(BASE, "llama3.2", mockFetch(routes))).toBe(false);
  });
});

describe("analyzeReceipt", () => {
  const db = createTestDb();
  const file = join(dir, "beleg.png");
  writeFileSync(file, "not really a png");
  const tools: ReceiptTools = {
    pdfText: async () => null,
    ocr: async () => ({ text: TEXT, source: "vision", pageCount: 1, warnings: [] }),
    pageImages: async () => ["aW1n"],
  };
  const base = { file, db, tools, keepAlive: 0, context: {}, today: "2026-10-14" };

  test("model + rules merged, validated", async () => {
    const fetchFn = mockFetch({
      "/api/tags": () => json({ models: [{ name: "qwen3.5:4b", size: 1 }] }),
      "/api/chat": () => json({ message: { content: JSON.stringify(LLM_ANSWER) } }),
    });
    const out = await analyzeReceipt({ ...base, settings: DEFAULT_OCR_SETTINGS, fetchFn });
    expect(out.status).toBe("done");
    expect(out.textSource).toBe("vision");
    expect(out.model).toBe("qwen3.5:4b");
    expect(out.usedModel).toBe(true);
    expect(out.result.llmSkipped).toBe(false);
    expect(out.result.fields.grossCents?.value).toBe(48000);
    // model and rules agree, sums check out
    expect(out.result.fields.grossCents!.confidence).toBeGreaterThan(0.9);
  });

  test("Ollama not running → failed with hint, but text and rule results kept", async () => {
    const out = await analyzeReceipt({ ...base, settings: DEFAULT_OCR_SETTINGS, fetchFn: mockFetch({}) });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("Ollama läuft nicht – starte es mit `ollama serve`");
    expect(out.text).toBe(TEXT);
    expect(out.usedModel).toBe(false);
    expect(out.result.llmSkipped).toBe(true);
    expect(out.result.fields.supplierUid?.value).toBe("ATU00000000");
    expect(out.result.fields.grossCents?.value).toBe(48000);
  });

  test("model not pulled → failed with pull hint", async () => {
    const fetchFn = mockFetch({ "/api/tags": () => json({ models: [] }) });
    const out = await analyzeReceipt({ ...base, settings: DEFAULT_OCR_SETTINGS, fetchFn });
    expect(out.status).toBe("failed");
    expect(out.error).toStartWith("Modell qwen3.5:4b fehlt – `ollama pull qwen3.5:4b`");
    expect(out.result.fields.supplierInvoiceNumber?.value).toBe("R-2026/0815");
  });

  test("vision mode sends page images to the vision model", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch(
      {
        "/api/tags": () => json({ models: [{ name: "qwen3.5:4b", size: 1 }] }),
        "/api/chat": () => json({ message: { content: JSON.stringify(LLM_ANSWER) } }),
      },
      calls,
    );
    const out = await analyzeReceipt({ ...base, settings: { ...DEFAULT_OCR_SETTINGS, mode: "vision" }, fetchFn });
    expect(out.model).toBe("qwen3.5:4b");
    const messages = calls.find((c) => c.url.endsWith("/api/chat"))!.body!.messages as { images?: string[] }[];
    expect(messages[1]!.images).toEqual(["aW1n"]);
  });

  test("LLM disabled → rules only, done", async () => {
    const out = await analyzeReceipt({ ...base, settings: { ...DEFAULT_OCR_SETTINGS, llmEnabled: false }, fetchFn: mockFetch({}) });
    expect(out.status).toBe("done");
    expect(out.model).toBe("");
  });

  test("known supplier: name, category and treatment from history", async () => {
    createExpense(db, {
      supplierName: "Elektro Gruber",
      supplierUid: "ATU 37675002",
      supplierCountry: "AT",
      vatTreatment: "domestic",
      issueDate: "2026-05-01",
      lines: [{ category: "fremdleistungen", description: "", netCents: 100, taxRateBp: 2000, taxCents: 20, deductibleBp: 10000 }],
    });
    const out = await analyzeReceipt({ ...base, settings: { ...DEFAULT_OCR_SETTINGS, llmEnabled: false }, fetchFn: mockFetch({}) });
    expect(out.result.matchedSupplier).toEqual({ name: "Elektro Gruber", by: "uid", count: 1 });
    expect(out.result.fields.supplierName).toMatchObject({ value: "Elektro Gruber", source: "supplier" });
    expect(out.result.fields.category).toMatchObject({ value: "fremdleistungen", source: "supplier" });
  });
});
