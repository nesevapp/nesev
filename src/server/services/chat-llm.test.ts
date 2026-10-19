import { afterAll, describe, expect, test } from "bun:test";
import { ChatLlmError, streamChat } from "./chat-llm";

// a model server that sends `before` chunks and then goes silent (a stalled llama-server), or answers after `delayMs`
const enc = new TextEncoder();
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const mode = new URL(req.url).searchParams.get("mode");
    if (mode === "silent-headers") await Bun.sleep(2000);
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(enc.encode(chunk("Hallo")));
        if (mode === "ok") {
          await Bun.sleep(50);
          controller.enqueue(enc.encode(chunk(" Welt")));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
        // "stall": never closes
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

const opts = (mode: string, extra: Partial<Parameters<typeof streamChat>[0]> = {}) => ({
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
  apiKey: "k",
  model: "m",
  messages: [{ role: "user" as const, content: "Hi" }],
  tools: [],
  reasoning: false,
  fetchFn: (url: string, init: RequestInit) => fetch(`${url}?mode=${mode}`, init),
  ...extra,
});

describe("streamChat inactivity timeout", () => {
  test("a stream that stops sending is aborted with a German error", async () => {
    const t0 = performance.now();
    const err = await streamChat(opts("stall", { idleTimeoutMs: 300 })).catch((e) => e);
    expect(err).toBeInstanceOf(ChatLlmError);
    expect(err.message).toContain("nichts geliefert");
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  test("no response at all: the first-byte timeout applies", async () => {
    const err = await streamChat(opts("silent-headers", { idleTimeoutMs: 100, firstByteTimeoutMs: 300 })).catch((e) => e);
    expect(err).toBeInstanceOf(ChatLlmError);
    expect(err.message).toContain("nichts geliefert");
  });

  test("chunks within the timeout pass; the user's abort still returns the partial text", async () => {
    const ok = await streamChat(opts("ok", { idleTimeoutMs: 1000 }));
    expect(ok.content).toBe("Hallo Welt");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const aborted = await streamChat(opts("stall", { idleTimeoutMs: 5000, signal: ctl.signal }));
    expect(aborted).toMatchObject({ aborted: true, content: "Hallo" });
  });
});
