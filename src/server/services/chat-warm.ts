import type { ChatSettings, ChatWarmState } from "../../shared/chat";
import type { LlamaLease } from "../lib/llama/lease";
import { configKey, type LlamaConfig, type LlamaEndpoint } from "../lib/llama/server";
import type { LlmMessage, LlmTool } from "./chat-llm";

// Warm-up when the chat panel opens: the first message on a cold llama-server pays for loading the model and
// reading the ~10k-token prompt prefix (system prompt + core tools). warm() starts the server with the chat config
// under the lease and primes its prompt cache with that prefix, in the background, so the first real request only
// reads the user's text. It never interferes with receipt recognition: while a batch runs or anyone holds or waits
// for the lease it does nothing ("busy"; the real request will wait its turn anyway), and it never queues. Cheap
// when repeated: a running warm-up is reused ("warming"), and a primed server (same config, same process, no OCR
// request since, which would have replaced the cached prompt) answers "warm" without a request.

export interface WarmPrompt {
  messages: LlmMessage[];
  tools: LlmTool[];
  reasoning: boolean;
}

export interface WarmDeps {
  settings: () => ChatSettings;
  /** the chat's llama config; throws (German message) when binary or model are missing */
  config: () => LlamaConfig;
  lease: () => Pick<LlamaLease, "busy" | "run" | "lastUsedAt">;
  /** port of the running llama-server, null when stopped (a restart loses the cache) */
  serverPort: () => number | null;
  /** a receipt batch is running (between two receipts the lease is free, but the server must not be restarted) */
  workerBusy: () => boolean;
  /** the prompt prefix every chat request starts with (chat.ts warmupPrompt) */
  prompt: () => Promise<WarmPrompt>;
  /** sends the one-token completion (chat-llm.ts primeCache) */
  prime: (endpoint: LlamaEndpoint, prompt: WarmPrompt, signal: AbortSignal) => Promise<void>;
  /** after a warm-up: schedule the idle stop like after a chat request */
  afterWarm?: () => void;
  log?: (line: string) => void;
  now?: () => number;
}

/** the last successful priming */
interface Primed {
  config: string;
  port: number;
  at: number;
}

const PRIME_TIMEOUT_MS = 180_000;

export class ChatWarmer {
  private primed: Primed | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: WarmDeps) {}

  /** Starts a warm-up if one is useful and possible; never waits for it. */
  warm(): ChatWarmState {
    const { deps } = this;
    if (!deps.settings().enabled) return "disabled";
    let config: LlamaConfig;
    try {
      config = deps.config();
    } catch {
      return "unavailable";
    }
    if (this.running) return "warming";
    if (this.isWarm(config)) return "warm";
    const lease = deps.lease();
    if (deps.workerBusy() || lease.busy) return "busy";
    this.running = this.run(config)
      .catch((err) => deps.log?.(`[chat] warm-up failed: ${(err as Error).message}`))
      .finally(() => {
        this.running = null;
      });
    return "warming";
  }

  /** the running warm-up (tests) */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * Primed today (the system prompt carries the date) for this config on the running server, and no OCR request
   * since (it replaces the slot's cache).
   */
  private isWarm(config: LlamaConfig): boolean {
    const p = this.primed;
    const today = new Date(this.deps.now?.() ?? Date.now()).toDateString();
    return (
      !!p &&
      p.config === configKey(config) &&
      p.port === this.deps.serverPort() &&
      new Date(p.at).toDateString() === today &&
      this.deps.lease().lastUsedAt("ocr") < p.at
    );
  }

  private async run(config: LlamaConfig): Promise<void> {
    const { deps } = this;
    const prompt = await deps.prompt();
    const t0 = deps.now?.() ?? Date.now();
    await deps.lease().run("chat", config, async (endpoint) => {
      await deps.prime(endpoint, prompt, AbortSignal.timeout(PRIME_TIMEOUT_MS));
      const at = deps.now?.() ?? Date.now();
      this.primed = { config: configKey(config), port: endpoint.port, at };
      deps.log?.(`[chat] warm-up: ${prompt.tools.length} tools primed in ${Math.round(at - t0)} ms${endpoint.startMs ? ` (server start ${endpoint.startMs} ms)` : ""}`);
    });
    deps.afterWarm?.();
  }
}
