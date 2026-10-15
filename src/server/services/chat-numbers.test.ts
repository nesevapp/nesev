import { describe, expect, test } from "bun:test";
import { knownNumbers, NumberGate, neutralizeNumbers, numberRetryMessage, numbersIn, unknownNumbers } from "./chat-numbers";

const known = new Set(["RE-2026-1", "ER-2026-2", "K-1"]);

describe("record numbers", () => {
  test("finds document, expense, client and asset numbers; keys ignore case and zero padding", () => {
    expect(numbersIn("RE-2026-0001, re-2026-1, ER-2026-0002, K-0001, AV-0003, GS-2026-0005 und MA-2026-0001").map((n) => n.key)).toEqual([
      "RE-2026-1",
      "RE-2026-1",
      "ER-2026-2",
      "K-1",
      "AV-3",
      "GS-2026-5",
      "MA-2026-1",
    ]);
    // not numbers: dates, IBAN-like or longer tokens, a prefix glued to a word
    expect(numbersIn("2026-10-15, XRE-2026-0001, RE-2026-0001a, Seite-2, ATU12345678")).toEqual([]);
  });

  test("known: tool results (text and stored result incl. cards) and user messages, never the assistant's text", () => {
    const k = knownNumbers(
      [
        { role: "user", content: "Was ist mit RE-2026-0007?" },
        { role: "assistant", content: "Die Rechnung RE-2026-0099 …" },
        { role: "tool", content: "2 Belege", toolResult: { ok: true, summary: "", links: [], cards: [{ kind: "table", rows: [{ cells: { number: "AN-2026-0003" } }] }] } },
        { role: "tool", content: "Ausgabe ER-2026-0001 A1" },
      ],
      ["Rechnung RE-2026-0002", undefined],
    );
    expect([...k].sort()).toEqual(["AN-2026-3", "ER-2026-1", "RE-2026-2", "RE-2026-7"]);
  });

  test("unknown numbers as written, deduplicated", () => {
    expect(unknownNumbers("RE-2026-0001 und RE-2026-0004, nochmal RE-2026-0004, K-0002", known)).toEqual(["RE-2026-0004", "K-0002"]);
    expect(unknownNumbers("Offen ist RE-2026-0001 (K-0001).", known)).toEqual([]);
    expect(numberRetryMessage(["RE-2026-0004"])).toContain("Die Nummer „RE-2026-0004“ steht in keinem Werkzeug-Ergebnis");
  });
});

describe("neutralizeNumbers", () => {
  const n = (text: string, drafts: string[] = []) => neutralizeNumbers(text, known, new Set(drafts));

  test("after a noun the number just goes (with Nr.)", () => {
    expect(n("Der Rechnungsentwurf RE-2026-0004 für Alpen ist angelegt.")).toBe("Der Rechnungsentwurf für Alpen ist angelegt.");
    expect(n("Ich habe die Rechnung Nr. RE-2026-0004 erstellt.")).toBe("Ich habe die Rechnung erstellt.");
    expect(n("Entwurf **RE-2026-0004**: 3 Std. Beratung")).toBe("Entwurf: 3 Std. Beratung");
  });

  test("in parentheses it goes with them", () => {
    expect(n("Der Entwurf (RE-2026-0004) für Alpen")).toBe("Der Entwurf für Alpen");
    expect(n("Entwurf für Alpen (Nr. RE-2026-0004).")).toBe("Entwurf für Alpen.");
  });

  test("a link labelled with the number keeps the link", () => {
    expect(n("Hier ist [RE-2026-0004](/invoices/4).", ["/invoices/4"])).toBe("Hier ist [Entwurf](/invoices/4).");
    expect(n("Hier ist [RE-2026-0004](/invoices/4).")).toBe("Hier ist [Rechnung](/invoices/4).");
    expect(n("Der Entwurf [RE-2026-0004](/invoices/4) ist fertig.")).toBe("Der [Entwurf](/invoices/4) ist fertig.");
  });

  test("anything else becomes a stand-in; known numbers and the rest of the text stay", () => {
    expect(n("RE-2026-0004 ist angelegt, RE-2026-0001 ist offen.")).toBe("Der Entwurf ist angelegt, RE-2026-0001 ist offen.");
    expect(n("Angelegt: AN-2026-0009 über € 100,00")).toBe("Angelegt: der Entwurf über € 100,00");
    expect(n("- Position 1\n  - Unterpunkt mit ER-2026-0002")).toBe("- Position 1\n  - Unterpunkt mit ER-2026-0002");
  });
});

describe("NumberGate", () => {
  const stream = (chunks: string[]) => {
    const gate = new NumberGate(known);
    const shown = chunks.map((c) => gate.push(c)).join("") + gate.flush();
    return { shown, blocked: gate.blocked };
  };

  test("known numbers pass, also when split across chunks", () => {
    expect(stream(["Offen ist R", "E-2026-00", "01 von Alpen."])).toEqual({ shown: "Offen ist RE-2026-0001 von Alpen.", blocked: false });
    expect(stream(["Kunde K-0", "001"])).toEqual({ shown: "Kunde K-0001", blocked: false });
  });

  test("stops before the first unknown number, never shows it", () => {
    expect(stream(["Der Entwurf ", "RE-2026-00", "04 ist angelegt."])).toEqual({ shown: "Der Entwurf ", blocked: true });
    // a number at the very end is only judged at flush
    expect(stream(["Angelegt als RE-2026-0004"])).toEqual({ shown: "Angelegt als ", blocked: true });
  });

  test("a held word that isn't a number is released with the next chunk", () => {
    const gate = new NumberGate(known);
    expect(gate.push("Ich lege es an")).toBe("Ich lege es ");
    expect(gate.push(" – fertig.")).toBe("an – fertig.");
    expect(gate.flush()).toBe("");
  });
});
