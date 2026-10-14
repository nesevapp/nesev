import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OCR_SETTINGS, type OcrSettings } from "../../shared/receipts";
import { createTestDb } from "../db/client";
import { nodeFs } from "../lib/llama/paths";
import { type LlamaConfig, type LlamaEndpoint, LlamaServerError } from "../lib/llama/server";
import { AbortedError } from "../lib/ocr/run";
import { llamaConfigFor, resolveLlama, syncLlamaServer, toLlmError } from "./receipt-llama";
import type { FetchFn } from "./receipt-ollama";
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

const LLAMA: OcrSettings = { ...DEFAULT_OCR_SETTINGS, provider: "llamacpp", llamaServerPath: binary, llamaModelPath: model };

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
    expect(() => llamaConfigFor({ ...LLAMA, llamaModelPath: "" }, {}, fs)).toThrow("Kein Modell gewählt");
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

describe("analyzeReceipt with provider llamacpp", () => {
  const db = createTestDb();
  const file = join(dir, "beleg.png");
  writeFileSync(file, "x");
  const TEXT = "Elektro Gruber GmbH\nUID: ATU00000000\nRechnungsdatum: 12.09.2026\nSumme netto 400,00\nzzgl. 20% USt 80,00\nGesamtbetrag EUR 480,00";
  const tools: ReceiptTools = {
    pdfText: async () => null,
    ocr: async () => ({ text: TEXT, source: "vision", pageCount: 1, warnings: [] }),
    pageImages: async () => [],
  };
  const base = { file, db, tools, keepAlive: 0, context: {}, today: "2026-10-14" };
  const endpoint: LlamaEndpoint = { baseUrl: "http://127.0.0.1:40001/v1", apiKey: "k", port: 40001, model: "Qwen3.5-4B-Q4_K_M", vision: false, startMs: 1234 };
  const answer = { supplierName: "Elektro Gruber GmbH", grossTotal: 480, taxLines: [{ ratePercent: 20, net: 400, tax: 80, gross: 480 }], confidence: {} };

  test("ensures the server, talks OpenAI-style with its key, reports the start time", async () => {
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
    expect(out.usedModel).toBe(true);
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
    expect(out.usedModel).toBe(false);
    expect(out.result.llmSkipped).toBe(true);
    expect(out.result.fields.supplierUid?.value).toBe("ATU00000000");

    const missing = await analyzeReceipt({ ...base, settings: { ...LLAMA, llamaModelPath: join(dir, "gone.gguf") }, llama });
    expect(missing.error).toContain("Modelldatei nicht gefunden");
    expect(missing.result.fields.grossCents?.value).toBe(48000);
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
    const other = fakeManager(key);
    await sync({ ...LLAMA, provider: "ollama" }, false, other);
    expect(other.stopped).toBe(1);
    const busy = fakeManager(key);
    await sync({ ...LLAMA, provider: "ollama" }, true, busy);
    expect(busy.stopped).toBe(0);
  });
});
