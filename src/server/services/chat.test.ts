import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIRM_TOOLS, type ChatStreamEvent, DEFAULT_CHAT_SETTINGS } from "../../shared/chat";
import { createTestDb, type Db } from "../db/client";
import { chatMessages, settings as settingsTable } from "../db/schema";
import { LlamaLease } from "../lib/llama/lease";
import { type LlamaConfig, type LlamaEndpoint, LlamaServerError } from "../lib/llama/server";
import { PROJECT_ROOT } from "../lib/paths";
import {
  assertCanConfirm,
  assertCanSend,
  autoTitle,
  buildHistory,
  ChatConflictError,
  type ChatDeps,
  confirmToolCall,
  conversationDetail,
  createConversation,
  deleteConversation,
  describePage,
  listConversations,
  needsData,
  renameConversation,
  sendMessage,
} from "./chat";
import { repetitionCut } from "./chat-llm";
import { getChatSettings, updateChatSettings } from "./chat-settings";
import { type ChatTool, confirmSummary, extractLinks, selectTools, selectToolsDetailed, type ToolHost, toChatToolResult, toolTokens } from "./chat-tools";
import { withUiTools } from "./chat-ui-tools";

// The agent loop against a fake OpenAI-compatible streaming server (Bun.serve emitting SSE chunks like
// llama-server, incl. tool calls split over several deltas) and a fake tool host, on an in-memory DB.

// --- fake model server ------------------------------------------------------------------------------------------

type Script = { chunks: unknown[]; delayMs?: number } | { status: number; body: string };
const scripts: Script[] = [];
const requests: any[] = [];

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const text = (...parts: string[]): Script => ({ chunks: [chunk({ role: "assistant", content: null }), ...parts.map((p) => chunk({ content: p })), chunk({}, "stop")] });
/** a tool call whose name/arguments arrive in pieces, like llama-server streams them */
const toolCall = (name: string, args: string, id = `id_${name}`): Script => ({
  chunks: [
    chunk({ role: "assistant", content: null }),
    chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args.slice(0, 3) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(3) } }] }),
    { ...chunk({}, "tool_calls"), timings: { prompt_n: 100, cache_n: 20, predicted_n: 9 } },
  ],
});

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    requests.push(await req.json());
    const script = scripts.shift();
    if (!script) return new Response("no script", { status: 500 });
    if ("status" in script) return new Response(script.body, { status: script.status });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const c of script.chunks) {
            if (script.delayMs) await Bun.sleep(script.delayMs);
            controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // client went away
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

const endpoint: LlamaEndpoint = { baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", port: server.port!, model: "m", vision: false, startMs: 0 };

// --- fake tools ---------------------------------------------------------------------------------------------------

const tool = (name: string, readOnly: boolean, destructive = false, group: ChatTool["group"] = "core"): ChatTool => ({
  name,
  group,
  description: `${name} tool`,
  inputSchema: { $schema: "x", type: "object", properties: { id: { type: "number" } } },
  readOnly,
  destructive,
});
const calls: { name: string; args: Record<string, unknown> }[] = [];
const host: ToolHost = {
  tools: [tool("search", true), tool("list_documents", true), tool("get_document", true), tool("create_invoice_draft", false), tool("finalize_document", false, true)],
  async call(name, args) {
    calls.push({ name, args });
    if (name === "list_documents") {
      return { isError: false, text: "2 offene Rechnungen\n- RE-2026-0001 Alpen GmbH € 120,00", structured: { documents: [{ number: "RE-2026-0001", link: "/invoices/1" }] } };
    }
    if (name === "get_document") {
      return { isError: false, text: "Rechnung", structured: { id: args.id, type: "invoice", typeLabel: "Rechnung", number: null, status: "draft", client: { name: "Alpen GmbH" }, gross: { cents: 54000, formatted: "€ 540,00" }, link: `/invoices/${args.id}` } };
    }
    if (name === "finalize_document") {
      return { isError: false, text: "Finalisiert: RE-2026-0002.", structured: { id: 2, number: "RE-2026-0002", link: "/invoices/2", pdf: { url: "/api/files/pdfs/RE-2026-0002.pdf" } } };
    }
    if (name === "create_invoice_draft" && !args.title) return { isError: true, text: "Fehler: Position 1: Bezeichnung fehlt", structured: null };
    return { isError: false, text: "OK", structured: null };
  },
};

let db: Db;
let deps: ChatDeps;
let statusTexts: string[];
beforeEach(() => {
  db = createTestDb();
  scripts.length = 0;
  requests.length = 0;
  calls.length = 0;
  statusTexts = [];
  deps = {
    db,
    host: async () => host,
    settings: () => getChatSettings(db),
    withModel: async (fn, { onStatus }) => {
      onStatus("Modell wird geladen …");
      return fn(endpoint);
    },
    now: () => new Date("2026-10-14T10:00:00"),
  };
});

async function collect(run: (emit: (e: ChatStreamEvent) => void) => Promise<void>) {
  const events: ChatStreamEvent[] = [];
  await run((e) => {
    events.push(e);
  });
  return events;
}
const types = (events: ChatStreamEvent[]) => events.map((e) => e.type).filter((t) => t !== "delta" && t !== "status");

// --- tests ----------------------------------------------------------------------------------------------------------

describe("conversations", () => {
  test("create, list newest first with preview, rename, delete", async () => {
    const a = createConversation(db);
    const b = createConversation(db);
    expect(a.title).toBe("Neue Unterhaltung");
    scripts.push(text("Hallo!"));
    await collect((emit) => sendMessage(deps, a.id, { text: "Hallo, wer bist du eigentlich und was kannst du?" }, emit));
    const list = listConversations(db);
    expect(list[0]!.id).toBe(a.id);
    expect(list[0]!.title).toBe("Hallo, wer bist du eigentlich und …");
    expect(list[0]!.preview).toBe("Hallo!");
    scripts.push(text("Entwurf angelegt:\n- **Kunde:** [Alpen](/clients/1)\n- `Beratung`"));
    await collect((emit) => sendMessage(deps, a.id, { text: "Leg an" }, emit));
    expect(listConversations(db)[0]!.preview).toBe("Entwurf angelegt: Kunde: Alpen Beratung");
    expect(renameConversation(db, b.id, " Steuern ").title).toBe("Steuern");
    deleteConversation(db, a.id);
    expect(listConversations(db).map((c) => c.id)).toEqual([b.id]);
    expect(db.select().from(chatMessages).all()).toHaveLength(0);
  });

  test("autoTitle and page descriptions", () => {
    expect(autoTitle("Welche Rechnungen sind offen?")).toBe("Welche Rechnungen sind offen?");
    expect(describePage("/invoices/12", "Rechnung RE-2026-0004")).toBe("Der Nutzer sieht gerade Rechnung id 12 („Rechnung RE-2026-0004“).");
    expect(describePage("/expenses")).toBe("Der Nutzer sieht gerade die Ausgaben.");
  });

  test("settings: defaults, unknown keys ignored, invalid fields fall back", () => {
    expect(getChatSettings(db)).toEqual(DEFAULT_CHAT_SETTINGS);
    db.update(settingsTable).set({ chatSettings: { contextSize: 16384, reasoning: "yes", foo: 1 } }).run();
    expect(getChatSettings(db)).toEqual({ ...DEFAULT_CHAT_SETTINGS, contextSize: 16384 });
    expect(updateChatSettings(db, { ...DEFAULT_CHAT_SETTINGS, reasoning: true }).reasoning).toBe(true);
  });
});

describe("agent loop", () => {
  test("plain answer: events, persisted message, system prompt, page context", async () => {
    const c = createConversation(db);
    scripts.push(text("Gerne", ", hier."));
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Hallo", context: { path: "/invoices/12", title: "RE-2026-0004" } }, emit));
    expect(types(events)).toEqual(["user_message", "assistant_start", "done"]);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("Gerne, hier.");
    expect(events.some((e) => e.type === "status")).toBe(true);
    const req = requests[0];
    expect(req.stream).toBe(true);
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(req.messages[0].content).toContain("14.10.2026");
    expect(req.messages[1].content).toBe("(Kontext: Der Nutzer sieht gerade Rechnung id 12 („RE-2026-0004“).)\nHallo");
    expect(req.tools.map((t: any) => t.function.name)).toEqual(host.tools.map((t) => t.name));
    expect(req.tools[0].function.parameters.$schema).toBeUndefined();
    const detail = conversationDetail(db, c.id);
    expect(detail.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Hallo"],
      ["assistant", "Gerne, hier."],
    ]);
    expect(detail.messages[0]!.contextPath).toBe("/invoices/12");
  });

  test("tool call → tool result → final answer", async () => {
    const c = createConversation(db);
    scripts.push(toolCall("list_documents", '{"status":"open"}'), text("Offen ist RE-2026-0001."));
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Welche Rechnungen sind offen?" }, emit));
    expect(types(events)).toEqual(["user_message", "assistant_start", "tool_call", "tool_result", "assistant_start", "done"]);
    expect(calls).toEqual([{ name: "list_documents", args: { status: "open" } }]);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.type === "tool_result" && result.message.toolResult).toMatchObject({
      ok: true,
      summary: "2 offene Rechnungen",
      links: [{ label: "RE-2026-0001", path: "/invoices/1" }],
      card: { kind: "table", rows: [{ path: "/invoices/1" }] },
    });
    // the second request carries the call and its result
    const msgs = requests[1].messages;
    expect(msgs.at(-2)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "id_list_documents", type: "function", function: { name: "list_documents", arguments: '{"status":"open"}' } }],
    });
    expect(msgs.at(-1)).toMatchObject({ role: "tool", tool_call_id: "id_list_documents" });
    expect(msgs.at(-1).content).toContain("RE-2026-0001");
  });

  test("cards and UI actions: stored on the tool row; the model is told the user sees the card", async () => {
    deps.host = async () => withUiTools(host, db);
    const c = createConversation(db);
    scripts.push(toolCall("get_document", '{"id":5}'), toolCall("download_pdf", '{"id":5}'), text("Lädt."));
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Lade mir die Vorschau vom Entwurf 5 herunter" }, emit));
    const results = events.filter((e) => e.type === "tool_result") as Extract<ChatStreamEvent, { type: "tool_result" }>[];
    expect(results[0]!.message.toolResult?.card).toMatchObject({ kind: "document", typeLabel: "Rechnung", number: null, grossCents: 54000, path: "/invoices/5", pdfUrl: "/api/pdf/documents/5" });
    expect(results[0]!.message.content).toContain("Beleg-Karte im Chat");
    expect(results[1]!.message.toolResult).toEqual({
      ok: true,
      summary: "PDF-Vorschau Rechnung (Entwurf) wird heruntergeladen (Entwurf-5.pdf).",
      links: [],
      action: { kind: "download", url: "/api/pdf/documents/5?download=1", fileName: "Entwurf-5.pdf", label: "Entwurf-5.pdf" },
    });
    // the UI tools are offered with every request
    expect(requests[0].tools.map((t: any) => t.function.name)).toContain("open_in_app");
    expect(requests[2].messages.at(-1).content).toBe(results[1]!.message.content);
  });

  test("confirm flow: pending blocks, approve executes and continues", async () => {
    const c = createConversation(db);
    scripts.push(toolCall("finalize_document", '{"id":2}'));
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Finalisiere die Rechnung" }, emit));
    expect(types(events)).toEqual(["user_message", "assistant_start", "tool_call", "confirm"]);
    const confirm = events.at(-1) as Extract<ChatStreamEvent, { type: "confirm" }>;
    expect(confirm.summary).toBe("Rechnung (Entwurf, id 2) für Alpen GmbH über € 540,00 finalisieren – vergibt die Nummer und erzeugt das PDF, danach unveränderbar");
    expect(calls.map((x) => x.name)).toEqual(["get_document"]); // only the lookup, not finalize
    const detail = conversationDetail(db, c.id);
    expect(detail.pending).toEqual({ messageId: confirm.messageId, toolCall: { id: "id_finalize_document", name: "finalize_document", arguments: { id: 2 } }, summary: confirm.summary });
    expect(() => assertCanSend(db, c.id)).toThrow(ChatConflictError);
    expect(() => assertCanSend(db, c.id)).toThrow("Bitte zuerst die offene Aktion bestätigen oder ablehnen");

    scripts.push(text("RE-2026-0002 ist finalisiert."));
    assertCanConfirm(db, c.id, confirm.messageId);
    const after = await collect((emit) => confirmToolCall(deps, c.id, confirm.messageId, true, emit));
    expect(types(after)).toEqual(["tool_result", "assistant_start", "done"]);
    expect(calls.at(-1)).toEqual({ name: "finalize_document", args: { id: 2 } });
    const r = after[0] as Extract<ChatStreamEvent, { type: "tool_result" }>;
    expect(r.message.status).toBe("done");
    expect(r.message.toolResult?.links).toEqual([
      { label: "RE-2026-0002", path: "/invoices/2" },
      { label: "PDF", path: "/api/files/pdfs/RE-2026-0002.pdf" },
    ]);
    expect(conversationDetail(db, c.id).pending).toBeNull();
    expect(() => assertCanConfirm(db, c.id, confirm.messageId)).toThrow("bereits beantwortet");
  });

  test("confirm flow: reject → cancelled, the model is told", async () => {
    const c = createConversation(db);
    scripts.push(toolCall("finalize_document", '{"id":2}'));
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Finalisiere" }, emit));
    const confirm = events.at(-1) as Extract<ChatStreamEvent, { type: "confirm" }>;
    scripts.push(text("Okay, nicht finalisiert."));
    const after = await collect((emit) => confirmToolCall(deps, c.id, confirm.messageId, false, emit));
    expect((after[0] as Extract<ChatStreamEvent, { type: "tool_result" }>).message.status).toBe("cancelled");
    expect(calls.map((x) => x.name)).toEqual(["get_document"]);
    expect(requests.at(-1).messages.at(-1)).toEqual({ role: "tool", tool_call_id: "id_finalize_document", content: "Der Nutzer hat abgelehnt; die Aktion wurde nicht ausgeführt." });
  });

  test("malformed arguments go back to the model once; repeated → error", async () => {
    const c = createConversation(db);
    scripts.push(toolCall("list_documents", '{"status":open}'), toolCall("list_documents", '{"status":"open"}'), text("Fertig."));
    const ok = await collect((emit) => sendMessage(deps, c.id, { text: "Offene Rechnungen?" }, emit));
    expect(types(ok)).toEqual(["user_message", "assistant_start", "tool_call", "tool_result", "assistant_start", "tool_call", "tool_result", "assistant_start", "done"]);
    const first = ok.find((e) => e.type === "tool_result") as Extract<ChatStreamEvent, { type: "tool_result" }>;
    expect(first.message.status).toBe("error");
    expect(first.message.content).toContain("kein gültiges JSON");
    expect(calls).toHaveLength(1);

    scripts.push(toolCall("list_documents", "{bad"), toolCall("nope", "{}"));
    const bad = await collect((emit) => sendMessage(deps, c.id, { text: "Nochmal" }, emit));
    expect(bad.at(-1)).toEqual({ type: "error", message: "Das Modell hat wiederholt ungültige Werkzeugaufrufe erzeugt – bitte die Anfrage anders formulieren." });
  });

  test("a failing call repeated unchanged is not executed again; the turn stops on the second repeat", async () => {
    const c = createConversation(db);
    const same = () => toolCall("create_invoice_draft", '{"clientId":1}');
    scripts.push(same(), same(), same());
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Rechnung anlegen" }, emit));
    expect(calls.filter((x) => x.name === "create_invoice_draft")).toHaveLength(1);
    const results = events.filter((e) => e.type === "tool_result") as Extract<ChatStreamEvent, { type: "tool_result" }>[];
    expect(results.map((r) => r.message.toolResult?.summary)).toEqual(["Fehler: Position 1: Bezeichnung fehlt", "Wiederholter fehlerhafter Aufruf", "Wiederholter fehlerhafter Aufruf"]);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  test("model server errors become a German error event, partial text kept", async () => {
    const c = createConversation(db);
    scripts.push({ status: 400, body: JSON.stringify({ error: { message: "the request exceeds the available context size" } }) });
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Hallo" }, emit));
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Die Unterhaltung ist zu lang für das Kontextfenster des Modells – eine neue Unterhaltung beginnen oder die Kontextgröße in den Einstellungen erhöhen",
    });
    // a start failure from the lease/manager
    deps.withModel = async () => {
      throw new LlamaServerError("llama-server konnte das Modell nicht laden: bad magic", "start_failed");
    };
    const failed = await collect((emit) => sendMessage(deps, c.id, { text: "Hallo" }, emit));
    expect(failed.at(-1)).toEqual({ type: "error", message: "llama-server konnte das Modell nicht laden: bad magic" });
  });

  test("abort keeps the partial text and stops", async () => {
    const c = createConversation(db);
    scripts.push({ ...text("Teil eins", " Teil zwei", " Teil drei"), delayMs: 40 });
    const controller = new AbortController();
    const events: ChatStreamEvent[] = [];
    await sendMessage(deps, c.id, { text: "Erzähl" }, (e) => {
      events.push(e);
      if (e.type === "delta") controller.abort();
    }, controller.signal);
    const assistant = conversationDetail(db, c.id).messages.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("Teil eins");
    expect(events.some((e) => e.type === "done")).toBe(false);
    // the conversation is free again
    expect(() => assertCanSend(db, c.id)).not.toThrow();
  });

  test("data questions force a tool call on the first step only", async () => {
    expect(needsData("Hallo")).toBe(false);
    expect(needsData("Danke!")).toBe(false);
    expect(needsData("Wie hoch war mein Umsatz 2026?")).toBe(true);
    const c = createConversation(db);
    scripts.push(toolCall("list_documents", "{}"), text("Eine."));
    await collect((emit) => sendMessage(deps, c.id, { text: "Welche Rechnungen sind offen?" }, emit));
    expect(requests.map((r) => r.tool_choice)).toEqual(["required", "auto"]);
    scripts.push(text("Hallo!"));
    await collect((emit) => sendMessage(deps, c.id, { text: "Hallo" }, emit));
    expect(requests.at(-1).tool_choice).toBe("auto");
  });

  test("reasoning on: enable_thinking per request, thinking event once", async () => {
    updateChatSettings(db, { ...DEFAULT_CHAT_SETTINGS, reasoning: true });
    const c = createConversation(db);
    scripts.push({ chunks: [chunk({ reasoning_content: "Hm" }), chunk({ reasoning_content: "…" }), chunk({ content: "42" }), chunk({}, "stop")] });
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "?" }, emit));
    expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(events.filter((e) => e.type === "thinking")).toHaveLength(1);
    expect(conversationDetail(db, c.id).messages.at(-1)!.content).toBe("42");
  });

  test("an empty answer is retried once without reasoning", async () => {
    updateChatSettings(db, { ...DEFAULT_CHAT_SETTINGS, reasoning: true });
    const c = createConversation(db);
    scripts.push({ chunks: [chunk({ reasoning_content: "Hm" }), chunk({}, "stop")] }, text("Erledigt."));
    await collect((emit) => sendMessage(deps, c.id, { text: "Und?" }, emit));
    expect(requests.map((r) => r.chat_template_kwargs.enable_thinking)).toEqual([true, false]);
    expect(conversationDetail(db, c.id).messages.map((m) => m.content)).toEqual(["Und?", "Erledigt."]);
  });

  test("a degenerate repetition loop is cut and stopped", async () => {
    const block = "Ich habe die Ausgaben geprüft. Offen ist ER-2026-0002.\n\nFalls Sie mehr wissen möchten, sagen Sie es.\n\n";
    expect(repetitionCut("Antwort.\n\n" + block.repeat(4) + block.slice(0, 40))).toBe(`Antwort.\n\n${block.trimEnd()}`);
    expect(repetitionCut("Eine ganz normale Antwort ohne Wiederholung, die etwas länger ist als sechzig Zeichen.")).toBeNull();
    const c = createConversation(db);
    scripts.push(text("Antwort.\n\n", ...Array(40).fill(block)));
    await collect((emit) => sendMessage(deps, c.id, { text: "Hallo" }, emit));
    expect(conversationDetail(db, c.id).messages.at(-1)!.content).toBe(`Antwort.\n\n${block.trimEnd()}`);
  });

  test("stops after MAX_STEPS tool rounds", async () => {
    const c = createConversation(db);
    for (let i = 0; i < 8; i++) scripts.push(toolCall("search", '{"q":"x"}', `s${i}`));
    const events = await collect((emit) => sendMessage(deps, c.id, { text: "Such" }, emit));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(calls).toHaveLength(8);
  });
});

describe("history", () => {
  const row = (id: number, r: Partial<typeof chatMessages.$inferSelect>) =>
    ({ id, conversationId: 1, content: "", toolCalls: null, toolCallId: null, toolName: null, toolResult: null, status: "done", contextPath: null, createdAt: "", updatedAt: "", ...r }) as typeof chatMessages.$inferSelect;
  const turn = (n: number, bulk: string) => [
    row(n * 10, { role: "user", content: `Frage ${n}` }),
    row(n * 10 + 1, { role: "assistant", toolCalls: [{ id: `c${n}`, name: "search", arguments: {} }] }),
    row(n * 10 + 2, { role: "tool", toolCallId: `c${n}`, toolName: "search", content: bulk }),
    row(n * 10 + 3, { role: "assistant", content: `Antwort ${n}` }),
  ];

  test("cuts old tool results first, then drops the oldest turns", () => {
    const rows = [...turn(1, "x".repeat(5000)), ...turn(2, "y".repeat(5000)), ...turn(3, "z".repeat(5000))];
    const all = buildHistory(rows, 100_000);
    expect(all).toHaveLength(12);
    const cut = buildHistory(rows, 5000);
    const tools = cut.filter((m) => m.role === "tool").map((m) => m.content.length);
    expect(tools[0]).toBeLessThan(700); // turn 1 cut
    expect(tools[2]).toBe(5000); // the last turn untouched
    expect(buildHistory(rows, 4500)[0]).toEqual({ role: "user", content: "Frage 1" });
    const dropped = buildHistory(rows, 3000);
    expect(dropped[0]).toEqual({ role: "user", content: "Frage 3" });
  });

  test("skips unanswered tool calls, pending rows and empty assistant messages", () => {
    const rows = [
      row(1, { role: "user", content: "a" }),
      row(2, { role: "assistant", toolCalls: [{ id: "x", name: "search", arguments: {} }] }), // aborted before the result
      row(3, { role: "user", content: "b" }),
      row(4, { role: "assistant", toolCalls: [{ id: "p", name: "finalize_document", arguments: { id: 1 } }] }),
      row(5, { role: "tool", toolCallId: "p", toolName: "finalize_document", status: "pending", content: "…" }),
    ];
    expect(buildHistory(rows, 100_000)).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
  });
});

describe("tools", () => {
  const g = (name: string, group: ChatTool["group"], readOnly = true, destructive = false) => tool(name, readOnly, destructive, group);
  const all = [
    g("search", "core"),
    g("get_dashboard", "core"),
    g("get_document", "core"),
    g("list_documents", "documents"),
    g("create_invoice_draft", "documents", false),
    g("create_reminder", "documents", false, true),
    g("list_clients", "clients"),
    g("create_client", "clients", false),
    g("list_expenses", "expenses"),
    g("list_fixed_costs", "expenses"),
    g("create_expense", "expenses", false),
    g("list_bank_transactions", "bank"),
    g("match_bank_transaction", "bank", false),
    g("get_forecast", "finance"),
    g("get_tax_report", "finance"),
    g("open_in_app", "ui"),
  ];
  const names = (input: Partial<Parameters<typeof selectTools>[1]>) => selectTools(all, { userTexts: [], budgetTokens: 100_000, ...input }).map((t) => t.name);
  const core = ["search", "get_dashboard", "get_document", "open_in_app"];

  test("routing: core + ui always, groups by words, page and recent tools; ordered by group", () => {
    expect(names({ userTexts: ["Zeig mir die offenen Rechnungen"] })).toEqual([...core, "list_documents", "create_invoice_draft", "create_reminder"]);
    expect(names({ userTexts: ["Wie hoch sind meine Fixkosten?"] })).toEqual([...core, "list_expenses", "list_fixed_costs", "create_expense"]);
    expect(names({ userTexts: ["Welche Bankumsätze sind noch nicht zugeordnet?"] })).toEqual([...core, "list_bank_transactions", "match_bank_transaction"]);
    expect(names({ userTexts: ["Was ist meine UVA-Zahllast?"] })).toEqual([...core, "get_forecast", "get_tax_report"]);
    // page context, recent tools and the previous message keep a group for follow-ups
    expect(names({ userTexts: ["ja"], contextPath: "/bank" })).toEqual([...core, "list_bank_transactions", "match_bank_transaction"]);
    expect(names({ userTexts: ["ja, mach"], recentTools: ["create_client"] })).toEqual([...core, "list_clients", "create_client"]);
    expect(names({ userTexts: ["und die zweite?", "Welche Kunden habe ich?"] })).toEqual([...core, "list_clients", "create_client"]);
    // several groups keep the TOOL_GROUPS order regardless of the host order
    expect(names({ userTexts: ["Ausgaben und Rechnungen"] })).toEqual([...core, "list_documents", "create_invoice_draft", "create_reminder", "list_expenses", "list_fixed_costs", "create_expense"]);
  });

  test("routing fallback: nothing matched → read tools of all groups; a generic write verb → everything", () => {
    const fallback = selectToolsDetailed(all, { userTexts: ["Wie lief Oktober?"], budgetTokens: 100_000 });
    expect(fallback.fallback).toBe(true);
    expect(fallback.tools.every((t) => t.readOnly)).toBe(true);
    expect(fallback.tools.map((t) => t.name)).toEqual([...core, "list_documents", "list_clients", "list_expenses", "list_fixed_costs", "list_bank_transactions", "get_forecast", "get_tax_report"]);
    expect(names({ userTexts: ["Leg das bitte an"] })).toHaveLength(all.length);
  });

  test("over the budget: write tools of groups matched only by page/recent use go first, then all non-core writes", () => {
    const input = { userTexts: ["Rechnung anlegen"], contextPath: "/expenses", budgetTokens: toolTokens(all) };
    expect(names(input)).toContain("create_expense");
    const wanted = selectTools(all, input).filter((t) => t.name !== "create_expense");
    const tight = selectTools(all, { ...input, budgetTokens: toolTokens(wanted) + 5 }).map((t) => t.name);
    expect(tight).toContain("create_invoice_draft");
    expect(tight).not.toContain("create_expense");
    const readOnly = selectTools(all, input).filter((t) => t.readOnly);
    expect(selectTools(all, { ...input, budgetTokens: toolTokens(readOnly) + 5 })).toEqual(readOnly);
  });

  test("results: summary line, links (absolute URLs → paths), errors without links", () => {
    expect(extractLinks({ link: "http://localhost:5174/clients/3", name: "Alpen", invoices: [{ number: "RE-1", link: "/invoices/1" }, { link: "/invoices/1" }] })).toEqual([
      { label: "Alpen", path: "/clients/3" },
      { label: "RE-1", path: "/invoices/1" },
    ]);
    expect(toChatToolResult({ isError: true, text: "Fehler: Kunde nicht gefunden", structured: { link: "/x" } })).toEqual({ ok: false, summary: "Fehler: Kunde nicht gefunden", links: [] });
  });

  test("confirmation summaries", async () => {
    const lookup = async (id: number) => (id === 7 ? "Rechnung RE-2026-0007 für Alpen GmbH über € 120,00" : null);
    expect(await confirmSummary("mark_invoice_paid", { id: 7, paidAt: "2026-10-01", expectedAmount: "120,00" }, lookup)).toBe(
      "Rechnung RE-2026-0007 für Alpen GmbH über € 120,00 als bezahlt markieren am 01.10.2026 (Betrag 120,00 €)",
    );
    expect(await confirmSummary("create_reminder", { invoiceId: 9 }, lookup)).toBe(
      "Mahnung zu Rechnung id 9 erstellen – wird sofort finalisiert (Nummer und PDF, unveränderbar)",
    );
    expect(await confirmSummary("convert_offer_to_invoice", { offerId: 3 }, lookup)).toBe(
      "Angebot id 3 in einen Rechnungsentwurf umwandeln (das Angebot wird als angenommen markiert)",
    );
  });
});

describe("llama lease (OCR and chat share one server)", () => {
  const cfg = (o: Partial<LlamaConfig>): LlamaConfig => ({ binary: "/b", model: "/m.gguf", mmproj: null, contextSize: 8192, ...o });
  function fakeManager() {
    let active: LlamaConfig | null = null;
    const log: string[] = [];
    return {
      log,
      activeConfig: () => active,
      async ensure(c: LlamaConfig) {
        if (!active || JSON.stringify(active) !== JSON.stringify(c)) {
          log.push(`start ${c.contextSize}${c.mmproj ? " vision" : ""}`);
          active = c;
        }
        await Bun.sleep(1);
        return endpoint;
      },
    };
  }

  test("serializes use: a chat call waits until the OCR request finished", async () => {
    const m = fakeManager();
    const lease = new LlamaLease(m);
    const order: string[] = [];
    let waited = false;
    const ocr = lease.run("ocr", cfg({}), async () => {
      order.push("ocr start");
      await Bun.sleep(30);
      order.push("ocr end");
    });
    const chat = lease.run("chat", cfg({ contextSize: 32768 }), async () => void order.push("chat"), { onWait: () => (waited = true) });
    expect(lease.busy).toBe(true);
    await Promise.all([ocr, chat]);
    expect(order).toEqual(["ocr start", "ocr end", "chat"]);
    expect(waited).toBe(true);
    expect(lease.busy).toBe(false);
    expect(lease.recentlyUsed("chat")).toBe(true);
    // chat's 32k server serves OCR (8k, text) and vision needs its projector → restart
    await lease.run("ocr", cfg({}), async () => {});
    await lease.run("ocr", cfg({ mmproj: "/p.gguf" }), async () => {});
    expect(m.log).toEqual(["start 8192", "start 32768", "start 8192 vision"]);
  });

  test("a failing request releases the lock", async () => {
    const lease = new LlamaLease(fakeManager());
    await expect(lease.run("chat", cfg({}), async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await lease.run("ocr", cfg({}), async () => "ok")).toBe("ok");
  });
});

// --- the real in-process MCP host (subprocess: src/mcp imports the app with its global DB) -------------------------

describe("in-process MCP host", () => {
  test("lists the MCP tools, confirm set = destructive tools, links are app paths, receipts queue in-process", () => {
    const dir = mkdtempSync(join(tmpdir(), "nesev-chat-host-"));
    try {
      const seed = Bun.spawnSync([process.execPath, "src/mcp/test/seed.ts"], { cwd: PROJECT_ROOT, env: { ...process.env, NESEV_DATA_DIR: dir } });
      if (seed.exitCode !== 0) throw new Error(seed.stderr.toString());
      const script = join(dir, "host.ts");
      writeFileSync(
        script,
        `const { mcpToolHost, needsConfirm, toChatToolResult } = await import(${JSON.stringify(join(PROJECT_ROOT, "src/server/services/chat-tools.ts"))});
const host = await mcpToolHost();
const search = await host.call("search", { query: "Alpen" });
const queue = await host.call("queue_receipt_analysis", { expenseIds: [999999] });
const bad = await host.call("get_document", { id: "x" });
process.stdout.write(JSON.stringify({
  names: host.tools.map((t) => t.name),
  confirm: host.tools.filter(needsConfirm).map((t) => t.name),
  destructive: host.tools.filter((t) => t.destructive).map((t) => t.name),
  search: toChatToolResult(search),
  queue: { isError: queue.isError, text: queue.text },
  bad: bad.isError,
}));
process.exit(0);`,
      );
      const out = Bun.spawnSync([process.execPath, script], { cwd: PROJECT_ROOT, env: { ...process.env, NESEV_DATA_DIR: dir } });
      if (out.exitCode !== 0) throw new Error(out.stderr.toString());
      const r = JSON.parse(out.stdout.toString());
      expect(r.names.length).toBeGreaterThanOrEqual(28);
      // every listed confirm tool is annotated destructive, and every destructive tool needs the click
      for (const name of CONFIRM_TOOLS) expect(r.destructive).toContain(name);
      expect([...r.confirm].sort()).toEqual([...r.destructive].sort());
      expect(r.search.ok).toBe(true);
      expect(r.search.links.length).toBeGreaterThan(0);
      for (const l of r.search.links) expect(l.path.startsWith("/")).toBe(true);
      // served in-process (no 403 "nur im nesev-Server"), the unknown expense is just skipped
      expect(r.queue.isError).toBe(false);
      expect(r.queue.text).toContain("Nichts eingereiht");
      expect(r.bad).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
