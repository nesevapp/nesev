import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbortedError } from "../ocr/run";
import { buildLlamaArgs, type ChildProcess, type LlamaConfig, LlamaServerError, LlamaServerManager, type ManagerDeps, reapOrphan, unregister } from "./server";

const dir = mkdtempSync(join(tmpdir(), "nesev-llama-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG: LlamaConfig = { binary: "/bin/llama-server", model: "/models/gemma-4-E2B-it-UD-Q4_K_XL.gguf", mmproj: null, contextSize: 8192 };

interface FakeChild extends ChildProcess {
  signals: string[];
  env: Record<string, string>;
  cmd: string[];
  exit(code: number | null): void;
  log(line: string): void;
}

interface FakeOptions {
  /** /health answers 503 this many times, then 200 */
  loadPolls?: number;
  /** the child exits during load with these log lines */
  crashWith?: string[];
  /** SIGTERM is ignored (needs SIGKILL) */
  ignoreTerm?: boolean;
  /** never becomes healthy */
  neverReady?: boolean;
  files?: string[];
  pidFile?: string | null;
}

function fakeDeps(o: FakeOptions = {}) {
  const children: FakeChild[] = [];
  let clock = 0;
  let nextPort = 40000;
  let nextPid = 900000;
  const files = new Set(o.files ?? [CONFIG.binary, CONFIG.model]);
  const deps: ManagerDeps = {
    spawn(cmd, env) {
      let resolveExit!: (code: number | null) => void;
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
      let exited = false;
      const child: FakeChild = {
        pid: nextPid++,
        cmd,
        env,
        signals: [],
        exited: new Promise((r) => (resolveExit = r)),
        output: [stream],
        kill(signal) {
          child.signals.push(signal);
          if (signal === "SIGKILL" || !o.ignoreTerm) child.exit(null);
        },
        exit(code) {
          if (exited) return;
          exited = true;
          try {
            ctl.close();
          } catch {}
          resolveExit(code);
        },
        log: (line) => ctl.enqueue(new TextEncoder().encode(`${line}\n`)),
      };
      (child as FakeChild & { polls: number }).polls = 0;
      children.push(child);
      if (o.crashWith) {
        setTimeout(() => {
          for (const l of o.crashWith!) child.log(l);
          setTimeout(() => child.exit(1), 5);
        }, 1);
      }
      return child;
    },
    async fetch(url) {
      const port = Number(new URL(url).port);
      const child = children.find((c) => c.cmd.includes(String(port)));
      if (!child) throw new TypeError("fetch failed");
      const state = child as FakeChild & { polls: number };
      state.polls++;
      const ready = !o.neverReady && state.polls > (o.loadPolls ?? 2);
      return new Response(ready ? '{"status":"ok"}' : '{"error":"Loading model"}', { status: ready ? 200 : 503 });
    },
    freePort: async () => nextPort++,
    isFile: (p) => files.has(p),
    async sleep(ms) {
      clock += ms;
      await new Promise((r) => setTimeout(r, 1));
    },
    now: () => clock,
    randomKey: () => `key-${nextPid}`,
    pidFile: o.pidFile ?? null,
  };
  return { deps, children };
}

function manager(o: FakeOptions = {}, timeout?: number) {
  const fake = fakeDeps(o);
  const m = new LlamaServerManager(fake.deps, timeout);
  unregister(m);
  return { m, ...fake };
}

describe("buildLlamaArgs", () => {
  test("loopback, port, context, alias, jinja, offline, no projector in text mode", () => {
    const args = buildLlamaArgs(CONFIG, 41234);
    expect(args.join(" ")).toBe(
      "-m /models/gemma-4-E2B-it-UD-Q4_K_XL.gguf --alias gemma-4-E2B-it-UD-Q4_K_XL --no-mmproj -c 8192 --host 127.0.0.1 --port 41234 --jinja --reasoning off -np 1 --no-webui --offline",
    );
    expect(args).not.toContain("--api-key");
  });

  test("with projector", () => {
    const args = buildLlamaArgs({ ...CONFIG, mmproj: "/models/mmproj-F16.gguf" }, 1);
    expect(args.slice(4, 6)).toEqual(["--mmproj", "/models/mmproj-F16.gguf"]);
    expect(args).not.toContain("--no-mmproj");
  });
});

describe("LlamaServerManager", () => {
  test("starts once (waits for /health), reuses the server for the batch, key only via env", async () => {
    const { m, children } = manager({ loadPolls: 3 });
    const a = await m.ensure(CONFIG);
    const b = await m.ensure(CONFIG);
    expect(children).toHaveLength(1);
    expect(a.baseUrl).toBe("http://127.0.0.1:40000/v1");
    expect(a.model).toBe("gemma-4-E2B-it-UD-Q4_K_XL");
    expect(a.vision).toBe(false);
    expect(a.startMs).toBeGreaterThan(0);
    expect(b.startMs).toBe(0);
    expect(children[0]!.env).toEqual({ LLAMA_API_KEY: a.apiKey });
    expect(children[0]!.cmd.join(" ")).not.toContain(a.apiKey);
    expect(m.state()).toMatchObject({ running: true, port: 40000, pid: children[0]!.pid, model: "gemma-4-E2B-it-UD-Q4_K_XL" });
    await m.stop();
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(m.state().running).toBe(false);
  });

  test("concurrent ensure() share one start", async () => {
    const { m, children } = manager();
    const [a, b] = await Promise.all([m.ensure(CONFIG), m.ensure(CONFIG)]);
    expect(children).toHaveLength(1);
    expect(a.port).toBe(b.port);
    await m.stop();
  });

  test("another config restarts the server", async () => {
    const { m, children } = manager({ files: [CONFIG.binary, CONFIG.model, "/models/other.gguf"] });
    await m.ensure(CONFIG);
    const b = await m.ensure({ ...CONFIG, model: "/models/other.gguf" });
    expect(children).toHaveLength(2);
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(b.model).toBe("other");
    await m.stop();
  });

  test("missing binary / model → German error, nothing spawned", async () => {
    const { m, children } = manager({ files: [CONFIG.model] });
    await expect(m.ensure(CONFIG)).rejects.toThrow("llama-server nicht gefunden: /bin/llama-server");
    const other = manager({ files: [CONFIG.binary] });
    await expect(other.m.ensure(CONFIG)).rejects.toThrow("Modelldatei nicht gefunden");
    await Bun.sleep(5);
    expect(children).toHaveLength(0);
    expect(other.children).toHaveLength(0);
    expect(other.m.lastError).toContain("Modelldatei nicht gefunden");
  });

  test("exit during load → error from the log tail", async () => {
    const { m } = manager({ neverReady: true, crashWith: ["llama_model_load: error loading model: tensor data is not within file bounds", "main: exiting due to model loading error"] });
    const err = await m.ensure(CONFIG).catch((e) => e);
    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.message).toContain("konnte das Modell nicht laden");
    expect(err.message).toContain("tensor data is not within file bounds");
    expect(m.state()).toMatchObject({ running: false, starting: false });
  });

  test("not healthy in time → timeout error, child killed", async () => {
    const { m, children } = manager({ neverReady: true }, 2_000);
    const err = await m.ensure(CONFIG).catch((e) => e);
    expect(err).toBeInstanceOf(LlamaServerError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("nicht bereit nach 2 s");
    expect(children[0]!.signals[0]).toBe("SIGTERM");
  });

  test("cancel while loading aborts cleanly", async () => {
    const { m, children } = manager({ neverReady: true });
    const controller = new AbortController();
    const pending = m.ensure(CONFIG, controller.signal);
    await Bun.sleep(10);
    controller.abort();
    expect(await pending.catch((e) => e)).toBeInstanceOf(AbortedError);
    expect(children[0]!.signals).toContain("SIGTERM");
    expect(m.state()).toMatchObject({ running: false, starting: false });
  });

  test("SIGKILL when SIGTERM is ignored", async () => {
    const { m, children } = manager({ ignoreTerm: true });
    await m.ensure(CONFIG);
    await m.stop();
    expect(children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("idle timeout stops the server; ensure() cancels the timer", async () => {
    const { m, children } = manager();
    await m.ensure(CONFIG);
    m.scheduleIdleStop(20);
    await m.ensure(CONFIG); // new batch: timer cleared
    await Bun.sleep(40);
    expect(m.state().running).toBe(true);
    m.scheduleIdleStop(10);
    await Bun.sleep(40);
    expect(m.state().running).toBe(false);
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
  });

  test("a crashed server is replaced on the next ensure()", async () => {
    const { m, children } = manager();
    await m.ensure(CONFIG);
    children[0]!.log("GGML_ASSERT failed");
    children[0]!.exit(134);
    await Bun.sleep(5);
    expect(m.state().running).toBe(false);
    expect(m.lastError).toContain("Exit-Code 134");
    await m.ensure(CONFIG);
    expect(children).toHaveLength(2);
    await m.stop();
  });

  test("pid file written while running, removed on stop; killNow is synchronous", async () => {
    const pidFile = join(dir, "llama.pid");
    const { m, children } = manager({ pidFile });
    await m.ensure(CONFIG);
    expect(readFileSync(pidFile, "utf8")).toBe(`${children[0]!.pid} 40000\n`);
    await m.stop();
    expect(existsSync(pidFile)).toBe(false);
    await m.ensure(CONFIG);
    m.killNow();
    expect(children[1]!.signals).toEqual(["SIGTERM"]);
    expect(m.state().running).toBe(false);
  });
});

describe("reapOrphan", () => {
  test("stops the recorded PID only if it still runs llama-server on the recorded port", async () => {
    const pidFile = join(dir, "orphan.pid");
    // a harmless child of this test stands in for the orphan
    const victim = Bun.spawn(["sleep", "30"]);
    writeFileSync(pidFile, `${victim.pid} 41234\n`);
    expect(await reapOrphan(pidFile, async () => "/opt/homebrew/bin/llama-server -m x.gguf --port 9999")).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
    writeFileSync(pidFile, `${victim.pid} 41234\n`);
    expect(await reapOrphan(pidFile, async () => "/usr/bin/sleep 30 --port 41234")).toBeNull();
    expect(victim.exitCode).toBeNull();
    writeFileSync(pidFile, `${victim.pid} 41234\n`);
    expect(await reapOrphan(pidFile, async () => "/Users/me/.unsloth/llama.cpp/build/bin/llama-server -m x.gguf --port 41234 --jinja")).toBe(victim.pid);
    await victim.exited;
    expect(victim.signalCode).toBe("SIGTERM");
    expect(await reapOrphan(join(dir, "missing.pid"))).toBeNull();
  });
});
