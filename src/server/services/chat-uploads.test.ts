import { describe, expect, test } from "bun:test";
import { messageUploads } from "../../shared/chat";
import { hasRecentUploads, isTextUser, isUploadRow, uploadLine, uploadsContent, uploadsPreview } from "./chat-uploads";

const upload = (expenseId: number, fileName = "rechnung.pdf") => ({ expenseId, number: `ER-2026-000${expenseId}`, fileName, attachmentPath: `receipts/2026/x-${expenseId}.pdf` });
const stored = (...ids: number[]) => ({ kind: "uploads", uploads: ids.map((id) => upload(id)), failures: [] });

describe("chat uploads", () => {
  test("one German line per receipt with number, id, state and file name", () => {
    expect(uploadLine(upload(4))).toBe("Hochgeladener Beleg: Ausgabe ER-2026-0004 (id 4), Entwurf ohne Lieferant und Positionen, Datei „rechnung.pdf“.");
    expect(uploadLine({ ...upload(5), number: null, incomplete: false })).toBe("Hochgeladener Beleg: Ausgabe id 5, bereits erfasst, Datei „rechnung.pdf“.");
    // quotes and line breaks in a file name can't break out of the line
    expect(uploadLine(upload(6, 'a"b\n“c”.png'))).toContain("Datei „a b c .png“.");
    const two = uploadsContent([upload(1), upload(2, "foto.jpg")]).split("\n");
    expect(two).toHaveLength(3);
    expect(two[2]).toContain("frag nach");
    expect(uploadsContent([upload(1)])).toContain("update_expense");
  });

  test("stored shape: recognised only on user rows with kind uploads", () => {
    expect(isUploadRow({ role: "user", toolResult: stored(1) })).toBe(true);
    expect(isUploadRow({ role: "tool", toolResult: stored(1) })).toBe(false);
    expect(isUploadRow({ role: "user", toolResult: null })).toBe(false);
    expect(isUploadRow({ role: "user", toolResult: { kind: "other" } })).toBe(false);
    expect(isTextUser({ role: "user", toolResult: null })).toBe(true);
    expect(isTextUser({ role: "user", toolResult: stored(1) })).toBe(false);
    expect(messageUploads("user", { kind: "uploads", uploads: [] })?.failures).toEqual([]);
    expect(uploadsPreview(messageUploads("user", stored(1))!)).toBe("Beleg hochgeladen: rechnung.pdf");
    expect(uploadsPreview(messageUploads("user", stored(1, 2, 3))!)).toBe("3 Belege hochgeladen");
  });

  test("recent uploads: until three user messages followed the last upload", () => {
    const u = { role: "user", toolResult: stored(1) };
    const q = { role: "user", toolResult: null };
    const a = { role: "assistant" };
    expect(hasRecentUploads([])).toBe(false);
    expect(hasRecentUploads([q, a])).toBe(false);
    expect(hasRecentUploads([u])).toBe(true);
    expect(hasRecentUploads([u, q, a, q, a, q])).toBe(true);
    expect(hasRecentUploads([u, q, a, q, a, q, a, q])).toBe(false);
    expect(hasRecentUploads([u, q, a, q, a, q, a, u, q])).toBe(true);
  });
});
