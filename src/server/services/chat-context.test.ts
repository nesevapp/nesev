import { describe, expect, test } from "bun:test";
import { callTarget, contextRecord, DEICTIC, mismatches, namedRefs } from "./chat-context";

// Page context guard: what a message names vs. the record the user is looking at.

describe("page context guard", () => {
  test("context record and call targets", () => {
    expect(contextRecord("/invoices/1")).toEqual({ kind: "document", id: 1 });
    expect(contextRecord("/clients/3/edit")).toEqual({ kind: "client", id: 3 });
    expect(contextRecord("/bank")).toBeNull();
    expect(callTarget({ name: "download_pdf", arguments: { id: 1 } })).toEqual({ kind: "document", id: 1 });
    expect(callTarget({ name: "open_pdf", arguments: { id: 1, type: "reminder" } })).toBeNull();
    expect(callTarget({ name: "create_reminder", arguments: { invoiceId: 4 } })).toEqual({ kind: "document", id: 4 });
    expect(callTarget({ name: "open_in_app", arguments: { what: "client", id: 3 } })).toEqual({ kind: "client", id: 3 });
    expect(callTarget({ name: "search", arguments: { query: "x" } })).toBeNull();
  });

  test("named references: numbers, names after für/von/bei, drafts; deictic words", () => {
    expect(namedRefs("Lade mir die Vorschau vom Entwurf für Alpen herunter")).toEqual({ numbers: [], names: ["Alpen"], draft: true });
    expect(namedRefs("Öffne RE-2026-0004 und die Rechnung für Oktober")).toEqual({ numbers: ["RE-2026-0004"], names: [], draft: false });
    expect(namedRefs("Schick eine Mahnung an Berlin Digital")).toMatchObject({ names: ["Berlin"] });
    expect(DEICTIC.test("Lade mir das PDF davon herunter")).toBe(true);
    expect(DEICTIC.test("Finalisiere diese Rechnung")).toBe(true);
    expect(DEICTIC.test("Lade die Vorschau für Alpen herunter")).toBe(false);
  });

  test("mismatches against the context record", () => {
    const re1 = { number: "RE-2026-0001", name: "Alpen Software GmbH", draft: false, label: "Rechnung RE-2026-0001" };
    expect(mismatches(namedRefs("Lade mir die Vorschau vom Entwurf für Alpen herunter"), re1)).toEqual(["die Nachricht meint einen Entwurf, dieser Beleg ist finalisiert"]);
    expect(mismatches(namedRefs("Lade RE-2026-0001 herunter"), re1)).toEqual([]);
    expect(mismatches(namedRefs("Lade RE-2026-0002 herunter"), re1)).toEqual(["die Nachricht nennt die Nummer RE-2026-0002"]);
    expect(mismatches(namedRefs("Lade die Rechnung für Berlin herunter"), re1)).toEqual(["die Nachricht nennt „Berlin“"]);
    expect(mismatches(namedRefs("Lade die Rechnung für Alpen herunter"), re1)).toEqual([]);
  });
});
