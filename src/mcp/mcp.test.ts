import type { Client } from "@modelcontextprotocol/client";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "../server/lib/paths";
import { connectClient, MODERN_VERSION } from "./test/client";
import type { SeedIds } from "./test/seed";

// End-to-end: the real entry (`bun run mcp`) as a subprocess on a seeded temp data dir, driven by the SDK client in
// both protocol eras (2025 initialize handshake and 2026-07-28 negotiation).

const TOOLS = [
  "search",
  "get_dashboard",
  "list_documents",
  "get_document",
  "list_reminders_due",
  "list_clients",
  "get_client",
  "list_articles",
  "list_expenses",
  "get_expense",
  "list_fixed_costs",
  "get_forecast",
  "get_tax_report",
  "list_assets",
];
/** appended after the read tools, in this order */
const WRITE_TOOLS = [
  "create_client",
  "create_article",
  "create_invoice_draft",
  "create_offer_draft",
  "update_document_draft",
  "finalize_document",
  "mark_document_sent",
  "mark_invoice_paid",
  "convert_offer_to_invoice",
  "create_credit_note",
  "create_reminder",
  "create_expense",
  "get_receipt_analysis",
  "queue_receipt_analysis",
];
const STATE_CHANGING = ["finalize_document", "mark_document_sent", "mark_invoice_paid", "convert_offer_to_invoice", "create_credit_note", "create_reminder"];
const WEB_URL = "http://nesev.test:4321";
/** never the user's server (the default NESEV_API_URL is http://localhost:3998): nothing listens on port 9 */
const DEAD_API_URL = "http://127.0.0.1:9";

let dataDir: string;
let ids: SeedIds;
const clients: Record<"legacy" | "modern", Client> = {} as never;

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };
/** structured content, checked field by field */
type Data = any;

async function callTool(name: string, args: Record<string, unknown> = {}, era: "legacy" | "modern" = "legacy") {
  const res = (await clients[era].callTool({ name, arguments: args })) as ToolResult;
  const text = res.content.map((c) => c.text ?? "").join("\n");
  return { ...res, text, data: res.structuredContent as Data };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "nesev-mcp-test-"));
  const seed = Bun.spawnSync([process.execPath, "src/mcp/test/seed.ts"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NESEV_DATA_DIR: dataDir },
  });
  if (seed.exitCode !== 0) throw new Error(`seed failed: ${seed.stderr.toString()}`);
  ids = JSON.parse(seed.stdout.toString().trim().split("\n").at(-1)!);
  const env = { NESEV_WEB_URL: `${WEB_URL}/`, NESEV_API_URL: DEAD_API_URL };
  [clients.legacy, clients.modern] = await Promise.all([
    connectClient({ dataDir, era: "legacy", env }),
    connectClient({ dataDir, era: "modern", env }),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.all(Object.values(clients).map((c) => c?.close()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("protocol eras", () => {
  test("legacy client uses the initialize handshake, modern client negotiates 2026-07-28", () => {
    expect(clients.legacy.getProtocolEra()).toBe("legacy");
    expect(clients.modern.getProtocolEra()).toBe("modern");
    expect(clients.modern.getNegotiatedProtocolVersion()).toBe(MODERN_VERSION);
    expect(clients.legacy.getServerVersion()?.name).toBe("nesev");
  });

  for (const era of ["legacy", "modern"] as const) {
    test(`${era}: tools/list is deterministic, annotated and has output schemas`, async () => {
      const { tools } = await clients[era].listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOLS, ...WRITE_TOOLS]);
      for (const t of tools) {
        const readOnly = TOOLS.includes(t.name) || t.name === "get_receipt_analysis";
        expect({ name: t.name, readOnly: t.annotations?.readOnlyHint }).toEqual({ name: t.name, readOnly });
        expect(t.annotations?.openWorldHint).toBe(false);
        if (!readOnly) {
          const destructive = STATE_CHANGING.includes(t.name);
          expect({ name: t.name, destructive: t.annotations?.destructiveHint }).toEqual({ name: t.name, destructive });
        }
        expect(t.outputSchema?.type).toBe("object");
        expect(t.description!.length).toBeGreaterThan(80);
      }
      for (const name of ["finalize_document", "create_reminder"]) {
        expect(tools.find((t) => t.name === name)!.description).toContain("IRREVERSIBL");
      }
      const again = await clients[era].listTools();
      expect(again.tools.map((t) => t.name)).toEqual([...TOOLS, ...WRITE_TOOLS]);
    });
  }
});

describe("tools", () => {
  test("every tool answers in both eras (structured content validated by the client)", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["search", { query: "alpen" }],
      ["get_dashboard", {}],
      ["list_documents", {}],
      ["get_document", { id: ids.documents.overdueInvoice }],
      ["list_reminders_due", {}],
      ["list_clients", {}],
      ["get_client", { id: ids.clients.alpen }],
      ["list_articles", {}],
      ["list_expenses", {}],
      ["get_expense", { id: ids.expenses.adobe }],
      ["list_fixed_costs", {}],
      ["get_forecast", {}],
      ["get_tax_report", { kind: "uva" }],
      ["list_assets", {}],
    ];
    expect(calls.map(([n]) => n)).toEqual(TOOLS);
    for (const era of ["legacy", "modern"] as const) {
      for (const [name, args] of calls) {
        const res = await callTool(name, args, era);
        expect({ name, era, isError: res.isError ?? false }).toEqual({ name, era, isError: false });
        expect(res.data).toBeObject();
        expect(res.text.length).toBeGreaterThan(10);
      }
    }
  }, 30_000);

  test("search finds the overdue invoice by number and amount", async () => {
    const byNumber = await callTool("search", { query: "re1" });
    expect(byNumber.data.results.some((r: Data) => r.type === "invoice" && r.id === ids.documents.overdueInvoice)).toBe(true);
    const byAmount = await callTool("search", { query: "1.284,00" });
    const hit = byAmount.data.results.find((r: Data) => r.id === ids.documents.overdueInvoice);
    expect(hit.link).toBe(`${WEB_URL}/invoices/${ids.documents.overdueInvoice}`);
  });

  test("get_document: items, credit note, open amount, frozen PDF", async () => {
    const { data, text } = await callTool("get_document", { id: ids.documents.overdueInvoice });
    expect(data.number).toMatch(/^RE-\d{4}-0001$/);
    expect(data.statusLabel).toBe("Überfällig");
    expect(data.gross).toEqual({ cents: 128400, formatted: expect.stringContaining("1.284,00") });
    expect(data.open.cents).toBe(114000);
    expect(data.payment.credited.cents).toBe(14400);
    expect(data.items.map((i: Data) => [i.title, i.quantity, i.unitPrice.cents, i.taxRatePercent, i.net.cents])).toEqual([
      ["Webentwicklung", 10, 9500, 20, 95000],
      ["Hosting", 1, 12000, 20, 12000],
    ]);
    expect(data.taxGroups).toHaveLength(1);
    expect(data.children).toHaveLength(1);
    expect(data.children[0]).toMatchObject({ id: ids.documents.creditNote, type: "credit_note", gross: { cents: 14400 } });
    expect(data.pdf.path.startsWith(dataDir)).toBe(true);
    expect(existsSync(data.pdf.path)).toBe(true);
    expect(data.link).toBe(`${WEB_URL}/invoices/${ids.documents.overdueInvoice}`);
    expect(text).toMatch(/offen €\s1\.140,00/);

    const draft = await callTool("get_document", { id: ids.documents.draftInvoice });
    expect(draft.data.number).toBeNull();
    expect(draft.data.pdf).toBeNull();
    expect(draft.data.payment).toBeNull();
  });

  test("list_documents: open, overdue and type filters, limit", async () => {
    const open = await callTool("list_documents", { status: "open" });
    expect(open.data.documents.map((d: Data) => d.id).sort()).toEqual([ids.documents.overdueInvoice, ids.documents.offer].sort());
    expect(open.data.sumOpen.cents).toBe(114000);

    const overdue = await callTool("list_documents", { status: "overdue" });
    expect(overdue.data.documents.map((d: Data) => d.id)).toEqual([ids.documents.overdueInvoice]);

    const invoices = await callTool("list_documents", { type: "invoice", limit: 1 });
    expect(invoices.data.total).toBe(3);
    expect(invoices.data.truncated).toBe(true);
    expect(invoices.data.documents).toHaveLength(1);
  });

  test("get_client lists the open invoices", async () => {
    const { data } = await callTool("get_client", { id: ids.clients.alpen });
    expect(data.number).toBe("K-0001");
    expect(data.documentCounts).toEqual({ offer: 1, invoice: 2, credit_note: 1 });
    expect(data.openInvoices).toMatchObject({ count: 1, overdueCount: 1, open: { cents: 114000 } });
  });

  test("dunning, expenses, fixed costs, assets", async () => {
    const due = await callTool("list_reminders_due");
    expect(due.data.invoices).toHaveLength(1);
    expect(due.data.invoices[0]).toMatchObject({ invoiceId: ids.documents.overdueInvoice, currentLevel: 0, suggestedLevel: 1, dueForReminder: true });

    // "open" = unpaid and complete; the incomplete draft only shows up with status "incomplete"
    const unpaid = await callTool("list_expenses", { status: "open" });
    expect(unpaid.data.expenses.map((e: Data) => e.id)).toEqual([ids.expenses.adobe]);
    const incomplete = await callTool("list_expenses", { status: "incomplete" });
    expect(incomplete.data.expenses.map((e: Data) => e.id)).toEqual([ids.expenses.incomplete]);

    const adobe = await callTool("get_expense", { id: ids.expenses.adobe });
    expect(adobe.data).toMatchObject({ vatTreatment: "reverse_charge", net: { cents: 6000 }, tax: { cents: 1200 }, gross: { cents: 6000 }, receipt: null });
    expect(adobe.data.lines[0]).toMatchObject({ category: "software_abos", taxRatePercent: 20, deductiblePercent: 100 });

    const fixed = await callTool("list_fixed_costs");
    expect(fixed.data.monthlyTotal.cents).toBe(60000);

    const assets = await callTool("list_assets");
    expect(assets.data.assets[0]).toMatchObject({ number: "AV-0001", cost: { cents: 240000 }, afa: { cents: 80000 } });
  });

  test("forecast and tax reports", async () => {
    const f = await callTool("get_forecast", { months: 3, topEntries: 3 });
    expect(f.data.months).toHaveLength(3);
    expect(f.data.topEntries).toHaveLength(3);
    expect(f.data.kpis.inOverdue.cents).toBe(114000);
    expect(f.data.startBalance).toBeNull();

    const invoiceMonth = (await callTool("get_document", { id: ids.documents.overdueInvoice })).data.issueDate.slice(0, 7);
    const uva = await callTool("get_tax_report", { kind: "uva", period: invoiceMonth });
    expect(uva.data.lines.find((l: Data) => l.code === "022")).toMatchObject({ amount: { cents: 107000 }, tax: { cents: 21400 } });
    expect(uva.text).toContain("keine Steuerberatung");

    const ear = await callTool("get_tax_report", { kind: "ear" });
    expect(ear.data.lines.filter((l: Data) => l.code === "9040")).toHaveLength(1);
    expect(ear.data.warnings.some((w: string) => w.includes("unvollständige"))).toBe(true);
  });
});

describe("errors", () => {
  test("unknown ids become tool errors with the API's German message", async () => {
    for (const era of ["legacy", "modern"] as const) {
      const doc = await callTool("get_document", { id: 99999 }, era);
      expect(doc.isError).toBe(true);
      expect(doc.text).toBe("Fehler: Beleg nicht gefunden");
      const client = await callTool("get_client", { id: 99999 }, era);
      expect(client.isError).toBe(true);
      expect(client.text).toContain("Kunde nicht gefunden");
    }
  });

  test("invalid input is rejected before the handler runs", async () => {
    const res = await callTool("get_tax_report", { kind: "uva", period: "2026-13" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("period");
  });
});

const FIXTURES = join(PROJECT_ROOT, "src/mcp/test/fixtures");
const seq = (number: string) => Number(number.split("-").at(-1));

describe("write tools", () => {
  let clientId: number;
  let articleId: number;
  let invoiceId: number;

  test("create_client, with duplicate check", async () => {
    const created = await callTool("create_client", { name: "Wiener Werkstatt OG", city: "Wien", zip: "1070", email: "office@werkstatt.at", paymentTermsDays: 10 });
    expect(created.isError).toBeFalsy();
    expect(created.data).toMatchObject({ name: "Wiener Werkstatt OG", country: "AT", paymentTermsDays: 10, openInvoices: { count: 0 } });
    expect(created.data.number).toMatch(/^K-\d{4}$/);
    clientId = created.data.id;

    const dupe = await callTool("create_client", { name: "Wiener Werkstatt" });
    expect(dupe.isError).toBe(true);
    expect(dupe.text).toContain("Möglicher Duplikat-Kunde");
    expect(dupe.text).toContain(`id ${clientId}`);
    const byUid = await callTool("create_client", { name: "Ganz Anders", uid: "de 123 456 789" });
    expect(byUid.isError).toBe(true);
    const forced = await callTool("create_client", { name: "Wiener Werkstatt", allowDuplicate: true });
    expect(forced.isError).toBeFalsy();
  });

  test("create_article parses euros and normalizes the unit", async () => {
    const a = await callTool("create_article", { title: "Wartungspauschale", unit: "pauschal", unitPrice: "1.250,50", taxRate: 20 });
    expect(a.data).toMatchObject({ unit: "Pauschal", unitPrice: { cents: 125050 }, taxRatePercent: 20 });
    articleId = a.data.id;
    const badRate = await callTool("create_article", { title: "x", unit: "Stk.", unitPrice: 1, taxRate: 19 });
    expect(badRate.isError).toBe(true);
    expect(badRate.text).toContain("Steuersatz 19 %");
  });

  test("create_invoice_draft: client by name, euro strings, article defaults, unit and ambiguity errors", async () => {
    const draft = await callTool("create_invoice_draft", {
      clientName: "wiener werkstatt og",
      title: "Reparatur",
      items: [
        { title: "Arbeitszeit", quantity: 2.5, unit: "Std.", unitPrice: "80,00" },
        { title: "Material", quantity: 3, unit: "Stk.", unitPrice: "12.5", taxRate: 20, discount: 10 },
        { articleId, title: "", quantity: 1 },
      ],
    });
    expect(draft.isError).toBeFalsy();
    expect(draft.data).toMatchObject({ status: "draft", number: null, clientId, taxMode: "AT_DOMESTIC" });
    // 200,00 + 33,75 + 1.250,50 = 1.484,25 net, 20 % VAT
    expect(draft.data.net.cents).toBe(148425);
    expect(draft.data.gross.cents).toBe(178110);
    expect(draft.data.items[2]).toMatchObject({ title: "Wartungspauschale", unit: "Pauschal", articleId });
    expect(draft.data.dueDate).not.toBeNull();
    invoiceId = draft.data.id;

    const unit = await callTool("create_invoice_draft", { clientId, items: [{ title: "x", quantity: 1, unit: "Stunden", unitPrice: 1 }] });
    expect(unit.isError).toBe(true);
    expect(unit.text).toContain("Erlaubt: Std., Stk.");
    const ambiguous = await callTool("create_invoice_draft", { clientName: "GmbH", items: [{ title: "x", quantity: 1, unit: "Std.", unitPrice: 1 }] });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("nicht eindeutig");
    const unknown = await callTool("create_invoice_draft", { clientName: "Niemand AG", items: [{ title: "x", quantity: 1, unit: "Std.", unitPrice: 1 }] });
    expect(unknown.text).toContain("Kein aktiver Kunde");
    const badEuro = await callTool("create_invoice_draft", { clientId, items: [{ title: "x", quantity: 1, unit: "Std.", unitPrice: "zwölf" }] });
    expect(badEuro.isError).toBe(true);
    expect(badEuro.text).toContain("Ungültiger Betrag");
  });

  test("update_document_draft replaces items; finalize assigns gapless numbers; finalized drafts are locked", async () => {
    const updated = await callTool("update_document_draft", { id: invoiceId, items: [{ title: "Arbeitszeit", quantity: 1, unit: "Std.", unitPrice: 100 }] });
    expect(updated.data.items).toHaveLength(1);
    expect(updated.data.gross.cents).toBe(12000);

    const before = await callTool("list_documents", { type: "invoice" });
    const year = updated.data.issueDate.slice(0, 4);
    const maxSeq = Math.max(0, ...before.data.documents.filter((d: Data) => d.number?.startsWith(`RE-${year}-`)).map((d: Data) => seq(d.number)));

    const fin = await callTool("finalize_document", { id: invoiceId });
    expect(fin.isError).toBeFalsy();
    expect(fin.data.number).toBe(`RE-${year}-${String(maxSeq + 1).padStart(4, "0")}`);
    expect(existsSync(fin.data.pdf.path)).toBe(true);
    expect(fin.text).toContain(`Finalisiert: ${fin.data.number}`);

    const second = await callTool("create_invoice_draft", { clientId, items: [{ title: "Nachtrag", quantity: 1, unit: "Pauschal", unitPrice: 50 }] });
    const fin2 = await callTool("finalize_document", { id: second.data.id });
    expect(seq(fin2.data.number)).toBe(maxSeq + 2);

    const locked = await callTool("update_document_draft", { id: invoiceId, title: "geändert" });
    expect(locked.isError).toBe(true);
    expect(locked.text).toBe("Fehler: Finalisierte Belege können nicht mehr bearbeitet werden");
    const again = await callTool("finalize_document", { id: invoiceId });
    expect(again.text).toBe("Fehler: Beleg ist bereits finalisiert");
  });

  test("mark_document_sent and mark_invoice_paid (with amount check)", async () => {
    const sent = await callTool("mark_document_sent", { id: invoiceId });
    expect(sent.data.status).toBe("sent");
    const wrong = await callTool("mark_invoice_paid", { id: invoiceId, expectedAmount: "100,00" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("Offener Betrag ist");
    const paid = await callTool("mark_invoice_paid", { id: invoiceId, expectedAmount: 120, paidAt: sent.data.issueDate });
    expect(paid.data).toMatchObject({ status: "paid", paidAt: sent.data.issueDate });
  });

  test("offer → finalize → convert_offer_to_invoice", async () => {
    const offer = await callTool("create_offer_draft", { clientId, items: [{ title: "Umbau", quantity: 10, unit: "Std.", unitPrice: 90 }] });
    expect(offer.data).toMatchObject({ type: "offer", status: "draft" });
    expect(offer.data.validUntil).not.toBeNull();
    const fin = await callTool("finalize_document", { id: offer.data.id });
    expect(fin.data.number).toMatch(/^AN-/);
    const inv = await callTool("convert_offer_to_invoice", { offerId: offer.data.id });
    expect(inv.data).toMatchObject({ type: "invoice", status: "draft", parent: { id: offer.data.id, status: "accepted" }, net: { cents: 90000 } });
  });

  test("create_credit_note: full or selected positions", async () => {
    const full = await callTool("create_credit_note", { invoiceId: ids.documents.paidInvoice });
    expect(full.data).toMatchObject({ type: "credit_note", status: "draft", parent: { id: ids.documents.paidInvoice }, gross: { cents: 76000 } });

    const partial = await callTool("create_credit_note", { invoiceId: ids.documents.overdueInvoice, items: [{ position: 1, quantity: 2, unitPrice: "90,00" }] });
    expect(partial.data.items).toHaveLength(1);
    expect(partial.data.items[0]).toMatchObject({ title: "Webentwicklung", quantity: 2, unitPrice: { cents: 9000 } });
    expect(partial.data.gross.cents).toBe(21600);

    const bad = await callTool("create_credit_note", { invoiceId: ids.documents.overdueInvoice, items: [{ position: 9 }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Position 9");
    const onDraft = await callTool("create_credit_note", { invoiceId: ids.documents.draftInvoice });
    expect(onDraft.text).toBe("Fehler: Rechnung muss zuerst finalisiert werden");
  });

  test("create_reminder finalizes with number and PDF", async () => {
    const r = await callTool("create_reminder", { invoiceId: ids.documents.overdueInvoice });
    expect(r.isError).toBeFalsy();
    expect(r.data).toMatchObject({ invoiceId: ids.documents.overdueInvoice, level: 1, status: "final", open: { cents: 114000 } });
    expect(r.data.number).toMatch(/^MA-\d{4}-0001$/);
    expect(existsSync(r.data.pdf.path)).toBe(true);
    const notOverdue = await callTool("create_reminder", { invoiceId: invoiceId });
    expect(notOverdue.isError).toBe(true);
  });

  test("create_expense: gross lines, receipt upload, Fixkosten link, file checks", async () => {
    const before = (await callTool("list_expenses", { limit: 500 })).data.total;
    const slot = `${new Date().getFullYear()}-01-01`;
    const e = await callTool("create_expense", {
      supplierName: "Hausverwaltung Wien",
      issueDate: slot,
      paidAt: slot,
      description: "Miete Jänner",
      lines: [{ category: "miete", gross: "600,00", taxRate: 20 }],
      receiptPath: join(FIXTURES, "receipt.png"),
      fixedCostId: ids.fixedCost,
      fixedCostSlot: slot,
    });
    expect(e.isError).toBeFalsy();
    expect(e.data).toMatchObject({ net: { cents: 50000 }, tax: { cents: 10000 }, gross: { cents: 60000 }, vatTreatment: "domestic", hasReceipt: true });
    expect(e.data.fixedCost).toMatchObject({ id: ids.fixedCost, scheduledDate: slot });
    expect(e.data.receipt.fileName).toBe("receipt.png");
    expect(existsSync(e.data.receipt.path)).toBe(true);

    const rc = await callTool("create_expense", {
      supplierName: "Hetzner Online GmbH",
      supplierCountry: "DE",
      supplierUid: "DE812871812",
      issueDate: slot,
      lines: [{ category: "software_abos", net: 10, taxRate: 20 }],
      receiptPath: join(FIXTURES, "receipt.pdf"),
    });
    expect(rc.data).toMatchObject({ vatTreatment: "reverse_charge", gross: { cents: 1000 }, tax: { cents: 200 } });

    const missing = await callTool("create_expense", { supplierName: "X", issueDate: slot, lines: [{ category: "buero", net: 1 }], receiptPath: "/nonexistent/beleg.pdf" });
    expect(missing.text).toContain("Belegdatei nicht gefunden");
    const fake = await callTool("create_expense", { supplierName: "X", issueDate: slot, lines: [{ category: "buero", net: 1 }], receiptPath: join(FIXTURES, "not-a-pdf.pdf") });
    expect(fake.text).toContain("kein gültiges PDF");
    const both = await callTool("create_expense", { supplierName: "X", issueDate: slot, lines: [{ category: "buero", net: 1, gross: 1 }] });
    expect(both.text).toContain("net oder gross");
    // failed calls created nothing
    expect((await callTool("list_expenses", { limit: 500 })).data.total).toBe(before + 2);
  });

  test("receipt analysis: read, unreachable server, fake server, data mismatch", async () => {
    const none = await callTool("get_receipt_analysis", { expenseId: ids.expenses.telekom });
    expect(none.data.analysis).toBeNull();

    const withReceipt = (await callTool("list_expenses", { receipt: "with" })).data.expenses[0].id as number;
    const dead = await callTool("queue_receipt_analysis", { expenseIds: [withReceipt] });
    expect(dead.isError).toBe(true);
    expect(dead.text).toContain(`nesev-Server unter ${DEAD_API_URL} nicht erreichbar`);

    // a fake nesev server on a random port: GET /api/expenses/:id from the same DB, POST /api/receipts/analyze recorded
    const sqlite = new Database(join(dataDir, "nesev.db"), { readonly: true });
    const posted: unknown[] = [];
    let tamper = false;
    const fakeServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const m = /^\/api\/expenses\/(\d+)$/.exec(url.pathname);
        if (req.method === "GET" && m) {
          const row = sqlite.query("select id, number, supplier_name as supplierName, attachment_path as attachmentPath from expenses where id = ?").get(Number(m[1])) as Data;
          if (!row) return Response.json({ error: "Ausgabe nicht gefunden" }, { status: 404 });
          return Response.json(tamper ? { ...row, supplierName: "Jemand anderes" } : row);
        }
        if (req.method === "POST" && url.pathname === "/api/receipts/analyze") {
          const body = (await req.json()) as { expenseIds: number[] };
          posted.push(body);
          return Response.json({ queued: body.expenseIds.filter((id) => id === withReceipt), skipped: body.expenseIds.filter((id) => id !== withReceipt).map((expenseId) => ({ expenseId, reason: "Kein Beleg" })) });
        }
        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });
    const viaFake = await connectClient({ dataDir, env: { NESEV_API_URL: `http://127.0.0.1:${fakeServer.port}` } });
    try {
      const ok = (await viaFake.callTool({ name: "queue_receipt_analysis", arguments: { expenseIds: [withReceipt, ids.expenses.telekom] } })) as ToolResult;
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ queued: [withReceipt], skipped: [{ expenseId: ids.expenses.telekom }] });
      expect(posted).toEqual([{ expenseIds: [withReceipt, ids.expenses.telekom] }]);

      tamper = true;
      const mismatch = (await viaFake.callTool({ name: "queue_receipt_analysis", arguments: { expenseIds: [withReceipt] } })) as ToolResult;
      expect(mismatch.isError).toBe(true);
      expect(mismatch.content[0]!.text).toContain("arbeitet mit anderen Daten");
      expect(posted).toHaveLength(1);
    } finally {
      await viaFake.close();
      fakeServer.stop(true);
      sqlite.close();
    }
  }, 30_000);

  test("the MCP process refuses to start receipt analysis in-process", () => {
    const script = `import { api } from "./src/mcp/api";
const res = await api.receipts.analyze.$post({ json: { expenseIds: [1] } });
console.error(JSON.stringify({ status: res.status, body: await res.json() }));`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: PROJECT_ROOT, env: { ...process.env, NESEV_DATA_DIR: dataDir } });
    const out = JSON.parse(run.stderr.toString().trim().split("\n").at(-1)!);
    expect(out.status).toBe(403);
    expect(out.body.error).toContain("nicht im MCP-Prozess");
  });
});

/** Responses (top-level id) among the complete stdout lines so far; a non-JSON line counts as a response so the loop ends. */
function countIds(out: string) {
  const complete = out.split("\n").slice(0, -1).filter((l) => l.trim());
  return complete.filter((l) => {
    try {
      return JSON.parse(l).id !== undefined;
    } catch {
      return true;
    }
  }).length;
}

test("stdout carries only JSON-RPC (raw `bun run mcp`)", async () => {
  const proc = Bun.spawn([process.execPath, "run", "mcp"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NESEV_DATA_DIR: dataDir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (msg: object) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_document", arguments: { id: ids.documents.overdueInvoice } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_dashboard", arguments: {} } });
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_document", arguments: { id: 99999 } } });

  // read until all five responses are in, then close stdin so the server exits
  const decoder = new TextDecoder();
  let out = "";
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 15_000;
  while (countIds(out) < 5 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  proc.stdin.end();
  await proc.exited;

  const lines = out.split("\n").filter((l) => l.trim());
  const messages = lines.map((l) => JSON.parse(l));
  for (const m of messages) expect(m.jsonrpc).toBe("2.0");
  expect(messages.map((m) => m.id).filter((id) => id !== undefined).sort()).toEqual([1, 2, 3, 4, 5]);
  expect(messages.find((m) => m.id === 5).result.isError).toBe(true);
}, 30_000);
