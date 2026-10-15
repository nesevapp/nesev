import type { ChatCard, ChatLink, ChatTone } from "../../shared/chat";
import { DOCUMENT_STATUSES, type DocumentStatus } from "../../shared/documents";
import { formatCents } from "../../shared/money";
import { appPath } from "./chat-tools";

// Generative UI: cards per tool result, built only from the tool's structured content (the MCP outputSchema
// shapes in src/mcp/tools), never from model text. Table-driven per tool name: the main card (BUILDERS), plus for
// a few tools a lead card shown above it (LEAD_BUILDERS, e.g. the dashboard's KPIs above its chart). A tool without
// a builder (or a result that doesn't have the expected shape) gets no card. Amounts stay integer cents; dates are formatted here
// because the UI can't tell a date column from text.

/** rows a table card shows; the rest is `more` */
export const CARD_ROWS = 8;

const MONTHS = ["Jän", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

// structured content is validated by the MCP outputSchema; here it is read loosely
type Data = Record<string, any>;
type Builder = (d: Data) => ChatCard | null;

const cents = (m: unknown): number => (m && typeof m === "object" && typeof (m as { cents?: unknown }).cents === "number" ? (m as { cents: number }).cents : 0);
const deDate = (iso: unknown): string => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10).split("-").reverse().join(".") : "–");
const path = (link: unknown): string | undefined => (typeof link === "string" ? (appPath(link) ?? undefined) : undefined);
const link = (label: string, to: unknown): ChatLink | undefined => {
  const p = path(to);
  return p ? { label, path: p } : undefined;
};
/** "2026-10" → "Okt" (with the year when the range spans two years: "Jän 27") */
const monthLabel = (key: string, withYear: boolean) => {
  const [y, m] = key.split("-");
  const name = MONTHS[Number(m) - 1] ?? key;
  return withYear ? `${name} ${y!.slice(2)}` : name;
};

type TableCard = Extract<ChatCard, { kind: "table" }>;
type KpiItem = Extract<ChatCard, { kind: "kpis" }>["items"][number];

function table(
  rows: Data[],
  o: {
    title: string;
    columns: TableCard["columns"];
    row: (r: Data) => Record<string, string | number | null>;
    rowPath?: (r: Data) => string | undefined;
    /** matching rows before the tool's own limit (list tools return `total`) */
    count?: number;
    link?: ChatLink;
  },
): TableCard {
  const shown = rows.slice(0, CARD_ROWS);
  const count = Math.max(typeof o.count === "number" ? o.count : rows.length, rows.length);
  return {
    kind: "table",
    title: o.title,
    columns: o.columns,
    rows: shown.map((r) => {
      const p = o.rowPath?.(r);
      return p ? { cells: o.row(r), path: p } : { cells: o.row(r) };
    }),
    ...(o.link ? { link: o.link } : {}),
    ...(count > shown.length ? { more: count - shown.length } : {}),
  };
}

/** the sum under a money column (default: the last one) */
const withTotal = (card: TableCard, total: { label: string; cents: number; column?: string } | null): ChatCard => {
  if (!total) return card;
  const column = total.column ?? card.columns.findLast((c) => c.money)?.key;
  return { ...card, total: column ? { ...total, column } : total };
};

// --- documents ------------------------------------------------------------------------------------------------

const DOC_LIST: Record<string, { title: string; path: string }> = {
  invoice: { title: "Rechnungen", path: "/invoices" },
  offer: { title: "Angebote", path: "/offers" },
  credit_note: { title: "Gutschriften", path: "/credit-notes" },
};

/** get_document and every write tool that returns the DocumentDetail */
const documentCard: Builder = (d) => {
  if (typeof d.id !== "number" || typeof d.typeLabel !== "string") return null;
  const p = path(d.link);
  if (!p) return null;
  const finalInvoice = d.type === "invoice" && d.status !== "draft";
  return {
    kind: "document",
    typeLabel: d.typeLabel,
    number: d.number ?? null,
    status: String(d.statusLabel ?? ""),
    ...((DOCUMENT_STATUSES as readonly unknown[]).includes(d.status) ? { statusKey: d.status as DocumentStatus } : {}),
    ...(typeof d.overdue === "boolean" ? { overdue: d.overdue } : {}),
    ...(typeof d.partiallyPaid === "boolean" ? { partial: d.partiallyPaid } : {}),
    client: (typeof d.client === "string" ? d.client : d.client?.name) || null,
    date: d.issueDate ?? null,
    dueDate: d.type === "offer" ? null : (d.dueDate ?? null),
    grossCents: cents(d.gross),
    openCents: finalInvoice ? (d.payment ? cents(d.payment.open) : d.open ? cents(d.open) : null) : null,
    path: p,
    pdfUrl: `/api/pdf/documents/${d.id}`,
  };
};

const documentList: Builder = (d) => {
  if (!Array.isArray(d.documents)) return null;
  const docs: Data[] = d.documents;
  const types = new Set(docs.map((x) => x.type));
  const only = types.size === 1 ? DOC_LIST[[...types][0]] : undefined;
  const showOpen = docs.some((x) => x.open && cents(x.open) > 0 && x.status !== "paid");
  const sumOpen = cents(d.sumOpen);
  const card = table(docs, {
    title: `${only?.title ?? "Belege"} (${d.total ?? docs.length})`,
    columns: [
      { key: "number", label: "Nummer" },
      { key: "client", label: "Kunde" },
      { key: "date", label: "Datum" },
      showOpen ? { key: "open", label: "Offen", align: "right", money: true } : { key: "gross", label: "Brutto", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
    row: (x) => ({
      number: x.number ?? `${x.typeLabel}-Entwurf`,
      client: x.client ?? "",
      date: deDate(x.issueDate),
      ...(showOpen ? { open: x.open ? cents(x.open) : null } : { gross: cents(x.gross) }),
      status: x.statusLabel ?? "",
    }),
    rowPath: (x) => path(x.link),
    count: d.total,
    link: only && { label: `Alle ${only.title}`, path: only.path },
  });
  return withTotal(card, showOpen && sumOpen ? { label: "Offen gesamt", cents: sumOpen } : { label: "Summe brutto", cents: cents(d.sumGross) });
};

const remindersDue: Builder = (d) => {
  if (!Array.isArray(d.invoices)) return null;
  const card = table(d.invoices, {
    title: `Überfällige Rechnungen (${d.invoices.length})`,
    columns: [
      { key: "number", label: "Rechnung" },
      { key: "client", label: "Kunde" },
      { key: "days", label: "Überfällig", align: "right" },
      { key: "open", label: "Offen", align: "right", money: true },
      { key: "next", label: "Nächste Stufe" },
    ],
    row: (x) => ({
      number: x.number ?? "",
      client: x.client ?? "",
      days: `${x.daysOverdue} Tage`,
      open: cents(x.open),
      next: x.dueForReminder ? String(x.suggestedLevelTitle ?? "") : `${x.suggestedLevelTitle ?? ""} (noch nicht fällig)`,
    }),
    rowPath: (x) => path(x.link),
    link: { label: "Mahnwesen", path: "/reminders" },
  });
  return withTotal(card, { label: "Offen gesamt", cents: cents(d.totalOpen) });
};

// --- master data, expenses ------------------------------------------------------------------------------------

const clientList: Builder = (d) => {
  if (!Array.isArray(d.clients)) return null;
  return table(d.clients, {
    title: `Kunden (${d.total ?? d.clients.length})`,
    columns: [
      { key: "number", label: "Nr." },
      { key: "name", label: "Name" },
      { key: "place", label: "Ort" },
      { key: "email", label: "E-Mail" },
    ],
    row: (x) => ({ number: x.number ?? "", name: x.name ?? "", place: [x.city, x.country].filter(Boolean).join(", "), email: x.email ?? "" }),
    rowPath: (x) => path(x.link),
    count: d.total,
    link: { label: "Alle Kunden", path: "/clients" },
  });
};

const expenseList: Builder = (d) => {
  if (!Array.isArray(d.expenses)) return null;
  const card = table(d.expenses, {
    title: `Ausgaben (${d.total ?? d.expenses.length})`,
    columns: [
      { key: "number", label: "Nummer" },
      { key: "supplier", label: "Lieferant" },
      { key: "date", label: "Datum" },
      { key: "gross", label: "Brutto", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
    row: (x) => ({ number: x.number ?? "–", supplier: x.supplier || x.description || "", date: deDate(x.issueDate), gross: cents(x.gross), status: x.statusLabel ?? "" }),
    rowPath: (x) => path(x.link),
    count: d.total,
    link: { label: "Alle Ausgaben", path: "/expenses" },
  });
  return withTotal(card, { label: "Summe brutto", cents: cents(d.sumGross) });
};

/** list_receipt_inbox: files waiting in the Belege-Eingang */
const receiptInbox: Builder = (d) => {
  if (!Array.isArray(d.items)) return null;
  return table(d.items, {
    title: `Belege-Eingang (${d.total ?? d.items.length})`,
    columns: [
      { key: "file", label: "Datei" },
      { key: "date", label: "Eingegangen" },
      { key: "source", label: "Quelle" },
    ],
    row: (x) => ({ file: x.fileName ?? "", date: deDate(x.receivedAt), source: x.source === "folder" ? "Ordner" : "hochgeladen" }),
    rowPath: () => "/expenses/inbox",
    count: d.total,
    link: { label: "Belege-Eingang öffnen", path: "/expenses/inbox" },
  });
};

/** create_expense_from_inbox: the new drafts */
const inboxExpenses: Builder = (d) => {
  if (!Array.isArray(d.created) || !d.created.length) return null;
  return table(d.created, {
    title: d.created.length === 1 ? "Ausgabe aus Belege-Eingang angelegt" : `${d.created.length} Ausgaben aus Belege-Eingang angelegt`,
    columns: [
      { key: "number", label: "Nummer" },
      { key: "file", label: "Beleg" },
    ],
    row: (x) => ({ number: x.number ?? "–", file: x.fileName ?? "" }),
    rowPath: (x) => path(x.link),
  });
};

const fixedCosts: Builder = (d) => {
  if (!Array.isArray(d.fixedCosts)) return null;
  const card = table(d.fixedCosts, {
    title: `Fixkosten (${d.fixedCosts.length})`,
    columns: [
      { key: "name", label: "Name" },
      { key: "interval", label: "Intervall" },
      { key: "next", label: "Nächste" },
      { key: "gross", label: "Betrag", align: "right", money: true },
      { key: "monthly", label: "pro Monat", align: "right", money: true },
    ],
    row: (x) => ({
      name: x.active === false ? `${x.name} (inaktiv)` : (x.name ?? ""),
      interval: x.interval ?? "",
      next: x.nextPaymentDate ? deDate(x.nextPaymentDate) : "beendet",
      gross: cents(x.gross),
      monthly: cents(x.monthly),
    }),
    rowPath: () => "/fixed-costs",
    link: { label: "Fixkosten", path: "/fixed-costs" },
  });
  return withTotal(card, { label: "Aktiv pro Monat", cents: cents(d.monthlyTotal) });
};

// --- finance --------------------------------------------------------------------------------------------------

const dashboard: Builder = (d) => {
  if (!Array.isArray(d.monthly) || !d.monthly.length) return null;
  const months: Data[] = d.monthly;
  // months after today without bookings have no value yet (null: no bar, the result line ends instead of dropping to 0)
  const thisMonth = typeof d.today === "string" ? d.today.slice(0, 7) : null;
  const empty = (m: Data) => thisMonth !== null && String(m.month) > thisMonth && !cents(m.revenue) && !cents(m.expenses);
  const values = (pick: (m: Data) => unknown) => months.map((m) => (empty(m) ? null : cents(pick(m))));
  return {
    kind: "chart",
    title: `Umsatz und Ausgaben ${d.year} (netto)`,
    chart: "bar",
    labels: months.map((m) => monthLabel(String(m.month), false)),
    series: [
      { label: "Umsatz", values: values((m) => m.revenue), tone: "revenue" },
      { label: "Ausgaben", values: values((m) => m.expenses), tone: "expenses" },
      { label: "Ergebnis", values: values((m) => m.result), tone: "result", type: "line" },
    ],
    link: link("Dashboard", d.link),
  };
};

/** the dashboard's key figures (above its monthly chart) */
const dashboardKpis: Builder = (d) => {
  const k: Data | undefined = d.kpis;
  if (!k || typeof k !== "object" || !k.revenue) return null;
  const previous = (m: unknown) => `Vorjahr ${formatCents(cents(m))}`;
  const overdue = k.overdue?.count ? `, ${k.overdue.count} überfällig` : "";
  return {
    kind: "kpis",
    title: `Kennzahlen ${d.year}`,
    items: [
      { label: "Umsatz netto", cents: cents(k.revenue), hint: previous(k.revenuePreviousYear), tone: "revenue" },
      { label: "Ausgaben netto", cents: cents(k.expenses), hint: previous(k.expensesPreviousYear), tone: "expenses" },
      { label: "Ergebnis", cents: cents(k.result), tone: "result" },
      {
        label: "Offene Rechnungen",
        cents: cents(k.openInvoices?.amount),
        hint: `${k.openInvoices?.count ?? 0} offen${overdue}`,
        tone: k.overdue?.count ? "negative" : "neutral",
      },
    ],
  };
};

const forecast: Builder = (d) => {
  if (!Array.isArray(d.months) || !d.months.length) return null;
  const months: Data[] = d.months;
  const years = new Set(months.map((m) => String(m.month).slice(0, 4)));
  const balance = months.every((m) => m.balanceEnd);
  return {
    kind: "chart",
    title: `Zahlungsprognose bis ${deDate(d.horizonEnd)} (brutto)`,
    chart: "bar",
    labels: months.map((m) => monthLabel(String(m.month), years.size > 1)),
    series: [
      { label: "Eingänge", values: months.map((m) => cents(m.in)), tone: "positive" },
      { label: "Ausgänge", values: months.map((m) => cents(m.out)), tone: "negative" },
      balance
        ? { label: "Kontostand", values: months.map((m) => cents(m.balanceEnd)), tone: "result", type: "line" }
        : { label: "Saldo", values: months.map((m) => cents(m.net)), tone: "result", type: "line" },
    ],
    link: link("Prognose", d.link),
  };
};

const TAX_TITLES: Record<string, string> = { uva: "UVA", zm: "ZM", ear: "EAR" };

const taxReport: Builder = (d) => {
  if (!Array.isArray(d.summary) || !d.summary.length) return null;
  const tone = (label: string, value: number): ChatTone | undefined => {
    if (/^Einnahmen/.test(label)) return "revenue";
    if (/^Ausgaben/.test(label)) return "expenses";
    if (/^(Gewinn|Verlust)/.test(label)) return "result";
    if (/^Zahllast/.test(label)) return "negative";
    if (/^Gutschrift/.test(label)) return value === 0 ? "neutral" : "positive";
    return undefined;
  };
  const items = (d.summary as Data[]).map((s, i, all) => {
    const value = cents(s.amount);
    const t = tone(String(s.label), value);
    const hint = i === all.length - 1 && d.dueDate ? `fällig ${deDate(d.dueDate)}` : undefined;
    return { label: String(s.label), cents: value, ...(hint ? { hint } : {}), ...(t ? { tone: t } : {}) };
  });
  return {
    kind: "kpis",
    title: `${TAX_TITLES[d.kind] ?? "Steuer"} ${d.period?.label ?? ""}`.trim(),
    items,
    link: link("Steuern", d.link),
  };
};

const assets: Builder = (d) => {
  if (!Array.isArray(d.assets)) return null;
  const card = table(d.assets, {
    title: `Anlagenverzeichnis ${d.year}`,
    columns: [
      { key: "number", label: "Nr." },
      { key: "name", label: "Bezeichnung" },
      { key: "cost", label: "AK", align: "right", money: true },
      { key: "afa", label: "AfA", align: "right", money: true },
      { key: "end", label: "Buchwert 31.12.", align: "right", money: true },
    ],
    row: (x) => ({ number: x.number ?? "", name: x.name ?? "", cost: cents(x.cost), afa: cents(x.afa), end: cents(x.bookValueEnd) }),
    rowPath: (x) => path(x.link),
    link: link("Anlagen", d.link),
  });
  return withTotal(card, d.totals ? { label: `AfA ${d.year}`, cents: cents(d.totals.afa) } : null);
};

const search: Builder = (d) => {
  if (!Array.isArray(d.results) || !d.results.length) return null;
  return table(d.results, {
    title: `Suche „${d.query}“`,
    columns: [
      { key: "type", label: "Typ" },
      { key: "label", label: "Treffer" },
      { key: "details", label: "Details" },
    ],
    row: (x) => ({ type: x.typeLabel ?? "", label: x.label ?? "", details: [x.sublabel, x.meta].filter(Boolean).join(" · ") }),
    rowPath: (x) => path(x.link),
  });
};

// --- bank -----------------------------------------------------------------------------------------------------

const TARGET_LABELS: Record<string, string> = { invoice: "Rechnung", credit_note: "Gutschrift", expense: "Ausgabe" };

const bankOverview: Builder = (d) => {
  if (!Array.isArray(d.accounts)) return null;
  const accounts = (d.accounts as Data[]).filter((a) => !a.archived);
  return {
    kind: "kpis",
    title: "Bank",
    items: [
      { label: "Offene Buchungen", cents: Number(d.openCount ?? 0), format: "count" as const, tone: "neutral" as ChatTone },
      { label: "Offene Eingänge", cents: cents(d.openIn), tone: "positive" as ChatTone },
      { label: "Offene Ausgänge", cents: -cents(d.openOut), tone: "negative" as ChatTone },
      ...accounts.slice(0, 3).map((a) => ({
        label: a.name || "Konto",
        cents: cents(a.importedSum),
        hint: `${a.transactionCount} Buchungen${a.lastBookingDate ? `, letzte ${deDate(a.lastBookingDate)}` : ""} (Summe der Importe, nicht der Kontostand)`,
        tone: "neutral" as ChatTone,
      })),
    ],
    link: { label: "Bank", path: "/bank" },
  };
};

const txCells = (x: Data) => ({
  date: deDate(x.date),
  counterparty: x.counterparty || "(ohne Name)",
  purpose: String(x.purpose ?? "").slice(0, 60),
  amount: cents(x.amount),
  status:
    Array.isArray(x.matches) && x.matches.length
      ? `→ ${(x.matches as Data[]).map((m) => m.number ?? TARGET_LABELS[m.kind] ?? "").join(", ")}`
      : String(x.statusLabel ?? ""),
});
const TX_COLUMNS: TableCard["columns"] = [
  { key: "date", label: "Datum" },
  { key: "counterparty", label: "Name" },
  { key: "purpose", label: "Zweck" },
  { key: "amount", label: "Betrag", align: "right", money: true },
  { key: "status", label: "Status" },
];

const bankTransactions: Builder = (d) => {
  if (!Array.isArray(d.transactions)) return null;
  const txs: Data[] = d.transactions;
  const statuses = new Set(txs.map((x) => x.status));
  const title = statuses.size === 1 && statuses.has("open") ? "Offene Bankbuchungen" : "Bankbuchungen";
  const card = table(txs, {
    title: `${title} (${d.total ?? txs.length})`,
    columns: TX_COLUMNS,
    row: txCells,
    rowPath: (x) => path(x.link),
    count: d.total,
    link: { label: "Bank", path: "/bank" },
  });
  const sumIn = cents(d.sumIn);
  const sumOut = cents(d.sumOut);
  // one direction only: its sum; mixed: the net
  return withTotal(card, !sumOut ? { label: "Eingänge", cents: sumIn } : !sumIn ? { label: "Ausgänge", cents: sumOut } : { label: "Saldo", cents: sumIn + sumOut });
};

/** get_bank_transaction and the matching tools (TransactionDetail): suggestions when open, else the allocations */
const bankTransaction: Builder = (d) => {
  if (typeof d.id !== "number" || !d.amount) return null;
  const head = `${deDate(d.date)} · ${d.counterparty || "(ohne Name)"} · ${d.statusLabel ?? ""}`;
  const suggestions: Data[] = Array.isArray(d.suggestions) ? d.suggestions : [];
  const matches: Data[] = Array.isArray(d.matches) ? d.matches : [];
  if (d.status === "open" && suggestions.length) {
    return table(suggestions, {
      title: `Vorschläge für Buchung ${formatCents(cents(d.amount))} – ${head}`,
      columns: [
        { key: "target", label: "Beleg" },
        { key: "name", label: "Name" },
        { key: "open", label: "Offen", align: "right", money: true },
        { key: "proposed", label: "Zuordnen", align: "right", money: true },
        { key: "confidence", label: "Treffer" },
      ],
      row: (x) => ({
        target: `${TARGET_LABELS[x.kind] ?? ""} ${x.number ?? ""}`.trim(),
        name: x.name ?? "",
        open: cents(x.open),
        proposed: cents(x.proposedAmount),
        confidence: `${CONFIDENCE[x.confidence] ?? x.confidence}${Array.isArray(x.reasons) && x.reasons.length ? ` (${x.reasons.join(", ")})` : ""}`,
      }),
      rowPath: (x) => path(x.link),
      link: link("In der Bank öffnen", d.link),
    });
  }
  if (matches.length) {
    const card = table(matches, {
      title: `Buchung ${head}`,
      columns: [
        { key: "target", label: "Zugeordnet" },
        { key: "name", label: "Name" },
        { key: "amount", label: "Betrag", align: "right", money: true },
      ],
      row: (x) => ({ target: `${TARGET_LABELS[x.kind] ?? ""} ${x.number ?? "(Entwurf)"}`.trim(), name: x.name ?? "", amount: cents(x.amount) }),
      rowPath: (x) => path(x.link),
      link: link("In der Bank öffnen", d.link),
    });
    return withTotal(card, cents(d.remaining) ? { label: "Noch nicht zugeordnet", cents: cents(d.remaining) } : null);
  }
  return {
    kind: "kpis",
    title: `Buchung ${head}`,
    items: [
      { label: "Betrag", cents: cents(d.amount), tone: cents(d.amount) >= 0 ? "positive" : "negative" },
      { label: "Nicht zugeordnet", cents: cents(d.remaining), tone: "muted" },
    ],
    link: link("In der Bank öffnen", d.link),
  };
};

const CONFIDENCE: Record<string, string> = { high: "sicher", medium: "wahrscheinlich", low: "möglich" };

// --- recurring invoices ---------------------------------------------------------------------------------------

const recurringCells = (x: Data) => ({
  name: x.name ?? "",
  client: x.client ?? "",
  interval: x.interval ?? "",
  next: x.ended ? "beendet" : x.active ? deDate(x.nextRunDate) : "pausiert",
  gross: cents(x.gross),
  mode: x.autoFinalize ? "finalisiert" : "Entwurf",
});
const RECURRING_COLUMNS: TableCard["columns"] = [
  { key: "name", label: "Name" },
  { key: "client", label: "Kunde" },
  { key: "interval", label: "Intervall" },
  { key: "next", label: "Nächste" },
  { key: "gross", label: "Brutto", align: "right", money: true },
  { key: "mode", label: "Erstellt als" },
];

const recurringList: Builder = (d) => {
  if (!Array.isArray(d.recurring)) return null;
  const card = table(d.recurring, {
    title: `Serienrechnungen (${d.count ?? d.recurring.length})`,
    columns: RECURRING_COLUMNS,
    row: recurringCells,
    rowPath: (x) => path(x.link),
    link: { label: "Serienrechnungen", path: "/recurring" },
  });
  return withTotal(card, { label: "Aktiv pro Monat", cents: cents(d.monthlyGross) });
};

/** set_recurring_invoice_active: the one row */
const recurringRow: Builder = (d) => {
  if (typeof d.id !== "number" || typeof d.name !== "string") return null;
  return table([d], {
    title: `Serienrechnung ${d.name}`,
    columns: RECURRING_COLUMNS,
    row: recurringCells,
    rowPath: (x) => path(x.link),
    link: link("Öffnen", d.link),
  });
};

// --- record changes, Fixkosten, assets -------------------------------------------------------------------------

/** update_client / update_expense / apply_receipt_analysis: what changed (the tools return `changes`) */
const changeTable =
  (title: (d: Data) => string): Builder =>
  (d) => {
    if (!Array.isArray(d.changes) || !d.changes.length) return null;
    return table(d.changes, {
      title: title(d),
      columns: [
        { key: "label", label: "Feld" },
        { key: "before", label: "vorher" },
        { key: "after", label: "nachher" },
      ],
      row: (c) => ({ label: c.label ?? c.field ?? "", before: c.before ?? "–", after: c.after ?? "–" }),
      link: link("Öffnen", d.link),
    });
  };

const expenseName = (d: Data) => [d.number ?? "Ausgabe", d.supplier].filter(Boolean).join(" · ");

/** mark_expense_paid: the expense as one row */
const expenseRowCard: Builder = (d) => {
  if (typeof d.id !== "number" || !d.gross) return null;
  return table([d], {
    title: `Ausgabe ${expenseName(d)}`,
    columns: [
      { key: "number", label: "Nummer" },
      { key: "supplier", label: "Lieferant" },
      { key: "paid", label: "Bezahlt am" },
      { key: "gross", label: "Brutto", align: "right", money: true },
      { key: "status", label: "Status" },
    ],
    row: (x) => ({ number: x.number ?? "–", supplier: x.supplier || x.description || "", paid: x.paidAt ? deDate(x.paidAt) : "–", gross: cents(x.gross), status: x.statusLabel ?? "" }),
    rowPath: (x) => path(x.link),
  });
};

const fixedCostLink: Builder = (d) => {
  if (!d.expense || !d.fixedCost) return null;
  return table([d], {
    title: d.replaced ? `Fixkosten-Verknüpfung ersetzt (vorher ${d.replaced.name} · ${deDate(d.replaced.scheduledDate)})` : "Mit Fixkosten verknüpft",
    columns: [
      { key: "expense", label: "Ausgabe" },
      { key: "fixedCost", label: "Fixkosten" },
      { key: "date", label: "Termin" },
      { key: "gross", label: "Betrag", align: "right", money: true },
    ],
    row: (x) => ({ expense: expenseName(x.expense), fixedCost: x.fixedCost.name ?? "", date: deDate(x.fixedCost.scheduledDate), gross: cents(x.expense.gross) }),
    rowPath: (x) => path(x.expense.link),
    link: { label: "Fixkosten", path: "/fixed-costs" },
  });
};

const fixedCostCreated: Builder = (d) => {
  if (typeof d.id !== "number" || !d.gross) return null;
  const tax = cents(d.tax);
  const next = d.nextPaymentDate ? `nächste Zahlung ${deDate(d.nextPaymentDate)}` : "keine weitere Zahlung";
  const items: KpiItem[] = [
    { label: "Pro Zahlung", cents: cents(d.gross), hint: [d.interval, next].filter(Boolean).join(" · "), tone: "expenses" },
    { label: "Pro Monat", cents: cents(d.monthly), tone: "expenses" },
  ];
  if (tax) items.push({ label: "Enthaltene USt", cents: tax, tone: "muted" });
  return { kind: "kpis", title: `Fixkosten ${d.name}`, items, link: { label: "Fixkosten", path: "/fixed-costs" } };
};

/** create_asset: the AfA plan per year (bars) with the book value at year end (line) */
const assetPlan: Builder = (d) => {
  if (!Array.isArray(d.schedule) || !d.schedule.length) return null;
  const years: Data[] = d.schedule;
  return {
    kind: "chart",
    title: `AfA-Plan ${d.number ?? ""} ${d.name ?? ""} (AK ${formatCents(cents(d.cost))}, ${d.usefulLifeYears} Jahre)`.replace(/\s+/g, " "),
    chart: "bar",
    labels: years.map((y) => String(y.year)),
    series: [
      { label: "AfA", values: years.map((y) => cents(y.afa)), tone: "expenses" },
      { label: "Buchwert 31.12.", values: years.map((y) => cents(y.bookValueEnd)), tone: "result", type: "line" },
    ],
    link: link("Anlage öffnen", d.link),
  };
};

const BUILDERS: Record<string, Builder> = {
  get_dashboard: dashboard,
  get_document: documentCard,
  // write tools that return the document
  create_invoice_draft: documentCard,
  create_offer_draft: documentCard,
  update_document_draft: documentCard,
  finalize_document: documentCard,
  mark_document_sent: documentCard,
  mark_invoice_paid: documentCard,
  convert_offer_to_invoice: documentCard,
  create_credit_note: documentCard,
  list_documents: documentList,
  list_reminders_due: remindersDue,
  list_clients: clientList,
  list_expenses: expenseList,
  list_receipt_inbox: receiptInbox,
  create_expense_from_inbox: inboxExpenses,
  list_fixed_costs: fixedCosts,
  list_assets: assets,
  get_forecast: forecast,
  get_tax_report: taxReport,
  search,
  get_bank_overview: bankOverview,
  list_bank_transactions: bankTransactions,
  get_bank_transaction: bankTransaction,
  match_bank_transaction: bankTransaction,
  unmatch_bank_transaction: bankTransaction,
  set_bank_transaction_ignored: bankTransaction,
  list_recurring_invoices: recurringList,
  set_recurring_invoice_active: recurringRow,
  generate_recurring_invoice: documentCard,
  update_client: changeTable((d) => `Kunde ${d.name ?? ""} geändert`),
  update_expense: changeTable((d) => `Ausgabe ${expenseName(d)} geändert`),
  apply_receipt_analysis: changeTable((d) => `Belegerkennung übernommen: ${expenseName(d)}`),
  mark_expense_paid: expenseRowCard,
  link_expense_to_fixed_cost: fixedCostLink,
  create_fixed_cost: fixedCostCreated,
  create_asset: assetPlan,
};

/** cards shown above the main card, where a second view adds something the main one can't show */
const LEAD_BUILDERS: Record<string, Builder> = {
  get_dashboard: dashboardKpis,
};

function run(build: Builder | undefined, structured: Record<string, unknown> | null): ChatCard | null {
  if (!build || !structured) return null;
  try {
    return build(structured);
  } catch {
    return null;
  }
}

/** The main card for a tool result, or null (unknown tool, no structured content, unexpected shape). */
export function buildCard(toolName: string, structured: Record<string, unknown> | null): ChatCard | null {
  return run(BUILDERS[toolName], structured);
}

/** All cards for a tool result, top to bottom (lead card, then the main card); empty when there are none. */
export function buildCards(toolName: string, structured: Record<string, unknown> | null): ChatCard[] {
  return [run(LEAD_BUILDERS[toolName], structured), buildCard(toolName, structured)].filter((c) => c !== null);
}

const CARD_NOUNS: Record<ChatCard["kind"], string> = { kpis: "Kennzahlen-Karte", chart: "Diagramm", document: "Beleg-Karte", table: "Tabelle" };

/**
 * Appended to the tool text for the model: the user already sees the card, so the answer should add a short
 * takeaway instead of repeating rows and figures.
 */
export function cardNote(cards: ChatCard | ChatCard[]): string {
  const nouns = [...new Set((Array.isArray(cards) ? cards : [cards]).map((c) => CARD_NOUNS[c.kind]))].join(" und ");
  return `[Der Nutzer sieht dieses Ergebnis bereits als ${nouns} im Chat. Nicht als Liste oder Tabelle wiederholen – antworte in 1–3 Sätzen mit dem Wesentlichen.]`;
}
