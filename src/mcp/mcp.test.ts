import type { Client } from "@modelcontextprotocol/client";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "../server/lib/paths";
import { addDays, todayIso } from "../shared/dates";
import { addMonthsAnchored } from "../shared/recurring";
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
/** appended after WRITE_TOOLS (tools/bank.ts, tools/recurring.ts, tools/write-records.ts), in this order */
const BANK_TOOLS: string[] = ["get_bank_overview", "list_bank_transactions", "get_bank_transaction", "match_bank_transaction", "unmatch_bank_transaction", "set_bank_transaction_ignored"];
const RECURRING_TOOLS: string[] = ["list_recurring_invoices", "set_recurring_invoice_active", "generate_recurring_invoice"];
const RECORD_TOOLS: string[] = ["update_client", "update_expense", "mark_expense_paid", "apply_receipt_analysis", "create_fixed_cost", "link_expense_to_fixed_cost", "create_asset"];
const MORE_READ_ONLY: string[] = ["get_bank_overview", "list_bank_transactions", "get_bank_transaction", "list_recurring_invoices"];
const MORE_STATE_CHANGING: string[] = ["match_bank_transaction", "unmatch_bank_transaction", "set_bank_transaction_ignored", "set_recurring_invoice_active", "generate_recurring_invoice", "update_client", "update_expense", "mark_expense_paid", "apply_receipt_analysis", "link_expense_to_fixed_cost"];
const ALL_TOOLS = [...TOOLS, ...WRITE_TOOLS, ...BANK_TOOLS, ...RECURRING_TOOLS, ...RECORD_TOOLS];
const STATE_CHANGING = [...MORE_STATE_CHANGING, "finalize_document", "mark_document_sent", "mark_invoice_paid", "convert_offer_to_invoice", "create_credit_note", "create_reminder"];
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
      expect(tools.map((t) => t.name)).toEqual(ALL_TOOLS);
      for (const t of tools) {
        const readOnly = TOOLS.includes(t.name) || MORE_READ_ONLY.includes(t.name) || t.name === "get_receipt_analysis";
        expect({ name: t.name, readOnly: t.annotations?.readOnlyHint }).toEqual({ name: t.name, readOnly });
        expect(t.annotations?.openWorldHint).toBe(false);
        if (!readOnly) {
          const destructive = STATE_CHANGING.includes(t.name);
          expect({ name: t.name, destructive: t.annotations?.destructiveHint }).toEqual({ name: t.name, destructive });
        }
        expect(t.outputSchema?.type).toBe("object");
        expect(["core", "documents", "clients", "expenses", "bank", "finance"]).toContain(t._meta?.["nesev/group"] as string);
        expect(t.description!.length).toBeGreaterThan(80);
      }
      for (const name of ["finalize_document", "create_reminder"]) {
        expect(tools.find((t) => t.name === name)!.description).toContain("IRREVERSIBL");
      }
      const again = await clients[era].listTools();
      expect(again.tools.map((t) => t.name)).toEqual(ALL_TOOLS);
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

// ── bank + recurring (tools/bank.ts, tools/recurring.ts) ──────────────────────────
// Every match is undone again, so later tests see the seeded payment state.
describe("bank and recurring tools", () => {
  const invoiceOpen = async () => (await callTool("get_document", { id: ids.documents.overdueInvoice })).data;

  test("get_bank_overview and list_bank_transactions with filters", async () => {
    const o = await callTool("get_bank_overview");
    expect(o.isError).toBeFalsy();
    expect(o.data).toMatchObject({ openCount: 3, openIn: { cents: 114000 }, openOut: { cents: 7234 } });
    expect(o.data.accounts).toEqual([
      expect.objectContaining({ id: ids.bank.account, iban: "AT61 1904 3002 3457 3201", transactionCount: 3, openCount: 3, link: `${WEB_URL}/bank?account=${ids.bank.account}` }),
    ]);

    const open = await callTool("list_bank_transactions");
    expect(open.data).toMatchObject({ total: 3, truncated: false, sumIn: { cents: 114000 }, sumOut: { cents: -7234 } });
    expect(open.data.transactions[0]).toMatchObject({ id: ids.bank.alpenPayment, direction: "in", status: "open", statusLabel: "Offen", remaining: { cents: 114000 }, matches: [] });
    expect(open.data.transactions[0].link).toBe(`${WEB_URL}/bank?account=${ids.bank.account}&status=all&q=1140%2C00`);
    const out = await callTool("list_bank_transactions", { direction: "out", limit: 1 });
    expect(out.data).toMatchObject({ total: 2, truncated: true });
    const byAmount = await callTool("list_bank_transactions", { amount: "60,00", status: "all" });
    expect(byAmount.data.transactions.map((t: Data) => t.id)).toEqual([ids.bank.adobePayment]);
    const byText = await callTool("list_bank_transactions", { query: "billa" });
    expect(byText.data.transactions.map((t: Data) => t.id)).toEqual([ids.bank.billa]);
    expect((await callTool("list_bank_transactions", { status: "matched" })).data.total).toBe(0);
  });

  test("get_bank_transaction: suggestions with reasons, candidate search", async () => {
    const t = await callTool("get_bank_transaction", { id: ids.bank.alpenPayment });
    expect(t.data.suggestions[0]).toMatchObject({ kind: "invoice", id: ids.documents.overdueInvoice, confidence: "high", open: { cents: 114000 }, proposedAmount: { cents: 114000 } });
    expect(t.data.suggestions[0].reasons).toContain("Betrag exakt");
    expect(t.data.suggestions[0].link).toBe(`${WEB_URL}/invoices/${ids.documents.overdueInvoice}`);
    expect(t.text).toContain("Rechnungsnummer im Verwendungszweck");

    const search = await callTool("get_bank_transaction", { id: ids.bank.adobePayment, query: "adobe" });
    expect(search.data.suggestions.map((s: Data) => [s.kind, s.id])).toEqual([["expense", ids.expenses.adobe]]);
    expect(search.data.suggestions[0].link).toBe(`${WEB_URL}/expenses/${ids.expenses.adobe}`);

    const missing = await callTool("get_bank_transaction", { id: 99999 });
    expect(missing.text).toBe("Fehler: Buchung nicht gefunden");
  });

  test("match_bank_transaction: partial, rest, then unmatch one and all", async () => {
    const tx = ids.bank.alpenPayment;
    const inv = ids.documents.overdueInvoice;
    const part = await callTool("match_bank_transaction", { id: tx, targets: [{ kind: "invoice", id: inv, amount: "1.000,00" }] });
    expect(part.isError).toBeFalsy();
    expect(part.data).toMatchObject({ status: "open", allocated: { cents: 100000 }, remaining: { cents: 14000 } });
    expect(part.data.targets).toEqual([{ kind: "invoice", id: inv, open: { cents: 14000, formatted: expect.any(String) }, paid: false, link: `${WEB_URL}/invoices/${inv}` }]);
    expect((await invoiceOpen()).open.cents).toBe(14000);

    const rest = await callTool("match_bank_transaction", { id: tx, targets: [{ kind: "invoice", id: inv }] });
    expect(rest.data).toMatchObject({ status: "matched", remaining: { cents: 0 }, targets: [{ paid: true }] });
    expect(rest.data.matches).toHaveLength(2);
    expect(rest.data.matches[0]).toMatchObject({ kind: "invoice", id: inv, number: expect.stringMatching(/^RE-/), name: "Alpen Software GmbH" });
    expect(rest.text).toContain("vollständig bezahlt");
    expect((await invoiceOpen()).status).toBe("paid");
    expect((await callTool("list_bank_transactions", { status: "matched", query: "RE-" })).data.transactions.map((t: Data) => t.id)).toEqual([tx]);

    const full = await callTool("match_bank_transaction", { id: tx, targets: [{ kind: "invoice", id: inv }] });
    expect(full.text).toContain("bereits vollständig zugeordnet");

    const one = await callTool("unmatch_bank_transaction", { id: tx, matchId: rest.data.matches[1].matchId });
    expect(one.data).toMatchObject({ status: "open", remaining: { cents: 14000 } });
    expect(one.data.matches).toHaveLength(1);
    const foreign = await callTool("unmatch_bank_transaction", { id: tx, matchId: 99999 });
    expect(foreign.text).toContain("gehört nicht zu Buchung");
    const all = await callTool("unmatch_bank_transaction", { id: tx });
    expect(all.data).toMatchObject({ status: "open", matches: [], remaining: { cents: 114000 } });
    const after = await invoiceOpen();
    expect(after).toMatchObject({ open: { cents: 114000 }, statusLabel: "Überfällig" });
    expect((await callTool("unmatch_bank_transaction", { id: tx })).text).toContain("keine Zuordnungen");
  });

  test("match_bank_transaction: expense, wrong kind, split without amounts, too much", async () => {
    const adobe = await callTool("match_bank_transaction", { id: ids.bank.adobePayment, targets: [{ kind: "expense", id: ids.expenses.adobe }] });
    expect(adobe.data).toMatchObject({ status: "matched", targets: [{ kind: "expense", paid: true }] });
    expect((await callTool("get_expense", { id: ids.expenses.adobe })).data.paidAt).toBe(addDays(todayIso(), -3));
    await callTool("unmatch_bank_transaction", { id: ids.bank.adobePayment });
    expect((await callTool("get_expense", { id: ids.expenses.adobe })).data.paidAt).toBeNull();

    const tx = ids.bank.alpenPayment;
    const toExpense = await callTool("match_bank_transaction", { id: tx, targets: [{ kind: "expense", id: ids.expenses.adobe }] });
    expect(toExpense.text).toBe("Fehler: Zahlungseingänge können nur Rechnungen zugeordnet werden");
    const wrongKind = await callTool("match_bank_transaction", { id: tx, targets: [{ kind: "credit_note", id: ids.documents.overdueInvoice }] });
    expect(wrongKind.text).toContain("ist kein Gutschrift");
    const split = await callTool("match_bank_transaction", { id: tx, targets: [{ kind: "invoice", id: ids.documents.overdueInvoice }, { kind: "invoice", id: ids.documents.paidInvoice, amount: 1 }] });
    expect(split.text).toContain("braucht jedes einen Betrag");
    const tooMuch = await callTool("match_bank_transaction", { id: tx, targets: [{ kind: "invoice", id: ids.documents.overdueInvoice, amount: 2000 }] });
    expect(tooMuch.text).toContain("übersteigt");
    expect((await callTool("get_bank_overview")).data.openCount).toBe(3);
  });

  test("set_bank_transaction_ignored and back", async () => {
    const ignored = await callTool("set_bank_transaction_ignored", { id: ids.bank.billa });
    expect(ignored.data).toMatchObject({ status: "ignored", statusLabel: "Ignoriert", suggestions: [] });
    expect((await callTool("list_bank_transactions", { status: "ignored" })).data.transactions.map((t: Data) => t.id)).toEqual([ids.bank.billa]);
    const blocked = await callTool("match_bank_transaction", { id: ids.bank.billa, targets: [{ kind: "expense", id: ids.expenses.adobe }] });
    expect(blocked.text).toContain("ist ignoriert");
    const reopened = await callTool("set_bank_transaction_ignored", { id: ids.bank.billa, ignored: false });
    expect(reopened.data.status).toBe("open");
  });

  test("recurring invoices: list, pause/resume, generate now", async () => {
    const start = addDays(todayIso(), 5);
    const list = await callTool("list_recurring_invoices");
    expect(list.data).toMatchObject({ count: 1, monthlyGross: { cents: 14400 } });
    expect(list.data.recurring[0]).toMatchObject({
      id: ids.recurring.hosting,
      name: "Hosting Alpen",
      client: "Alpen Software GmbH",
      active: true,
      interval: "monatlich",
      nextRunDate: start,
      ended: false,
      autoFinalize: false,
      gross: { cents: 14400 },
      invoiceCount: 0,
      link: `${WEB_URL}/recurring/${ids.recurring.hosting}`,
    });

    const paused = await callTool("set_recurring_invoice_active", { id: ids.recurring.hosting, active: false });
    expect(paused.data.active).toBe(false);
    expect(paused.text).toContain("Pausiert");
    expect((await callTool("list_recurring_invoices", { active: true })).data.count).toBe(0);
    expect((await callTool("set_recurring_invoice_active", { id: ids.recurring.hosting, active: true })).data.active).toBe(true);

    const gen = await callTool("generate_recurring_invoice", { id: ids.recurring.hosting });
    expect(gen.isError).toBeFalsy();
    expect(gen.data).toMatchObject({ type: "invoice", status: "draft", number: null, clientId: ids.clients.alpen, issueDate: todayIso(), servicePeriodStart: start, gross: { cents: 14400 } });
    expect(gen.text).toContain("als Entwurf");
    const next = addMonthsAnchored(start, 1, Number(start.slice(8, 10)));
    expect((await callTool("list_recurring_invoices")).data.recurring[0]).toMatchObject({ nextRunDate: next, invoiceCount: 1 });

    const missing = await callTool("generate_recurring_invoice", { id: 99999 });
    expect(missing.text).toBe("Fehler: Serienrechnung nicht gefunden");
  });
});

describe("record tools (updates, fixed costs, assets)", () => {
  const year = new Date().getFullYear();

  test("update_client changes only the given fields", async () => {
    const id = ids.clients.berlin;
    const before = (await callTool("get_client", { id })).data;
    const res = await callTool("update_client", { id, city: "München", paymentTermsDays: 21, uid: before.uid });
    expect(res.isError).toBeFalsy();
    expect(res.data).toMatchObject({ city: "München", paymentTermsDays: 21, name: before.name, uid: before.uid, street: before.street, country: "DE" });
    expect(res.data.changes).toEqual([
      { field: "city", label: "Ort", before: "Berlin", after: "München" },
      { field: "paymentTermsDays", label: "Zahlungsziel (Tage)", before: "Standard", after: "21" },
    ]);
    expect((await callTool("get_client", { id })).data).toMatchObject({ city: "München", paymentTermsDays: 21, zip: before.zip });

    const back = await callTool("update_client", { id, paymentTermsDays: null });
    expect(back.data.paymentTermsDays).toBeNull();
    expect((await callTool("update_client", { id })).text).toContain("Keine Felder");
    const badEmail = await callTool("update_client", { id, email: "kein-mail" });
    expect(badEmail.isError).toBe(true);
    expect(badEmail.text).toContain("E-Mail");
    expect((await callTool("update_client", { id: 99999, city: "x" })).text).toContain("Kunde nicht gefunden");
  });

  test("update_expense: fields, category, lines, treatment switch; mark_expense_paid", async () => {
    const created = await callTool("create_expense", { supplierName: "Office Shop", issueDate: `${year}-03-02`, lines: [{ category: "buero", net: 100 }] });
    const id = created.data.id;

    const cat = await callTool("update_expense", { id, supplierInvoiceNumber: "R-1", category: "werbung" });
    expect(cat.isError).toBeFalsy();
    expect(cat.data).toMatchObject({ supplierInvoiceNumber: "R-1", supplier: "Office Shop", net: { cents: 10000 }, tax: { cents: 2000 } });
    expect(cat.data.lines[0].category).toBe("werbung");
    expect(cat.data.changes.map((c: Data) => c.field)).toEqual(["supplierInvoiceNumber", "lines"]);

    // reverse charge: gross = amount payable = net, the VAT is self-assessed
    const rc = await callTool("update_expense", {
      id,
      supplierCountry: "de",
      supplierUid: "DE000000000",
      vatTreatment: "reverse_charge",
      lines: [{ category: "software_abos", gross: 50 }],
    });
    expect(rc.data).toMatchObject({ supplierCountry: "DE", vatTreatment: "reverse_charge", net: { cents: 5000 }, tax: { cents: 1000 }, gross: { cents: 5000 } });

    const none = await callTool("update_expense", { id, vatTreatment: "none" });
    expect(none.data).toMatchObject({ tax: { cents: 0 }, gross: { cents: 5000 } });
    const domestic = await callTool("update_expense", { id, vatTreatment: "domestic" });
    expect(domestic.data).toMatchObject({ net: { cents: 5000 }, tax: { cents: 1000 }, gross: { cents: 6000 } });
    expect(domestic.data.lines[0].taxRatePercent).toBe(20);

    expect((await callTool("update_expense", { id })).text).toContain("Keine Felder");
    expect((await callTool("update_expense", { id, lines: [{ category: "buero", net: 1, gross: 1 }] })).text).toContain("net oder gross");
    expect((await callTool("update_expense", { id, lines: [{ category: "buero", net: 1, taxRate: 19 }] })).text).toContain("Steuersatz 19 %");
    expect((await callTool("get_expense", { id })).data.gross.cents).toBe(6000);

    const paid = await callTool("mark_expense_paid", { id, paidAt: `${year}-03-10` });
    expect(paid.data).toMatchObject({ paidAt: `${year}-03-10`, statusLabel: "bezahlt" });
    const open = await callTool("mark_expense_paid", { id, paidAt: null });
    expect(open.data).toMatchObject({ paidAt: null, statusLabel: "offen" });
    expect((await callTool("mark_expense_paid", { id: 99999 })).isError).toBe(true);
  });

  test("apply_receipt_analysis applies only the approved fields and marks the analysis applied", async () => {
    const e = await callTool("create_expense", {
      supplierName: "Unbekannt",
      issueDate: `${year}-03-01`,
      lines: [{ category: "sonstiges", net: 1 }],
      receiptPath: join(FIXTURES, "receipt.png"),
    });
    const expenseId = e.data.id;
    expect((await callTool("apply_receipt_analysis", { expenseId, fields: ["supplierName"] })).text).toContain("keine Belegerkennung");

    // a finished analysis as the worker would store it
    const sqlite = new Database(join(dataDir, "nesev.db"));
    const { attachment_path } = sqlite.query("select attachment_path from expenses where id = ?").get(expenseId) as { attachment_path: string };
    const s = (value: unknown) => ({ value, confidence: 0.9, source: "llm" });
    const result = {
      fields: {
        supplierName: s("Libro GmbH"),
        supplierUid: s("ATU11111111"),
        issueDate: s(`${year}-03-05`),
        category: s("buero"),
        vatTreatment: s("domestic"),
        grossCents: s(3000),
        taxLines: s([{ taxRateBp: 2000, netCents: 2500, taxCents: 500, grossCents: 3000 }]),
      },
      warnings: [],
    };
    const now = new Date().toISOString();
    const analysisId = Number(
      sqlite
        .query(
          "insert into receipt_analyses (expense_id, status, attachment_path, text_source, result, finished_at, created_at, updated_at) values (?, 'done', ?, 'vision', ?, ?, ?, ?)",
        )
        .run(expenseId, attachment_path, JSON.stringify(result), now, now, now).lastInsertRowid,
    );
    try {
      expect((await callTool("apply_receipt_analysis", { expenseId, fields: ["supplierName"], analysisId: analysisId + 1 })).text).toContain("neuere Belegerkennung");
      const missing = await callTool("apply_receipt_analysis", { expenseId, fields: ["dueDate", "supplierName"] });
      expect(missing.text).toContain("Kein Vorschlag für: dueDate");
      expect(missing.text).toContain("lines");

      const applied = await callTool("apply_receipt_analysis", { expenseId, fields: ["supplierName", "issueDate", "lines"], analysisId });
      expect(applied.isError).toBeFalsy();
      expect(applied.data).toMatchObject({ analysisId, applied: ["supplierName", "issueDate", "lines"], supplier: "Libro GmbH", supplierUid: "", issueDate: `${year}-03-05`, gross: { cents: 3000 } });
      expect(applied.data.lines).toEqual([expect.objectContaining({ category: "buero", net: expect.objectContaining({ cents: 2500 }), tax: expect.objectContaining({ cents: 500 }) })]);
      expect(applied.data.changes.map((c: Data) => c.field)).toEqual(["supplierName", "issueDate", "lines", "gross"]);
      expect((await callTool("get_receipt_analysis", { expenseId })).data.analysis.applied).toBe(true);

      sqlite.query("update receipt_analyses set attachment_path = 'receipts/other.png' where id = ?").run(analysisId);
      expect((await callTool("apply_receipt_analysis", { expenseId, fields: ["supplierUid"] })).text).toContain("ersetzt");
    } finally {
      sqlite.close();
    }
  });

  test("create_fixed_cost and link_expense_to_fixed_cost (suggested and explicit slot)", async () => {
    const fc = await callTool("create_fixed_cost", {
      name: "Cloud-Server",
      supplierName: "Hetzner Online GmbH",
      category: "software_abos",
      gross: "24,00",
      startDate: `${year}-03-15`,
    });
    expect(fc.isError).toBeFalsy();
    expect(fc.data).toMatchObject({ name: "Cloud-Server", interval: "monatlich", gross: { cents: 2400 }, tax: { cents: 400 }, monthly: { cents: 2400 } });
    expect((await callTool("list_fixed_costs")).data.fixedCosts.some((f: Data) => f.id === fc.data.id)).toBe(true);
    expect((await callTool("create_fixed_cost", { name: "x", category: "svs", gross: 0, startDate: `${year}-01-01` })).text).toContain("größer als 0");
    expect((await callTool("create_fixed_cost", { name: "x", category: "svs", gross: 10, taxRate: 19, startDate: `${year}-01-01` })).text).toContain("Steuersatz 19 %");

    const e = await callTool("create_expense", { supplierName: "Hetzner Online GmbH", issueDate: `${year}-03-16`, lines: [{ category: "software_abos", gross: 24 }] });
    const expenseId = e.data.id;
    const linked = await callTool("link_expense_to_fixed_cost", { expenseId });
    expect(linked.isError).toBeFalsy();
    expect(linked.data).toMatchObject({ expense: { id: expenseId }, fixedCost: { id: fc.data.id, scheduledDate: `${year}-03-15` }, replaced: null });
    expect((await callTool("get_expense", { id: expenseId })).data.fixedCost).toMatchObject({ id: fc.data.id, scheduledDate: `${year}-03-15` });

    const moved = await callTool("link_expense_to_fixed_cost", { expenseId, fixedCostId: fc.data.id, scheduledDate: `${year}-04-15` });
    expect(moved.data.replaced).toMatchObject({ fixedCostId: fc.data.id, scheduledDate: `${year}-03-15` });

    expect((await callTool("link_expense_to_fixed_cost", { expenseId, fixedCostId: fc.data.id, scheduledDate: `${year}-04-16` })).text).toContain("Kein geplanter Zahlungstermin");
    expect((await callTool("link_expense_to_fixed_cost", { expenseId, scheduledDate: `${year}-04-15` })).text).toContain("nur zusammen mit fixedCostId");
    expect((await callTool("link_expense_to_fixed_cost", { expenseId: ids.expenses.telekom })).text).toContain("Kein freier passender Fixkosten-Termin");
  });

  test("create_asset from an expense's anlagen line and by hand, with the AfA plan", async () => {
    const e = await callTool("create_expense", {
      supplierName: "Computerhändler",
      issueDate: `${year}-09-01`,
      lines: [{ category: "anlagen", description: "Workstation", gross: "1.200,00" }, { category: "buero", gross: 12 }],
    });
    const fromExpense = await callTool("create_asset", { expenseId: e.data.id, usefulLifeYears: 4 });
    expect(fromExpense.isError).toBeFalsy();
    expect(fromExpense.data).toMatchObject({
      name: "Workstation",
      acquisitionDate: `${year}-09-01`,
      inServiceDate: `${year}-09-01`,
      cost: { cents: 100000 },
      annualAfa: { cents: 25000 },
      halfYearFirst: true,
      gwg: true,
      expense: { id: e.data.id },
      link: `${WEB_URL}/assets/${fromExpense.data.id}`,
    });
    expect(fromExpense.data.number).toMatch(/^AV-\d{4}$/);
    expect(fromExpense.data.schedule[0]).toMatchObject({ year, afa: { cents: 12500 } });
    expect(fromExpense.data.schedule.reduce((s: number, y: Data) => s + y.afa.cents, 0)).toBe(100000);
    expect((await callTool("create_asset", { expenseId: e.data.id, usefulLifeYears: 4 })).text).toContain("schon vollständig als Anlagen erfasst");

    const chair = await callTool("create_asset", { name: "Bürostuhl", cost: "1.500,00", acquisitionDate: `${year}-03-01`, usefulLifeYears: 10 });
    expect(chair.data).toMatchObject({ inServiceDate: `${year}-03-01`, annualAfa: { cents: 15000 }, halfYearFirst: false, gwg: false, expense: null });
    expect(chair.data.schedule).toHaveLength(10);

    expect((await callTool("create_asset", { name: "x", usefulLifeYears: 3 })).text).toContain("fehlen: cost, acquisitionDate");
    expect((await callTool("create_asset", { expenseId: ids.expenses.telekom, usefulLifeYears: 3 })).text).toContain("keine Position der Kategorie");
    const register = await callTool("list_assets", { year });
    expect(register.data.assets.map((a: Data) => a.id)).toEqual(expect.arrayContaining([fromExpense.data.id, chair.data.id]));
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
