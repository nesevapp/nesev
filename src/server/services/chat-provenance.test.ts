import { describe, expect, test } from "bun:test";
import type { ToolHost } from "./chat-tools";
import { callRefs, checkProvenance, conversationProvenance, type ProvenanceRow, unknownRefs } from "./chat-provenance";

// Id provenance guard: state-changing calls may only use ids the conversation established.

const user = (content: string, contextPath: string | null = null): ProvenanceRow => ({ role: "user", content, status: "done", contextPath });
const tool = (content: string, toolResult: unknown = null, status = "done"): ProvenanceRow => ({ role: "tool", content, status, contextPath: null, toolResult });

// texts in the shape of the MCP tools (bank.ts txLine, documents.ts detail, overview.ts search)
const LIST_BANK = "3 Bankbuchungen:\n- 13.10.2026 € 1.140,00 · Alpen Software GmbH · Rechnung RE-2026-0001 · Offen · id 1\n- 12.10.2026 -€ 60,00 · Adobe · Offen · id 2";
const GET_DOC = "Rechnung RE-2026-0001 (id 1) · Überfällig\nKunde: Alpen Software GmbH (id 1)";
const SEARCH_ALPEN = "Kunden:\n- Alpen Software GmbH (client id 1) · K-0001\nRechnungen:\n- RE-2026-0001 (invoice id 1) · Alpen Software GmbH";

const searchCalls: string[] = [];
const host: ToolHost = {
  tools: [],
  async call(name, args) {
    searchCalls.push(String(args.query));
    if (name === "search" && args.query === "RE-2026-0001") return { isError: false, text: "Rechnungen:\n- RE-2026-0001 (invoice id 1) · Alpen", structured: null };
    return { isError: false, text: "Keine Treffer.", structured: null };
  },
};
const match = { name: "match_bank_transaction", arguments: { id: 1, targets: [{ kind: "invoice", id: 1 }] } };

describe("id provenance", () => {
  test("which arguments are record ids", () => {
    expect(callRefs(match)).toEqual([
      ["bank_transaction", 1],
      ["document", 1],
    ]);
    expect(callRefs({ name: "match_bank_transaction", arguments: { id: 3, targets: [{ kind: "expense", id: 2 }] } })).toEqual([
      ["bank_transaction", 3],
      ["expense", 2],
    ]);
    expect(callRefs({ name: "create_invoice_draft", arguments: { clientId: 1, items: [{ title: "x", articleId: 4 }, { title: "y" }] } })).toEqual([
      ["client", 1],
      ["article", 4],
    ]);
    expect(callRefs({ name: "create_invoice_draft", arguments: { clientName: "Alpen", items: [] } })).toEqual([]);
    expect(callRefs({ name: "queue_receipt_analysis", arguments: { expenseIds: [2, 3] } })).toEqual([
      ["expense", 2],
      ["expense", 3],
    ]);
    expect(callRefs({ name: "get_document", arguments: { id: 9 } })).toEqual([]);
  });

  test("the 9B case: match without any lookup is blocked; after list_bank_transactions + get_document it passes", async () => {
    const rows = [user("Ordne die Zahlung von Alpen der Rechnung RE-2026-0001 zu")];
    const blocked = await checkProvenance(match, { rows, host });
    // the invoice number the user named is resolved via search, the booking id is still a guess
    expect(searchCalls).toContain("RE-2026-0001");
    expect(blocked).toBe(
      "Fehler: Bankbuchung id 1 wurde in dieser Unterhaltung nicht nachgeschlagen – die id nicht raten. Zuerst suchen/auflisten (list_bank_transactions) und dann mit der id aus dem Ergebnis aufrufen.",
    );
    expect(await checkProvenance(match, { rows: [...rows, tool(LIST_BANK), tool(GET_DOC)], host })).toBeNull();
    // the guard's own error doesn't count as a lookup
    expect(await checkProvenance(match, { rows: [user("Ordne zu"), tool(blocked!, null, "error")], host })).toContain("Bankbuchung id 1, Beleg id 1 wurden in dieser Unterhaltung nicht nachgeschlagen");
  });

  test("legitimate flows: client from search, ids from earlier turns, card rows and links, explicit ids, the page record", async () => {
    const draft = { name: "create_invoice_draft", arguments: { clientId: 1, items: [{ title: "Beratung" }] } };
    expect(await checkProvenance(draft, { rows: [user("Rechnung für Alpen"), tool(SEARCH_ALPEN)], host })).toBeNull();
    expect(await checkProvenance({ ...draft, arguments: { clientId: 7, items: [] } }, { rows: [user("Rechnung für Alpen"), tool(SEARCH_ALPEN)], host })).toContain("Kunde id 7");
    // a follow-up turn: provenance spans the conversation
    const earlier = [user("Welche Ausgaben sind offen?"), tool("1 Ausgaben:\n- ER-2026-0002 (expense id 2) · Adobe"), user("Markier die als bezahlt")];
    expect(await checkProvenance({ name: "mark_expense_paid", arguments: { id: 2 } }, { rows: earlier, host })).toBeNull();
    // only a card row / link carries the id
    const viaCard = [user("Zeig offene Ausgaben"), tool("Liste", { ok: true, summary: "", links: [], card: { kind: "table", title: "", columns: [], rows: [{ cells: {}, path: "/expenses/5" }] } })];
    expect(unknownRefs({ name: "mark_expense_paid", arguments: { id: 5 } }, conversationProvenance(viaCard))).toEqual([]);
    expect(unknownRefs({ name: "update_client", arguments: { id: 3 } }, conversationProvenance([tool("ok", { ok: true, summary: "", links: [{ label: "Alpen", path: "/clients/3" }] })]))).toEqual([]);
    // the user typed an id
    expect(await checkProvenance({ name: "finalize_document", arguments: { id: 4 } }, { rows: [user("Finalisiere den Entwurf id 4")], host })).toBeNull();
    // the page record: when the message refers to it or names nothing else, not when it names another record
    const fin = { name: "finalize_document", arguments: { id: 2 } };
    expect(await checkProvenance(fin, { rows: [user("Finalisiere diese Rechnung", "/invoices/2")], host })).toBeNull();
    expect(await checkProvenance(fin, { rows: [user("Finalisieren bitte", "/invoices/2")], host })).toBeNull();
    expect(await checkProvenance(fin, { rows: [user("Finalisiere die Rechnung für Berlin", "/invoices/2")], host })).toContain("Beleg id 2");
    // kinds matter where the text says them: an invoice id 1 is no client id 1
    expect(unknownRefs({ name: "update_client", arguments: { id: 1 } }, conversationProvenance([tool("RE-2026-0001 (invoice id 1)")]))).toEqual([["client", 1]]);
    // read tools and tools without id arguments are never checked
    expect(await checkProvenance({ name: "get_document", arguments: { id: 99 } }, { rows: [], host })).toBeNull();
    expect(await checkProvenance({ name: "create_client", arguments: { name: "X" } }, { rows: [], host })).toBeNull();
  });
});
