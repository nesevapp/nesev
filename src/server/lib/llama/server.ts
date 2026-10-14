import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { AbortedError } from "../ocr/run";
import { modelAlias } from "./paths";

// Process manager for llama.cpp: nesev starts llama-server itself when the receipt worker needs a
// model, reuses it for the whole batch and stops it afterwards (or after an idle timeout).
//
// - Binds 127.0.0.1 on a free port chosen here; a random per-process API key is passed via LLAMA_API_KEY
//   (env, so it doesn't show up in `ps`). `--offline` keeps llama-server from downloading anything.
// - Only the child we spawned is ever signalled (SIGTERM, SIGKILL after a grace period). Its PID is also written
//   to a pid file so a nesev process that died hard (SIGKILL) can reap the orphan on the next start – after
//   checking that the PID still runs llama-server with our port.
// - Managers live in a process-wide registry on globalThis: `bun --hot` re-evaluates modules but must not
//   start a second server or lose the handle; exit/SIGINT/SIGTERM handlers stop every registered child.

export interface LlamaConfig {
  binary: string;
  model: string;
  /** projector for vision; null → text only */
  mmproj: string | null;
  contextSize: number;
}

export interface LlamaEndpoint {
  /** API base URL incl. /v1 (chat completions) */
  baseUrl: string;
  apiKey: string;
  port: number;
  /** model id (= --alias) */
  model: string;
  vision: boolean;
  /** ms spent starting the server for this call (0 when it was already running) */
  startMs: number;
}

/** German message, degrades the run to rules-only (the pipeline wraps it in an LlmError). */
export class LlamaServerError extends Error {
  constructor(
    message: string,
    readonly kind: "binary_missing" | "model_missing" | "start_failed" | "timeout" | "crashed",
  ) {
    super(message);
  }
}

export function buildLlamaArgs(config: LlamaConfig, port: number): string[] {
  return [
    "-m", config.model,
    "--alias", modelAlias(config.model),
    ...(config.mmproj ? ["--mmproj", config.mmproj] : ["--no-mmproj"]),
    "-c", String(config.contextSize),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--jinja",
    "--reasoning", "off",
    "-np", "1",
    "--no-webui",
    "--offline",
  ];
}

/** identity of a config: a running server with another key is restarted */
export const configKey = (c: LlamaConfig) => JSON.stringify([c.binary, c.model, c.mmproj, c.contextSize]);

// --- injectable process / network access -----------------------------------------------------------------

export interface ChildProcess {
  pid: number;
  exited: Promise<number | null>;
  /** stdout + stderr, read continuously (llama-server blocks when a pipe fills up) */
  output: ReadableStream<Uint8Array>[];
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface ManagerDeps {
  spawn(cmd: string[], env: Record<string, string>): ChildProcess;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  freePort(): Promise<number>;
  isFile(path: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  randomKey(): string;
  /** pid file for orphan recovery; null = none (tests) */
  pidFile: string | null;
}

export const defaultDeps = (pidFile: string | null): ManagerDeps => ({
  spawn(cmd, env) {
    const proc = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return {
      pid: proc.pid,
      exited: proc.exited,
      output: [proc.stdout, proc.stderr],
      kill: (signal) => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      },
    };
  },
  fetch: (url, init) => fetch(url, init),
  async freePort() {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    return port;
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => performance.now(),
  randomKey: () => `nesev-${crypto.randomUUID()}`,
  pidFile,
});

// --- manager ---------------------------------------------------------------------------------------------

interface Running {
  child: ChildProcess;
  config: LlamaConfig;
  key: string;
  port: number;
  apiKey: string;
  startedAt: string;
}

export interface LlamaServerState {
  running: boolean;
  starting: boolean;
  port: number | null;
  pid: number | null;
  model: string | null;
  startedAt: string | null;
  lastError: string | null;
}

const TAIL_LINES = 40;
export const HEALTH_TIMEOUT_MS = 120_000;
export const STOP_GRACE_MS = 5_000;
export const IDLE_STOP_MS = 5 * 60_000;

export class LlamaServerManager {
  private running: Running | null = null;
  private starting: { key: string; promise: Promise<Running>; controller: AbortController } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tail: string[] = [];
  /** child of a start in progress (killNow must reach it before the health check passes) */
  private loadingChild: ChildProcess | null = null;
  lastError: string | null = null;

  constructor(
    private readonly deps: ManagerDeps,
    readonly healthTimeoutMs = HEALTH_TIMEOUT_MS,
  ) {
    registry().add(this);
  }

  state(): LlamaServerState {
    const r = this.running;
    return {
      running: !!r,
      starting: !!this.starting,
      port: r?.port ?? null,
      pid: r?.child.pid ?? null,
      model: r ? modelAlias(r.config.model) : null,
      startedAt: r?.startedAt ?? null,
      lastError: this.lastError,
    };
  }

  /** key of the running (or starting) config, null when stopped */
  activeKey(): string | null {
    return this.running?.key ?? this.starting?.key ?? null;
  }

  /** config of the running server (not one still starting), null when stopped */
  activeConfig(): LlamaConfig | null {
    return this.running?.config ?? null;
  }

  /** Running server for `config` – reused, or (re)started. Aborting `signal` while it loads stops it. */
  async ensure(config: LlamaConfig, signal?: AbortSignal): Promise<LlamaEndpoint> {
    if (signal?.aborted) throw new AbortedError();
    this.clearIdle();
    const key = configKey(config);
    if (this.running?.key === key) return this.endpoint(this.running, 0);
    if (this.running || (this.starting && this.starting.key !== key)) await this.stop();
    const t0 = this.deps.now();
    if (!this.starting) {
      const controller = new AbortController();
      const promise = this.start(config, key, controller.signal);
      this.starting = { key, promise, controller };
      promise.then(
        () => {
          if (this.starting?.promise === promise) this.starting = null;
        },
        () => {
          if (this.starting?.promise === promise) this.starting = null;
        },
      );
    }
    const pending = this.starting;
    const onAbort = () => pending.controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const running = await pending.promise;
      return this.endpoint(running, Math.round(this.deps.now() - t0));
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Stop after `ms` without a new ensure() (unloadAfterBatch off). */
  scheduleIdleStop(ms = IDLE_STOP_MS): void {
    this.clearIdle();
    if (!this.running) return;
    this.idleTimer = setTimeout(() => void this.stop(), ms);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** SIGTERM, then SIGKILL after the grace period. Also aborts a start in progress. */
  async stop(): Promise<void> {
    this.clearIdle();
    if (this.starting) {
      const s = this.starting;
      s.controller.abort();
      await s.promise.catch(() => {});
    }
    const r = this.running;
    if (!r) return;
    this.running = null;
    await this.terminate(r.child);
  }

  /** Synchronous last-resort kill (process exit). Keeps the pid file: if SIGTERM doesn't take, the next start reaps it. */
  killNow(): void {
    this.clearIdle();
    this.running?.child.kill("SIGTERM");
    this.loadingChild?.kill("SIGTERM");
    this.starting?.controller.abort();
    this.running = null;
  }

  private endpoint(r: Running, startMs: number): LlamaEndpoint {
    return {
      baseUrl: `http://127.0.0.1:${r.port}/v1`,
      apiKey: r.apiKey,
      port: r.port,
      model: modelAlias(r.config.model),
      vision: !!r.config.mmproj,
      startMs,
    };
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async terminate(child: ChildProcess): Promise<void> {
    child.kill("SIGTERM");
    const exited = await Promise.race([child.exited.then(() => true), this.deps.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([child.exited, this.deps.sleep(STOP_GRACE_MS)]);
    }
    this.removePidFile(child.pid);
  }

  private async start(config: LlamaConfig, key: string, signal: AbortSignal): Promise<Running> {
    this.lastError = null;
    try {
      return await this.startOnce(config, key, signal);
    } catch (err) {
      if (err instanceof LlamaServerError && /address already in use|bind|couldn't bind/i.test(this.tail.join("\n"))) {
        // the free port was taken between probing and binding: one more try on another port
        return await this.startOnce(config, key, signal);
      }
      throw err;
    }
  }

  private async startOnce(config: LlamaConfig, key: string, signal: AbortSignal): Promise<Running> {
    const fail = (message: string, kind: LlamaServerError["kind"]) => {
      this.lastError = message;
      return new LlamaServerError(message, kind);
    };
    if (!this.deps.isFile(config.binary)) throw fail(`llama-server nicht gefunden: ${config.binary}`, "binary_missing");
    if (!this.deps.isFile(config.model)) throw fail(`Modelldatei nicht gefunden: ${config.model}`, "model_missing");
    if (config.mmproj && !this.deps.isFile(config.mmproj)) throw fail(`mmproj-Datei nicht gefunden: ${config.mmproj}`, "model_missing");
    if (signal.aborted) throw new AbortedError();

    const port = await this.deps.freePort();
    const apiKey = this.deps.randomKey();
    this.tail = [];
    let child: ChildProcess;
    try {
      child = this.deps.spawn([config.binary, ...buildLlamaArgs(config, port)], { LLAMA_API_KEY: apiKey });
    } catch (err) {
      throw fail(`llama-server konnte nicht gestartet werden: ${(err as Error).message}`, "start_failed");
    }
    this.loadingChild = child;
    this.writePidFile(child.pid, port);
    for (const stream of child.output) void this.collect(stream);
    let exitCode: number | null | undefined;
    void child.exited.then((code) => {
      exitCode = code;
      // crashed while in use: forget it, so the next ensure() starts a fresh one
      if (this.running?.child === child) {
        this.running = null;
        this.lastError = `llama-server beendet (Exit-Code ${code ?? "Signal"}): ${this.tailSummary()}`;
        this.removePidFile(child.pid);
      }
    });

    const deadline = this.deps.now() + this.healthTimeoutMs;
    try {
      for (;;) {
        if (signal.aborted) throw new AbortedError();
        if (exitCode !== undefined) throw fail(this.exitMessage(exitCode), "start_failed");
        if (this.deps.now() > deadline) {
          throw fail(
            `llama-server nicht bereit nach ${Math.round(this.healthTimeoutMs / 1000)} s (Modell zu groß / zu wenig Speicher?)`,
            "timeout",
          );
        }
        if (await this.healthy(port, apiKey, signal)) break;
        await Promise.race([this.deps.sleep(250), child.exited]);
      }
    } catch (err) {
      await this.terminate(child);
      throw err;
    } finally {
      this.loadingChild = null;
    }
    const running: Running = { child, config, key, port, apiKey, startedAt: new Date().toISOString() };
    this.running = running;
    return running;
  }

  private async healthy(port: number, apiKey: string, signal: AbortSignal): Promise<boolean> {
    try {
      const res = await this.deps.fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      await res.body?.cancel();
      return res.status === 200;
    } catch {
      return false; // not listening yet
    }
  }

  private async collect(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of stream) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        // drop llama.cpp's "0.00.028.400 E srv  " timestamp / level / module prefix
        for (const line of lines) if (line.trim()) this.tail.push(line.trimEnd().replace(/^\d+(?:\.\d+)+\s+[A-Z]\s+\S+\s+/, ""));
        if (this.tail.length > TAIL_LINES * 2) this.tail.splice(0, this.tail.length - TAIL_LINES);
      }
    } catch {
      // stream closed
    }
    if (rest.trim()) this.tail.push(rest.trimEnd());
  }

  /** the most telling log lines (errors first) */
  private tailSummary(): string {
    const lines = this.tail.slice(-TAIL_LINES);
    const errors = lines.filter((l) => /error|failed|unable|cannot|invalid|unknown|not found|exception/i.test(l));
    return (errors.length ? errors.slice(-3) : lines.slice(-3)).join(" | ").slice(0, 600) || "keine Ausgabe";
  }

  private exitMessage(code: number | null): string {
    const log = this.tail.join("\n");
    if (/address already in use|couldn't bind/i.test(log)) return "llama-server: Port belegt";
    if (/failed to (load|read) model|error loading model|gguf_init/i.test(log)) {
      return `llama-server konnte das Modell nicht laden: ${this.tailSummary()}`;
    }
    if (/invalid argument|unknown argument|error: .*argument/i.test(log)) {
      return `llama-server kennt eine Option nicht (zu alte Version?): ${this.tailSummary()}`;
    }
    return `llama-server beendet (Exit-Code ${code ?? "Signal"}): ${this.tailSummary()}`;
  }

  private writePidFile(pid: number, port: number) {
    if (!this.deps.pidFile) return;
    try {
      writeFileSync(this.deps.pidFile, `${pid} ${port}\n`);
    } catch {
      // best effort
    }
  }

  private removePidFile(pid: number) {
    if (!this.deps.pidFile) return;
    try {
      if (readFileSync(this.deps.pidFile, "utf8").split(" ")[0] === String(pid)) rmSync(this.deps.pidFile, { force: true });
    } catch {
      // gone already
    }
  }
}

// --- orphan recovery -------------------------------------------------------------------------------------

/**
 * A previous nesev process died without stopping its llama-server (SIGKILL, crash): stop that child now.
 * Only if the recorded PID still runs llama-server with the recorded port – never anything else.
 */
export async function reapOrphan(pidFile: string, command = psCommand): Promise<number | null> {
  let pid: number;
  let port: string;
  try {
    const [p, q] = readFileSync(pidFile, "utf8").trim().split(/\s+/);
    pid = Number(p);
    port = q ?? "";
  } catch {
    return null;
  }
  rmSync(pidFile, { force: true });
  if (!Number.isInteger(pid) || pid <= 1 || !port) return null;
  const cmd = await command(pid);
  if (!cmd || basename(cmd.split(/\s+/)[0] ?? "") !== "llama-server" || !cmd.includes(`--port ${port}`)) return null;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return null;
  }
  return pid;
}

async function psCommand(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}

// --- process-wide registry -------------------------------------------------------------------------------

const REGISTRY_KEY = Symbol.for("nesev.llamaManagers");
const HANDLERS_KEY = Symbol.for("nesev.llamaExitHandlers");

function registry(): Set<LlamaServerManager> {
  const g = globalThis as { [REGISTRY_KEY]?: Set<LlamaServerManager> };
  g[REGISTRY_KEY] ??= new Set();
  return g[REGISTRY_KEY];
}

/** Forget a short-lived manager (e.g. the settings test) after stopping it. */
export function unregister(manager: LlamaServerManager): void {
  registry().delete(manager);
}

/** Once per process: stop every child llama-server when nesev exits. */
export function installExitHandlers(): void {
  const g = globalThis as { [HANDLERS_KEY]?: boolean };
  if (g[HANDLERS_KEY]) return;
  g[HANDLERS_KEY] = true;
  const killAll = () => {
    for (const m of registry()) m.killNow();
  };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      killAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}
