import { describe, expect, test } from "bun:test";
import { createTestDb } from "../db/client";
import { chatMessages } from "../db/schema";
import { createConversation, renameConversation } from "../services/chat";
import { deleteFeedback, listFeedback, saveFeedback } from "../services/chat-feedback";
import { formatFeedback, loadFeedback } from "./feedback";

// "Antwort war falsch": the flags (service) and their export as draft eval cases (bun run eval:feedback), on an
// in-memory DB.

function seed() {
  const db = createTestDb();
  const c = createConversation(db);
  renameConversation(db, c.id, "Rechnung für Alpen");
  const add = (values: Omit<typeof chatMessages.$inferInsert, "conversationId">) => db.insert(chatMessages).values({ conversationId: c.id, ...values }).returning().get().id;
  add({ role: "user", content: "Welche Kunden habe ich?" });
  add({ role: "assistant", content: "Alpen und Berlin." });
  add({ role: "user", content: "Erstelle eine Rechnung für Alpen", contextPath: "/clients/1" });
  add({ role: "assistant", content: "", toolCalls: [{ id: "a", name: "create_invoice_draft", arguments: { clientName: "Alpen" } }] });
  add({ role: "tool", content: "Entwurf (invoice id 4)", toolCallId: "a", toolName: "create_invoice_draft" });
  const bad = add({ role: "assistant", content: "Die Rechnung RE-2026-0004\nist angelegt." });
  add({ role: "user", content: "Danke" });
  const later = add({ role: "assistant", content: "Gern." });
  return { db, conversationId: c.id, bad, later };
}

describe("chat feedback", () => {
  test("flag an answer, edit the note, list, delete; only assistant answers of the conversation", () => {
    const { db, conversationId, bad } = seed();
    expect(saveFeedback(db, conversationId, { messageId: bad, note: "" })).toMatchObject({ conversationId, messageId: bad, note: "" });
    saveFeedback(db, conversationId, { messageId: bad, note: "Entwürfe haben keine Nummer" });
    expect(listFeedback(db, conversationId).map((f) => [f.messageId, f.note])).toEqual([[bad, "Entwürfe haben keine Nummer"]]);
    expect(() => saveFeedback(db, conversationId, { messageId: bad - 1, note: "" })).toThrow("Antwort nicht gefunden"); // a tool row
    expect(() => saveFeedback(db, conversationId + 1, { messageId: bad, note: "" })).toThrow("Antwort nicht gefunden");
    expect(() => listFeedback(db, conversationId + 1)).toThrow("Unterhaltung nicht gefunden");
    deleteFeedback(db, conversationId, bad);
    expect(listFeedback(db, conversationId)).toEqual([]);
    expect(() => deleteFeedback(db, conversationId, bad)).toThrow("Markierung nicht gefunden");
  });

  test("export: turns up to the flagged answer, the turn's tools, the answer and the note as a draft case", () => {
    const { db, conversationId, bad } = seed();
    const flag = saveFeedback(db, conversationId, { messageId: bad, note: "Entwürfe haben keine Nummer – hätte „Entwurf“ sagen sollen" });
    const cases = loadFeedback(db.$client);
    expect(cases).toEqual([
      {
        feedbackId: flag.id,
        conversationId,
        title: "Rechnung für Alpen",
        note: "Entwürfe haben keine Nummer – hätte „Entwurf“ sagen sollen",
        flaggedAt: flag.createdAt,
        turns: [
          { text: "Welche Kunden habe ich?", contextPath: null },
          { text: "Erstelle eine Rechnung für Alpen", contextPath: "/clients/1" },
        ],
        tools: ['create_invoice_draft {"clientName":"Alpen"} → done'],
        toolNames: ["create_invoice_draft"],
        answer: "Die Rechnung RE-2026-0004\nist angelegt.",
      },
    ]);
    const text = formatFeedback(cases, "2026-10-15T10:00:00Z");
    expect(text).toContain("// Draft eval cases from 1 answer(s) flagged „Antwort war falsch“ (bun run eval:feedback, 15.10.2026).");
    expect(text).toContain(`    id: "feedback-${flag.id}",`);
    expect(text).toContain('      { text: "Erstelle eine Rechnung für Alpen", contextPath: "/clients/1" },');
    expect(text).toContain('  //   create_invoice_draft {"clientName":"Alpen"} → done');
    expect(text).toContain("  // Flagged answer: „Die Rechnung RE-2026-0004 ist angelegt.“");
    expect(text).toContain('    description: "TODO: Entwürfe haben keine Nummer – hätte „Entwurf“ sagen sollen",');
    // the case part is valid TypeScript: an array literal of it evaluates
    const body = text.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    const parsed = new Function(`return [${body}]`)() as { id: string; turns: unknown[]; tags: string[] }[];
    expect(parsed[0]).toMatchObject({ id: `feedback-${flag.id}`, tags: ["feedback"] });
    expect(parsed[0]!.turns).toHaveLength(2);
  });
});
