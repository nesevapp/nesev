import type { LlamaConfig, LlamaEndpoint, LlamaServerManager } from "./server";

// One llama-server is shared by the receipt worker ("ocr") and the in-app assistant ("chat"). The manager restarts
// the server whenever another config is requested, so without coordination a chat request could yank the model
// away from a running receipt extraction (or the other way round). The lease serializes "ensure config + request":
//
// - run(owner, config, fn) waits for the lock (FIFO), ensures the server and runs fn with the endpoint; the next
//   caller only gets the server after fn settled. The worker takes it per receipt, the chat per model call.
// - A running server that satisfies the request is reused instead of restarted: same binary and model, at least
//   the requested context, and the requested projector (or none requested). So OCR (8k, text) runs on the chat's
//   32k server of the same model without a restart; only chat after an 8k OCR server restarts once to 32k.
// - Idle handling stays with the owners (receipt worker: stop after the batch / 5 min idle). recentlyUsed("chat")
//   lets them keep the server warm while a conversation is active.

export type LeaseOwner = "ocr" | "chat";

type Manager = Pick<LlamaServerManager, "ensure" | "activeConfig">;

/** `running` can serve a request for `wanted` without a restart. */
export function satisfies(running: LlamaConfig, wanted: LlamaConfig): boolean {
  return (
    running.binary === wanted.binary &&
    running.model === wanted.model &&
    running.contextSize >= wanted.contextSize &&
    (wanted.mmproj === null || running.mmproj === wanted.mmproj)
  );
}

export const CHAT_WARM_MS = 5 * 60_000;

export class LlamaLease {
  private tail: Promise<void> = Promise.resolve();
  private holders = 0;
  private lastUse: Record<LeaseOwner, number> = { ocr: 0, chat: 0 };

  constructor(
    private readonly manager: Manager,
    private readonly now: () => number = Date.now,
  ) {}

  /** Someone holds or waits for the server. */
  get busy(): boolean {
    return this.holders > 0;
  }

  /** `owner` used the server within the last `ms` (default: the idle-stop window). */
  recentlyUsed(owner: LeaseOwner, ms = CHAT_WARM_MS): boolean {
    return this.lastUse[owner] > 0 && this.now() - this.lastUse[owner] < ms;
  }

  /** The config that will actually run for `wanted`: the running one when it satisfies the request. */
  effectiveConfig(wanted: LlamaConfig): LlamaConfig {
    const active = this.manager.activeConfig();
    return active && satisfies(active, wanted) ? active : wanted;
  }

  /**
   * Exclusive use of the server: waits for the lock, ensures a server for `config` (reusing a compatible one) and
   * runs `fn`. `onWait` is called when another owner holds the lock; `onStart` when a (re)start is needed.
   */
  async run<T>(
    owner: LeaseOwner,
    config: LlamaConfig,
    fn: (endpoint: LlamaEndpoint) => Promise<T>,
    opts: { signal?: AbortSignal; onWait?: () => void; onStart?: () => void } = {},
  ): Promise<T> {
    this.holders++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    try {
      if (this.holders > 1) opts.onWait?.();
      await previous;
      opts.signal?.throwIfAborted();
      const effective = this.effectiveConfig(config);
      if (effective === config) opts.onStart?.();
      const endpoint = await this.manager.ensure(effective, opts.signal);
      this.lastUse[owner] = this.now();
      try {
        return await fn(endpoint);
      } finally {
        this.lastUse[owner] = this.now();
      }
    } finally {
      this.holders--;
      release();
    }
  }
}
