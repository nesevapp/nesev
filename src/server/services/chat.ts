import { and, asc, desc, eq, ne } from "drizzle-orm";
import type {
  ChatConversationDetail,
  ChatConversationSummary,
  ChatMessageView,
  ChatSendInput,
  ChatSettings,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolResult,
  ChatUpload,
  ChatUploadsInput,
  ChatUploadsResult,
} from "../../shared/chat";
import { chatUploadsSchema, messageUploads, resultCards } from "../../shared/chat";
import type { DbOrTx } from "../db/client";
import { type ChatConversation, type ChatMessage, chatConversations, chatMessages } from "../db/schema";
import { type LlamaEndpoint, LlamaServerError } from "../lib/llama/server";
import { AbortedError } from "../lib/ocr/run";
import { ChatLlmError, type LlmMessage, type LlmTool, streamChat } from "./chat-llm";
import { claimRetryMessage, detectClaims, honestReply, isWriteRequest, unbackedClaims } from "./chat-claims";
import { checkContextUse } from "./chat-context";
import { knownNumbers, NumberGate, neutralizeNumbers, numberRetryMessage, unknownNumbers } from "./chat-numbers";
import { OFFER_NUDGE, offerInsteadOfAction } from "./chat-offers";
import { checkProvenance } from "./chat-provenance";
import { ChatModelError } from "./chat-settings";
import { confirmLookups, confirmSummary, estimateTokens, needsConfirm, selectToolsDetailed, type ToolHost, toChatToolResult, toLlmTool, toolContent, toolTokens } from "./chat-tools";
import { nudgeUiCall } from "./chat-ui-tools";
import { hasRecentUploads, isTextUser, isUploadRow, uploadsContent, uploadsPreview } from "./chat-uploads";
import { getExpense } from "./expenses";
import { getSettings } from "./settings";

// In-app assistant: conversations (CRUD) and the agent loop. A turn: user message → model call (streamed) → tool
// calls executed in-process (MCP tools) → model again … until the model answers without tools (max MAX_STEPS calls).
// State-changing tools (needsConfirm) are not executed: the tool row is stored "pending", a `confirm` event ends the
// stream, and confirm() executes or cancels it and continues the loop. Everything is persisted as it happens, so a
// reload (or an aborted stream) shows the same conversation; aborting keeps the partial assistant text. In turns that
// ask for a change, texts are held back and a final answer claiming what no tool did is retried (chat-claims.ts).
// Record numbers in answers must come from the conversation (chat-numbers.ts): streamed text stops before an unknown
// one, the answer is retried once, then the number is replaced by neutral wording.

export const MAX_STEPS = 8;
/** malformed tool calls (bad JSON, unknown tool, a failed call repeated unchanged) per turn before giving up; the first one goes back to the model */
const MAX_MALFORMED = 2;
/** tokens kept free for the answer, plus a safety margin for the estimate */
const ANSWER_RESERVE = 2048;
const SAFETY = 1024;
/** tool results older than the last turns are cut to this many characters first when the history is too long */
const OLD_TOOL_CHARS = 600;
const RECENT_TURNS = 2;

/** what the model reads (in later turns) for a declined confirmation */
export const REJECTED_TEXT = "Der Nutzer hat die Aktion abgelehnt; es wurde nichts ausgeführt oder geändert.";

/** a confirmed call whose execution started but never recorded a result (crash / restart while it ran) */
export const INTERRUPTED_TEXT =
  "Die Aktion wurde gestartet, aber ihr Ergebnis wurde nicht gespeichert (Abbruch oder Neustart). Ob sie ausgeführt wurde, ist unbekannt – bitte in der App prüfen, nicht einfach wiederholen.";

/** what stays as it was, per declined tool (the reply is fixed text, no model call) */
const REJECTED_EFFECT: Record<string, string> = {
  finalize_document: "der Entwurf bleibt unverändert und wird nicht finalisiert",
  mark_document_sent: "der Beleg bleibt als nicht versendet markiert",
  mark_invoice_paid: "der Zahlungsstatus der Rechnung bleibt unverändert",
  convert_offer_to_invoice: "das Angebot bleibt, wie es ist – es wurde keine Rechnung erstellt",
  create_credit_note: "es wurde keine Gutschrift angelegt",
  create_reminder: "es wurde keine Mahnung erstellt",
  match_bank_transaction: "die Buchung bleibt unzugeordnet",
  unmatch_bank_transaction: "die Zuordnung bleibt bestehen",
  set_bank_transaction_ignored: "die Buchung bleibt, wie sie ist",
  set_recurring_invoice_active: "die Serienrechnung bleibt, wie sie ist",
  generate_recurring_invoice: "es wurde keine Rechnung erstellt",
  update_client: "die Kundendaten bleiben unverändert",
  update_document_draft: "der Entwurf bleibt unverändert",
  update_expense: "die Ausgabe bleibt unverändert",
  mark_expense_paid: "der Zahlungsstatus der Ausgabe bleibt unverändert",
  apply_receipt_analysis: "die Ausgabe bleibt unverändert, die Erkennung wurde nicht übernommen",
  link_expense_to_fixed_cost: "die Ausgabe bleibt ohne neue Fixkosten-Verknüpfung",
};

/** "Alles klar, die Kundendaten bleiben unverändert. Soll ich etwas anders machen?" */
export function rejectionReply(toolName: string): string {
  return `Alles klar, ${REJECTED_EFFECT[toolName] ?? "ich habe nichts geändert"}. Soll ich etwas anders machen?`;
}

export class ChatConflictError extends Error {}
export class ChatNotFoundError extends Error {}

export type Emit = (event: ChatStreamEvent) => Promise<void> | void;

export interface ChatDeps {
  db: DbOrTx;
  host: () => Promise<ToolHost>;
  settings: () => ChatSettings;
  /**
   * Runs one model call with the llama-server (under the lease shared with receipt recognition). `onStatus` gets
   * German progress text while the server starts or another user holds it.
   */
  withModel: <T>(fn: (endpoint: LlamaEndpoint) => Promise<T>, o: { signal?: AbortSignal; onStatus: (text: string) => void }) => Promise<T>;
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  /** one line per model call (tokens, latency) */
  log?: (line: string) => void;
}

// --- views ------------------------------------------------------------------------------------------------------

export function messageView(m: ChatMessage): ChatMessageView {
  const uploads = messageUploads(m.role, m.toolResult);
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: Array.isArray(m.toolCalls) ? (m.toolCalls as ChatToolCall[]) : null,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    toolResult: uploads ? null : ((m.toolResult as ChatToolResult | null) ?? null),
    status: m.status,
    contextPath: m.contextPath,
    uploads,
    createdAt: m.createdAt,
  };
}

function lastPreview(db: DbOrTx, conversationId: number): string {
  const rows = db
    .select({ role: chatMessages.role, content: chatMessages.content, toolResult: chatMessages.toolResult })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), ne(chatMessages.role, "tool"), ne(chatMessages.content, "")))
    .orderBy(desc(chatMessages.id))
    .limit(1)
    .all();
  const uploads = rows[0] ? messageUploads(rows[0].role, rows[0].toolResult) : null;
  const text = uploads ? uploadsPreview(uploads) : (rows[0]?.content ?? "");
  // plain text: no Markdown emphasis, list markers, headings, code ticks; links keep their label
  const flat = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.|#{1,6})\s+/gm, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

function summary(db: DbOrTx, c: ChatConversation): ChatConversationSummary {
  return { id: c.id, title: c.title || "Neue Unterhaltung", createdAt: c.createdAt, updatedAt: c.updatedAt, preview: lastPreview(db, c.id) };
}

function requireConversation(db: DbOrTx, id: number): ChatConversation {
  const c = db.select().from(chatConversations).where(eq(chatConversations.id, id)).get();
  if (!c) throw new ChatNotFoundError("Unterhaltung nicht gefunden");
  return c;
}

function touch(db: DbOrTx, id: number): ChatConversation {
  return db.update(chatConversations).set({ updatedAt: new Date().toISOString() }).where(eq(chatConversations.id, id)).returning().get()!;
}

// --- conversations ------------------------------------------------------------------------------------------------

export function listConversations(db: DbOrTx): ChatConversationSummary[] {
  return db
    .select()
    .from(chatConversations)
    .orderBy(desc(chatConversations.updatedAt), desc(chatConversations.id))
    .all()
    .map((c) => summary(db, c));
}

export function createConversation(db: DbOrTx): ChatConversationSummary {
  return summary(db, db.insert(chatConversations).values({}).returning().get());
}

export function renameConversation(db: DbOrTx, id: number, title: string): ChatConversationSummary {
  requireConversation(db, id);
  return summary(db, db.update(chatConversations).set({ title: title.trim().slice(0, 120) }).where(eq(chatConversations.id, id)).returning().get()!);
}

export function deleteConversation(db: DbOrTx, id: number): void {
  requireConversation(db, id);
  db.delete(chatConversations).where(eq(chatConversations.id, id)).run();
}

function messages(db: DbOrTx, conversationId: number): ChatMessage[] {
  return db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).orderBy(asc(chatMessages.id)).all();
}

function pendingRow(rows: ChatMessage[]): ChatMessage | null {
  return rows.findLast((m) => m.role === "tool" && m.status === "pending") ?? null;
}

/** the assistant call a tool row answers */
function callFor(rows: ChatMessage[], toolRow: ChatMessage): ChatToolCall | null {
  for (let i = rows.indexOf(toolRow) - 1; i >= 0; i--) {
    const calls = rows[i]!.toolCalls as ChatToolCall[] | null;
    const hit = rows[i]!.role === "assistant" && Array.isArray(calls) ? calls.find((c) => c.id === toolRow.toolCallId) : undefined;
    if (hit) return hit;
  }
  return null;
}

export function conversationDetail(db: DbOrTx, id: number): ChatConversationDetail {
  const c = requireConversation(db, id);
  const rows = messages(db, id);
  const p = pendingRow(rows);
  const call = p && callFor(rows, p);
  return {
    ...summary(db, c),
    messages: rows.map(messageView),
    pending: p && call ? { messageId: p.id, toolCall: call, summary: p.content } : null,
  };
}

/** "Welche Rechnungen sind diesen Monat offen?" → first ~6 words, ≤ 60 chars */
export function autoTitle(text: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  let title = words.slice(0, 6).join(" ");
  if (title.length > 60) title = `${title.slice(0, 59).trimEnd()}…`;
  else if (words.length > 6) title += " …";
  return title;
}

// --- busy / pending guards --------------------------------------------------------------------------------------

const ACTIVE_KEY = Symbol.for("nesev.chatActive");
/** conversations with a running turn (one stream per conversation) */
function active(): Set<number> {
  const g = globalThis as { [ACTIVE_KEY]?: Set<number> };
  g[ACTIVE_KEY] ??= new Set();
  return g[ACTIVE_KEY];
}

/** Throws ChatNotFoundError / ChatConflictError (German) before a stream is opened. */
export function assertCanSend(db: DbOrTx, id: number): void {
  requireConversation(db, id);
  if (active().has(id)) throw new ChatConflictError("Der Assistent antwortet in dieser Unterhaltung gerade noch");
  if (pendingRow(messages(db, id))) {
    throw new ChatConflictError("Bitte zuerst die offene Aktion bestätigen oder ablehnen");
  }
}

export function assertCanConfirm(db: DbOrTx, id: number, messageId: number): void {
  requireConversation(db, id);
  if (active().has(id)) throw new ChatConflictError("Der Assistent antwortet in dieser Unterhaltung gerade noch");
  const row = db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.conversationId, id)))
    .get();
  if (!row || row.role !== "tool") throw new ChatNotFoundError("Aktion nicht gefunden");
  if (row.status !== "pending") throw new ChatConflictError("Diese Aktion wurde bereits beantwortet");
}

// --- prompt & history ---------------------------------------------------------------------------------------------

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

export function systemPrompt(companyName: string, today: Date): string {
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const de = iso.split("-").reverse().join(".");
  return `Du bist der Assistent in nesev, der lokalen Rechnungs- und Buchhaltungs-App${companyName ? ` von ${companyName}` : ""} (österreichisches Einzelunternehmen, EUR).
Heute ist ${WEEKDAYS[today.getDay()]}, der ${de} (${iso}).

Regeln:
- Antworte immer auf Deutsch, kurz und sachlich. Beträge als € 1.234,56, Datumsangaben als ${de}.
- Zahlen, Namen, Nummern und Status nennst du nur aus Werkzeug-Ergebnissen dieser Unterhaltung, nie aus dem Gedächtnis. Fehlen sie, ruf zuerst das passende Werkzeug auf: search (Ids zu Namen, Nummern, Beträgen), get_dashboard (Umsatz, Ausgaben, Ergebnis), get_tax_report (UVA, ZM, EAR), list_documents, get_document, list_expenses, get_forecast …
- Kunden gibst du per clientName an oder mit der clientId aus einem Werkzeug-Ergebnis dieser Unterhaltung – rate nie eine id.
- Rechnungen, Angebote und Gutschriften entstehen als Entwurf. Entwürfe haben noch keine Nummer (erst beim Finalisieren). Zeig nach dem Anlegen kurz den Entwurf (Kunde, Positionen, Netto/USt/Brutto). Preise in Positionen sind netto, Einheiten z. B. Std., Stk., Pauschal.
- Finalisieren, als bezahlt/versendet markieren, Angebote umwandeln, Gutschriften und Mahnungen bestätigt der Nutzer per Klick in der App: Wenn er es will, ruf das Werkzeug direkt auf, statt im Text nachzufragen.
- Meldet ein Werkzeug „Fehler: …“, korrigiere die Argumente laut Meldung. Gelingt es nicht, sag dem Nutzer, was fehlt. Behaupte nie, etwas sei angelegt oder geändert, wenn kein Werkzeug-Ergebnis es bestätigt.
- Steuerzahlen (UVA, ZM, EAR, AfA) sind eine Hilfe, keine Steuerberatung – sag das dazu.
- Löschen, Einstellungen, Bankimport und E-Mail-Versand gehen nur in der Web-App; verweise darauf.
- Verlinke Datensätze als Markdown mit dem Pfad aus dem Werkzeug-Ergebnis, z. B. [RE-2026-0004](/invoices/12).
- „Öffne …“ / „geh zu …“ → open_in_app (Seite oder Datensatz), „PDF zeigen“ → open_pdf, „herunterladen“ → download_pdf – mit der id aus einem Werkzeug-Ergebnis (sonst zuerst search). Danach nur kurz bestätigen; Nummern nur aus Werkzeug-Ergebnissen (Entwürfe haben keine).
- Tabellen, Diagramme und Belege aus Werkzeug-Ergebnissen sieht der Nutzer direkt im Chat. Wiederhole sie nicht als Liste, sondern nenne in 1–3 Sätzen das Wesentliche (Summe, Auffälliges, nächster Schritt).
- Beginnt eine Nutzernachricht mit „(Kontext: …)“, steht dort, was der Nutzer gerade in der App sieht. Diesen Datensatz meint er nur mit „diese/dieses/davon/hier/die aktuelle“. Nennt er einen Kunden, eine Nummer oder „den Entwurf für X“, such genau diesen (search) – nimm dann nie die id aus dem Kontext. Schreib selbst keine solche Kontext-Zeile.`;
}

/**
 * The prompt prefix every request starts with: the system prompt and the always-offered core + ui tools (selectTools
 * puts them first, in this order). The warm-up (services/chat-warm.ts) has llama-server cache it.
 */
export async function warmupPrompt(deps: Pick<ChatDeps, "db" | "host" | "settings" | "now">): Promise<{ messages: LlmMessage[]; tools: LlmTool[]; reasoning: boolean }> {
  const host = await deps.host();
  const system = systemPrompt(getSettings(deps.db).companyName, deps.now?.() ?? new Date());
  const always = host.tools.filter((t) => t.group === "core" || t.group === "ui");
  const tools = selectToolsDetailed(always, { userTexts: [], budgetTokens: Number.POSITIVE_INFINITY }).tools;
  return { messages: [{ role: "system", content: system }, { role: "user", content: "Hallo" }], tools: tools.map(toLlmTool), reasoning: deps.settings().reasoning };
}

const PAGE_TYPES: [RegExp, string][] = [
  [/^\/invoices\/(\d+)/, "Rechnung"],
  [/^\/offers\/(\d+)/, "Angebot"],
  [/^\/credit-notes\/(\d+)/, "Gutschrift"],
  [/^\/clients\/(\d+)/, "Kunde"],
  [/^\/expenses\/(\d+)/, "Ausgabe"],
  [/^\/reminders\/(\d+)/, "Mahnung"],
  [/^\/recurring\/(\d+)/, "Serienrechnung"],
  [/^\/assets\/(\d+)/, "Anlage"],
  [/^\/fixed-costs\/(\d+)/, "Fixkosten-Eintrag"],
];
const PAGE_LISTS: [RegExp, string][] = [
  [/^\/invoices/, "die Rechnungsliste"],
  [/^\/offers/, "die Angebotsliste"],
  [/^\/credit-notes/, "die Gutschriften"],
  [/^\/clients/, "die Kundenliste"],
  [/^\/expenses/, "die Ausgaben"],
  [/^\/reminders/, "das Mahnwesen"],
  [/^\/recurring/, "die Serienrechnungen"],
  [/^\/assets/, "das Anlagenverzeichnis"],
  [/^\/fixed-costs/, "die Fixkosten"],
  [/^\/articles/, "die Artikel"],
  [/^\/forecast/, "die Zahlungsprognose"],
  [/^\/tax/, "die Steuer-Auswertungen"],
  [/^\/bank/, "die Bankumsätze"],
  [/^\/settings/, "die Einstellungen"],
  [/^\/?$/, "das Dashboard"],
];

/** "/invoices/12" → "Der Nutzer sieht gerade Rechnung id 12 („Rechnung RE-2026-0004“)." */
export function describePage(path: string, title?: string): string {
  const t = title?.trim() ? ` („${title.trim()}“)` : "";
  for (const [re, label] of PAGE_TYPES) {
    const m = re.exec(path);
    if (m) return `Der Nutzer sieht gerade ${label} id ${m[1]}${t}.`;
  }
  for (const [re, label] of PAGE_LISTS) if (re.test(path)) return `Der Nutzer sieht gerade ${label}${t}.`;
  return `Der Nutzer ist gerade auf ${path}${t}.`;
}

function userContent(m: ChatMessage, title?: string): string {
  return m.contextPath ? `(Kontext: ${describePage(m.contextPath, title)} Gilt nur für „diese/hier/davon“.)\n${m.content}` : m.content;
}

/**
 * History as OpenAI messages, capped to `budget` tokens: whole turns (user message + what followed) are dropped
 * from the oldest; before that, tool results older than the last RECENT_TURNS turns are cut. Tool calls without a
 * result (aborted turn) and empty assistant messages are left out so the template sees a consistent history.
 */
export function buildHistory(rows: ChatMessage[], budget: number, currentTitle?: string): LlmMessage[] {
  const answered = new Set(rows.filter((r) => r.role === "tool" && r.status !== "pending").map((r) => r.toolCallId));
  const turns: LlmMessage[][] = [];
  const lastUser = rows.findLast(isTextUser);
  const issued = new Set<string>();
  /** receipts uploaded since the last user message: their lines go in front of the next one (chat-uploads.ts) */
  let uploaded: string[] = [];
  for (const r of rows) {
    if (isUploadRow(r)) {
      uploaded.push(r.content);
      continue;
    }
    if (r.role === "user") {
      const content = userContent(r, r === lastUser ? currentTitle : undefined);
      turns.push([{ role: "user", content: uploaded.length ? `${uploaded.join("\n")}\n${content}` : content }]);
      uploaded = [];
      continue;
    }
    if (!turns.length) turns.push([]);
    const turn = turns.at(-1)!;
    if (r.role === "assistant") {
      const calls = ((r.toolCalls as ChatToolCall[] | null) ?? []).filter((c) => answered.has(c.id));
      if (!r.content.trim() && !calls.length) continue;
      for (const c of calls) issued.add(c.id);
      turn.push({
        role: "assistant",
        content: r.content,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
      });
    } else if (r.status !== "pending" && r.toolCallId && issued.has(r.toolCallId)) {
      turn.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
    }
  }
  const size = (ms: LlmMessage[][]) => estimateTokens(JSON.stringify(ms));
  const cut = (limit: number, upto: number) => {
    for (const turn of turns.slice(0, upto)) {
      for (const m of turn) if (m.role === "tool" && m.content.length > limit) m.content = `${m.content.slice(0, limit)}\n… (gekürzt)`;
    }
  };
  if (size(turns) > budget) cut(OLD_TOOL_CHARS, Math.max(0, turns.length - RECENT_TURNS));
  while (turns.length > 1 && size(turns) > budget) turns.shift();
  if (size(turns) > budget) cut(1500, turns.length);
  return turns.flat();
}

// --- the loop ---------------------------------------------------------------------------------------------------

interface TurnState {
  conversationId: number;
  contextTitle?: string;
  /** malformed or repeated failing calls in this turn */
  malformed: number;
  /** name + arguments of calls that failed in this turn (a small model tends to repeat them unchanged) */
  failed?: Set<string>;
  /** context records whose blind use was already flagged in this turn (chat-context.ts) */
  contextWarned?: Set<string>;
}

function insertMessage(db: DbOrTx, values: typeof chatMessages.$inferInsert): ChatMessage {
  return db.insert(chatMessages).values(values).returning().get();
}

function updateMessage(db: DbOrTx, id: number, values: Partial<typeof chatMessages.$inferInsert>): ChatMessage {
  return db.update(chatMessages).set(values).where(eq(chatMessages.id, id)).returning().get()!;
}

/** Sends a user message and runs the loop. assertCanSend() must have passed. */
export async function sendMessage(deps: ChatDeps, conversationId: number, input: ChatSendInput, emit: Emit, signal?: AbortSignal) {
  await exclusive(conversationId, emit, async () => {
    const { db } = deps;
    const conv = requireConversation(db, conversationId);
    if (!conv.title) db.update(chatConversations).set({ title: autoTitle(input.text) }).where(eq(chatConversations.id, conversationId)).run();
    const user = insertMessage(db, { conversationId, role: "user", content: input.text, contextPath: input.context?.path || null });
    await emit({ type: "user_message", message: messageView(user) });
    await runLoop(deps, { conversationId, contextTitle: input.context?.title, malformed: 0 }, emit, signal);
  });
}

/** Executes (approve) or cancels the pending tool call, then continues the loop. assertCanConfirm() must have passed. */
export async function confirmToolCall(deps: ChatDeps, conversationId: number, messageId: number, approve: boolean, emit: Emit, signal?: AbortSignal) {
  await exclusive(conversationId, emit, async () => {
    const { db } = deps;
    const rows = messages(db, conversationId);
    const row = rows.find((r) => r.id === messageId && r.status === "pending");
    const call = row && callFor(rows, row);
    if (!row || !call) throw new ChatNotFoundError("Aktion nicht gefunden");
    let done: ChatMessage;
    if (approve) {
      const host = await deps.host();
      // consumed before it runs (status no longer "pending"): a crash or restart during host.call, or a second
      // confirm, can't execute it twice; if the process dies here, the row says the outcome is unknown
      const claimed = db
        .update(chatMessages)
        .set({ content: INTERRUPTED_TEXT, status: "error", toolResult: { ok: false, summary: "Ausführung unterbrochen – Ergebnis bitte prüfen", links: [] } satisfies ChatToolResult })
        .where(and(eq(chatMessages.id, row.id), eq(chatMessages.status, "pending")))
        .returning()
        .get();
      if (!claimed) throw new ChatConflictError("Diese Aktion wurde bereits beantwortet");
      let outcome: Awaited<ReturnType<ToolHost["call"]>>;
      try {
        outcome = await host.call(call.name, call.arguments);
      } catch (err) {
        outcome = { isError: true, text: `Fehler: ${(err as Error).message}`, structured: null };
      }
      const result = toChatToolResult(outcome, call.name);
      done = updateMessage(db, row.id, { content: toolContent(outcome, result), toolResult: result, status: outcome.isError ? "error" : "done" });
    } else {
      done = updateMessage(db, row.id, {
        content: REJECTED_TEXT,
        toolResult: { ok: false, summary: "Abgelehnt", links: [] } satisfies ChatToolResult,
        status: "cancelled",
      });
    }
    await emit({ type: "tool_result", message: messageView(done) });
    if (signal?.aborted) return;
    if (!approve) {
      // no model call: a fixed acknowledgement (models tended to speculate or ask to "confirm in the app")
      const text = rejectionReply(call.name);
      const reply = insertMessage(db, { conversationId, role: "assistant", content: text });
      await emit({ type: "assistant_start", messageId: reply.id });
      await emit({ type: "delta", messageId: reply.id, text });
      await emit({ type: "done", conversation: summary(db, touch(db, conversationId)) });
      return;
    }
    await runLoop(deps, { conversationId, malformed: 0 }, emit, signal);
  });
}

/**
 * Records receipts uploaded in the chat (the drafts were created by POST /api/expenses/drafts): one user message with
 * the uploads as structured data and, as content, the lines the model reads with the next message (chat-uploads.ts).
 * Like a message, not while a reply runs or a confirmation waits (ChatConflictError). Unknown expense ids → 404.
 */
export function recordUploads(db: DbOrTx, conversationId: number, input: ChatUploadsInput): ChatUploadsResult {
  const { expenseIds, failures } = chatUploadsSchema.parse(input);
  assertCanSend(db, conversationId);
  const found = [...new Set(expenseIds)].map((id) => {
    const e = getExpense(db, id);
    if (!e) throw new ChatNotFoundError(`Ausgabe id ${id} nicht gefunden`);
    return e;
  });
  const uploads: ChatUpload[] = found.map((e) => ({ expenseId: e.id, number: e.number, fileName: e.attachmentName || "Beleg", attachmentPath: e.attachmentPath }));
  const content = uploadsContent(found.map((e, i) => ({ ...uploads[i]!, incomplete: e.incomplete })));
  const row = insertMessage(db, { conversationId, role: "user", content, toolResult: { kind: "uploads", uploads, failures } });
  return { message: messageView(row), conversation: summary(db, touch(db, conversationId)) };
}

async function exclusive(conversationId: number, emit: Emit, fn: () => Promise<void>) {
  if (active().has(conversationId)) {
    await emit({ type: "error", message: "Der Assistent antwortet in dieser Unterhaltung gerade noch" });
    return;
  }
  active().add(conversationId);
  try {
    await fn();
  } catch (err) {
    if (err instanceof AbortedError || (err as Error)?.name === "AbortError") return; // client gone
    if (!(err instanceof LlamaServerError || err instanceof ChatLlmError || err instanceof ChatModelError)) console.error("[chat]", err);
    await emit({ type: "error", message: errorMessage(err) });
  } finally {
    active().delete(conversationId);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Unbekannter Fehler im Assistenten";
}

function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The user asks about their data (numbers, records, status) or wants something done: the first model call of the
 * turn must use a tool. Small models otherwise answer such questions from thin air (measured with Qwen3.5-4B:
 * "Wie hoch war mein Umsatz …" got invented figures without a single tool call). Greetings, thanks and questions
 * about the app itself stay free.
 */
export function needsData(text: string): boolean {
  const t = text.toLowerCase();
  if (/^\s*(hallo|hi|hey|servus|grüß|danke|ok|okay|super|passt|alles klar|wer bist|was kannst)/.test(t) && t.length < 40) return false;
  return /\d|€|rechnung|angebot|gutschrift|mahnung|kunde|kundin|ausgabe|beleg|umsatz|gewinn|ergebnis|uva|zm\b|ear\b|steuer|ust|afa|anlage|fixkost|prognose|offen|bezahlt|überfällig|fällig|summe|betrag|wie viel|wieviel|welche|zeig|such|finde|liste|anleg|erstell|finalisier|markier|artikel|öffne|oeffne|pdf|herunterlad|download|vorschau|bank|konto|buchung|zuordn|änder|aender|e-mail|email|adresse|verknüpf|übernimm|übernehm|serienrechnung|wie lief|wie läuft|wie steh|monat|quartal|jänner|januar|februar|märz|april|mai\b|juni|juli|august|september|oktober|november|dezember/.test(t);
}

/** paths of drafts shown in this conversation (a link labelled with an invented number becomes "Entwurf") */
function draftPaths(rows: ChatMessage[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    for (const card of r.role === "tool" ? resultCards(r.toolResult as ChatToolResult | null) : []) {
      if (card.kind === "document" && card.statusKey === "draft") out.add(card.path);
    }
  }
  return out;
}

let callSeq = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`;

async function runLoop(deps: ChatDeps, state: TurnState, emit: Emit, signal?: AbortSignal): Promise<void> {
  const { db } = deps;
  const settings = deps.settings();
  const host = await deps.host();
  const company = getSettings(db).companyName;
  const system = systemPrompt(company, deps.now?.() ?? new Date());

  /** an empty answer (with reasoning: thinking only) is retried once without reasoning */
  let reasoning = settings.reasoning;
  let emptyRetried = false;
  /** a forced first call answered with text instead of a tool call (Qwen3.5-4B ignores "required" now and then) is retried once */
  let forcedRetried = false;
  /** the discarded answer plus a correction for the next call (claim guard, offer nudge) */
  let correction: LlmMessage[] | null = null;
  /** a final answer claiming a change no tool made (chat-claims.ts) is retried once, the next one replaced */
  let claimRetried = false;
  /** a final answer offering the requested action instead of calling the tool (chat-offers.ts) is retried once */
  let offerNudged = false;
  /** a final answer with a record number no tool result showed (chat-numbers.ts) is retried once, then neutralized */
  let numberRetried = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return;
    const rows = messages(db, state.conversationId);
    const userTexts = rows.filter(isTextUser).map((r) => r.content).reverse();
    const lastUser = rows.findLast(isTextUser);
    const recentTools = rows.slice(-12).filter((r) => r.role === "tool" && r.toolName).map((r) => r.toolName!);
    const reserve = reasoning ? 8192 : ANSWER_RESERVE;
    const available = settings.contextSize - estimateTokens(system) - reserve - SAFETY;
    // tools may take up to 60 % of what is left
    const selection = selectToolsDetailed(host.tools, {
      userTexts,
      contextPath: lastUser?.contextPath,
      recentTools,
      uploads: hasRecentUploads(rows),
      budgetTokens: Math.floor(available * 0.6),
    });
    const tools = selection.tools;
    const history = buildHistory(rows, available - toolTokens(tools), state.contextTitle);
    const turnRows = lastUser ? rows.slice(rows.indexOf(lastUser) + 1) : [];

    // first call after a new user message (not after a confirmation, which already ran a tool); its text is held
    // back until it's clear the model called a tool
    const forceTool = rows.at(-1)?.role === "user" && needsData(rows.at(-1)!.content);
    const forcedHold = forceTool && !forcedRetried;
    // the user asked for a change: every text is held back, a final answer until its claims are checked
    const previousAnswer = lastUser ? rows.slice(0, rows.indexOf(lastUser)).findLast((r) => r.role === "assistant" && r.content.trim())?.content : null;
    const writeTurn = !!lastUser && isWriteRequest(lastUser.content, previousAnswer);
    const holdText = forcedHold || writeTurn;
    const extra: LlmMessage[] = correction ?? [];
    correction = null;
    const known = knownNumbers(rows, [state.contextTitle]);
    const gate = new NumberGate(known);
    let assistant: ChatMessage | null = null;
    let thinkingSent = false;
    const result = await deps.withModel(
      async (endpoint) => {
        assistant = insertMessage(db, { conversationId: state.conversationId, role: "assistant", content: "" });
        const messageId = assistant.id;
        await emit({ type: "assistant_start", messageId });
        let pendingText = "";
        const out = await streamChat({
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          model: endpoint.model,
          messages: [{ role: "system", content: system }, ...history, ...extra],
          tools: tools.map(toLlmTool),
          reasoning,
          toolChoice: forceTool ? "required" : "auto",
          signal,
          fetchFn: deps.fetchFn,
          onDelta: (text) => {
            pendingText += text;
            if (holdText) return;
            const shown = gate.push(text);
            if (shown) void emit({ type: "delta", messageId, text: shown });
          },
          onThinking: () => {
            if (thinkingSent) return;
            thinkingSent = true;
            void emit({ type: "thinking", messageId });
          },
        }).catch((err) => {
          // keep what arrived before the error
          if (pendingText) updateMessage(db, messageId, { content: pendingText, status: "error" });
          else updateMessage(db, messageId, { status: "error" });
          throw err;
        });
        deps.log?.(
          `[chat] conv ${state.conversationId} step ${step + 1}: ${tools.length} tools (${selection.groups.join("+")}${selection.fallback ? " +read" : ""}), prompt ${out.promptTokens ?? "?"} tok, ` +
            `first token ${Math.round(out.firstTokenMs ?? 0)} ms, total ${Math.round(out.totalMs)} ms${endpoint.startMs ? `, server start ${endpoint.startMs} ms` : ""}`,
        );
        if (out.finishReason === "repetition") deps.log?.(`[chat] conv ${state.conversationId}: repetition loop cut`);
        return out;
      },
      { signal, onStatus: (text) => void emit({ type: "status", text }) },
    );
    const messageId = (assistant as ChatMessage | null)?.id;
    if (!messageId) return;

    if (result.aborted) {
      updateMessage(db, messageId, { content: result.content });
      return;
    }
    const calls: ChatToolCall[] = [];
    const malformed = new Map<string, string>();
    for (const raw of result.toolCalls) {
      const id = raw.id || newCallId();
      const args = parseArgs(raw.arguments);
      if (!args) malformed.set(id, raw.arguments);
      const nudged = nudgeUiCall(raw.name, args ?? {}, lastUser?.content ?? "");
      if (nudged.name !== raw.name) deps.log?.(`[chat] conv ${state.conversationId}: nudged ${raw.name} → ${nudged.name}`);
      calls.push({ id, ...nudged });
    }
    if (forcedHold && !calls.length) {
      forcedRetried = true;
      deps.log?.(`[chat] conv ${state.conversationId}: forced tool call answered with text – retrying once`);
      db.delete(chatMessages).where(eq(chatMessages.id, messageId)).run();
      continue;
    }
    let content: string = result.content;
    if (writeTurn && !calls.length && content.trim()) {
      const unbacked = unbackedClaims(detectClaims(content), turnRows);
      if (unbacked.length) {
        const words = [...new Set(unbacked.map((c) => c.word))].join(", ");
        if (!claimRetried) {
          claimRetried = true;
          deps.log?.(`[chat] conv ${state.conversationId}: claim-guard „${words}“ without a matching tool call – retrying once`);
          db.delete(chatMessages).where(eq(chatMessages.id, messageId)).run();
          correction = [
            { role: "assistant", content },
            { role: "user", content: claimRetryMessage(unbacked) },
          ];
          continue;
        }
        deps.log?.(`[chat] conv ${state.conversationId}: claim-guard „${words}“ again – fixed reply`);
        content = honestReply(unbacked);
      } else if (!offerNudged) {
        const rule = offerInsteadOfAction(content, lastUser!.content, turnRows);
        if (rule) {
          offerNudged = true;
          deps.log?.(`[chat] conv ${state.conversationId}: offer-nudge ${rule.tool} offered instead of called – retrying once`);
          db.delete(chatMessages).where(eq(chatMessages.id, messageId)).run();
          correction = [
            { role: "assistant", content },
            { role: "user", content: OFFER_NUDGE },
          ];
          continue;
        }
      }
    }
    const unknownNums = unknownNumbers(content, known);
    if (unknownNums.length && !calls.length && !numberRetried) {
      numberRetried = true;
      deps.log?.(`[chat] conv ${state.conversationId}: number-guard ${unknownNums.join(", ")} not in any tool result – retrying once`);
      if (!holdText) await emit({ type: "discard", messageId });
      db.delete(chatMessages).where(eq(chatMessages.id, messageId)).run();
      correction = [
        { role: "assistant", content },
        { role: "user", content: numberRetryMessage(unknownNums) },
      ];
      continue;
    }
    if (unknownNums.length) {
      deps.log?.(`[chat] conv ${state.conversationId}: number-guard ${unknownNums.join(", ")} – replaced`);
      content = neutralizeNumbers(content, known, draftPaths(rows));
    }
    if (holdText && content) await emit({ type: "delta", messageId, text: content });
    else if (!holdText && (unknownNums.length || gate.blocked)) await emit({ type: "replace", messageId, text: content });
    else if (!holdText) {
      const rest = gate.flush();
      if (rest) await emit({ type: "delta", messageId, text: rest });
    }
    updateMessage(db, messageId, { content, toolCalls: calls.length ? calls : null });
    for (const c of calls) await emit({ type: "tool_call", messageId, toolCall: c });

    if (!calls.length && !result.content.trim() && !emptyRetried) {
      emptyRetried = true;
      reasoning = false;
      db.delete(chatMessages).where(eq(chatMessages.id, messageId)).run();
      continue;
    }
    if (!calls.length) {
      if (!result.content.trim()) updateMessage(db, messageId, { content: "(Das Modell hat keine Antwort geliefert – bitte die Frage erneut stellen.)", status: "error" });
      await emit({ type: "done", conversation: summary(db, touch(db, state.conversationId)) });
      return;
    }

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const tool = host.tools.find((t) => t.name === call.name);
      const base = { conversationId: state.conversationId, role: "tool" as const, toolCallId: call.id, toolName: call.name };
      if (!tool || malformed.has(call.id)) {
        state.malformed++;
        const text = !tool
          ? `Fehler: Unbekanntes Werkzeug „${call.name}“. Verfügbar: ${tools.map((t) => t.name).join(", ")}.`
          : `Fehler: Die Argumente sind kein gültiges JSON-Objekt (${malformed.get(call.id)!.slice(0, 200)}). Bitte den Aufruf mit korrektem JSON wiederholen.`;
        const row = insertMessage(db, { ...base, content: text, status: "error", toolResult: { ok: false, summary: text.split(". ")[0]!, links: [] } satisfies ChatToolResult });
        await emit({ type: "tool_result", message: messageView(row) });
        continue;
      }
      const contextError = await checkContextUse(call, { contextPath: lastUser?.contextPath, userText: lastUser?.content ?? "", host, warned: (state.contextWarned ??= new Set()) });
      if (contextError) {
        const row = insertMessage(db, { ...base, content: contextError, status: "error", toolResult: { ok: false, summary: "Anderer Datensatz als auf der Seite gemeint", links: [] } satisfies ChatToolResult });
        await emit({ type: "tool_result", message: messageView(row) });
        continue;
      }
      const provenanceError = await checkProvenance(call, { rows: messages(db, state.conversationId), host });
      if (provenanceError) {
        // counts like a malformed call: a second guessed id in the same turn ends it instead of looping
        state.malformed++;
        deps.log?.(`[chat] conv ${state.conversationId}: ${call.name} with ids not looked up – rejected`);
        const row = insertMessage(db, { ...base, content: provenanceError, status: "error", toolResult: { ok: false, summary: "Id nicht nachgeschlagen – zuerst suchen", links: [] } satisfies ChatToolResult });
        await emit({ type: "tool_result", message: messageView(row) });
        continue;
      }
      if (needsConfirm(tool)) {
        const text = await confirmSummary(call.name, call.arguments, confirmLookups(host));
        const row = insertMessage(db, { ...base, content: text, status: "pending" });
        // later calls of the same message wait: the model may repeat them after the confirmation
        for (const later of calls.slice(i + 1)) {
          insertMessage(db, {
            conversationId: state.conversationId,
            role: "tool",
            toolCallId: later.id,
            toolName: later.name,
            content: "Nicht ausgeführt, weil zuerst eine Bestätigung nötig war – bei Bedarf erneut aufrufen.",
            status: "cancelled",
            toolResult: { ok: false, summary: "Nicht ausgeführt", links: [] } satisfies ChatToolResult,
          });
        }
        touch(db, state.conversationId);
        await emit({ type: "confirm", messageId: row.id, toolCall: call, summary: text });
        return;
      }
      const key = `${call.name} ${JSON.stringify(call.arguments)}`;
      state.failed ??= new Set();
      if (state.failed.has(key)) {
        state.malformed++;
        const text = "Fehler: Genau dieser Aufruf ist eben schon fehlgeschlagen. Ändere die Argumente laut der Fehlermeldung oder erkläre dem Nutzer, was fehlt.";
        const row = insertMessage(db, { ...base, content: text, status: "error", toolResult: { ok: false, summary: "Wiederholter fehlerhafter Aufruf", links: [] } satisfies ChatToolResult });
        await emit({ type: "tool_result", message: messageView(row) });
        continue;
      }
      const outcome = await host.call(call.name, call.arguments);
      if (outcome.isError) state.failed.add(key);
      const result = toChatToolResult(outcome, call.name);
      const row = insertMessage(db, { ...base, content: toolContent(outcome, result), status: outcome.isError ? "error" : "done", toolResult: result });
      await emit({ type: "tool_result", message: messageView(row) });
    }
    if (state.malformed >= MAX_MALFORMED) {
      touch(db, state.conversationId);
      await emit({ type: "error", message: "Das Modell hat wiederholt ungültige Werkzeugaufrufe erzeugt – bitte die Anfrage anders formulieren." });
      return;
    }
  }
  touch(db, state.conversationId);
  await emit({ type: "error", message: `Abgebrochen nach ${MAX_STEPS} Schritten ohne abschließende Antwort – bitte die Anfrage aufteilen.` });
}

