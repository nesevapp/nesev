import { describe, expect, test } from "bun:test";
import { formatCents } from "../../shared/money";
import { buildCard } from "./chat-cards";
import { type ConfirmLookups, confirmSummary } from "./chat-tools";

// Cards and confirmation summaries of the bank and recurring-invoice tools, from structured content shaped like
// the MCP outputSchemas (src/mcp/tools/bank.ts, recurring.ts).

const m = (cents: number) => ({ cents, formatted: formatCents(cents) });
/** formatCents uses a no-break space after "€" */
const sp = (text: string | undefined) => text?.replace(/\u00a0/g, " ");

const tx = (o: Record<string, unknown> = {}) => ({
  id: 5,
  date: "2026-10-03",
  accountId: 1,
  account: "Giro",
  amount: m(54000),
  direction: "in",
  counterparty: "Alpen Software GmbH",
  purpose: "RE-2026-0003 danke",
  status: "open",
  statusLabel: "Offen",
  remaining: m(54000),
  matches: [],
  link: "/bank?account=1&status=all&q=540%2C00",
  ...o,
});

const detail = (o: Record<string, unknown> = {}) => ({
  ...tx(),
  counterpartyIban: "AT61 1904 3002 3457 3201",
  reference: "",
  valueDate: null,
  allocated: m(0),
  suggestions: [
    {
      kind: "invoice",
      id: 6,
      number: "RE-2026-0003",
      name: "Alpen Software GmbH",
      issueDate: "2026-10-01",
      open: m(54000),
      proposedAmount: m(54000),
      confidence: "high",
      reasons: ["Rechnungsnummer im Zweck", "Betrag gleich"],
      link: "/invoices/6",
    },
  ],
  ...o,
});

const recurring = (o: Record<string, unknown> = {}) => ({
  id: 2,
  name: "Wartung",
  clientId: 1,
  client: "Alpen Software GmbH",
  active: true,
  interval: "monatlich",
  nextRunDate: "2026-11-01",
  endDate: null,
  ended: false,
  autoFinalize: true,
  net: m(10000),
  gross: m(12000),
  invoiceCount: 3,
  lastInvoiceDate: "2026-10-01",
  link: "/recurring/2",
  ...o,
});

describe("bank cards", () => {
  test("overview → kpis with the open count as a count item", () => {
    const card = buildCard("get_bank_overview", {
      accounts: [
        { id: 1, name: "Giro", iban: "AT…", archived: false, transactionCount: 12, openCount: 2, importedSum: m(150000), lastBookingDate: "2026-10-03", link: "/bank" },
        { id: 2, name: "Alt", iban: "AT…", archived: true, transactionCount: 1, openCount: 0, importedSum: m(1), lastBookingDate: null, link: "/bank" },
      ],
      openCount: 2,
      openIn: m(54000),
      openOut: m(1999),
    });
    expect(card).toMatchObject({ kind: "kpis", title: "Bank", link: { path: "/bank" } });
    expect(card?.kind === "kpis" && card.items[0]).toEqual({ label: "Offene Buchungen", cents: 2, format: "count", tone: "neutral" });
    if (card?.kind !== "kpis") throw new Error("kpis");
    expect(card.items.map((i) => [i.label, i.cents])).toEqual([
      ["Offene Buchungen", 2],
      ["Offene Eingänge", 54000],
      ["Offene Ausgänge", -1999],
      ["Giro", 150000],
    ]);
  });

  test("transaction list → table with date, name, amount, status; each row links", () => {
    const card = buildCard("list_bank_transactions", {
      total: 2,
      truncated: false,
      sumIn: m(54000),
      sumOut: m(-1999),
      transactions: [
        tx(),
        tx({ id: 6, amount: m(-1999), direction: "out", counterparty: "A1", status: "matched", statusLabel: "Zugeordnet", matches: [{ matchId: 1, kind: "expense", id: 1, number: "ER-2026-0001", name: "A1", amount: m(1999), link: "/expenses/1" }], link: "/bank?account=1&status=all&q=19%2C99" }),
      ],
    });
    if (card?.kind !== "table") throw new Error("table");
    expect(card.title).toBe("Bankbuchungen (2)");
    expect(card.rows[0]).toEqual({
      cells: { date: "03.10.2026", counterparty: "Alpen Software GmbH", purpose: "RE-2026-0003 danke", amount: 54000, status: "Offen" },
      path: "/bank?account=1&status=all&q=540%2C00",
    });
    expect(card.rows[1]!.cells.status).toBe("→ ER-2026-0001");
    expect(card.total).toEqual({ label: "Saldo", cents: 52001, column: "amount" });
  });

  test("open transaction → its suggestions; matched → its allocations; the matching tools use the same card", () => {
    const open = buildCard("get_bank_transaction", detail());
    if (open?.kind !== "table") throw new Error("table");
    expect(sp(open.title)).toBe("Vorschläge für Buchung € 540,00 – 03.10.2026 · Alpen Software GmbH · Offen");
    expect(open.rows).toEqual([
      {
        cells: { target: "Rechnung RE-2026-0003", name: "Alpen Software GmbH", open: 54000, proposed: 54000, confidence: "sicher (Rechnungsnummer im Zweck, Betrag gleich)" },
        path: "/invoices/6",
      },
    ]);
    const matched = buildCard(
      "match_bank_transaction",
      detail({
        status: "matched",
        statusLabel: "Zugeordnet",
        remaining: m(0),
        suggestions: [],
        matches: [{ matchId: 9, kind: "invoice", id: 6, number: "RE-2026-0003", name: "Alpen Software GmbH", amount: m(54000), link: "/invoices/6" }],
        targets: [{ kind: "invoice", id: 6, open: m(0), paid: true, link: "/invoices/6" }],
      }),
    );
    if (matched?.kind !== "table") throw new Error("table");
    expect(matched.rows).toEqual([{ cells: { target: "Rechnung RE-2026-0003", name: "Alpen Software GmbH", amount: 54000 }, path: "/invoices/6" }]);
    expect(matched.total).toBeUndefined();
    const ignored = buildCard("set_bank_transaction_ignored", detail({ status: "ignored", statusLabel: "Ignoriert", suggestions: [] }));
    expect(ignored).toMatchObject({ kind: "kpis", items: [{ label: "Betrag", cents: 54000 }, { label: "Nicht zugeordnet", cents: 54000 }] });
  });
});

describe("recurring cards", () => {
  test("list → table with the monthly total; pause → the one row; generate → document card", () => {
    const list = buildCard("list_recurring_invoices", { count: 2, monthlyGross: m(12000), recurring: [recurring(), recurring({ id: 3, name: "Hosting", active: false, link: "/recurring/3" })] });
    if (list?.kind !== "table") throw new Error("table");
    expect(list.rows.map((r) => [r.cells.name, r.cells.next, r.path])).toEqual([
      ["Wartung", "01.11.2026", "/recurring/2"],
      ["Hosting", "pausiert", "/recurring/3"],
    ]);
    expect(list.total).toEqual({ label: "Aktiv pro Monat", cents: 12000, column: "gross" });
    const paused = buildCard("set_recurring_invoice_active", recurring({ active: false }));
    expect(paused).toMatchObject({ kind: "table", title: "Serienrechnung Wartung", rows: [{ cells: { next: "pausiert" }, path: "/recurring/2" }] });
    const doc = buildCard("generate_recurring_invoice", {
      id: 9,
      type: "invoice",
      typeLabel: "Rechnung",
      number: "RE-2026-0005",
      status: "final",
      statusLabel: "Finalisiert",
      client: { name: "Alpen Software GmbH" },
      issueDate: "2026-11-01",
      dueDate: "2026-11-15",
      gross: m(12000),
      open: m(12000),
      link: "/invoices/9",
    });
    expect(doc).toMatchObject({ kind: "document", number: "RE-2026-0005", grossCents: 12000, openCents: 12000, path: "/invoices/9" });
  });
});

describe("confirmation summaries: bank and recurring", () => {
  const lookups: ConfirmLookups = {
    document: async (id, amount) => (id === 6 ? `Rechnung RE-2026-0003 für Alpen Software GmbH${amount === "open" ? " (offen € 540,00)" : " über € 540,00"}` : null),
    transaction: async (id) =>
      id === 5
        ? {
            date: "2026-10-03",
            amountCents: 54000,
            counterparty: "Alpen Software GmbH",
            remainingCents: 54000,
            matches: [{ matchId: 9, kind: "invoice", number: "RE-2026-0001", name: "Alpen Software GmbH", amountCents: 14400 }],
          }
        : null,
    expense: async (id) => (id === 1 ? "Ausgabe ER-2026-0001 A1 Telekom" : null),
    recurring: async (id) => (id === 2 ? { name: "Wartung", client: "Alpen Software GmbH", grossCents: 12000, autoFinalize: true, nextRunDate: "2026-01-01" } : null),
  };

  test("match: transaction, targets with amount or the whole remaining amount, effect", async () => {
    expect(sp(await confirmSummary("match_bank_transaction", { id: 5, targets: [{ kind: "invoice", id: 6 }] }, lookups))).toBe(
      "Buchung 03.10.2026 € 540,00 Alpen Software GmbH zuordnen → Rechnung RE-2026-0003 für Alpen Software GmbH (offen € 540,00): ganzer offener Betrag € 540,00 – eine dadurch gedeckte Rechnung gilt danach als bezahlt",
    );
    expect(sp(await confirmSummary("match_bank_transaction", { id: 7, targets: [{ kind: "expense", id: 1, amount: "19,99" }] }, lookups))).toBe(
      "Bankbuchung id 7 zuordnen → Ausgabe ER-2026-0001 A1 Telekom: € 19,99 – eine dadurch gedeckte Ausgabe gilt danach als bezahlt",
    );
  });

  test("unmatch says what becomes unpaid again; ignore / reopen", async () => {
    expect(sp(await confirmSummary("unmatch_bank_transaction", { id: 5 }, lookups))).toBe(
      "Alle Zuordnungen von Buchung 03.10.2026 € 540,00 Alpen Software GmbH lösen (Rechnung RE-2026-0001 Alpen Software GmbH € 144,00) – damit bezahlte Rechnungen bzw. Ausgaben gelten wieder als offen",
    );
    expect(sp(await confirmSummary("set_bank_transaction_ignored", { id: 5, ignored: true }, lookups))).toBe(
      "Buchung 03.10.2026 € 540,00 Alpen Software GmbH ignorieren – braucht keine Rechnung oder Ausgabe (z. B. privat, Umbuchung)",
    );
    expect(sp(await confirmSummary("set_bank_transaction_ignored", { id: 5, ignored: false }, lookups))).toBe(
      "Buchung 03.10.2026 € 540,00 Alpen Software GmbH wieder als offen führen (nicht mehr ignorieren)",
    );
  });

  test("recurring: pause, resume with catch-up, generate (finalized or draft)", async () => {
    expect(sp(await confirmSummary("set_recurring_invoice_active", { id: 2, active: false }, lookups))).toBe(
      "Serienrechnung „Wartung“ (Alpen Software GmbH) pausieren – es werden keine Rechnungen mehr erstellt, bis sie fortgesetzt wird",
    );
    expect(sp(await confirmSummary("set_recurring_invoice_active", { id: 2, active: true }, lookups))).toBe(
      "Serienrechnung „Wartung“ (Alpen Software GmbH) fortsetzen – versäumte Termine seit 01.01.2026 werden nachgeholt",
    );
    expect(sp(await confirmSummary("generate_recurring_invoice", { id: 2 }, lookups))).toBe(
      "Rechnung aus Serienrechnung „Wartung“ für Alpen Software GmbH jetzt erstellen (€ 120,00, wird sofort finalisiert (Nummer und PDF, unveränderbar))",
    );
    expect(sp(await confirmSummary("generate_recurring_invoice", { id: 99 }, lookups))).toBe("Rechnung aus Serienrechnung id 99 jetzt erstellen");
  });
});
