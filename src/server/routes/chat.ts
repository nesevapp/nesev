import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type ChatStreamEvent, chatConfirmSchema, chatSendSchema, chatSettingsSchema } from "../../shared/chat";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  assertCanConfirm,
  assertCanSend,
  ChatConflictError,
  type ChatDeps,
  ChatNotFoundError,
  confirmToolCall,
  conversationDetail,
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
  sendMessage,
} from "../services/chat";
import { chatLlamaConfig, chatStatus, getChatSettings, syncChatServer, updateChatSettings } from "../services/chat-settings";
import { mcpToolHost, type ToolHost } from "../services/chat-tools";
import { withUiTools } from "../services/chat-ui-tools";
import { getLlamaLease, getLlamaServer } from "../services/receipt-llama";
import { getReceiptWorker } from "../services/receipt-queue";
import { getOcrSettings } from "../services/receipt-settings";

// In-app assistant (contract: src/shared/chat.ts). Messages and confirmations answer with a text/event-stream of
// ChatStreamEvent; 404/409 (unknown conversation, a pending confirmation, a reply still running) come as JSON before
// the stream opens. The model runs in nesev's own llama-server under the lease shared with receipt recognition.

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

/** the MCP tools plus the assistant-only UI tools, composed once per MCP host */
let composed: { mcp: ToolHost; host: ToolHost } | null = null;
async function assistantHost(): Promise<ToolHost> {
  const mcp = await mcpToolHost();
  if (composed?.mcp !== mcp) composed = { mcp, host: withUiTools(mcp, db) };
  return composed.host;
}

const deps: ChatDeps = {
  db,
  host: assistantHost,
  settings: () => getChatSettings(db),
  log: (line) => console.log(line),
  async withModel(fn, { signal, onStatus }) {
    const config = chatLlamaConfig(getChatSettings(db), getOcrSettings(db));
    const lease = getLlamaLease();
    try {
      return await lease.run("chat", config, fn, {
        signal,
        onWait: () => onStatus("Wartet, bis die Belegerkennung das Modell freigibt …"),
        onStart: () => onStatus("Modell wird geladen … (beim ersten Mal einige Sekunden)"),
      });
    } finally {
      // keep it warm for the conversation; stopped after 5 min without use
      if (!lease.busy) getLlamaServer().scheduleIdleStop();
    }
  },
};

/** one SSE event per ChatStreamEvent; writes after the client left are ignored */
function sse(c: Parameters<typeof streamSSE>[0], run: (emit: (e: ChatStreamEvent) => Promise<void>, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    const emit = async (e: ChatStreamEvent) => {
      if (controller.signal.aborted) return;
      await stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => controller.abort());
    };
    // comment lines keep the connection alive while the model loads or reads a long prompt (Bun.serve closes
    // connections idle for 10 s; parsers ignore lines without "data:")
    const ping = setInterval(() => void stream.write(": ping\n\n").catch(() => controller.abort()), 5_000);
    try {
      await run(emit, controller.signal);
    } finally {
      clearInterval(ping);
    }
  });
}

function guardError(err: unknown) {
  if (err instanceof ChatNotFoundError) return { error: err.message, status: 404 as const };
  if (err instanceof ChatConflictError) return { error: err.message, status: 409 as const };
  throw err;
}

const app = new Hono()
  .get("/conversations", (c) => c.json(listConversations(db)))
  .post("/conversations", (c) => c.json(createConversation(db), 201))
  .get("/conversations/:id", idParam, (c) => {
    try {
      return c.json(conversationDetail(db, c.req.valid("param").id));
    } catch (err) {
      const e = guardError(err);
      return c.json({ error: e.error }, e.status);
    }
  })
  .patch("/conversations/:id", idParam, validate("json", z.object({ title: z.string().trim().min(1).max(120) })), (c) => {
    try {
      return c.json(renameConversation(db, c.req.valid("param").id, c.req.valid("json").title));
    } catch (err) {
      const e = guardError(err);
      return c.json({ error: e.error }, e.status);
    }
  })
  .delete("/conversations/:id", idParam, (c) => {
    try {
      deleteConversation(db, c.req.valid("param").id);
      return c.json({ ok: true as const });
    } catch (err) {
      const e = guardError(err);
      return c.json({ error: e.error }, e.status);
    }
  })
  .post("/conversations/:id/messages", idParam, validate("json", chatSendSchema), (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    if (!getChatSettings(db).enabled) return c.json({ error: "Der Assistent ist in den Einstellungen ausgeschaltet" }, 409);
    try {
      assertCanSend(db, id);
    } catch (err) {
      const e = guardError(err);
      return c.json({ error: e.error }, e.status);
    }
    return sse(c, (emit, signal) => sendMessage(deps, id, input, emit, signal));
  })
  .post("/conversations/:id/confirm", idParam, validate("json", chatConfirmSchema), (c) => {
    const { id } = c.req.valid("param");
    const { messageId, approve } = c.req.valid("json");
    try {
      assertCanConfirm(db, id, messageId);
    } catch (err) {
      const e = guardError(err);
      return c.json({ error: e.error }, e.status);
    }
    return sse(c, (emit, signal) => confirmToolCall(deps, id, messageId, approve, emit, signal));
  })
  .get("/settings", (c) => c.json(getChatSettings(db)))
  .put("/settings", validate("json", chatSettingsSchema), async (c) => {
    const saved = updateChatSettings(db, c.req.valid("json"));
    await syncChatServer(db, getLlamaServer(), getLlamaLease(), getReceiptWorker(db).busy);
    return c.json(saved);
  })
  .get("/status", (c) => c.json(chatStatus(db, getLlamaServer())));

export default app;
