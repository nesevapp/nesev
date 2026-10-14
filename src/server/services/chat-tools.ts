import { CONFIRM_TOOLS, type ChatLink, type ChatToolResult } from "../../shared/chat";
import type { LlmTool } from "./chat-llm";

// The assistant's tools are nesev's MCP tools (src/mcp), executed in-process: an MCP client linked to buildServer()
// over the SDK's in-memory transport, with the in-server ToolContext (links are app paths, receipt analysis is
// queued in this process). Here: the ToolHost abstraction (tests use a fake), MCP → OpenAI tool definitions, which
// tools a request gets, tool results → ChatToolResult for the UI, and the German confirmation summaries.

export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** changes state (MCP destructiveHint): needs the user's click */
  destructive: boolean;
}

export interface ToolOutcome {
  isError: boolean;
  /** text content for the model */
  text: string;
  structured: Record<string, unknown> | null;
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

/** Write tools by intent; read tools are always offered. */
const WRITE_GROUPS: { tools: string[]; words: RegExp; paths: RegExp }[] = [
  {
    tools: [
      "create_invoice_draft",
      "create_offer_draft",
      "update_document_draft",
      "finalize_document",
      "mark_document_sent",
      "mark_invoice_paid",
      "convert_offer_to_invoice",
      "create_credit_note",
    ],
    words: /rechnung|angebot|entwurf|gutschrift|storn|finalis|abschlie|bezahlt|zahlung|versend|verschick|gesendet|umwandel|position|zeile|preis|menge|stunde|std\b|beratung|fällig/,
    paths: /^\/(invoices|offers|credit-notes)\b/,
  },
  { tools: ["create_reminder"], words: /mahn|erinner|überfällig|ueberfaellig/, paths: /^\/(reminders|invoices)\b/ },
  { tools: ["create_client", "create_article"], words: /kunde|kundin|artikel|leistung|produkt/, paths: /^\/(clients|articles)\b/ },
  {
    tools: ["create_expense", "queue_receipt_analysis"],
    words: /ausgabe|beleg|quittung|kassenbon|einkauf|erkennung|ocr|lieferant|eingangsrechnung/,
    paths: /^\/(expenses|fixed-costs)\b/,
  },
];
/** generic verbs: any write tool may be meant */
const GENERIC_WRITE = /anleg|erstell|erfass|neu(e|er|en|es)?\b|änder|aender|korrigier|bearbeit|mach|trag|buch|leg .* an/;

export interface ToolSelectionInput {
  /** latest user messages, newest first (the current one first) */
  userTexts: string[];
  contextPath?: string | null;
  /** tools the model called in the recent history (kept, so follow-ups like "ja, finalisiere" work) */
  recentTools?: string[];
  /** tokens available for tool definitions */
  budgetTokens: number;
}

/**
 * Which tools a request gets. Read tools always. Write tools: all of them when they fit the budget, else by intent
 * (German keywords in the last three user messages, the page the user is on, tools used recently). With the default
 * 32k context everything fits (all 28 definitions ≈ 13k tokens, the read tools ≈ 4k; see PLAN.md), so the heuristic only matters for
 * small context sizes.
 */
export function selectTools(all: ChatTool[], input: ToolSelectionInput): ChatTool[] {
  if (toolTokens(all) <= input.budgetTokens) return all;
  const text = input.userTexts.slice(0, 3).join("\n").toLowerCase();
  const wanted = new Set<string>(input.recentTools ?? []);
  const generic = GENERIC_WRITE.test(text);
  for (const g of WRITE_GROUPS) {
    if (generic || g.words.test(text) || (input.contextPath && g.paths.test(input.contextPath))) for (const t of g.tools) wanted.add(t);
  }
  const grouped = new Set(WRITE_GROUPS.flatMap((g) => g.tools));
  // unknown (new) write tools are offered like generic ones
  return all.filter((t) => t.readOnly || wanted.has(t.name) || (generic && !grouped.has(t.name)));
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

export function toChatToolResult(outcome: ToolOutcome): ChatToolResult {
  const first = outcome.text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const summary = first.length > 160 ? `${first.slice(0, 157)}…` : first;
  return { ok: !outcome.isError, summary: summary || (outcome.isError ? "Fehler" : "Erledigt"), links: outcome.isError ? [] : extractLinks(outcome.structured) };
}

// --- confirmation summaries -----------------------------------------------------------------------------------

/** "Rechnung (Entwurf, id 12) für Alpen GmbH über € 648,00" from a get_document result; null when unknown */
export type DocumentLookup = (id: number, amount?: "gross" | "open") => Promise<string | null>;

export function documentLookup(host: ToolHost): DocumentLookup {
  return async (id, amount = "gross") => {
    const res = await host.call("get_document", { id }).catch(() => null);
    const d = res && !res.isError ? (res.structured as Record<string, any> | null) : null;
    if (!d) return null;
    const what = d.number ? `${d.typeLabel} ${d.number}` : `${d.typeLabel} (Entwurf, id ${d.id})`;
    const client = d.client?.name ? ` für ${d.client.name}` : "";
    const sum = amount === "open" && d.open?.formatted ? ` (offen ${d.open.formatted})` : d.gross?.formatted ? ` über ${d.gross.formatted}` : "";
    return `${what}${client}${sum}`;
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/** One German line for the confirmation card, e.g. "Rechnung (Entwurf, id 12) für Alpen GmbH über € 648,00 finalisieren – …". */
export async function confirmSummary(name: string, args: Record<string, unknown>, lookup: DocumentLookup): Promise<string> {
  const doc = async (id: number | null, fallback: string, amount?: "gross" | "open") =>
    id ? ((await lookup(id, amount)) ?? `${fallback} id ${id}`) : fallback;
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
    default:
      return `Aktion „${name}“ ausführen`;
  }
}
