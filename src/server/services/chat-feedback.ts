import { and, asc, eq } from "drizzle-orm";
import type { ChatFeedback } from "../../shared/chat";
import type { DbOrTx } from "../db/client";
import { chatConversations, chatFeedback, chatMessages } from "../db/schema";
import { ChatNotFoundError } from "./chat";

// "Antwort war falsch": the user flags an assistant answer, optionally with what should have happened. One flag per
// answer (flagging again edits the note); deleted with the conversation. `bun run eval:feedback` turns the flags into
// draft eval cases (src/server/eval/feedback.ts).

const view = (r: typeof chatFeedback.$inferSelect): ChatFeedback => ({
  id: r.id,
  conversationId: r.conversationId,
  messageId: r.messageId,
  note: r.note,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function listFeedback(db: DbOrTx, conversationId: number): ChatFeedback[] {
  if (!db.select({ id: chatConversations.id }).from(chatConversations).where(eq(chatConversations.id, conversationId)).get()) {
    throw new ChatNotFoundError("Unterhaltung nicht gefunden");
  }
  return db.select().from(chatFeedback).where(eq(chatFeedback.conversationId, conversationId)).orderBy(asc(chatFeedback.messageId)).all().map(view);
}

/** Flags an assistant answer of the conversation (or updates the note of an existing flag). */
export function saveFeedback(db: DbOrTx, conversationId: number, input: { messageId: number; note: string }): ChatFeedback {
  const message = db
    .select({ role: chatMessages.role })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.conversationId, conversationId)))
    .get();
  if (!message || message.role !== "assistant") throw new ChatNotFoundError("Antwort nicht gefunden");
  const row = db
    .insert(chatFeedback)
    .values({ conversationId, messageId: input.messageId, note: input.note })
    .onConflictDoUpdate({ target: chatFeedback.messageId, set: { note: input.note, updatedAt: new Date().toISOString() } })
    .returning()
    .get();
  return view(row);
}

export function deleteFeedback(db: DbOrTx, conversationId: number, messageId: number): void {
  const res = db.delete(chatFeedback).where(and(eq(chatFeedback.conversationId, conversationId), eq(chatFeedback.messageId, messageId))).returning().all();
  if (!res.length) throw new ChatNotFoundError("Markierung nicht gefunden");
}
