import type { Client } from "@modelcontextprotocol/client";
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
const WEB_URL = "http://nesev.test:4321";

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
  const env = { NESEV_WEB_URL: `${WEB_URL}/` };
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
    test(`${era}: tools/list is deterministic, read-only and has output schemas`, async () => {
      const { tools } = await clients[era].listTools();
      expect(tools.map((t) => t.name)).toEqual(TOOLS);
      for (const t of tools) {
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.annotations?.openWorldHint).toBe(false);
        expect(t.outputSchema?.type).toBe("object");
        expect(t.description!.length).toBeGreaterThan(80);
      }
      const again = await clients[era].listTools();
      expect(again.tools.map((t) => t.name)).toEqual(TOOLS);
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

    // "open" = not paid (the incomplete draft has no paidAt either)
    const unpaid = await callTool("list_expenses", { status: "open" });
    expect(unpaid.data.expenses.map((e: Data) => e.id).sort()).toEqual([ids.expenses.adobe, ids.expenses.incomplete].sort());
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
