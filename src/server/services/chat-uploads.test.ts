import { describe, expect, test } from "bun:test";
import { messageUploads } from "../../shared/chat";
import { amountsIn, guessedAmountError, hasRecentUploads, isTextUser, isUploadRow, knownAmounts, uploadLine, uploadsContent, uploadsHint, uploadsPreview } from "./chat-uploads";

const upload = (expenseId: number, fileName = "rechnung.pdf") => ({ expenseId, number: `ER-2026-000${expenseId}`, fileName, attachmentPath: `receipts/2026/x-${expenseId}.pdf` });
const stored = (...ids: number[]) => ({ kind: "uploads", uploads: ids.map((id) => upload(id)), failures: [] });

describe("chat uploads", () => {
  test("one German line per receipt with number, id, state and file name", () => {
    expect(uploadLine(upload(4))).toBe("Hochgeladener Beleg: Ausgabe ER-2026-0004 (id 4), Entwurf ohne Lieferant und Positionen, Datei „rechnung.pdf“.");
    expect(uploadLine({ ...upload(5), number: null, incomplete: false })).toBe("Hochgeladener Beleg: Ausgabe id 5, bereits erfasst, Datei „rechnung.pdf“.");
    // quotes and line breaks in a file name can't break out of the line
    expect(uploadLine(upload(6, 'a"b\n“c”.png'))).toContain("Datei „a b c .png“.");
    expect(uploadsContent([upload(1), upload(2, "foto.jpg")]).split("\n")).toEqual([uploadLine(upload(1)), uploadLine(upload(2, "foto.jpg"))]);
    expect(uploadsHint(2)).toContain("frag nach");
    expect(uploadsHint(1)).not.toContain("welcher");
    // no amount is known: the model must not make one up for lines
    expect(uploadsHint(1)).toContain("Den Betrag kennst du nicht");
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

  test("amounts in text: German and English notation, thousands", () => {
    expect([...amountsIn("Summe € 1.234,56, Trinkgeld 4,30 und 48.60 bzw. 25")]).toEqual(expect.arrayContaining([123456, 430, 4860, 2500]));
    const known = knownAmounts([
      { role: "user", toolResult: stored(7), content: "Hochgeladener Beleg: Ausgabe ER-2026-0007 (id 7) …" },
      { role: "user", content: "Das war Bewirtung, 48,60 bar" },
      { role: "tool", status: "done", content: "Erkennung: Summe € 12,90", toolResult: { ok: true, summary: "", links: [], cards: [{ kind: "kpis", title: "", items: [{ label: "x", cents: 999 }] }] } },
      { role: "tool", status: "error", content: "Fehler: 77,00" },
    ]);
    expect([4860, 1290, 999].every((c) => known.has(c))).toBe(true);
    expect(known.has(7700)).toBe(false); // failed calls don't count
    expect(known.has(700)).toBe(false); // the upload line's id is no amount
  });

  test("guessed amounts on an uploaded draft are rejected; given, looked-up or other expenses pass", () => {
    const rows = [
      { role: "user", toolResult: stored(7), content: "Hochgeladener Beleg: Ausgabe ER-2026-0007 (id 7), Entwurf …" },
      { role: "user", toolResult: null, content: "Bewirtung mit Kunde Huber, bar bezahlt" },
    ];
    const call = (args: Record<string, unknown>) => ({ name: "update_expense", arguments: { id: 7, ...args } });
    expect(guessedAmountError(call({ lines: [{ category: "bewirtung", gross: 54.6 }] }), rows)).toMatch(/€\s54,60 hat der Nutzer nicht genannt/);
    expect(guessedAmountError(call({ lines: [{ category: "bewirtung", net: "54,60" }] }), rows)).toContain("get_receipt_analysis");
    expect(guessedAmountError(call({ description: "Bewirtung Huber" }), rows)).toBeNull();
    expect(guessedAmountError({ name: "update_expense", arguments: { id: 8, lines: [{ gross: 54.6 }] } }, rows)).toBeNull();
    expect(guessedAmountError({ name: "create_expense", arguments: { id: 7, lines: [{ gross: 54.6 }] } }, rows)).toBeNull();
    const given = [...rows, { role: "user", toolResult: null, content: "Es waren 54,60 €" }];
    expect(guessedAmountError(call({ lines: [{ category: "bewirtung", gross: 54.6 }] }), given)).toBeNull();
    const analysed = [...rows, { role: "tool", status: "done", content: "Vorschläge: Summe brutto € 54,60" }];
    expect(guessedAmountError(call({ lines: [{ category: "bewirtung", gross: "54,60" }] }), analysed)).toBeNull();
  });
});
