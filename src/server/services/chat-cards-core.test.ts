import { describe, expect, test } from "bun:test";
import { formatCents } from "../../shared/money";
import { buildCard, buildCards, CARD_ROWS, cardNote } from "./chat-cards";
import { type ConfirmLookups, confirmSummary, toChatToolResult, toolContent } from "./chat-tools";

// Cards of the core, document, list, finance and record tools, and the confirmation summaries of the record tools,
// from structured content shaped like the MCP outputSchemas (trimmed to the fields that are read). Bank and
// recurring invoices: chat-cards.test.ts.

const m = (cents: number) => ({ cents, formatted: formatCents(cents) });
/** formatCents uses a no-break space after "€" */
const sp = (text: string) => text.replace(/ /g, " ");

describe("cards", () => {
  test("get_dashboard → bar chart with a result line", () => {
    const card = buildCard("get_dashboard", {
      year: 2026,
      monthly: [
        { month: "2026-01", revenue: m(100000), expenses: m(40000), result: m(60000) },
        { month: "2026-02", revenue: m(0), expenses: m(5000), result: m(-5000) },
      ],
      link: "/?year=2026",
    });
    expect(card).toEqual({
      kind: "chart",
      title: "Umsatz und Ausgaben 2026 (netto)",
      chart: "bar",
      labels: ["Jän", "Feb"],
      series: [
        { label: "Umsatz", values: [100000, 0], tone: "revenue" },
        { label: "Ausgaben", values: [40000, 5000], tone: "expenses" },
        { label: "Ergebnis", values: [60000, -5000], tone: "result", type: "line" },
      ],
      link: { label: "Dashboard", path: "/?year=2026" },
    });
  });

  test("get_dashboard: months after today without bookings are null (no bar, the line ends)", () => {
    const month = (k: string, r: number, e: number) => ({ month: k, revenue: m(r), expenses: m(e), result: m(r - e) });
    const card = buildCard("get_dashboard", { year: 2026, today: "2026-10-14", monthly: [month("2026-09", 100, 40), month("2026-10", 0, 0), month("2026-11", 0, 0), month("2026-12", 500, 0)] });
    expect(card?.kind === "chart" && card.series.map((x) => x.values)).toEqual([
      [100, 0, null, 500],
      [40, 0, null, 0],
      [60, 0, null, 500],
    ]);
  });

  test("get_dashboard → KPIs above the chart; other tools keep one card", () => {
    const fig = (count: number, cents: number) => ({ count, amount: m(cents) });
    const data = {
      year: 2026,
      kpis: {
        revenue: m(500000),
        revenuePreviousYear: m(400000),
        expenses: m(120000),
        expensesPreviousYear: m(100000),
        result: m(380000),
        paid: fig(3, 300000),
        openInvoices: fig(2, 150000),
        overdue: fig(1, 114000),
        openOffers: fig(0, 0),
      },
      monthly: [{ month: "2026-01", revenue: m(500000), expenses: m(120000), result: m(380000) }],
    };
    const cards = buildCards("get_dashboard", data);
    expect(cards.map((c) => c.kind)).toEqual(["kpis", "chart"]);
    expect(cards[0]).toEqual({
      kind: "kpis",
      title: "Kennzahlen 2026",
      items: [
        { label: "Umsatz netto", cents: 500000, hint: `Vorjahr ${formatCents(400000)}`, tone: "revenue" },
        { label: "Ausgaben netto", cents: 120000, hint: `Vorjahr ${formatCents(100000)}`, tone: "expenses" },
        { label: "Ergebnis", cents: 380000, tone: "result" },
        { label: "Offene Rechnungen", cents: 150000, hint: "2 offen, 1 überfällig", tone: "negative" },
      ],
    });
    // without kpis (older shape) only the chart
    expect(buildCards("get_dashboard", { ...data, kpis: undefined }).map((c) => c.kind)).toEqual(["chart"]);
    expect(buildCards("list_clients", { total: 1, clients: [{ name: "Alpen", link: "/clients/1" }] }).map((c) => c.kind)).toEqual(["table"]);
    expect(buildCards("create_client", { id: 1 })).toEqual([]);
    const result = toChatToolResult({ isError: false, text: "Dashboard", structured: data }, "get_dashboard");
    expect(result.cards?.length).toBe(2);
    expect(result.card).toBeUndefined();
    expect(cardNote(result.cards!)).toContain("als Kennzahlen-Karte und Diagramm im Chat");
  });

  test("tool summaries drop the trailing colon of a heading line", () => {
    expect(toChatToolResult({ isError: false, text: "1 Belege, Summe brutto € 1.284,00, offen € 1.140,00:\n- RE-2026-0001", structured: null }).summary).toBe(
      "1 Belege, Summe brutto € 1.284,00, offen € 1.140,00",
    );
  });

  test("get_document (and document write tools) → document card with raw status; open only for finalized invoices", () => {
    const doc = {
      id: 12,
      type: "invoice",
      typeLabel: "Rechnung",
      number: "RE-2026-0004",
      status: "sent",
      statusLabel: "Überfällig (teilbezahlt)",
      overdue: true,
      partiallyPaid: true,
      client: { id: 1, name: "Alpen GmbH" },
      issueDate: "2026-09-01",
      dueDate: "2026-09-15",
      gross: m(64800),
      open: m(30000),
      payment: { open: m(30000) },
      link: "http://localhost:5174/invoices/12",
    };
    expect(buildCard("get_document", doc)).toEqual({
      kind: "document",
      typeLabel: "Rechnung",
      number: "RE-2026-0004",
      status: "Überfällig (teilbezahlt)",
      statusKey: "sent",
      overdue: true,
      partial: true,
      client: "Alpen GmbH",
      date: "2026-09-01",
      dueDate: "2026-09-15",
      grossCents: 64800,
      openCents: 30000,
      path: "/invoices/12",
      pdfUrl: "/api/pdf/documents/12",
    });
    const offer = buildCard("create_offer_draft", { ...doc, type: "offer", typeLabel: "Angebot", number: null, status: "draft", payment: null, open: null, link: "/offers/3", id: 3 });
    expect(offer).toMatchObject({ kind: "document", number: null, statusKey: "draft", dueDate: null, openCents: null, path: "/offers/3", pdfUrl: "/api/pdf/documents/3" });
  });

  test("list_documents → table, max CARD_ROWS rows + more, open column and total (under its column)", () => {
    const row = (i: number) => ({
      id: i,
      type: "invoice",
      typeLabel: "Rechnung",
      number: i === 1 ? null : `RE-2026-000${i}`,
      client: "Alpen",
      issueDate: "2026-10-01",
      gross: m(1000 * i),
      open: m(500),
      status: "final",
      statusLabel: "Offen",
      link: `/invoices/${i}`,
    });
    const docs = [...Array(10)].map((_, i) => row(i + 1));
    const card = buildCard("list_documents", { total: 12, truncated: true, sumGross: m(99), sumOpen: m(6000), documents: docs });
    if (card?.kind !== "table") throw new Error("table expected");
    expect(card.title).toBe("Rechnungen (12)");
    expect(card.rows).toHaveLength(CARD_ROWS);
    expect(card.more).toBe(12 - CARD_ROWS);
    expect(card.columns.map((c) => c.key)).toEqual(["number", "client", "date", "open", "status"]);
    expect(card.rows[0]).toEqual({ cells: { number: "Rechnung-Entwurf", client: "Alpen", date: "01.10.2026", open: 500, status: "Offen" }, path: "/invoices/1" });
    expect(card.total).toEqual({ label: "Offen gesamt", cents: 6000, column: "open" });
    expect(card.link).toEqual({ label: "Alle Rechnungen", path: "/invoices" });
    const paid = buildCard("list_documents", { total: 1, sumGross: m(1000), sumOpen: m(0), documents: [{ ...row(2), open: m(0), status: "paid" }] });
    expect(paid).toMatchObject({ total: { label: "Summe brutto", cents: 1000, column: "gross" }, rows: [{ cells: { gross: 2000 } }] });
    expect(paid && "more" in paid).toBe(false);
  });

  test("lists: expenses, clients, reminders due, fixed costs, assets, search", () => {
    expect(buildCard("list_expenses", { total: 1, sumGross: m(1200), expenses: [{ number: "ER-2026-0001", supplier: "A1", issueDate: "2026-10-02", gross: m(1200), statusLabel: "Bezahlt", link: "/expenses/1" }] })).toMatchObject({
      kind: "table",
      title: "Ausgaben (1)",
      rows: [{ cells: { number: "ER-2026-0001", supplier: "A1", date: "02.10.2026", gross: 1200, status: "Bezahlt" }, path: "/expenses/1" }],
      total: { label: "Summe brutto", cents: 1200 },
    });
    expect(buildCard("list_clients", { total: 1, clients: [{ number: "K-0001", name: "Alpen", city: "Wien", country: "AT", email: "a@b.at", link: "/clients/1" }] })).toMatchObject({
      rows: [{ cells: { number: "K-0001", name: "Alpen", place: "Wien, AT", email: "a@b.at" }, path: "/clients/1" }],
    });
    expect(
      buildCard("list_reminders_due", {
        totalOpen: m(5000),
        invoices: [{ number: "RE-1", client: "Alpen", daysOverdue: 12, open: m(5000), suggestedLevelTitle: "1. Mahnung", dueForReminder: true, link: "/invoices/1" }],
      }),
    ).toMatchObject({ rows: [{ cells: { days: "12 Tage", open: 5000, next: "1. Mahnung" } }], total: { cents: 5000, column: "open" } });
    expect(
      buildCard("list_fixed_costs", {
        monthlyTotal: m(15000),
        fixedCosts: [{ name: "Miete", active: true, interval: "monatlich", nextPaymentDate: "2026-11-01", gross: m(15000), monthly: m(15000) }],
      }),
    ).toMatchObject({ rows: [{ cells: { name: "Miete", next: "01.11.2026", gross: 15000, monthly: 15000 }, path: "/fixed-costs" }], total: { label: "Aktiv pro Monat", cents: 15000, column: "monthly" } });
    expect(
      buildCard("list_assets", { year: 2026, totals: { afa: m(41667) }, assets: [{ number: "AV-0001", name: "MacBook", cost: m(250000), afa: m(41667), bookValueEnd: m(208333), link: "/assets/1" }], link: "/assets?year=2026" }),
    ).toMatchObject({ title: "Anlagenverzeichnis 2026", total: { label: "AfA 2026", cents: 41667, column: "end" }, link: { path: "/assets?year=2026" } });
    expect(buildCard("search", { query: "alp", results: [{ typeLabel: "Kunden", label: "Alpen", sublabel: "K-0001", meta: "Wien", link: "/clients/1" }] })).toMatchObject({
      title: "Suche „alp“",
      rows: [{ cells: { type: "Kunden", label: "Alpen", details: "K-0001 · Wien" }, path: "/clients/1" }],
    });
    expect(buildCard("search", { query: "x", results: [] })).toBeNull();
  });

  test("get_forecast → chart (balance line when a start balance is set); get_tax_report → kpis", () => {
    const months = [
      { month: "2026-12", in: m(1000), out: m(400), net: m(600), balanceEnd: null },
      { month: "2027-01", in: m(2000), out: m(500), net: m(1500), balanceEnd: null },
    ];
    expect(buildCard("get_forecast", { horizonEnd: "2027-01-31", months, link: "/forecast?months=2" })).toEqual({
      kind: "chart",
      title: "Zahlungsprognose bis 31.01.2027 (brutto)",
      chart: "bar",
      labels: ["Dez 26", "Jän 27"],
      series: [
        { label: "Eingänge", values: [1000, 2000], tone: "positive" },
        { label: "Ausgänge", values: [400, 500], tone: "negative" },
        { label: "Saldo", values: [600, 1500], tone: "result", type: "line" },
      ],
      link: { label: "Prognose", path: "/forecast?months=2" },
    });
    const withBalance = buildCard("get_forecast", { horizonEnd: "2027-01-31", months: months.map((x, i) => ({ ...x, balanceEnd: m(10000 + i) })) });
    expect(withBalance?.kind === "chart" && withBalance.series[2]).toMatchObject({ label: "Kontostand", values: [10000, 10001] });
    expect(
      buildCard("get_tax_report", {
        kind: "uva",
        period: { label: "September 2026" },
        dueDate: "2026-11-15",
        summary: [
          { label: "Umsatzsteuer", amount: m(20000) },
          { label: "Vorsteuer", amount: m(5000) },
          { label: "Zahllast (KZ 095)", amount: m(15000) },
        ],
        link: "/tax?tab=uva&period=2026-09",
      }),
    ).toEqual({
      kind: "kpis",
      title: "UVA September 2026",
      items: [
        { label: "Umsatzsteuer", cents: 20000 },
        { label: "Vorsteuer", cents: 5000 },
        { label: "Zahllast (KZ 095)", cents: 15000, hint: "fällig 15.11.2026", tone: "negative" },
      ],
      link: { label: "Steuern", path: "/tax?tab=uva&period=2026-09" },
    });
  });

  test("no card: unknown tool, no structured content, unexpected shape, errors; the model gets a note when there is one", () => {
    expect(buildCard("create_client", { id: 1 })).toBeNull();
    expect(buildCard("get_dashboard", null)).toBeNull();
    expect(buildCard("list_documents", { documents: "nope" })).toBeNull();
    expect(buildCard("get_document", { id: 1 })).toBeNull();
    expect(toChatToolResult({ isError: true, text: "Fehler: x", structured: { documents: [] } }, "list_documents")).toEqual({ ok: false, summary: "Fehler: x", links: [] });
    const outcome = { isError: false, text: "1 Kunde", structured: { total: 1, clients: [{ name: "Alpen", link: "/clients/1" }] } };
    const result = toChatToolResult(outcome, "list_clients");
    expect(toolContent(outcome, result)).toBe(`1 Kunde\n${cardNote(result.cards!)}`);
    expect(toolContent(outcome, toChatToolResult(outcome))).toBe("1 Kunde");
  });
});

describe("record tools: cards", () => {
  const changes = [
    { field: "email", label: "E-Mail", before: "a@alpen.at", after: "office@alpen.at" },
    { field: "city", label: "Ort", before: "Wien", after: "Graz" },
  ];

  test("update_* and apply_receipt_analysis → change table; no change → no card", () => {
    expect(buildCard("update_client", { id: 1, name: "Alpen GmbH", link: "/clients/1", changes })).toEqual({
      kind: "table",
      title: "Kunde Alpen GmbH geändert",
      columns: [
        { key: "label", label: "Feld" },
        { key: "before", label: "vorher" },
        { key: "after", label: "nachher" },
      ],
      rows: [{ cells: { label: "E-Mail", before: "a@alpen.at", after: "office@alpen.at" } }, { cells: { label: "Ort", before: "Wien", after: "Graz" } }],
      link: { label: "Öffnen", path: "/clients/1" },
    });
    expect(buildCard("update_expense", { id: 2, number: "ER-2026-0002", supplier: "A1", link: "/expenses/2", changes })).toMatchObject({ title: "Ausgabe ER-2026-0002 · A1 geändert" });
    expect(buildCard("apply_receipt_analysis", { id: 2, number: "ER-2026-0002", supplier: "A1", changes })).toMatchObject({ title: "Belegerkennung übernommen: ER-2026-0002 · A1" });
    expect(buildCard("update_client", { id: 1, name: "Alpen", changes: [] })).toBeNull();
  });

  test("mark_expense_paid / link_expense_to_fixed_cost → one row; create_fixed_cost → kpis; create_asset → AfA chart", () => {
    expect(buildCard("mark_expense_paid", { id: 2, number: "ER-2026-0002", supplier: "A1", paidAt: "2026-10-05", gross: m(6000), statusLabel: "Bezahlt", link: "/expenses/2" })).toMatchObject({
      kind: "table",
      rows: [{ cells: { number: "ER-2026-0002", supplier: "A1", paid: "05.10.2026", gross: 6000, status: "Bezahlt" }, path: "/expenses/2" }],
    });
    expect(
      buildCard("link_expense_to_fixed_cost", {
        expense: { id: 2, number: "ER-2026-0002", supplier: "Hausverwaltung", gross: m(60000), link: "/expenses/2" },
        fixedCost: { id: 1, name: "Büromiete", scheduledDate: "2026-10-01", gross: m(60000), link: "/fixed-costs" },
        replaced: { fixedCostId: 1, name: "Büromiete", scheduledDate: "2026-09-01" },
        otherSuggestions: [],
      }),
    ).toMatchObject({
      title: "Fixkosten-Verknüpfung ersetzt (vorher Büromiete · 01.09.2026)",
      rows: [{ cells: { expense: "ER-2026-0002 · Hausverwaltung", fixedCost: "Büromiete", date: "01.10.2026", gross: 60000 }, path: "/expenses/2" }],
    });
    expect(
      buildCard("create_fixed_cost", { id: 3, name: "SVS", interval: "vierteljährlich", nextPaymentDate: "2026-11-28", gross: m(90000), tax: m(0), monthly: m(30000), link: "/fixed-costs" }),
    ).toEqual({
      kind: "kpis",
      title: "Fixkosten SVS",
      items: [
        { label: "Pro Zahlung", cents: 90000, hint: "vierteljährlich · nächste Zahlung 28.11.2026", tone: "expenses" },
        { label: "Pro Monat", cents: 30000, tone: "expenses" },
      ],
      link: { label: "Fixkosten", path: "/fixed-costs" },
    });
    expect(
      buildCard("create_asset", {
        id: 4,
        number: "AV-0002",
        name: "Monitor",
        usefulLifeYears: 3,
        cost: m(120000),
        schedule: [
          { year: 2026, afa: m(20000), bookValueEnd: m(100000) },
          { year: 2027, afa: m(40000), bookValueEnd: m(60000) },
        ],
        link: "/assets/4",
      }),
    ).toMatchObject({
      kind: "chart",
      labels: ["2026", "2027"],
      series: [
        { label: "AfA", values: [20000, 40000], tone: "expenses" },
        { label: "Buchwert 31.12.", values: [100000, 60000], tone: "result", type: "line" },
      ],
      link: { path: "/assets/4" },
    });
  });
});

describe("record tools: confirmation summaries", () => {
  const reads: Record<string, Record<string, any>> = {
    get_client: { id: 1, name: "Alpen Software GmbH", email: "info@alpen.at", city: "Wien", paymentTermsDays: null, defaultTaxMode: null },
    get_expense: {
      id: 2,
      number: "ER-2026-0002",
      supplier: "A1 Telekom",
      issueDate: "2026-10-04",
      vatTreatment: "domestic",
      gross: m(6000),
      lines: [{ categoryLabel: "Telefon und Internet" }],
      fixedCost: { name: "Internet", scheduledDate: "2026-10-01" },
    },
    get_receipt_analysis: { analysis: { suggestions: [{ field: "supplierName", value: "A1 Telekom Austria AG" }, { field: "issueDate", value: "04.10.2026" }] } },
    list_fixed_costs: { fixedCosts: [{ id: 1, name: "Büromiete" }] },
    get_document: {
      id: 12,
      typeLabel: "Rechnung",
      client: { id: 1, name: "Alpen Software GmbH" },
      issueDate: "2026-10-01",
      dueDate: "2026-10-15",
      title: "Wartung",
      taxMode: "AT_DOMESTIC",
      net: m(19000),
      items: [{ title: "Wartung" }],
    },
  };
  const lookups: ConfirmLookups = { document: async () => null, read: async (tool) => reads[tool] ?? null };
  const summary = async (name: string, args: Record<string, unknown>) => sp(await confirmSummary(name, args, lookups));

  test("update_client: before → after per changed field, unchanged fields left out", async () => {
    expect(await summary("update_client", { id: 1, email: "office@alpen.at", city: "Wien", paymentTermsDays: 14 })).toBe(
      "Kunde Alpen Software GmbH ändern: E-Mail: info@alpen.at → office@alpen.at; Zahlungsziel (Tage): Standard → 14",
    );
    expect(await summary("update_client", { id: 1, city: "Wien" })).toBe("Kunde Alpen Software GmbH ändern: keine Änderung (die Werte sind schon so)");
  });

  test("update_expense: fields with German labels, category and lines", async () => {
    expect(
      await summary("update_expense", {
        id: 2,
        issueDate: "2026-10-05",
        vatTreatment: "reverse_charge",
        category: "telefon_internet",
        lines: [{ category: "telefon_internet", gross: 25 }, { category: "bewirtung", net: "12,50" }, {}],
      }),
    ).toBe(
      "Ausgabe ER-2026-0002 A1 Telekom ändern: Datum: 04.10.2026 → 05.10.2026; USt-Behandlung: Inland → Reverse Charge; " +
        "Kategorie aller Positionen: Telefon und Internet → Telefon & Internet; Positionen ersetzen: 1 Position(en), brutto € 60,00 → 3 neue Position(en) " +
        "(Telefon & Internet € 25,00 brutto, Bewirtung (50 %) € 12,50 netto, ? ohne Betrag)",
    );
  });

  test("update_document_draft: changed fields and the replaced items", async () => {
    expect(
      await summary("update_document_draft", {
        id: 12,
        title: "Wartung",
        dueDate: "2026-10-31",
        taxMode: "EU_REVERSE_CHARGE",
        items: [{ title: "Wartung Oktober", quantity: 2.5, unit: "Std.", unitPrice: "95,00" }, { title: "Hosting", quantity: 1, unit: "Pauschal", unitPrice: 20 }],
      }),
    ).toBe(
      "Rechnung (Entwurf, id 12) für Alpen Software GmbH ändern: Fällig am: 15.10.2026 → 31.10.2026; Steuermodus: Inland (AT) → EU Reverse Charge; " +
        "alle Positionen ersetzen: 1 Position(en), netto € 190,00 → 2 neue (Wartung Oktober 2,5 Std. × € 95,00, Hosting 1 Pauschal × € 20,00)",
    );
    expect(await summary("update_document_draft", { id: 12, clientName: "Berlin Digital" })).toBe(
      "Rechnung (Entwurf, id 12) für Alpen Software GmbH ändern: Kunde: Alpen Software GmbH → Berlin Digital",
    );
    expect(sp(await confirmSummary("update_document_draft", { id: 7, issueDate: "2026-10-02" }, { document: async () => null }))).toBe("Entwurf id 7 ändern: Datum → 02.10.2026");
  });

  test("mark_expense_paid, apply_receipt_analysis, link_expense_to_fixed_cost", async () => {
    expect(await summary("mark_expense_paid", { id: 2, paidAt: "2026-10-06" })).toBe("Ausgabe ER-2026-0002 A1 Telekom (€ 60,00) als bezahlt am 06.10.2026 markieren");
    expect(await summary("mark_expense_paid", { id: 2, paidAt: null })).toBe("Ausgabe ER-2026-0002 A1 Telekom (€ 60,00) wieder als offen markieren");
    expect(await summary("apply_receipt_analysis", { expenseId: 2, fields: ["supplierName", "lines"] })).toBe(
      "Belegerkennung auf Ausgabe ER-2026-0002 A1 Telekom übernehmen: Lieferant „A1 Telekom Austria AG“, Positionen (Steuerzeilen) – bestehende Werte werden ersetzt",
    );
    expect(await summary("link_expense_to_fixed_cost", { expenseId: 2, fixedCostId: 1, scheduledDate: "2026-10-01" })).toBe(
      "Ausgabe ER-2026-0002 A1 Telekom den Fixkosten „Büromiete“ zuordnen (Termin 01.10.2026); der Termin zählt dann nicht mehr in der Prognose – ersetzt die bestehende Verknüpfung mit „Internet“ (01.10.2026)",
    );
    // lookups fail → ids instead of names
    expect(sp(await confirmSummary("link_expense_to_fixed_cost", { expenseId: 9 }, { document: async () => null }))).toBe(
      "Ausgabe id 9 den passenden Fixkosten zuordnen (passender freier Termin); der Termin zählt dann nicht mehr in der Prognose",
    );
  });
});
