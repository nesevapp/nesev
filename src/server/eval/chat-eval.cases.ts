import { addDays, todayIso } from "../../shared/dates";
import type { EvalCase, TurnRecord } from "./chat-eval";

// The assistant eval's cases, run against the demo data of src/mcp/test/seed.ts (a fresh copy per case). The seed's
// dates are relative to today, so the expectations are too: numbers carry the current year, the overdue invoice is
// due 31 days ago, the expenses are from the last 10 days. Ids of the seed: invoice RE-<year>-0001 = 1 (overdue,
// Alpen, open € 1.140,00), credit note 2, paid invoice RE-<year>-0002 = 3 (Berlin), Alpen draft = 4, offer = 5;
// clients Alpen = 1, Berlin = 2; expenses A1 = 1, Adobe = 2 (open), incomplete = 3; bank bookings Alpen = 1,
// Adobe = 2, BILLA = 3; fixed cost Büromiete € 600,00/month.
//
// An expectation applies to the last turn of a case. Confirmations are always rejected by the runner.

const TODAY = todayIso();
const YEAR = TODAY.slice(0, 4);
const RE1 = `RE-${YEAR}-0001`;
const RE2 = `RE-${YEAR}-0002`;
const deDate = (iso: string) => iso.split("-").reverse().join(".");
const DUE = deDate(addDays(TODAY, -31));
const MONTH_INDEX = Number(TODAY.slice(5, 7)) - 1;
const MONTHS = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const MONTHS_SHORT = ["Jän", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

const amount = (s: string) => s.replace(/ /g, " ").replace(/^-?€\s?/, "");
/** a figure from a tool's text, e.g. the month row of get_dashboard; null when the tool didn't run */
const fromTool =
  (tool: string, re: RegExp, group = 1) =>
  (t: TurnRecord): string | null => {
    const r = t.results.find((x) => x.name === tool && x.ok);
    const m = r && re.exec(r.content.replace(/ /g, " "));
    return m?.[group] ? amount(m[group]) : null;
  };
const EURO = "(-?€ ?-?[\\d.]+,\\d\\d)";

export const CASES: EvalCase[] = [
  {
    id: "month",
    turns: [{ text: `Wie lief der ${MONTHS[MONTH_INDEX]}?` }],
    description: "get_dashboard; the month's expenses and result from the tool",
    tags: ["finance", "facts"],
    expect: {
      tools: ["get_dashboard"],
      facts: [
        fromTool("get_dashboard", new RegExp(`${MONTHS_SHORT[MONTH_INDEX]} ${EURO} / ${EURO} / ${EURO}`), 2),
        fromTool("get_dashboard", new RegExp(`${MONTHS_SHORT[MONTH_INDEX]} ${EURO} / ${EURO} / ${EURO}`), 3),
      ],
    },
  },
  {
    id: "open-invoices",
    turns: [{ text: "Zeig mir die offenen Rechnungen" }],
    description: `list_documents; ${RE1}, offen € 1.140,00`,
    tags: ["documents", "facts"],
    expect: { anyTool: ["list_documents", "list_reminders_due"], facts: [RE1, "1.140,00"] },
  },
  {
    id: "open-number",
    turns: [{ text: `Öffne die Rechnung ${RE1}` }],
    description: "navigate /invoices/1",
    tags: ["nav"],
    expect: { action: { kind: "navigate", path: "/invoices/1" } },
  },
  {
    id: "download",
    turns: [{ text: "Lade mir die Vorschau vom Entwurf für Alpen herunter" }],
    description: "download Entwurf-4.pdf (drafts have no number)",
    tags: ["nav", "pdf", "hard"],
    expect: { action: { kind: "download", url: "/api/pdf/documents/4?download=1", fileName: "Entwurf-4.pdf" }, notInAnswer: [new RegExp(`RE-${YEAR}-0004`)] },
  },
  {
    id: "fixed-costs",
    turns: [{ text: "Wie hoch sind meine Fixkosten?" }],
    description: "list_fixed_costs; € 600,00 per month",
    tags: ["expenses", "facts"],
    expect: { tools: ["list_fixed_costs"], facts: ["600,00"] },
  },
  {
    id: "bank-open",
    turns: [{ text: "Welche Bankumsätze sind noch nicht zugeordnet?" }],
    description: "list_bank_transactions; Alpen € 1.140,00 … BILLA",
    tags: ["bank", "facts"],
    expect: { tools: ["list_bank_transactions"], facts: ["1.140,00", /billa/i] },
  },
  {
    id: "forecast",
    turns: [{ text: "Wie sieht die Zahlungsprognose aus?" }],
    description: "get_forecast; amounts from the result",
    tags: ["finance"],
    expect: { tools: ["get_forecast"], facts: [/\d,\d\d/] },
  },
  {
    id: "uva",
    turns: [{ text: "Was muss ich für die letzte UVA zahlen?" }],
    description: "get_tax_report uva; the Zahllast/Gutschrift (KZ 095) and the disclaimer",
    tags: ["tax", "facts"],
    expect: {
      callArgs: [{ tool: "get_tax_report", args: { kind: "uva" } }],
      facts: [fromTool("get_tax_report", new RegExp(`(?:Zahllast|Gutschrift) \\(KZ 095\\) ${EURO}`)), /beratung|hilfsrechnung|prüf/i],
    },
  },
  {
    id: "pdf-deictic",
    turns: [{ text: "Zeig mir das PDF davon", contextPath: "/invoices/3", contextTitle: `Rechnung ${RE2}` }],
    description: "open_tab /api/pdf/documents/3 (the page's invoice)",
    tags: ["nav", "pdf", "context"],
    expect: { action: { kind: "open_tab", url: "/api/pdf/documents/3" } },
  },
  {
    id: "open-by-name",
    turns: [{ text: "Öffne die Ausgabe von A1" }],
    description: "navigate /expenses/1",
    tags: ["nav"],
    expect: { action: { kind: "navigate", path: "/expenses/1" } },
  },
  {
    id: "debtors",
    turns: [{ text: "Wer schuldet mir noch Geld und seit wann?" }],
    description: `Alpen, € 1.140,00, fällig seit ${DUE} (31 Tage)`,
    tags: ["documents", "facts"],
    expect: { facts: [/alpen/i, "1.140,00", new RegExp(`${DUE.replace(/\./g, "\\.")}|31 Tage`)] },
  },
  {
    id: "follow-up",
    turns: [{ text: "Welche Kunden habe ich?" }, { text: "Welche offenen Rechnungen hat der erste davon?" }],
    description: `second turn needs the first: Alpen → ${RE1}, € 1.140,00`,
    tags: ["multi-turn", "facts"],
    expect: { facts: [RE1, "1.140,00"] },
  },
  {
    id: "context-guard",
    turns: [{ text: "Lade mir die Vorschau vom Entwurf für Alpen herunter", contextPath: "/invoices/1", contextTitle: `Rechnung ${RE1}` }],
    description: "on /invoices/1: download the Alpen draft (4), never the page's invoice",
    tags: ["context", "pdf", "hard"],
    expect: { action: { kind: "download", url: "/api/pdf/documents/4?download=1" } },
  },
  {
    id: "ambiguous",
    turns: [{ text: "Öffne die Rechnung von Alpen" }],
    description: `no navigation; asks: ${RE1} or the draft`,
    tags: ["nav", "hard"],
    expect: { action: "none", facts: [RE1, /entwurf|id 4/i] },
  },
  {
    id: "ear",
    turns: [{ text: `Wie hoch ist mein Gewinn laut EAR ${YEAR}?` }],
    description: "get_tax_report ear; the Gewinn/Verlust from the result",
    tags: ["tax", "facts"],
    expect: { callArgs: [{ tool: "get_tax_report", args: { kind: "ear" } }], facts: [fromTool("get_tax_report", new RegExp(`(?:Gewinn|Verlust) ${EURO}`))] },
  },
  {
    id: "recent-expenses",
    turns: [{ text: "Welche Ausgaben hatte ich in den letzten zwei Wochen?" }],
    description: "list_expenses; A1 (Internet) and Adobe",
    tags: ["expenses", "facts"],
    expect: { tools: ["list_expenses"], facts: [/a1|telekom|internet/i, /adobe/i] },
  },
  {
    id: "bank-match",
    turns: [{ text: `Ordne die Zahlung von Alpen der Rechnung ${RE1} zu` }],
    description: "confirm match_bank_transaction {id 1, targets [invoice 1]} after a lookup",
    tags: ["bank", "confirm", "hard"],
    expect: { confirm: { tool: "match_bank_transaction", args: { id: 1, targets: [{ id: 1 }] } } },
  },
  {
    id: "update-client",
    turns: [{ text: "Ändere die E-Mail von Alpen auf office@alpen.at" }],
    description: "confirm update_client {id 1, email} and nothing else",
    tags: ["clients", "confirm"],
    expect: { confirm: { tool: "update_client", args: { id: 1, email: "office@alpen.at" }, exact: true } },
  },
  {
    id: "expense-paid",
    turns: [{ text: "Markiere die Ausgabe von Adobe als bezahlt" }],
    description: "confirm mark_expense_paid {id 2}",
    tags: ["expenses", "confirm"],
    expect: { confirm: { tool: "mark_expense_paid", args: { id: 2 } } },
  },
  {
    id: "reminder",
    turns: [{ text: "Schick eine Mahnung für die überfällige Rechnung" }],
    description: "confirm create_reminder {invoiceId 1}",
    tags: ["documents", "confirm", "hard"],
    expect: { confirm: { tool: "create_reminder", args: { invoiceId: 1 } } },
  },
  {
    id: "draft",
    turns: [{ text: "Erstelle eine Rechnung für Alpen mit 3 Std. Beratung à 120 € und zeig sie mir" }],
    description: "create_invoice_draft (3 × 120,00) → shown with brutto € 432,00",
    tags: ["documents", "multi-step", "hard"],
    expect: {
      tools: ["create_invoice_draft"],
      callArgs: [{ tool: "create_invoice_draft", args: { items: [{ quantity: 3, unitPrice: 120 }] } }],
      facts: ["432,00"],
      confirm: false,
    },
  },
];
