import { z } from "./schemas/zod";

// In-app assistant ("Assistent"): API contract shared by server (src/server/services/chat*.ts,
// routes/chat.ts) and web (src/web/sdk/chat.ts, features/chat). Fully local: the server runs the agent loop
// against nesev's own llama-server and executes the tools of nesev's MCP server (src/mcp) in-process.
//
// Endpoints (mounted at /api/chat):
//   GET    /conversations                 → ChatConversationSummary[] (newest first)
//   POST   /conversations                 → ChatConversationSummary (empty conversation)
//   GET    /conversations/:id             → ChatConversationDetail
//   PATCH  /conversations/:id {title}     → ChatConversationSummary
//   DELETE /conversations/:id             → { ok: true }
//   POST   /conversations/:id/messages    ChatSendInput → text/event-stream of ChatStreamEvent
//   POST   /conversations/:id/confirm     ChatConfirmInput → text/event-stream of ChatStreamEvent
//          (approve or reject a pending state-changing tool call; the loop then continues)
//   GET    /settings / PUT /settings      ChatSettings
//   GET    /status                        → ChatStatus
// Aborting the fetch (client disconnect) stops generation; the partial assistant text is kept.

/** Tools whose execution needs an explicit click in the UI (the MCP's destructiveHint tools). */
export const CONFIRM_TOOLS = [
  "finalize_document",
  "create_reminder",
  "mark_invoice_paid",
  "mark_document_sent",
  "convert_offer_to_invoice",
  "create_credit_note",
] as const;

export interface ChatSettings {
  enabled: boolean;
  /** GGUF path; "" = auto (prefers Qwen3.5-4B, like receipt recognition) */
  modelPath: string;
  /** context window for chat (tool definitions + history) */
  contextSize: number;
  /** let the model think before answering (slower, sometimes better on multi-step requests) */
  reasoning: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  enabled: true,
  modelPath: "",
  contextSize: 32768,
  reasoning: false,
};

export const chatSettingsSchema = z.object({
  enabled: z.boolean(),
  modelPath: z.string().trim().max(1000),
  contextSize: z.number().int().min(4096).max(262144),
  reasoning: z.boolean(),
});

export interface ChatConversationSummary {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** first characters of the last message */
  preview: string;
}

export interface ChatToolCall {
  /** id from the model (or generated), echoed in tool results */
  id: string;
  name: string;
  /** parsed JSON arguments */
  arguments: Record<string, unknown>;
}

export interface ChatLink {
  label: string;
  /** app route, e.g. "/invoices/12" */
  path: string;
}

/** What the UI shows for an executed (or pending/cancelled) tool call. */
export interface ChatToolResult {
  ok: boolean;
  /** one line, German, e.g. "3 Treffer" or "RE-2026-0004 finalisiert" */
  summary: string;
  links: ChatLink[];
}

export type ChatMessageStatus = "done" | "pending" | "cancelled" | "error";

export interface ChatMessageView {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls: ChatToolCall[] | null;
  toolCallId: string | null;
  toolName: string | null;
  toolResult: ChatToolResult | null;
  status: ChatMessageStatus;
  contextPath: string | null;
  createdAt: string;
}

export interface ChatConversationDetail extends ChatConversationSummary {
  messages: ChatMessageView[];
  /** a tool call waiting for confirmation (blocks new messages until answered) */
  pending: { messageId: number; toolCall: ChatToolCall; summary: string } | null;
}

/** Page context sent with a message so the model can resolve "diese Rechnung". */
export interface ChatContext {
  path: string;
  /** human title of the page/record, e.g. "Rechnung RE-2026-0004" */
  title?: string;
}

export const chatSendSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  context: z.object({ path: z.string().max(300), title: z.string().max(300).optional() }).optional(),
});
export type ChatSendInput = z.infer<typeof chatSendSchema>;

export const chatConfirmSchema = z.object({
  messageId: z.number().int().positive(),
  approve: z.boolean(),
});
export type ChatConfirmInput = z.infer<typeof chatConfirmSchema>;

/**
 * Server-sent events, one JSON object per `data:` line (event name = `type`).
 * Order per turn: user_message → (assistant_start → delta* → tool_call* → tool_result*)* → done | confirm | error.
 */
export type ChatStreamEvent =
  | { type: "user_message"; message: ChatMessageView }
  | { type: "assistant_start"; messageId: number }
  | { type: "delta"; messageId: number; text: string }
  /** the model is reasoning (only with settings.reasoning); text is not stored */
  | { type: "thinking"; messageId: number }
  | { type: "tool_call"; messageId: number; toolCall: ChatToolCall }
  | { type: "tool_result"; message: ChatMessageView }
  /** a state-changing tool call needs the user's click; the stream ends after this */
  | { type: "confirm"; messageId: number; toolCall: ChatToolCall; summary: string }
  /** model server is starting / loading the model (first request can take a while) */
  | { type: "status"; text: string }
  | { type: "done"; conversation: ChatConversationSummary }
  | { type: "error"; message: string };

export interface ChatStatus {
  enabled: boolean;
  /** llama-server binary + model resolved */
  ready: boolean;
  model: { path: string; label: string; auto: boolean } | null;
  running: boolean;
  /** German reason when not ready */
  problem: string | null;
}
