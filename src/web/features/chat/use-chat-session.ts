import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ChatContext } from "@shared/chat";
import {
  apiErrorMessage,
  type ChatConversationDetail,
  type ChatMessageView,
  type ChatStreamEvent,
  type ChatStreamTarget,
  chatApi,
  chatConversationQuery,
  createdDraftIds,
  keys,
  streamChat,
  useChatTurnRefresh,
  useCreateExpenseDrafts,
} from "@/sdk";
import { useRunUiAction } from "./chat-actions";
import { chatUi } from "./chat-store";

// One conversation in the panel: loads the detail, streams turns into its query cache (so the message list
// renders from one source), and refreshes the chat and affected app data at the end of a turn.

export interface LiveState {
  /** assistant message currently reasoning ("denkt nach …") */
  thinkingId: number | null;
  /** model server status line ("Modell wird geladen …") */
  statusText: string | null;
  /** tool call ids running right now (shown with a spinner) */
  runningCalls: Set<string>;
}

const IDLE: LiveState = { thinkingId: null, statusText: null, runningCalls: new Set() };

function emptyDetail(id: number): ChatConversationDetail {
  const now = new Date().toISOString();
  return { id, title: "", createdAt: now, updatedAt: now, preview: "", messages: [], pending: null };
}

function placeholder(id: number, role: ChatMessageView["role"], content = ""): ChatMessageView {
  return {
    id,
    role,
    content,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    toolResult: null,
    status: "pending",
    contextPath: null,
    createdAt: new Date().toISOString(),
  };
}

const upsert = (messages: ChatMessageView[], m: ChatMessageView) =>
  messages.some((x) => x.id === m.id) ? messages.map((x) => (x.id === m.id ? m : x)) : [...messages, m];

const patch = (messages: ChatMessageView[], id: number, fn: (m: ChatMessageView) => ChatMessageView) =>
  messages.map((m) => (m.id === id ? fn(m) : m));

/** Applies one stream event to the cached conversation detail. */
export function applyEvent(d: ChatConversationDetail, e: ChatStreamEvent): ChatConversationDetail {
  switch (e.type) {
    case "user_message":
      return { ...d, messages: upsert(d.messages, e.message) };
    case "assistant_start":
      return { ...d, messages: upsert(d.messages, placeholder(e.messageId, "assistant")) };
    case "delta":
      return {
        ...d,
        messages: d.messages.some((m) => m.id === e.messageId)
          ? patch(d.messages, e.messageId, (m) => ({ ...m, content: m.content + e.text }))
          : [...d.messages, placeholder(e.messageId, "assistant", e.text)],
      };
    case "replace":
      return { ...d, messages: patch(d.messages, e.messageId, (m) => ({ ...m, content: e.text })) };
    case "discard":
      return { ...d, messages: d.messages.filter((m) => m.id !== e.messageId) };
    case "tool_call":
      return {
        ...d,
        messages: patch(d.messages, e.messageId, (m) =>
          m.toolCalls?.some((c) => c.id === e.toolCall.id) ? m : { ...m, toolCalls: [...(m.toolCalls ?? []), e.toolCall] },
        ),
      };
    case "tool_result":
      return { ...d, messages: upsert(d.messages, e.message) };
    case "confirm":
      return { ...d, pending: { messageId: e.messageId, toolCall: e.toolCall, summary: e.summary } };
    case "done":
      return { ...d, ...e.conversation };
    default:
      return d;
  }
}

export function useChatSession(conversationId: number | null) {
  const qc = useQueryClient();
  const refresh = useChatTurnRefresh();
  const runUiAction = useRunUiAction();
  // no focus refetch: it could replace the cache mid-stream; turns invalidate it explicitly when they end
  const detail = useQuery({
    ...chatConversationQuery(conversationId ?? 0),
    enabled: conversationId != null,
    refetchOnWindowFocus: false,
  });
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LiveState>(IDLE);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** conversation of the running stream (a new conversation is selected right before its first stream) */
  const streamIdRef = useRef<number | null>(null);

  // switching conversations stops the running stream (the server keeps the partial answer)
  useEffect(() => {
    setError(null);
    if (streamIdRef.current !== null && streamIdRef.current !== conversationId) abortRef.current?.abort();
  }, [conversationId]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // the stored conversation was deleted elsewhere (or the DB was reset): start fresh
  useEffect(() => {
    if (detail.isError && conversationId != null) chatUi.select(null);
  }, [detail.isError, conversationId]);

  const run = async (target: ChatStreamTarget) => {
    const id = target.conversationId;
    const key = keys.chat.conversation(id);
    const tools = new Set<string>();
    const controller = new AbortController();
    abortRef.current = controller;
    streamIdRef.current = id;
    setStreaming(true);
    setError(null);
    setLive(IDLE);
    try {
      await streamChat(target, {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "error") setError(e.message);
          else qc.setQueryData<ChatConversationDetail>(key, (d) => applyEvent(d ?? emptyDetail(id), e));
          // a UI action (open_in_app, download_pdf, …) runs once, live; the history only shows a button
          const action = e.type === "tool_result" && e.message.toolResult?.ok ? e.message.toolResult.action : null;
          if (action) runUiAction(action);
          setLive((s) => {
            switch (e.type) {
              case "thinking":
                return { ...s, thinkingId: e.messageId, statusText: null };
              case "status":
                return { ...s, statusText: e.text };
              case "delta":
                return s.thinkingId === null && s.statusText === null ? s : { ...s, thinkingId: null, statusText: null };
              case "assistant_start":
                return { ...s, statusText: null };
              case "tool_call":
                tools.add(e.toolCall.name);
                return { ...s, thinkingId: null, runningCalls: new Set(s.runningCalls).add(e.toolCall.id) };
              case "tool_result": {
                if (e.message.toolName) tools.add(e.message.toolName);
                const running = new Set(s.runningCalls);
                if (e.message.toolCallId) running.delete(e.message.toolCallId);
                return { ...s, runningCalls: running };
              }
              default:
                return s;
            }
          });
        },
      });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        streamIdRef.current = null;
      }
      setStreaming(false);
      setLive(IDLE);
      // after a stop the server stores the partial answer once it notices the disconnect: refetch a bit later
      if (controller.signal.aborted) setTimeout(() => refresh(id, tools), 1000);
      else refresh(id, tools);
    }
  };

  /** the selected conversation, created first when there is none ("Neu" only creates it on the first message) */
  const ensureConversation = async (): Promise<number | null> => {
    if (conversationId != null) return conversationId;
    try {
      const created = await chatApi.create();
      qc.setQueryData(keys.chat.conversation(created.id), { ...created, messages: [], pending: null });
      chatUi.select(created.id);
      return created.id;
    } catch (err) {
      setError(apiErrorMessage(err));
      return null;
    }
  };

  const send = async (text: string, context: ChatContext | undefined) => {
    const id = await ensureConversation();
    if (id == null) return;
    await run({ kind: "message", conversationId: id, body: { text, context } });
  };

  // receipts from the paperclip / a drop on the panel: one draft expense per file (the normal quick capture, nothing
  // is analysed), then recorded in the conversation so the cards and the model's context survive a reload
  const createDrafts = useCreateExpenseDrafts();
  const [uploading, setUploading] = useState(false);
  const upload = async (files: File[]) => {
    if (!files.length || uploading) return;
    setUploading(true);
    setError(null);
    try {
      let expenseIds: number[];
      const failures: string[] = [];
      try {
        expenseIds = (await createDrafts.mutateAsync(files)).map((e) => e.id);
      } catch (err) {
        expenseIds = createdDraftIds(err);
        failures.push(apiErrorMessage(err));
        if (!expenseIds.length) {
          toast.error(apiErrorMessage(err));
          return;
        }
        toast.warning(apiErrorMessage(err));
      }
      const id = await ensureConversation();
      if (id == null) return;
      try {
        const res = await chatApi.recordUploads(id, { expenseIds, failures });
        qc.setQueryData<ChatConversationDetail>(keys.chat.conversation(id), (d) =>
          d ? { ...d, ...res.conversation, messages: upsert(d.messages, res.message) } : d,
        );
        void qc.invalidateQueries({ queryKey: keys.chat.conversations });
      } catch (err) {
        setError(`Die Belege wurden als Ausgaben angelegt, aber nicht im Chat vermerkt: ${apiErrorMessage(err)}`);
      }
    } finally {
      setUploading(false);
    }
  };

  const confirm = async (approve: boolean) => {
    const pending = detail.data?.pending;
    if (conversationId == null || !pending) return;
    qc.setQueryData<ChatConversationDetail>(keys.chat.conversation(conversationId), (d) => (d ? { ...d, pending: null } : d));
    await run({ kind: "confirm", conversationId, body: { messageId: pending.messageId, approve } });
  };

  const stop = () => abortRef.current?.abort();

  return { detail, streaming, live, error, dismissError: () => setError(null), send, confirm, stop, upload, uploading };
}
