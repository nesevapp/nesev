import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ChatConfirmInput,
  ChatConversationDetail,
  ChatConversationSummary,
  ChatSendInput,
  ChatSettings,
  ChatStatus,
  ChatStreamEvent,
  ChatWarmState,
} from "@shared/chat";
import { chat, idParam, parseResponse } from "./client";
import { type Change, useInvalidate } from "./invalidate";
import { keys } from "./keys";
import { readSse } from "./sse";

// Assistent (in-app chat, contract in src/shared/chat.ts). JSON endpoints via hc; the two streaming
// endpoints (send message, confirm a tool call) return text/event-stream and go through streamChat().

/** the server's `/conversations/:id` routes */
const conversation = () => chat.conversations[":id"];

export const chatApi = {
  conversations: (): Promise<ChatConversationSummary[]> => parseResponse(chat.conversations.$get()),
  create: (): Promise<ChatConversationSummary> => parseResponse(chat.conversations.$post()),
  get: (id: number): Promise<ChatConversationDetail> => parseResponse(conversation().$get({ param: idParam(id) })),
  rename: (id: number, title: string): Promise<ChatConversationSummary> =>
    parseResponse(conversation().$patch({ param: idParam(id), json: { title } })),
  remove: (id: number) => parseResponse(conversation().$delete({ param: idParam(id) })),
  settings: (): Promise<ChatSettings> => parseResponse(chat.settings.$get()),
  updateSettings: (json: ChatSettings): Promise<ChatSettings> => parseResponse(chat.settings.$put({ json })),
  status: (): Promise<ChatStatus> => parseResponse(chat.status.$get()),
  /** starts the model and fills its prompt cache in the background (the panel opened) */
  warm: (): Promise<{ state: ChatWarmState }> => parseResponse(chat.warm.$post()),
};

export { resultCards } from "@shared/chat";
export type {
  ChatCard,
  ChatLink,
  ChatTone,
  ChatUiAction,
  ChatConversationDetail,
  ChatConversationSummary,
  ChatMessageView,
  ChatSettings,
  ChatStatus,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolResult,
  ChatWarmState,
} from "@shared/chat";

export const chatConversationsQuery = queryOptions({
  queryKey: keys.chat.conversations,
  queryFn: chatApi.conversations,
});

export const chatConversationQuery = (id: number) =>
  queryOptions({ queryKey: keys.chat.conversation(id), queryFn: () => chatApi.get(id) });

export const chatSettingsQuery = queryOptions({ queryKey: keys.chat.settings, queryFn: chatApi.settings });

/** Model readiness; polled while the panel is open (`poll`) so a finished model download shows up. */
export const chatStatusQuery = (poll = false) =>
  queryOptions({
    queryKey: keys.chat.status,
    queryFn: chatApi.status,
    staleTime: 5_000,
    refetchInterval: poll ? 15_000 : false,
  });

export function useCreateChatConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: chatApi.create,
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.chat.conversations }),
  });
}

export function useRenameChatConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: number; title: string }) => chatApi.rename(id, title),
    onSuccess: (saved) => {
      qc.setQueryData<ChatConversationDetail>(keys.chat.conversation(saved.id), (d) => (d ? { ...d, ...saved } : d));
      void qc.invalidateQueries({ queryKey: keys.chat.conversations });
    },
  });
}

export function useDeleteChatConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => chatApi.remove(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: keys.chat.conversation(id) });
      void qc.invalidateQueries({ queryKey: keys.chat.conversations });
    },
  });
}

export function useUpdateChatSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: chatApi.updateSettings,
    onSuccess: (saved) => {
      qc.setQueryData(keys.chat.settings, saved);
      void qc.invalidateQueries({ queryKey: keys.chat.status });
    },
  });
}

// ── Streaming ────────────────────────────────────────────────────────────────

export type ChatStreamTarget = { kind: "message"; conversationId: number; body: ChatSendInput } | { kind: "confirm"; conversationId: number; body: ChatConfirmInput };

/**
 * POSTs to a streaming endpoint and calls onEvent for every ChatStreamEvent until the stream ends.
 * Abort via `signal` (the server stops generating and keeps the partial text); an abort resolves quietly.
 * Throws on a non-2xx response (message from the `{ error }` body).
 */
export async function streamChat(
  target: ChatStreamTarget,
  { signal, onEvent }: { signal?: AbortSignal; onEvent: (event: ChatStreamEvent) => void },
): Promise<void> {
  const route = conversation();
  const param = idParam(target.conversationId);
  const url = target.kind === "message" ? route.messages.$url({ param }) : route.confirm.$url({ param });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(target.body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof data?.error === "string" ? data.error : `Fehler ${res.status}`);
  }
  try {
    await readSse(res.body, (data) => {
      let event: ChatStreamEvent;
      try {
        event = JSON.parse(data) as ChatStreamEvent;
      } catch {
        return; // not JSON (keep-alive or garbage): skip
      }
      onEvent(event);
    });
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  }
}

/** Tools that only read: no cache invalidation after they ran. */
const READ_TOOL = /^(search|list_|get_)/;

/** Which cached views a write tool changes (unknown write tools: the broad default). */
const TOOL_CHANGES: Record<string, Change[]> = {
  create_client: ["clients"],
  create_article: ["articles"],
  create_expense: ["expenses"],
  queue_receipt_analysis: ["receipts"],
  create_reminder: ["reminders", "documents"],
};
const DEFAULT_TOOL_CHANGES: Change[] = ["documents", "clients", "expenses"];

/** Changes to invalidate after the given tools ran (documents for all document tools). */
export function chatToolChanges(toolNames: Iterable<string>): Change[] {
  const changes = new Set<Change>();
  for (const name of toolNames) {
    if (READ_TOOL.test(name)) continue;
    const list = TOOL_CHANGES[name] ?? (/document|invoice|offer|credit_note/.test(name) ? ["documents"] : DEFAULT_TOOL_CHANGES);
    for (const c of list) changes.add(c);
  }
  return [...changes];
}

/** Returns `refresh(conversationId, toolNames)` for the end of a turn: chat caches plus whatever the tools changed. */
export function useChatTurnRefresh() {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (conversationId: number | null, toolNames: Iterable<string>) => {
    void qc.invalidateQueries({ queryKey: keys.chat.conversations });
    if (conversationId != null) void qc.invalidateQueries({ queryKey: keys.chat.conversation(conversationId) });
    for (const change of chatToolChanges(toolNames)) void invalidate(change);
  };
}
