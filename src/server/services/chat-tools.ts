import { CONFIRM_TOOLS, type ChatLink, type ChatToolResult, type ChatUiAction, resultCards, TOOL_GROUP_META, TOOL_GROUPS, type ToolGroup } from "../../shared/chat";
import { todayIso } from "../../shared/dates";
import { categoryLabel, VAT_TREATMENT_SHORT_LABELS, type VatTreatment } from "../../shared/expenses";
import { formatCents, parseMoneyToCents } from "../../shared/money";
import { TAX_MODE_LABELS, type TaxMode } from "../../shared/tax";
import { buildCards, cardNote } from "./chat-cards";
import type { LlmTool } from "./chat-llm";

// The assistant's tools are nesev's MCP tools (src/mcp), executed in-process: an MCP client linked to buildServer()
// over the SDK's in-memory transport, with the in-server ToolContext (links are app paths, receipt analysis is
// queued in this process). Here: the ToolHost abstraction (tests use a fake), MCP → OpenAI tool definitions, which
// tools a request gets (routing by group), tool results → ChatToolResult (with cards) for the UI, and the German
// confirmation summaries.

export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** changes state (MCP destructiveHint): needs the user's click */
  destructive: boolean;
  /** routing group (MCP `_meta["nesev/group"]`; "core" when missing) */
  group: ToolGroup;
}

export const toolGroup = (meta: Record<string, unknown> | undefined): ToolGroup => {
  const g = meta?.[TOOL_GROUP_META];
  return (TOOL_GROUPS as readonly unknown[]).includes(g) ? (g as ToolGroup) : "core";
};

export interface ToolOutcome {
  isError: boolean;
  /** text content for the model */
  text: string;
  structured: Record<string, unknown> | null;
  /** UI action of an assistant-only tool (chat-ui-tools.ts) */
  action?: ChatUiAction;
}

export interface ToolHost {
  tools: ChatTool[];
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

// --- in-process MCP host --------------------------------------------------------------------------------------

let hostPromise: Promise<ToolHost> | null = null;

/**
 * The process-wide host, connected on first use. Loaded lazily: src/mcp imports the Hono app (which mounts this
 * module's route), and the dynamic import keeps that cycle and the MCP modules out of startup and of tests.
 */
export function mcpToolHost(): Promise<ToolHost> {
  hostPromise ??= connectMcpHost().catch((err) => {
    hostPromise = null;
    throw err;
  });
  return hostPromise;
}

async function connectMcpHost(): Promise<ToolHost> {
  const [{ Client }, { InMemoryTransport }, { buildServer }, { createServerContext }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/server"),
    import("../../mcp/build"),
    import("../../mcp/tool"),
  ]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(createServerContext());
  await server.connect(serverTransport);
  const client = new Client({ name: "nesev-assistant", version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      inputSchema: t.inputSchema as Record<string, unknown>,
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
      group: toolGroup(t._meta),
    })),
    async call(name, args) {
      try {
        const res = (await client.callTool({ name, arguments: args })) as {
          isError?: boolean;
          content?: { type: string; text?: string }[];
          structuredContent?: Record<string, unknown>;
        };
        const text = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n").trim();
        return { isError: !!res.isError, text: text || (res.isError ? "Fehler" : "OK"), structured: res.structuredContent ?? null };
      } catch (err) {
        // protocol-level errors (unknown tool, invalid arguments) go back to the model as a tool error
        return { isError: true, text: `Fehler: ${(err as Error).message}`, structured: null };
      }
    },
  };
}

// --- definitions & selection --------------------------------------------------------------------------------

/** Needs confirmation: listed in CONFIRM_TOOLS or annotated destructive (the MCP's CHANGES_STATE tools). */
export const needsConfirm = (tool: Pick<ChatTool, "name" | "destructive">) =>
  tool.destructive || (CONFIRM_TOOLS as readonly string[]).includes(tool.name);

export function toLlmTool(tool: ChatTool): LlmTool {
  const { $schema: _schema, ...parameters } = tool.inputSchema;
  return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
}

/**
 * Rough token estimate, on the safe side: the 28 tool definitions as JSON are ~35k chars and render to ~13k tokens in
 * Qwen3.5's template (measured via llama-server /apply-template + /tokenize), i.e. ~2.7 chars per token.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 2.7);

export const toolTokens = (tools: ChatTool[]) => estimateTokens(JSON.stringify(tools.map(toLlmTool)));

/**
 * Routing table: which groups a request gets besides "core" and "ui" (always offered). A group is added when the
 * current or previous user message matches its `words`, when the user is on one of its pages, or when one of its
 * tools ran in the last turns (follow-ups like "ja, finalisiere" or "und im September?"). `weak` words are ambiguous
 * ("bezahlt", "offen", "Zahlung", "ändern" …): they add their group only when no other group is named by a strong
 * word, so "Markiere die Ausgabe von Adobe als bezahlt" gets expenses only, "Was ist noch offen?" documents.
 * New tools only need a group. Matched on the lower-cased text; stems, so "rechnungen", "Rechnungsentwurf" match.
 */
export const GROUP_ROUTES: Record<Exclude<ToolGroup, "core" | "ui">, { words: RegExp; weak?: RegExp; paths: RegExp }> = {
  documents: {
    words:
      /rechnung|angebot|gutschrift|storn|entwurf|entwürf|finalis|abschlie|mahn|zahlungserinnerung|überfällig|ueberfaellig|versend|verschick|gesendet|umwandel|serien|wiederkehrend|abrechn|verrechn|stunde|std\b|\b(re|an|gs|ma)-?\s?\d/,
    weak: /fällig|faellig|offen|bezahlt|position/,
    paths: /^\/(invoices|offers|credit-notes|reminders|recurring)\b/,
  },
  clients: {
    words: /kunde|kundin|client|artikel|leistung|produkt|stammdat|adresse|e-?mail|telefon|ansprechp|kontaktp|\bk-?\d/,
    weak: /änder|aender|\buid\b/,
    paths: /^\/(clients|articles)\b/,
  },
  expenses: {
    words:
      /ausgabe|beleg|quittung|kassenbon|rechnungsfoto|einkauf|eingangsrechnung|lieferant|fixkost|miete|versicherung|\bsvs\b|abo\b|abonnement|kategori|erkennung|\bocr\b|\ber-?\s?\d/,
    weak: /kosten/,
    paths: /^\/(expenses|fixed-costs)\b/,
  },
  bank: {
    words:
      /bank|konto|kontoauszug|buchung|zugeordnet|zahlungseingang|geldeingang|überweis|ueberweis|lastschrift|\biban\b|umsätze zu|umsatz zu|camt|kontobewegung|(zahlung|eingang)[^.?!]*\bzu\b|zuordn[^.?!]*zahlung/,
    weak: /zuordn|\bordne|\bzahlung(en)?\b|eingegangen|abgleich/,
    paths: /^\/bank\b/,
  },
  finance: {
    words:
      /prognose|liquidität|liquiditaet|cashflow|cash-flow|vorschau auf|kontostand|\buva\b|\bzm\b|\bear\b|umsatzsteuer|zahllast|finanzamt|\bafa\b|abschreib|anlage|anlagen|\bgwg\b|geringwertig|e1a|einnahmen-ausgaben/,
    weak: /steuer|\bust\b|vorsteuer|gewinn|verlust/,
    paths: /^\/(forecast|tax|assets)\b/,
  },
};

type RoutedGroup = keyof typeof GROUP_ROUTES;

/** Groups named by the text: strong words, plus weak words of a group when no other group is named strongly. */
export function textGroups(text: string): Set<RoutedGroup> {
  const entries = Object.entries(GROUP_ROUTES) as [RoutedGroup, (typeof GROUP_ROUTES)[RoutedGroup]][];
  const strong = new Set(entries.filter(([, r]) => r.words.test(text)).map(([g]) => g));
  const out = new Set(strong);
  for (const [g, r] of entries) {
    if (!strong.has(g) && r.weak?.test(text) && ![...strong].some((s) => s !== g)) out.add(g);
  }
  return out;
}

/**
 * A short, pure navigation request ("Öffne die Ausgabe von A1", "Geh zu den Steuern"): only core + ui, so the 4B
 * reaches for open_in_app (with `query`/`number`) instead of a list tool whose result it then just describes.
 */
const OPEN_INTENT = /^\s*(bitte\s+)?(öffne|oeffne|geh(e)?\s+(zu|zur|zum|in)|bring\s+mich|navigier|spring\s+(zu|zur|zum))\b/;
const OTHER_ACTION = /\bund\b|bezahlt|markier|finalis|änder|aender|erstell|anleg|zuordn|pdf|herunterlad|runter|download/;

/** a short, pure navigation request (see OPEN_INTENT) */
export const isOpenRequest = (text: string) => {
  const t = text.toLowerCase();
  return OPEN_INTENT.test(t) && !OTHER_ACTION.test(t) && t.length <= 80;
};

/** generic write verbs without a group word ("leg das an"): every group may be meant */
const GENERIC_WRITE = /anleg|erstell|erfass|\bneu(e|er|en|es)?\b|änder|aender|korrigier|bearbeit|trag .* ein|leg .* an/;

/** stable order of the groups in the tool list (keeps the cached prompt prefix: core + ui first) */
const GROUP_ORDER = new Map<ToolGroup, number>(TOOL_GROUPS.map((g, i) => [g, i]));

export interface ToolSelectionInput {
  /** latest user messages, newest first (the current one first) */
  userTexts: string[];
  contextPath?: string | null;
  /** tools the model called in the recent history (kept, so follow-ups like "ja, finalisiere" work) */
  recentTools?: string[];
  /** tokens available for tool definitions */
  budgetTokens: number;
}

export interface ToolSelection {
  tools: ChatTool[];
  /** groups offered in full; `fallback`: nothing matched, so only the read tools of the other groups */
  groups: ToolGroup[];
  fallback: boolean;
}

/** Which groups a request gets, and why (see GROUP_ROUTES). */
export function routeGroups(all: ChatTool[], input: Omit<ToolSelectionInput, "budgetTokens">): { groups: Set<ToolGroup>; fallback: boolean; generic: boolean } {
  const text = input.userTexts.slice(0, 2).join("\n").toLowerCase();
  const groups = new Set<ToolGroup>(["core", "ui"]);
  if (isOpenRequest(input.userTexts[0] ?? "")) return { groups, fallback: false, generic: false };
  for (const g of textGroups(text)) groups.add(g);
  for (const [group, route] of Object.entries(GROUP_ROUTES) as [RoutedGroup, { paths: RegExp }][]) {
    if (input.contextPath && route.paths.test(input.contextPath)) groups.add(group);
  }
  const byName = new Map(all.map((t) => [t.name, t.group]));
  for (const name of input.recentTools ?? []) {
    const g = byName.get(name);
    if (g) groups.add(g);
  }
  const generic = GENERIC_WRITE.test(text);
  return { groups, fallback: groups.size === 2, generic };
}

/**
 * Which tools a request gets: "core" + "ui" always, other groups by intent (routeGroups). When no group matched, the
 * read tools of all groups (questions like "Wie lief Oktober?" need no write tool, and the read tools are small),
 * plus every write tool when the text has a generic write verb ("leg das an"). The list is ordered by TOOL_GROUPS so
 * the prompt prefix (system prompt + core/ui tools) stays the same across turns and llama-server's prompt cache
 * keeps working. Over the token budget (small context sizes): write tools of groups matched only by page or recent
 * use are dropped first, then all write tools outside core.
 */
export function selectTools(all: ChatTool[], input: ToolSelectionInput): ChatTool[] {
  return selectToolsDetailed(all, input).tools;
}

export function selectToolsDetailed(all: ChatTool[], input: ToolSelectionInput): ToolSelection {
  const { groups, fallback, generic } = routeGroups(all, input);
  const order = (tools: ChatTool[]) =>
    tools
      .map((t, i) => ({ t, i }))
      .sort((a, b) => GROUP_ORDER.get(a.t.group)! - GROUP_ORDER.get(b.t.group)! || a.i - b.i)
      .map((x) => x.t);
  let tools = order(all.filter((t) => groups.has(t.group) || (fallback && (t.readOnly || generic))));
  if (toolTokens(tools) > input.budgetTokens) {
    const text = input.userTexts.slice(0, 2).join("\n").toLowerCase();
    const worded: Set<ToolGroup> = textGroups(text);
    tools = tools.filter((t) => t.readOnly || t.group === "core" || worded.has(t.group));
    if (toolTokens(tools) > input.budgetTokens) tools = tools.filter((t) => t.readOnly || t.group === "core");
  }
  return { tools, groups: [...groups].sort((a, b) => GROUP_ORDER.get(a)! - GROUP_ORDER.get(b)!), fallback };
}

// --- results for the UI ---------------------------------------------------------------------------------------

const MAX_LINKS = 6;

/** app path of a link from a tool result ("/invoices/12"; absolute web URLs are reduced to their path) */
export function appPath(link: string): string | null {
  if (link.startsWith("/")) return link;
  try {
    const url = new URL(link);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function linkLabel(o: Record<string, unknown>): string {
  for (const key of ["number", "label", "name", "title", "supplier", "client"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (typeof o.typeLabel === "string") return `${o.typeLabel} (Entwurf)`;
  return "Öffnen";
}

/** links found in structured content: every object's `link` (labelled by its number/name), plus a PDF url */
export function extractLinks(structured: Record<string, unknown> | null): ChatLink[] {
  const out: ChatLink[] = [];
  const seen = new Set<string>();
  const add = (label: string, link: unknown) => {
    if (typeof link !== "string" || out.length >= MAX_LINKS) return;
    const path = appPath(link);
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ label, path });
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || out.length >= MAX_LINKS || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    const o = value as Record<string, unknown>;
    if (typeof o.link === "string") add(linkLabel(o), o.link);
    const pdf = o.pdf as { url?: unknown } | null | undefined;
    if (pdf && typeof pdf === "object" && typeof pdf.url === "string") add("PDF", pdf.url);
    for (const [k, v] of Object.entries(o)) if (k !== "pdf" && v && typeof v === "object") walk(v, depth + 1);
  };
  walk(structured, 0);
  return out;
}

/** The UI view of a tool result: summary line, links, and for successful calls the card (chat-cards.ts) and the UI action. */
export function toChatToolResult(outcome: ToolOutcome, toolName?: string): ChatToolResult {
  // the first line is often a heading of the list that follows ("3 Belege, Summe brutto € 1.284,00:")
  const first = (outcome.text.split("\n").find((l) => l.trim())?.trim() ?? "").replace(/\s*:$/, "");
  const summary = first.length > 160 ? `${first.slice(0, 157)}…` : first;
  const result: ChatToolResult = { ok: !outcome.isError, summary: summary || (outcome.isError ? "Fehler" : "Erledigt"), links: outcome.isError ? [] : extractLinks(outcome.structured) };
  if (outcome.isError) return result;
  const cards = toolName ? buildCards(toolName, outcome.structured) : [];
  if (cards.length) result.cards = cards;
  if (outcome.action) result.action = outcome.action;
  return result;
}

/** What the model reads for a tool result: the tool text, plus a note when the user already sees it as a card. */
export function toolContent(outcome: ToolOutcome, result: ChatToolResult): string {
  const cards = resultCards(result);
  return cards.length ? `${outcome.text}\n${cardNote(cards)}` : outcome.text;
}

// --- confirmation summaries -----------------------------------------------------------------------------------

/** "Rechnung (Entwurf, id 12) für Alpen GmbH über € 648,00" from a get_document result; null when unknown */
export type DocumentLookup = (id: number, amount?: "gross" | "open") => Promise<string | null>;

/** a bank transaction for the summary (from get_bank_transaction) */
export interface TxInfo {
  date: string;
  /** signed */
  amountCents: number;
  counterparty: string;
  remainingCents: number;
  matches: { matchId: number; kind: string; number: string | null; name: string; amountCents: number }[];
}

/** a recurring invoice for the summary (from list_recurring_invoices; the tools only take its id) */
export interface RecurringInfo {
  name: string;
  client: string;
  grossCents: number;
  autoFinalize: boolean;
  nextRunDate: string;
}

/** Records the summaries name; each lookup returns null when the record is unknown (the summary then shows the id). */
export interface ConfirmLookups {
  document: DocumentLookup;
  transaction?: (id: number) => Promise<TxInfo | null>;
  /** "Ausgabe ER-2026-0002 A1 Telekom" */
  expense?: (id: number) => Promise<string | null>;
  recurring?: (id: number) => Promise<RecurringInfo | null>;
  /** structured content of a read tool (get_client, get_expense, list_fixed_costs, get_receipt_analysis); null on error */
  read?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, any> | null>;
}

const structuredOf = async (host: ToolHost, name: string, args: Record<string, unknown>) => {
  const res = await host.call(name, args).catch(() => null);
  return res && !res.isError ? (res.structured as Record<string, any> | null) : null;
};
const centsOf = (m: unknown) => (m && typeof m === "object" && typeof (m as { cents?: unknown }).cents === "number" ? (m as { cents: number }).cents : 0);

export function documentLookup(host: ToolHost): DocumentLookup {
  return async (id, amount = "gross") => {
    const d = await structuredOf(host, "get_document", { id });
    if (!d) return null;
    const what = d.number ? `${d.typeLabel} ${d.number}` : `${d.typeLabel} (Entwurf, id ${d.id})`;
    const client = d.client?.name ? ` für ${d.client.name}` : "";
    const sum = amount === "open" && d.open?.formatted ? ` (offen ${d.open.formatted})` : d.gross?.formatted ? ` über ${d.gross.formatted}` : "";
    return `${what}${client}${sum}`;
  };
}

/** The lookups for the real tool host (MCP read tools). */
export function confirmLookups(host: ToolHost): ConfirmLookups {
  return {
    document: documentLookup(host),
    read: (tool, args) => structuredOf(host, tool, args),
    async transaction(id) {
      const t = await structuredOf(host, "get_bank_transaction", { id });
      if (!t) return null;
      return {
        date: String(t.date ?? ""),
        amountCents: centsOf(t.amount),
        counterparty: String(t.counterparty ?? ""),
        remainingCents: centsOf(t.remaining),
        matches: (Array.isArray(t.matches) ? t.matches : []).map((m: Record<string, any>) => ({
          matchId: m.matchId,
          kind: m.kind,
          number: m.number ?? null,
          name: m.name ?? "",
          amountCents: centsOf(m.amount),
        })),
      };
    },
    async expense(id) {
      const e = await structuredOf(host, "get_expense", { id });
      return e ? ["Ausgabe", e.number ?? `(id ${id})`, e.supplier].filter(Boolean).join(" ") : null;
    },
    async recurring(id) {
      const list = await structuredOf(host, "list_recurring_invoices", {});
      const r = Array.isArray(list?.recurring) ? list.recurring.find((x: Record<string, any>) => x.id === id) : null;
      return r ? { name: r.name, client: r.client ?? "", grossCents: centsOf(r.gross), autoFinalize: !!r.autoFinalize, nextRunDate: r.nextRunDate ?? "" } : null;
    },
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const deDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");
/** euro input as the tools take it (number or "1.234,56") → "€ 1.234,56" */
function euroInput(v: unknown): string {
  const c = typeof v === "number" ? Math.round(v * 100) : typeof v === "string" ? parseMoneyToCents(v) : null;
  return c === null ? String(v) : formatCents(c);
}
const KIND_LABELS: Record<string, string> = { invoice: "Rechnung", credit_note: "Gutschrift", expense: "Ausgabe" };

/** "Buchung 03.10.2026 € 540,00 Alpen Software GmbH" */
const txLabel = (t: TxInfo | null, id: number | null) =>
  t ? ["Buchung", deDate(t.date), formatCents(t.amountCents), t.counterparty].filter(Boolean).join(" ") : `Bankbuchung id ${id ?? "?"}`;

/** One German line for the confirmation card, e.g. "Rechnung (Entwurf, id 12) für Alpen GmbH über € 648,00 finalisieren – …". */
export async function confirmSummary(name: string, args: Record<string, unknown>, lookups: DocumentLookup | ConfirmLookups): Promise<string> {
  const l: ConfirmLookups = typeof lookups === "function" ? { document: lookups } : lookups;
  const doc = async (id: number | null, fallback: string, amount?: "gross" | "open") =>
    id ? ((await l.document(id, amount)) ?? `${fallback} id ${id}`) : fallback;
  switch (name) {
    case "finalize_document":
      return `${await doc(num(args.id), "Dokument")} finalisieren – vergibt die Nummer und erzeugt das PDF, danach unveränderbar`;
    case "mark_document_sent":
      return `${await doc(num(args.id), "Dokument")} als versendet markieren (es wird nichts verschickt)`;
    case "mark_invoice_paid": {
      const amount = args.expectedAmount !== undefined ? ` (Betrag ${String(args.expectedAmount)} €)` : "";
      const date = typeof args.paidAt === "string" ? ` am ${args.paidAt.split("-").reverse().join(".")}` : " mit heutigem Datum";
      return `${await doc(num(args.id), "Rechnung", "open")} als bezahlt markieren${date}${amount}`;
    }
    case "convert_offer_to_invoice":
      return `${await doc(num(args.offerId), "Angebot")} in einen Rechnungsentwurf umwandeln (das Angebot wird als angenommen markiert)`;
    case "create_credit_note": {
      const partial = Array.isArray(args.items) && args.items.length ? ` für ${args.items.length} Position(en)` : " über die ganze Rechnung";
      return `Gutschrift-Entwurf zu ${await doc(num(args.invoiceId), "Rechnung")}${partial} anlegen`;
    }
    case "create_reminder": {
      const final = args.finalize === false ? " als Entwurf" : " – wird sofort finalisiert (Nummer und PDF, unveränderbar)";
      const level = num(args.level) ? ` (Stufe ${args.level})` : "";
      return `Mahnung${level} zu ${await doc(num(args.invoiceId), "Rechnung")} erstellen${final}`;
    }
    case "match_bank_transaction": {
      const id = num(args.id);
      const tx = id && l.transaction ? await l.transaction(id) : null;
      const targets = Array.isArray(args.targets) ? (args.targets as Record<string, unknown>[]) : [];
      const parts = await Promise.all(
        targets.map(async (t) => {
          const tid = num(t.id);
          const kind = String(t.kind ?? "invoice");
          const label =
            kind === "expense"
              ? ((tid && l.expense ? await l.expense(tid) : null) ?? `Ausgabe id ${tid ?? "?"}`)
              : await doc(tid, KIND_LABELS[kind] ?? "Beleg", "open");
          const amount =
            t.amount !== undefined && t.amount !== null
              ? euroInput(t.amount)
              : tx
                ? `ganzer offener Betrag ${formatCents(Math.abs(tx.remainingCents))}`
                : "ganzer offener Betrag";
          return `${label}: ${amount}`;
        }),
      );
      const effect = targets.some((t) => t.kind !== "expense") ? " – eine dadurch gedeckte Rechnung gilt danach als bezahlt" : " – eine dadurch gedeckte Ausgabe gilt danach als bezahlt";
      return `${txLabel(tx, id)} zuordnen → ${parts.join("; ") || "?"}${effect}`;
    }
    case "unmatch_bank_transaction": {
      const id = num(args.id);
      const tx = id && l.transaction ? await l.transaction(id) : null;
      const matchId = num(args.matchId);
      const matches = tx ? tx.matches.filter((m) => !matchId || m.matchId === matchId) : [];
      const which = matches.length
        ? ` (${matches.map((m) => `${KIND_LABELS[m.kind] ?? "Beleg"} ${m.number ?? "Entwurf"} ${m.name} ${formatCents(m.amountCents)}`.replace(/\s+/g, " ").trim()).join(", ")})`
        : "";
      return `${matchId ? "Eine Zuordnung" : "Alle Zuordnungen"} von ${txLabel(tx, id)} lösen${which} – damit bezahlte Rechnungen bzw. Ausgaben gelten wieder als offen`;
    }
    case "set_bank_transaction_ignored": {
      const id = num(args.id);
      const tx = id && l.transaction ? await l.transaction(id) : null;
      return args.ignored === false
        ? `${txLabel(tx, id)} wieder als offen führen (nicht mehr ignorieren)`
        : `${txLabel(tx, id)} ignorieren – braucht keine Rechnung oder Ausgabe (z. B. privat, Umbuchung)`;
    }
    case "set_recurring_invoice_active": {
      const id = num(args.id);
      const r = id && l.recurring ? await l.recurring(id) : null;
      const what = r ? `Serienrechnung „${r.name}“${r.client ? ` (${r.client})` : ""}` : `Serienrechnung id ${id ?? "?"}`;
      if (args.active === false) return `${what} pausieren – es werden keine Rechnungen mehr erstellt, bis sie fortgesetzt wird`;
      const today = todayIso();
      const catchUp = r && r.nextRunDate && r.nextRunDate < today ? ` – versäumte Termine seit ${deDate(r.nextRunDate)} werden nachgeholt` : "";
      return `${what} fortsetzen${catchUp}`;
    }
    case "generate_recurring_invoice": {
      const id = num(args.id);
      const r = id && l.recurring ? await l.recurring(id) : null;
      if (!r) return `Rechnung aus Serienrechnung id ${id ?? "?"} jetzt erstellen`;
      const mode = r.autoFinalize ? "wird sofort finalisiert (Nummer und PDF, unveränderbar)" : "als Entwurf";
      return `Rechnung aus Serienrechnung „${r.name}“${r.client ? ` für ${r.client}` : ""} jetzt erstellen (${formatCents(r.grossCents)}, ${mode})`;
    }
    case "update_client":
    case "update_expense":
    case "mark_expense_paid":
    case "apply_receipt_analysis":
    case "link_expense_to_fixed_cost":
      return recordSummary(name, args, l.read ?? (async () => null));
    default:
      return `Aktion „${name}“ ausführen`;
  }
}

// --- record changes (update_client, update_expense, expense payment, receipt analysis, Fixkosten link) -----------

type Read = NonNullable<ConfirmLookups["read"]>;

const CLIENT_FIELDS: Record<string, string> = {
  type: "Typ",
  name: "Name",
  contactPerson: "Ansprechperson",
  street: "Straße",
  addressExtra: "Adresszusatz",
  zip: "PLZ",
  city: "Ort",
  country: "Land",
  uid: "UID",
  email: "E-Mail",
  phone: "Telefon",
  paymentTermsDays: "Zahlungsziel (Tage)",
  defaultTaxMode: "Steuermodus",
  notes: "Notizen",
};
/** update_expense argument → [label, field of the get_expense result] */
const EXPENSE_FIELDS: Record<string, [string, string]> = {
  supplierName: ["Lieferant", "supplier"],
  supplierCountry: ["Land", "supplierCountry"],
  supplierUid: ["UID", "supplierUid"],
  supplierInvoiceNumber: ["Rechnungsnr.", "supplierInvoiceNumber"],
  issueDate: ["Datum", "issueDate"],
  dueDate: ["Fällig am", "dueDate"],
  vatTreatment: ["USt-Behandlung", "vatTreatment"],
  description: ["Beschreibung", "description"],
  notes: ["Notizen", "notes"],
};
/** apply_receipt_analysis `fields` → German labels */
const RECEIPT_FIELDS: Record<string, string> = {
  supplierName: "Lieferant",
  supplierUid: "UID",
  supplierCountry: "Land",
  supplierInvoiceNumber: "Rechnungsnr.",
  issueDate: "Datum",
  dueDate: "Fälligkeit",
  vatTreatment: "USt-Behandlung",
  category: "Kategorie",
  description: "Beschreibung",
  lines: "Positionen (Steuerzeilen)",
};

const shown = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return deDate(v);
  return String(v);
};
const clip = (v: string) => (v.length > 60 ? `${v.slice(0, 59)}…` : v);
const diffText = (diffs: string[]) => (diffs.length ? diffs.join("; ") : "keine Änderung (die Werte sind schon so)");

/** "Ausgabe ER-2026-0001 A1 Telekom" from a get_expense result */
const expenseName = (e: Record<string, any> | null, id: number | null) => (e ? ["Ausgabe", e.number ?? `(id ${e.id})`, e.supplier].filter(Boolean).join(" ") : `Ausgabe id ${id ?? "?"}`);

async function recordSummary(name: string, args: Record<string, unknown>, read: Read): Promise<string> {
  switch (name) {
    case "update_client": {
      const id = num(args.id);
      const c = id ? await read("get_client", { id }) : null;
      const diffs = Object.entries(CLIENT_FIELDS)
        .filter(([field]) => args[field] !== undefined)
        .filter(([field]) => !c || (args[field] ?? null) !== (c[field] ?? null))
        .map(([field, label]) => {
          const show = (v: unknown) =>
            field === "paymentTermsDays" && v === null ? "Standard" : field === "defaultTaxMode" ? (v ? (TAX_MODE_LABELS[v as TaxMode] ?? String(v)) : "Standard") : clip(shown(v));
          return c ? `${label}: ${show(c[field])} → ${show(args[field])}` : `${label} → ${show(args[field])}`;
        });
      return `Kunde ${c?.name ?? `id ${id ?? "?"}`} ändern: ${diffText(diffs)}`;
    }
    case "update_expense": {
      const id = num(args.id);
      const e = id ? await read("get_expense", { id }) : null;
      const show = (field: string, v: unknown) => (field === "vatTreatment" && v ? (VAT_TREATMENT_SHORT_LABELS[v as VatTreatment] ?? String(v)) : clip(shown(v)));
      const diffs = Object.entries(EXPENSE_FIELDS)
        .filter(([arg]) => args[arg] !== undefined)
        .filter(([arg, [, field]]) => !e || (args[arg] ?? null) !== (e[field] ?? null))
        .map(([arg, [label, field]]) => (e ? `${label}: ${show(arg, e[field])} → ${show(arg, args[arg])}` : `${label} → ${show(arg, args[arg])}`));
      const beforeCats = e && Array.isArray(e.lines) ? [...new Set(e.lines.map((l: Record<string, any>) => l.categoryLabel))].join(", ") || "–" : null;
      if (typeof args.category === "string") diffs.push(`Kategorie aller Positionen: ${beforeCats ? `${beforeCats} → ` : ""}${categoryLabel(args.category)}`);
      if (Array.isArray(args.lines)) {
        const before = e && Array.isArray(e.lines) ? `${e.lines.length} Position(en), brutto ${e.gross?.formatted ?? "?"}` : null;
        diffs.push(`Positionen ersetzen: ${before ? `${before} → ` : ""}${args.lines.length} neue Position(en)`);
      }
      return `${expenseName(e, id)} ändern: ${diffText(diffs)}`;
    }
    case "mark_expense_paid": {
      const id = num(args.id);
      const e = id ? await read("get_expense", { id }) : null;
      const amount = e?.gross?.formatted ? ` (${e.gross.formatted})` : "";
      if (args.paidAt === null) return `${expenseName(e, id)}${amount} wieder als offen markieren`;
      const date = typeof args.paidAt === "string" ? deDate(args.paidAt) : `heute (${deDate(todayIso())})`;
      return `${expenseName(e, id)}${amount} als bezahlt am ${date} markieren`;
    }
    case "apply_receipt_analysis": {
      const id = num(args.expenseId);
      const [e, r] = id ? await Promise.all([read("get_expense", { id }), read("get_receipt_analysis", { expenseId: id })]) : [null, null];
      const suggestions: Record<string, any>[] = Array.isArray(r?.analysis?.suggestions) ? r.analysis.suggestions : [];
      const fields = Array.isArray(args.fields) ? (args.fields as unknown[]).map(String) : [];
      const parts = fields.map((f) => {
        const value = suggestions.find((x) => x.field === f)?.value;
        const label = RECEIPT_FIELDS[f] ?? f;
        return value && f !== "lines" ? `${label} „${clip(String(value))}“` : label;
      });
      return `Belegerkennung auf ${expenseName(e, id)} übernehmen: ${parts.join(", ") || "?"} – bestehende Werte werden ersetzt`;
    }
    case "link_expense_to_fixed_cost": {
      const id = num(args.expenseId);
      const fcId = num(args.fixedCostId);
      const [e, list] = await Promise.all([id ? read("get_expense", { id }) : null, fcId ? read("list_fixed_costs", {}) : null]);
      const fc = fcId && Array.isArray(list?.fixedCosts) ? list.fixedCosts.find((f: Record<string, any>) => f.id === fcId) : null;
      const target = fcId ? `den Fixkosten ${fc ? `„${fc.name}“` : `id ${fcId}`}` : "den passenden Fixkosten";
      const slot = typeof args.scheduledDate === "string" ? `Termin ${deDate(args.scheduledDate)}` : "passender freier Termin";
      const replaced = e?.fixedCost ? ` – ersetzt die bestehende Verknüpfung mit „${e.fixedCost.name}“ (${deDate(String(e.fixedCost.scheduledDate))})` : "";
      return `${expenseName(e, id)} ${target} zuordnen (${slot}); der Termin zählt dann nicht mehr in der Prognose${replaced}`;
    }
    default:
      return `Aktion „${name}“ ausführen`;
  }
}
