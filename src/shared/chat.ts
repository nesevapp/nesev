import type { DocumentStatus } from "./documents";
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
  "match_bank_transaction",
  "unmatch_bank_transaction",
  "set_bank_transaction_ignored",
  "set_recurring_invoice_active",
  "generate_recurring_invoice",
  "update_client",
  "update_expense",
  "mark_expense_paid",
  "apply_receipt_analysis",
  "link_expense_to_fixed_cost",
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
  contextSize: 65536,
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

/**
 * Tool groups for routing: every MCP tool declares one (defineTool `group`, sent as `_meta["nesev/group"]`).
 * The assistant always offers "core" and "ui" and adds the other groups by intent (page, keywords, recent tools),
 * so the small model sees a short, relevant tool list. Stdio MCP clients (Claude Code) get all tools.
 */
export const TOOL_GROUPS = ["core", "ui", "documents", "clients", "expenses", "bank", "finance"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];
export const TOOL_GROUP_META = "nesev/group";

/**
 * Visual tone of a value or chart series; the UI maps it to the platform's colors (revenue blue, expenses orange,
 * result line, forecast in/out, …).
 */
export type ChatTone = "revenue" | "expenses" | "result" | "positive" | "negative" | "neutral" | "muted";

/**
 * Generative UI: a card the UI renders under a tool result. Built on the server from the tool's structured content
 * (services/chat-cards.ts), never from model-written numbers. Amounts are integer cents; the UI formats them.
 */
export type ChatCard =
  /** a few key figures, e.g. dashboard KPIs */
  | {
      kind: "kpis";
      title: string;
      /**
       * `cents` holds the value: cents (default), a plain count (format "count") or basis points (format "percent",
       * 2000 = 20 %)
       */
      items: { label: string; cents: number; hint?: string; tone?: ChatTone; format?: "cents" | "count" | "percent" }[];
      link?: ChatLink;
    }
  /** small chart in the style of the dashboard / forecast charts; values are cents, one per label */
  | {
      kind: "chart";
      title: string;
      chart: "bar" | "line";
      /** x-axis labels, e.g. ["Jän", "Feb", …] or ["KW 42", …] */
      labels: string[];
      /** bars are drawn side by side; a "line" series in a bar chart is drawn as a line on top (like the result line) */
      /** null = no value (e.g. months after today): no bar, a gap in the line */
      series: { label: string; values: (number | null)[]; tone: ChatTone; type?: "bar" | "line" }[];
      link?: ChatLink;
    }
  /** one invoice / offer / credit note / reminder */
  | {
      kind: "document";
      /** "Rechnung", "Angebot", … */
      typeLabel: string;
      number: string | null;
      /** German status incl. "Überfällig", "teilbezahlt" */
      status: string;
      /** raw status for the badge color (status is the label) */
      statusKey?: DocumentStatus;
      overdue?: boolean;
      partial?: boolean;
      client: string | null;
      date: string | null;
      dueDate: string | null;
      grossCents: number;
      /** open amount for invoices; null otherwise */
      openCents: number | null;
      path: string;
      /** app URL of the PDF (/api/pdf/documents/:id), drafts render live as a preview */
      pdfUrl: string | null;
    }
  /** a list of records; at most ~8 rows, `more` = rows not shown */
  | {
      kind: "table";
      title: string;
      columns: { key: string; label: string; align?: "left" | "right"; money?: boolean }[];
      /** cells keyed by column key: strings, or cents for money columns */
      rows: { cells: Record<string, string | number | null>; path?: string }[];
      /** `column`: key of the money column the sum belongs under (default: the last money column) */
      total?: { label: string; cents: number; column?: string };
      more?: number;
      link?: ChatLink;
    };

/**
 * Something the assistant does in the UI (assistant-only tools such as open_in_app / download_pdf, see
 * services/chat-ui-tools.ts). The UI runs it once when the tool_result arrives live; in the history it is a button.
 */
export type ChatUiAction =
  | { kind: "navigate"; path: string; label: string }
  | { kind: "download"; url: string; fileName: string; label: string }
  | { kind: "open_tab"; url: string; label: string };

/** What the UI shows for an executed (or pending/cancelled) tool call. */
export interface ChatToolResult {
  ok: boolean;
  /** one line, German, e.g. "3 Treffer" or "RE-2026-0004 finalisiert" */
  summary: string;
  links: ChatLink[];
  /** generative UI for the result, rendered stacked (e.g. dashboard KPIs above the monthly chart) */
  cards?: ChatCard[];
  /** older rows: a single card (read via resultCards(), no longer written) */
  card?: ChatCard | null;
  /** UI action of an assistant-only tool */
  action?: ChatUiAction | null;
}

/** the cards of a tool result: `cards`, or the single `card` of older rows */
export function resultCards(result: Pick<ChatToolResult, "cards" | "card"> | null | undefined): ChatCard[] {
  if (!result) return [];
  if (Array.isArray(result.cards)) return result.cards;
  return result.card ? [result.card] : [];
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
