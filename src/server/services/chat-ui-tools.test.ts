import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb, type Db } from "../db/client";
import { fixedAssets } from "../db/schema";
import type { ChatTool, ToolHost } from "./chat-tools";
import { nudgeUiCall, UI_TOOLS, withUiTools } from "./chat-ui-tools";

// Assistant-only UI tools against a fake MCP host (documents/clients/expenses) and an in-memory DB (assets,
// reminders, recurring invoices).

const docs: Record<number, Record<string, unknown>> = {
  4: { id: 4, type: "invoice", typeLabel: "Rechnung", number: "RE-2026-0004", status: "final", link: "/invoices/4" },
  7: { id: 7, type: "offer", typeLabel: "Angebot", number: null, status: "draft", link: "http://localhost:5174/offers/7" },
};
const mcpCalls: string[] = [];
const mcp: ToolHost = {
  tools: [{ name: "get_document", description: "", inputSchema: {}, readOnly: true, destructive: false, group: "core" } satisfies ChatTool],
  async call(name, args) {
    mcpCalls.push(name);
    const id = args.id as number;
    if (name === "get_document" && docs[id]) return { isError: false, text: "Beleg", structured: docs[id]! };
    if (name === "get_client" && id === 3) return { isError: false, text: "Kunde", structured: { id: 3, name: "Alpen GmbH", link: "/clients/3" } };
    if (name === "search") {
      const results =
        args.query === "RE-2026-0004"
          ? [{ type: "client", id: 3 }, { type: "invoice", id: 4 }]
          : args.query === "Alpen"
            ? [{ type: "client", id: 3, label: "Alpen GmbH" }, { type: "invoice", id: 4, label: "RE-2026-0004", sublabel: "Alpen GmbH" }, { type: "offer", id: 7, label: "Angebot (Entwurf)", sublabel: "Alpen GmbH" }]
            : [];
      return { isError: false, text: "Treffer", structured: { query: args.query, results } };
    }
    return { isError: true, text: "Fehler: nicht gefunden", structured: null };
  },
};

let db: Db;
let host: ToolHost;
beforeEach(() => {
  db = createTestDb();
  host = withUiTools(mcp, db);
  mcpCalls.length = 0;
});

describe("UI tools", () => {
  test("composed host: MCP tools plus the ui group; other calls pass through", async () => {
    expect(host.tools.map((t) => t.name)).toEqual(["get_document", "open_in_app", "open_pdf", "download_pdf"]);
    expect(UI_TOOLS.every((t) => t.group === "ui" && t.readOnly && !t.destructive)).toBe(true);
    expect((await host.call("search", { query: "x" })).text).toBe("Treffer");
  });

  test("open_in_app: records are checked, pages by name or alias", async () => {
    expect(await host.call("open_in_app", { what: "invoice", id: 4 })).toEqual({
      isError: false,
      text: "Rechnung RE-2026-0004 wird in der App geöffnet.",
      structured: null,
      action: { kind: "navigate", path: "/invoices/4", label: "Rechnung RE-2026-0004" },
    });
    // absolute web links are reduced to the app path; the type comes from the document, not from `what`
    expect((await host.call("open_in_app", { what: "document", id: 7 })).action).toEqual({ kind: "navigate", path: "/offers/7", label: "Angebot (Entwurf)" });
    expect((await host.call("open_in_app", { what: "client", id: "3" })).action).toMatchObject({ path: "/clients/3", label: "Kunde Alpen GmbH" });
    const missing = await host.call("open_in_app", { what: "invoice", id: 99 });
    expect(missing.isError).toBe(true);
    expect(missing.action).toBeUndefined();
    expect(missing.text).toContain("id 99 nicht gefunden");
    expect((await host.call("open_in_app", { what: "bank" })).action).toEqual({ kind: "navigate", path: "/bank", label: "Bank" });
    expect((await host.call("open_in_app", { what: "Rechnungen" })).action).toEqual({ kind: "navigate", path: "/invoices", label: "Rechnungen" });
    expect((await host.call("open_in_app", { what: "Prognose" })).action).toMatchObject({ path: "/forecast" });
    // no detail page: the list page even with an id
    expect((await host.call("open_in_app", { what: "fixed_cost", id: 2 })).action).toMatchObject({ path: "/fixed-costs" });
    expect((await host.call("open_in_app", { what: "rocket" })).isError).toBe(true);
    expect((await host.call("open_in_app", { what: "invoice", id: -3 })).text).toContain("Ungültige id");
  });

  test("records by number (resolved via search), also when the model puts the number into id", async () => {
    expect((await host.call("open_in_app", { what: "invoice", number: "RE-2026-0004" })).action).toMatchObject({ path: "/invoices/4" });
    expect((await host.call("open_in_app", { what: "document", id: "RE-2026-0004" })).action).toMatchObject({ path: "/invoices/4" });
    expect((await host.call("open_in_app", { what: "invoice", number: "RE-2099-0001" })).text).toBe("Fehler: Rechnungen: „RE-2099-0001“ nicht gefunden – mit search suchen");
    expect((await host.call("download_pdf", { number: "RE-2026-0004" })).action).toMatchObject({ url: "/api/pdf/documents/4?download=1", fileName: "RE-2026-0004.pdf" });
    expect((await host.call("open_pdf", { number: "RE-2099-0001" })).isError).toBe(true);
  });

  test("open_in_app: DB-checked records (asset, reminder, recurring invoice)", async () => {
    const a = db
      .insert(fixedAssets)
      .values({ number: 1, name: "MacBook", acquisitionDate: "2026-01-10", inServiceDate: "2026-01-10", costCents: 250000, usefulLifeYears: 3 })
      .returning()
      .get();
    expect((await host.call("open_in_app", { what: "asset", id: a.id })).action).toEqual({ kind: "navigate", path: `/assets/${a.id}`, label: "Anlage AV-0001 MacBook" });
    expect((await host.call("open_in_app", { what: "reminder", id: 1 })).isError).toBe(true);
    expect((await host.call("open_in_app", { what: "recurring_invoice", id: 1 })).isError).toBe(true);
    expect((await host.call("open_in_app", { what: "reminder" })).action).toMatchObject({ path: "/reminders" });
  });

  test("open_pdf / download_pdf: tab or download with the route's file name; drafts are previews", async () => {
    expect(await host.call("open_pdf", { id: 4 })).toMatchObject({
      isError: false,
      text: "PDF Rechnung RE-2026-0004 wird in einem neuen Tab geöffnet.",
      action: { kind: "open_tab", url: "/api/pdf/documents/4", label: "PDF Rechnung RE-2026-0004" },
    });
    expect((await host.call("download_pdf", { id: 4 })).action).toEqual({
      kind: "download",
      url: "/api/pdf/documents/4?download=1",
      fileName: "RE-2026-0004.pdf",
      label: "RE-2026-0004.pdf",
    });
    const draft = await host.call("download_pdf", { id: 7, type: "document" });
    expect(draft.text).toBe("PDF-Vorschau Angebot (Entwurf) wird heruntergeladen (Entwurf-7.pdf).");
    expect(draft.action).toMatchObject({ fileName: "Entwurf-7.pdf" });
    expect((await host.call("open_pdf", { id: 99 })).isError).toBe(true);
    expect((await host.call("open_pdf", {})).text).toContain("id, number oder query fehlt");
    expect((await host.call("open_pdf", { id: 1, type: "reminder" })).text).toContain("Mahnung id 1 nicht gefunden");
    expect((await host.call("open_pdf", { id: 3, type: "client" })).text).toContain("PDFs gibt es nur");
  });

  test("query: a unique hit opens, several hits come back as candidates for the model to ask", async () => {
    expect((await host.call("open_in_app", { what: "client", query: "Alpen" })).action).toMatchObject({ path: "/clients/3" });
    const ambiguous = await host.call("open_pdf", { query: "Alpen" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toBe(
      "Fehler: Beleg: „Alpen“ ist nicht eindeutig (2 Treffer: RE-2026-0004 · Alpen GmbH (id 4); Angebot (Entwurf) · Alpen GmbH (id 7)). Frag den Nutzer, welcher gemeint ist, und ruf dann mit der id auf.",
    );
    expect((await host.call("open_in_app", { what: "expense", query: "Alpen" })).text).toContain("„Alpen“ nicht gefunden");
  });

  test("nudges: download words → download_pdf; a search in a pure open request → open_in_app with query", () => {
    const n = (name: string, args: Record<string, unknown>, text: string) => nudgeUiCall(name, args, text);
    expect(n("open_pdf", { id: 4 }, "Lade mir die Vorschau vom Entwurf herunter")).toEqual({ name: "download_pdf", arguments: { id: 4 } });
    expect(n("open_pdf", { id: 4 }, "Zeig mir die Vorschau").name).toBe("open_pdf");
    expect(n("search", { query: "A1", limit: 6 }, "Öffne die Ausgabe von A1")).toEqual({ name: "open_in_app", arguments: { what: "expense", query: "A1" } });
    expect(n("search", { query: "Alpen" }, "Öffne das Angebot für Alpen")).toEqual({ name: "open_in_app", arguments: { what: "offer", query: "Alpen" } });
    // not a pure open request, or no record word: unchanged
    expect(n("search", { query: "Alpen" }, "Öffne die Rechnung von Alpen und markiere sie als bezahlt").name).toBe("search");
    expect(n("search", { query: "Alpen" }, "Wer ist Alpen?").name).toBe("search");
    expect(n("search", { query: "x" }, "Geh zu den Steuern").name).toBe("search");
  });

  test("a specific document type only matches its own search hits", async () => {
    expect((await host.call("open_in_app", { what: "offer", query: "Alpen" })).action).toMatchObject({ path: "/offers/7" });
  });
});
