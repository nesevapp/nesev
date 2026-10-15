import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from "../../shared/chat";
import { LlamaLease } from "../lib/llama/lease";
import type { LlamaConfig, LlamaEndpoint } from "../lib/llama/server";
import { ChatWarmer, type WarmDeps, type WarmPrompt } from "./chat-warm";

// The panel's warm-up with a real lease on a fake server manager and a fake prime request.

const chatConfig: LlamaConfig = { binary: "/bin/llama-server", model: "/m/qwen.gguf", mmproj: null, contextSize: 65536 };
const ocrConfig: LlamaConfig = { ...chatConfig, contextSize: 8192 };

let active: LlamaConfig | null;
let port: number;
let ensured: LlamaConfig[];
let primes: { port: number; prompt: WarmPrompt }[];
let settings: ChatSettings;
let workerBusy: boolean;
let clock: number;
let primeGate: Promise<void> | null;
let configError: Error | null;
let lease: LlamaLease;
let deps: WarmDeps;

const endpoint = (): LlamaEndpoint => ({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", port, model: "qwen", vision: false, startMs: 0 });
const prompt: WarmPrompt = { messages: [{ role: "system", content: "Du bist der Assistent" }, { role: "user", content: "Hallo" }], tools: [], reasoning: false };

beforeEach(() => {
  active = null;
  port = 4100;
  ensured = [];
  primes = [];
  settings = { ...DEFAULT_CHAT_SETTINGS };
  workerBusy = false;
  clock = new Date("2026-10-15T09:00:00").getTime();
  primeGate = null;
  configError = null;
  const manager = {
    activeConfig: () => active,
    async ensure(config: LlamaConfig) {
      ensured.push(config);
      if (active !== config) port++; // a (re)start gets a new port
      active = config;
      return endpoint();
    },
  };
  lease = new LlamaLease(manager, () => clock);
  deps = {
    settings: () => settings,
    config: () => {
      if (configError) throw configError;
      return chatConfig;
    },
    lease: () => lease,
    serverPort: () => (active ? port : null),
    workerBusy: () => workerBusy,
    prompt: async () => prompt,
    prime: async (e, p) => {
      await primeGate;
      primes.push({ port: e.port, prompt: p });
    },
    now: () => clock,
  };
});

describe("chat warm-up", () => {
  test("starts the chat server and primes the prompt once; repeated calls are cheap", async () => {
    const w = new ChatWarmer(deps);
    let release!: () => void;
    primeGate = new Promise((r) => (release = r));
    expect(w.warm()).toBe("warming");
    // while it runs: no second warm-up
    expect(w.warm()).toBe("warming");
    release();
    await w.settled();
    expect(ensured).toEqual([chatConfig]);
    expect(primes).toEqual([{ port: 4101, prompt }]);
    expect(lease.recentlyUsed("chat")).toBe(true);
    expect(w.warm()).toBe("warm");
    await w.settled();
    expect(primes).toHaveLength(1);
  });

  test("off, unavailable, receipt batch running or the lease taken: nothing happens", async () => {
    const w = new ChatWarmer(deps);
    settings = { ...settings, enabled: false };
    expect(w.warm()).toBe("disabled");
    settings = { ...settings, enabled: true };
    configError = new Error("Kein Modell gefunden");
    expect(w.warm()).toBe("unavailable");
    configError = null;
    workerBusy = true;
    expect(w.warm()).toBe("busy");
    workerBusy = false;
    // OCR holds the server: no queueing behind it, no restart afterwards
    let release!: () => void;
    const ocr = lease.run("ocr", ocrConfig, () => new Promise<void>((r) => (release = r)));
    await Bun.sleep(0);
    expect(w.warm()).toBe("busy");
    release();
    await ocr;
    await w.settled();
    expect(ensured).toEqual([ocrConfig]);
    expect(primes).toEqual([]);
  });

  test("primed again after an OCR request, a server restart or the next day", async () => {
    const w = new ChatWarmer(deps);
    w.warm();
    await w.settled();
    // OCR ran on the chat server (it satisfies the OCR config): the slot's cache is gone
    clock += 1000;
    await lease.run("ocr", ocrConfig, async () => {});
    clock += 1000;
    expect(w.warm()).toBe("warming");
    await w.settled();
    expect(primes).toHaveLength(2);
    expect(w.warm()).toBe("warm");
    // the server was restarted (idle stop and a new start)
    port = 5000;
    expect(w.warm()).toBe("warming");
    await w.settled();
    expect(primes).toHaveLength(3);
    // the system prompt carries the date
    clock += 24 * 3600_000;
    expect(w.warm()).toBe("warming");
    await w.settled();
    expect(primes).toHaveLength(4);
  });

  test("a failing prime is logged and retried on the next call", async () => {
    const logs: string[] = [];
    const w = new ChatWarmer({ ...deps, log: (l) => void logs.push(l), prime: async () => Promise.reject(new Error("HTTP 500")) });
    expect(w.warm()).toBe("warming");
    await w.settled();
    expect(logs).toEqual(["[chat] warm-up failed: HTTP 500"]);
    expect(w.warm()).toBe("warming");
    await w.settled();
  });
});
