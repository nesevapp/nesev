import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OCR_SETTINGS, type OcrSettings } from "../../shared/receipts";
import { ocrSettingsSchema } from "../../shared/schemas/receipt";
import { createTestDb } from "../db/client";
import { createExpense } from "./expenses";
import { type GgufModel, nodeFs } from "../lib/llama/paths";
import { type LlamaConfig, type LlamaEndpoint, LlamaServerError } from "../lib/llama/server";
import { AbortedError } from "../lib/ocr/run";
import { autoPickModel, llamaConfigFor, llamaCppStatus, resolveLlama, syncLlamaServer, toLlmError } from "./receipt-llama";
import type { FetchFn } from "./receipt-llm";
import { getOcrSettings, updateOcrSettings } from "./receipt-settings";
import { settings as settingsTable } from "../db/schema";
import { analyzeReceipt, type ReceiptTools } from "./receipt-pipeline";

const dir = mkdtempSync(join(tmpdir(), "nesev-llamacpp-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const binary = join(dir, "bin/llama-server");
const modelDir = join(dir, "models");
const model = join(modelDir, "Qwen3.5-4B-Q4_K_M.gguf");
mkdirSync(join(dir, "bin"));
mkdirSync(modelDir);
writeFileSync(binary, "#!/bin/sh\n");
chmodSync(binary, 0o755);
writeFileSync(model, "gguf");
const fs = { ...nodeFs, home: dir, which: () => null };

const LLAMA: OcrSettings = { ...DEFAULT_OCR_SETTINGS, llamaServerPath: binary, llamaModelPath: model };
const none = () => [];

describe("llamaConfigFor", () => {
  test("resolved config; text mode never loads a projector", () => {
    writeFileSync(join(modelDir, "mmproj-F16.gguf"), "p");
    expect(llamaConfigFor(LLAMA, {}, fs)).toEqual({ binary, model, mmproj: null, contextSize: 8192 });
    expect(llamaConfigFor({ ...LLAMA, mode: "vision" }, {}, fs).mmproj).toBe(join(modelDir, "mmproj-F16.gguf"));
    expect(resolveLlama(LLAMA, {}, fs)).toMatchObject({ mmprojAuto: true });
    rmSync(join(modelDir, "mmproj-F16.gguf"));
  });

  test("German errors for missing pieces", () => {
    expect(() => llamaConfigFor({ ...LLAMA, llamaServerPath: "/nope/llama-server" }, {}, fs)).toThrow("llama-server nicht gefunden: /nope/llama-server");
    expect(() => llamaConfigFor({ ...LLAMA, llamaModelPath: "" }, {}, fs, none)).toThrow("Kein Modell gefunden – einmal `llama-server -hf");
    expect(() => llamaConfigFor({ ...LLAMA, llamaModelPath: "/nope/x.gguf" }, {}, fs)).toThrow("Modelldatei nicht gefunden: /nope/x.gguf");
    expect(() => llamaConfigFor({ ...LLAMA, mode: "vision" }, {}, fs)).toThrow("Vision-Modus braucht eine mmproj-Datei");
  });

  test("overrides from the form win", () => {
    expect(llamaConfigFor({ ...LLAMA, llamaModelPath: "" }, { modelPath: model, contextSize: 4096 }, fs).contextSize).toBe(4096);
  });

  test("manager errors map to LlmError kinds", () => {
    expect(toLlmError(new LlamaServerError("x", "model_missing")).kind).toBe("model_missing");
    expect(toLlmError(new LlamaServerError("y", "timeout"))).toMatchObject({ kind: "unreachable", message: "y" });
    expect(toLlmError(new AbortedError()).message).toContain("gestoppt");
  });
});

describe("automatic model choice (empty llamaModelPath)", () => {
  const gguf = (path: string, name: string, quant: string, mmproj: string | null = null): GgufModel => ({ path, name, quant, sizeBytes: 1, mmproj });
  const gemma = gguf("/hub/gemma-4-E2B-it-UD-Q4_K_XL.gguf", "unsloth/gemma-4-E2B-it-GGUF", "UD-Q4_K_XL", "/hub/mmproj-F16.gguf");
  const qwenText = gguf("/a/Qwen3.5-4B-Q8_0.gguf", "unsloth/Qwen3.5-4B-GGUF", "Q8_0");
  const qwenVision = gguf("/b/Qwen3.5-4B-UD-Q4_K_XL.gguf", "unsloth/Qwen3.5-4B-GGUF", "UD-Q4_K_XL", "/b/mmproj-F16.gguf");
  const qwen27 = gguf("/c/Qwen3.5-27B-Q4_K_M.gguf", "unsloth/Qwen3.5-27B-GGUF", "Q4_K_M", "/c/mmproj-F16.gguf");

  test("prefers Qwen3.5-4B (with mmproj when several), else the first model found", () => {
    expect(autoPickModel([gemma, qwenText, qwenVision, qwen27])).toBe(qwenVision);
    expect(autoPickModel([gemma, qwenText])).toBe(qwenText);
    expect(autoPickModel([qwen27, gemma])).toBe(qwen27);
    expect(autoPickModel([])).toBeNull();
  });

  test("used for config and status; a configured path wins", async () => {
    const found = () => [{ path: model, name: "unsloth/Qwen3.5-4B-GGUF", quant: "Q4_K_M", sizeBytes: 4, mmproj: null }];
    const auto = { ...LLAMA, llamaModelPath: "" };
    expect(llamaConfigFor(auto, {}, fs, found).model).toBe(model);
    expect(resolveLlama(auto, {}, fs, found).auto?.path).toBe(model);
    expect(resolveLlama(LLAMA, {}, fs, () => [gemma]).auto).toBeNull();
    const manager = { state: () => ({ running: false }) } as unknown as Parameters<typeof llamaCppStatus>[3];
    const s = await llamaCppStatus(auto, {}, fs, manager, found());
    expect(s.model).toMatchObject({ path: model, auto: true, exists: true, label: "unsloth/Qwen3.5-4B-GGUF · Q4_K_M" });
    const configured = await llamaCppStatus(LLAMA, {}, fs, manager, found());
    expect(configured.model).toMatchObject({ auto: false, label: "Qwen3.5-4B-Q4_K_M" });
    const nothing = await llamaCppStatus(auto, {}, fs, manager, []);
    expect(nothing.model.hint).toContain("Kein Modell gefunden");
  });
});

describe("stored settings", () => {
  test("JSON from older versions (other model servers) parses: unknown keys dropped, known ones kept", () => {
    const old = {
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      openaiUrl: "http://127.0.0.1:8888/v1",
      openaiApiKey: "sk-x",
      openaiModel: "",
      model: "qwen3.5:4b",
      visionModel: "qwen3.5:4b",
      mode: "vision",
      llmEnabled: true,
      ocrEngine: "tesseract",
      unloadAfterBatch: false,
    };
    expect(ocrSettingsSchema.parse(old)).toEqual({ ...DEFAULT_OCR_SETTINGS, mode: "vision", ocrEngine: "tesseract", unloadAfterBatch: false });
    const db = createTestDb();
    updateOcrSettings(db, DEFAULT_OCR_SETTINGS);
    db.update(settingsTable).set({ ocrSettings: old as unknown as OcrSettings }).run();
    expect(getOcrSettings(db)).toEqual({ ...DEFAULT_OCR_SETTINGS, mode: "vision", ocrEngine: "tesseract", unloadAfterBatch: false });
  });
});

describe("analyzeReceipt", () => {
  const db = createTestDb();
  const file = join(dir, "beleg.png");
  writeFileSync(file, "x");
  const TEXT = "Elektro Gruber GmbH\nUID: ATU00000000\nRechnungsdatum: 12.09.2026\nSumme netto 400,00\nzzgl. 20% USt 80,00\nGesamtbetrag EUR 480,00";
  const tools: ReceiptTools = {
    pdfText: async () => null,
    ocr: async () => ({ text: TEXT, source: "vision", pageCount: 1, warnings: [] }),
    pageImages: async () => [],
  };
  const base = { file, db, tools, context: {}, today: "2026-10-14" };
  const endpoint: LlamaEndpoint = { baseUrl: "http://127.0.0.1:40001/v1", apiKey: "k", port: 40001, model: "Qwen3.5-4B-Q4_K_M", vision: false, startMs: 1234 };
  const answer = { supplierName: "Elektro Gruber GmbH", grossTotal: 480, taxLines: [{ ratePercent: 20, net: 400, tax: 80, gross: 480 }], confidence: {} };

  test("ensures the server, sends the request with its key, reports the start time", async () => {
    const configs: LlamaConfig[] = [];
    const calls: { url: string; auth: string | null }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }] });
    };
    const llama = { ensure: async (c: LlamaConfig) => (configs.push(c), endpoint) };
    const out = await analyzeReceipt({ ...base, settings: { ...LLAMA, llamaServerPath: binary }, fetchFn, llama });
    expect(out.status).toBe("done");
    expect(out.model).toBe("Qwen3.5-4B-Q4_K_M");
    expect(out.result.llmSkipped).toBe(false);
    expect(out.result.timings?.server).toBe(1234);
    expect(out.result.fields.grossCents?.value).toBe(48000);
    expect(configs[0]).toMatchObject({ model, mmproj: null, contextSize: 8192 });
    expect(calls).toEqual([{ url: "http://127.0.0.1:40001/v1/chat/completions", auth: "Bearer k" }]);
  });

  test("start failure / missing model → rules-only with German error, no crash", async () => {
    const llama = {
      ensure: async (): Promise<LlamaEndpoint> => {
        throw new LlamaServerError("llama-server konnte das Modell nicht laden: bad magic", "start_failed");
      },
    };
    const out = await analyzeReceipt({ ...base, settings: LLAMA, llama });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("llama-server konnte das Modell nicht laden: bad magic");
    expect(out.model).toBe("Qwen3.5-4B-Q4_K_M");
    expect(out.result.llmSkipped).toBe(true);
    expect(out.result.fields.supplierUid?.value).toBe("ATU00000000");

    const missing = await analyzeReceipt({ ...base, settings: { ...LLAMA, llamaModelPath: join(dir, "gone.gguf") }, llama });
    expect(missing.error).toContain("Modelldatei nicht gefunden");
    expect(missing.result.fields.grossCents?.value).toBe(48000);
  });

  test("vision mode loads the projector and sends the page images", async () => {
    writeFileSync(join(modelDir, "mmproj-F16.gguf"), "p");
    const configs: LlamaConfig[] = [];
    let sent = "";
    const fetchFn: FetchFn = async (_url, init) => {
      sent = String(init?.body);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }] });
    };
    const llama = { ensure: async (c: LlamaConfig) => (configs.push(c), { ...endpoint, vision: true }) };
    const out = await analyzeReceipt({ ...base, tools: { ...tools, pageImages: async () => ["aW1n"] }, settings: { ...LLAMA, mode: "vision" }, fetchFn, llama });
    rmSync(join(modelDir, "mmproj-F16.gguf"));
    expect(out.status).toBe("done");
    expect(configs[0]!.mmproj).toBe(join(modelDir, "mmproj-F16.gguf"));
    expect(sent).toContain("data:image/png;base64,aW1n");
  });

  test("LLM disabled → rules only, done, no server", async () => {
    const llama = { ensure: async (): Promise<LlamaEndpoint> => { throw new Error("must not start"); } };
    const out = await analyzeReceipt({ ...base, settings: { ...LLAMA, llmEnabled: false }, llama });
    expect(out.status).toBe("done");
    expect(out.model).toBe("");
    expect(out.result.llmSkipped).toBe(true);
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
    const out = await analyzeReceipt({ ...base, settings: { ...LLAMA, llmEnabled: false } });
    expect(out.result.matchedSupplier).toEqual({ name: "Elektro Gruber", by: "uid", count: 1 });
    expect(out.result.fields.supplierName).toMatchObject({ value: "Elektro Gruber", source: "supplier" });
    expect(out.result.fields.category).toMatchObject({ value: "fremdleistungen", source: "supplier" });
  });

  test("cancel while the server loads → AbortedError (worker drops the run)", async () => {
    const controller = new AbortController();
    const llama = {
      ensure: async (): Promise<LlamaEndpoint> => {
        controller.abort();
        throw new AbortedError();
      },
    };
    await expect(analyzeReceipt({ ...base, settings: LLAMA, llama, signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
  });
});

describe("syncLlamaServer", () => {
  const fakeManager = (key: string | null) => {
    const m = { stopped: 0, activeKey: () => key, stop: async () => void m.stopped++ };
    return m;
  };
  const sync = (s: OcrSettings, busy: boolean, m: ReturnType<typeof fakeManager>) =>
    syncLlamaServer(s, busy, m as unknown as Parameters<typeof syncLlamaServer>[2]);

  test("stops an idle server whose config no longer matches", async () => {
    const key = JSON.stringify([binary, model, null, 8192]);
    const same = fakeManager(key);
    await sync(LLAMA, false, same);
    expect(same.stopped).toBe(0);
    const ctx = fakeManager(key);
    await sync({ ...LLAMA, llamaContextSize: 4096 }, false, ctx);
    expect(ctx.stopped).toBe(1);
    const off = fakeManager(key);
    await sync({ ...LLAMA, llmEnabled: false }, false, off);
    expect(off.stopped).toBe(1);
    const busy = fakeManager(key);
    await sync({ ...LLAMA, llmEnabled: false }, true, busy);
    expect(busy.stopped).toBe(0);
  });
});
