import { eq } from "drizzle-orm";
import { formatAssetNumber } from "../../shared/assets";
import type { ChatUiAction } from "../../shared/chat";
import type { DbOrTx } from "../db/client";
import { fixedAssets, recurringInvoices, reminders } from "../db/schema";
import { appPath, type ChatTool, isOpenRequest, type ToolHost, type ToolOutcome } from "./chat-tools";
import { documentPdfFileName, reminderPdfFileName } from "./pdf";

// Assistant-only tools (group "ui"), not part of the MCP server: they act in the user's app instead of on data.
// open_in_app navigates to a record or page, open_pdf opens a PDF in a new tab, download_pdf downloads it. Ids are
// checked first (documents, clients, expenses via the MCP get_* tools; reminders, assets, recurring invoices in the
// DB, which have no get_* tool), so the model can't send the user to a 404. The outcome carries a ChatUiAction that
// the UI runs once when the result arrives live. withUiTools() composes them with the MCP host.

const TARGETS = {
  // records (with id) and their list pages (without)
  document: { page: "/invoices", label: "Rechnungen", record: "document" },
  invoice: { page: "/invoices", label: "Rechnungen", record: "document" },
  offer: { page: "/offers", label: "Angebote", record: "document" },
  credit_note: { page: "/credit-notes", label: "Gutschriften", record: "document" },
  reminder: { page: "/reminders", label: "Mahnwesen", record: "reminder" },
  recurring_invoice: { page: "/recurring", label: "Serienrechnungen", record: "recurring" },
  client: { page: "/clients", label: "Kunden", record: "client" },
  expense: { page: "/expenses", label: "Ausgaben", record: "expense" },
  asset: { page: "/assets", label: "Anlagen", record: "asset" },
  fixed_cost: { page: "/fixed-costs", label: "Fixkosten", record: null },
  article: { page: "/articles", label: "Artikel", record: null },
  // pages only
  dashboard: { page: "/", label: "Dashboard", record: null },
  bank: { page: "/bank", label: "Bank", record: null },
  forecast: { page: "/forecast", label: "Zahlungsprognose", record: null },
  tax: { page: "/tax", label: "Steuern", record: null },
  export: { page: "/export", label: "Export", record: null },
  templates: { page: "/templates", label: "PDF-Vorlagen", record: null },
  settings: { page: "/settings", label: "Einstellungen", record: null },
} as const satisfies Record<string, { page: string; label: string; record: string | null }>;
type Target = keyof typeof TARGETS;
const TARGET_KEYS = Object.keys(TARGETS) as Target[];

/** German and plural spellings small models produce instead of the enum value */
const TARGET_ALIASES: Record<string, Target> = {
  invoices: "invoice",
  rechnung: "invoice",
  rechnungen: "invoice",
  offers: "offer",
  angebot: "offer",
  angebote: "offer",
  credit_notes: "credit_note",
  gutschrift: "credit_note",
  gutschriften: "credit_note",
  documents: "document",
  beleg: "document",
  reminders: "reminder",
  mahnung: "reminder",
  mahnungen: "reminder",
  mahnwesen: "reminder",
  recurring: "recurring_invoice",
  serienrechnung: "recurring_invoice",
  serienrechnungen: "recurring_invoice",
  clients: "client",
  kunde: "client",
  kunden: "client",
  expenses: "expense",
  ausgabe: "expense",
  ausgaben: "expense",
  assets: "asset",
  anlage: "asset",
  anlagen: "asset",
  anlagenverzeichnis: "asset",
  fixed_costs: "fixed_cost",
  fixkosten: "fixed_cost",
  articles: "article",
  artikel: "article",
  start: "dashboard",
  übersicht: "dashboard",
  prognose: "forecast",
  zahlungsprognose: "forecast",
  steuern: "tax",
  steuer: "tax",
  uva: "tax",
  bankumsätze: "bank",
  einstellungen: "settings",
  vorlagen: "templates",
};

function target(raw: unknown): Target | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (TARGET_KEYS as string[]).includes(key) ? (key as Target) : (TARGET_ALIASES[key] ?? null);
}

const positiveId = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};

const error = (text: string): ToolOutcome => ({ isError: true, text: `Fehler: ${text}`, structured: null });
const done = (text: string, action: ChatUiAction): ToolOutcome => ({ isError: false, text, structured: null, action });

// --- record lookups -----------------------------------------------------------------------------------------------

interface DocInfo {
  id: number;
  path: string;
  /** "Rechnung RE-2026-0004" / "Rechnung (Entwurf)" */
  label: string;
  number: string | null;
  draft: boolean;
}

async function lookupDocument(host: ToolHost, id: number): Promise<DocInfo | null> {
  const res = await host.call("get_document", { id }).catch(() => null);
  const d = res && !res.isError ? (res.structured as Record<string, any> | null) : null;
  const path = d && typeof d.link === "string" ? appPath(d.link) : null;
  if (!d || !path) return null;
  return { id, path, label: d.number ? `${d.typeLabel} ${d.number}` : `${d.typeLabel} (Entwurf)`, number: d.number ?? null, draft: d.status === "draft" };
}

/** a record's app path and label; null when it doesn't exist */
async function lookupRecord(host: ToolHost, db: DbOrTx, kind: string, id: number): Promise<{ path: string; label: string } | null> {
  switch (kind) {
    case "document":
      return lookupDocument(host, id);
    case "client":
    case "expense": {
      const res = await host.call(kind === "client" ? "get_client" : "get_expense", { id }).catch(() => null);
      const d = res && !res.isError ? (res.structured as Record<string, any> | null) : null;
      const path = d && typeof d.link === "string" ? appPath(d.link) : null;
      if (!d || !path) return null;
      return { path, label: kind === "client" ? `Kunde ${d.name}` : `Ausgabe ${d.number ?? d.supplier ?? id}` };
    }
    case "reminder": {
      const r = db.select({ number: reminders.number }).from(reminders).where(eq(reminders.id, id)).get();
      return r ? { path: `/reminders/${id}`, label: r.number ? `Mahnung ${r.number}` : "Mahnung (Entwurf)" } : null;
    }
    case "recurring": {
      const r = db.select({ name: recurringInvoices.name }).from(recurringInvoices).where(eq(recurringInvoices.id, id)).get();
      return r ? { path: `/recurring/${id}`, label: `Serienrechnung ${r.name}` } : null;
    }
    case "asset": {
      const r = db.select({ number: fixedAssets.number, name: fixedAssets.name }).from(fixedAssets).where(eq(fixedAssets.id, id)).get();
      return r ? { path: `/assets/${id}`, label: `Anlage ${formatAssetNumber(r.number)} ${r.name}` } : null;
    }
    default:
      return null;
  }
}

/** search result type → record kind (see TARGETS) */
const SEARCH_KINDS: Record<string, string> = {
  invoice: "document",
  offer: "document",
  credit_note: "document",
  client: "client",
  expense: "expense",
  reminder: "reminder",
  recurring: "recurring",
  asset: "asset",
};

/** a specific document type only matches its own search results ("Angebot für Alpen" → offers) */
const SEARCH_TYPES: Partial<Record<Target, readonly string[]>> = { invoice: ["invoice"], offer: ["offer"], credit_note: ["credit_note"] };

type Found = { id: number } | { error: string };

/**
 * The record behind `number` / `query` (or a non-numeric `id`, which small models fill with "RE-2026-0004"), via
 * search, so the model can open a record in one call. A number takes the matching (or first) hit of that kind; a
 * query must be unambiguous, else the candidates come back as an error so the model can ask. undefined = neither
 * given.
 */
async function findRecord(host: ToolHost, args: Record<string, unknown>, kind: string, what: string, types?: readonly string[]): Promise<Found | undefined> {
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const number = text(args.number) ?? (typeof args.id === "string" && !/^\d+$/.test(args.id.trim()) ? text(args.id) : null);
  const query = number ?? text(args.query);
  if (!query) return undefined;
  const res = await host.call("search", { query, limit: 8 }).catch(() => null);
  const all = res && !res.isError && Array.isArray(res.structured?.results) ? (res.structured.results as { type: string; id: number; label?: string; sublabel?: string }[]) : [];
  const hits = all.filter((r) => (types ? types.includes(r.type) : SEARCH_KINDS[r.type] === kind));
  if (!hits.length) return { error: `${what}: „${query}“ nicht gefunden – mit search suchen` };
  const fold = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9äöüß]/g, "");
  const exact = hits.filter((r) => fold(r.label) === fold(query));
  if (number || hits.length === 1 || exact.length === 1) return { id: (exact[0] ?? hits[0]!).id };
  const list = hits.slice(0, 5).map((r) => `${[r.label, r.sublabel].filter(Boolean).join(" · ")} (id ${r.id})`);
  return { error: `${what}: „${query}“ ist nicht eindeutig (${hits.length} Treffer: ${list.join("; ")}). Frag den Nutzer, welcher gemeint ist, und ruf dann mit der id auf.` };
}

async function pdfTarget(host: ToolHost, db: DbOrTx, args: Record<string, unknown>) {
  const t = target(args.type ?? "document");
  const kind = t === "reminder" ? "reminder" : "document";
  const found = await findRecord(host, args, kind, t === "reminder" ? "Mahnung" : "Beleg");
  if (found && "error" in found) return found;
  const id = found?.id ?? positiveId(args.id);
  if (!id) return { error: "id, number oder query fehlt (Beleg-id aus search/list_documents, Mahnungs-id oder die Nummer wie RE-2026-0004)" };
  if (t === "reminder") {
    const r = db.select({ id: reminders.id, number: reminders.number }).from(reminders).where(eq(reminders.id, id)).get();
    if (!r) return { error: `Mahnung id ${id} nicht gefunden` };
    return { url: `/api/pdf/reminders/${id}`, fileName: reminderPdfFileName(r), label: r.number ? `Mahnung ${r.number}` : "Mahnung (Entwurf)", draft: !r.number };
  }
  if (t && TARGETS[t].record !== "document") return { error: `PDFs gibt es nur für Rechnungen, Angebote, Gutschriften und Mahnungen (type „${String(args.type)}“)` };
  const d = await lookupDocument(host, id);
  if (!d) return { error: `Beleg id ${id} nicht gefunden – die id mit search oder list_documents ermitteln` };
  return { url: `/api/pdf/documents/${id}`, fileName: documentPdfFileName(d), label: d.label, draft: d.draft };
}

// --- tools ----------------------------------------------------------------------------------------------------------

const PDF_ARGS = {
  type: "object",
  properties: {
    id: { type: "integer", description: "document id (invoice/offer/credit note) or reminder id from a tool result" },
    number: { type: "string", description: 'or the number instead of the id, e.g. "RE-2026-0004" (drafts have none: use the id)' },
    query: { type: "string", description: "or a client name to search for when neither id nor number is known" },
    type: { type: "string", enum: ["document", "reminder"], description: "document (default) or reminder (Mahnung)" },
  },
};

const ui = (name: string, description: string, inputSchema: Record<string, unknown>): ChatTool => ({
  name,
  description,
  inputSchema,
  readOnly: true,
  destructive: false,
  group: "ui",
});

export const UI_TOOLS: ChatTool[] = [
  ui(
    "open_in_app",
    'Use when the user says "öffne", "geh zu", "zeig mir … in der App", "bring mich zu". Opens a page or a record in the ' +
      "nesev app for the user (navigation, nothing is changed). With `id` or `number`: that record " +
      "(document = invoice/offer/credit note by document id, client, expense, reminder, recurring_invoice, asset; find ids " +
      "with search). Without `id`: the list page of `what` or one of dashboard, bank, forecast (Prognose), tax (Steuern: " +
      "UVA/ZM/EAR), fixed_cost (Fixkosten), article, export, templates, settings.",
    {
      type: "object",
      properties: {
        what: { type: "string", enum: TARGET_KEYS, description: "record type or page" },
        id: { type: "integer", description: "record id from a tool result (omit both id and number to open the page)" },
        number: { type: "string", description: 'or the record number instead of the id, e.g. "RE-2026-0004", "K-0001", "ER-2026-0003"' },
        query: { type: "string", description: 'or a name to search for, e.g. the supplier ("A1") or client ("Alpen"); must match one record' },
      },
      required: ["what"],
    },
  ),
  ui(
    "open_pdf",
    'Use for "PDF öffnen/anzeigen/ansehen". Opens the PDF of an invoice, offer, credit note or reminder in a new browser ' +
      "tab. Finalized documents show their frozen PDF, drafts a live preview. To save the file use download_pdf.",
    PDF_ARGS,
  ),
  ui(
    "download_pdf",
    'Use when the user says "herunterladen", "runterladen", "download", "speichern". Downloads the PDF of an invoice, ' +
      'offer, credit note or reminder to the user\'s computer (file name like "RE-2026-0004.pdf"; drafts as a preview ' +
      '"Entwurf-<id>.pdf").',
    PDF_ARGS,
  ),
];

export async function callUiTool(host: ToolHost, db: DbOrTx, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (name === "open_in_app") {
    const t = target(args.what);
    if (!t) return error(`Unbekanntes Ziel „${String(args.what)}“. Möglich: ${TARGET_KEYS.join(", ")}`);
    const spec = TARGETS[t];
    const found = spec.record ? await findRecord(host, args, spec.record, spec.label, SEARCH_TYPES[t]) : undefined;
    if (found && "error" in found) return error(found.error);
    const id = found?.id ?? (args.id === undefined || args.id === null ? null : positiveId(args.id));
    if (!found && args.id !== undefined && args.id !== null && !id) return error(`Ungültige id „${String(args.id)}“ – eine Zahl aus einem Werkzeug-Ergebnis angeben`);
    if (id && spec.record) {
      const rec = await lookupRecord(host, db, spec.record, id);
      if (!rec) return error(`${spec.label}: id ${id} nicht gefunden – die id mit search ermitteln`);
      return done(`${rec.label} wird in der App geöffnet.`, { kind: "navigate", path: rec.path, label: rec.label });
    }
    return done(`${spec.label} wird in der App geöffnet.`, { kind: "navigate", path: spec.page, label: spec.label });
  }
  if (name === "open_pdf" || name === "download_pdf") {
    const pdf = await pdfTarget(host, db, args);
    if ("error" in pdf) return error(pdf.error);
    // drafts render live: a preview, not the final PDF
    const what = `${pdf.draft ? "PDF-Vorschau" : "PDF"} ${pdf.label}`;
    if (name === "open_pdf") return done(`${what} wird in einem neuen Tab geöffnet.`, { kind: "open_tab", url: pdf.url, label: what });
    return done(`${what} wird heruntergeladen (${pdf.fileName}).`, {
      kind: "download",
      url: `${pdf.url}?download=1`,
      fileName: pdf.fileName,
      label: pdf.fileName,
    });
  }
  return error(`Unbekanntes Werkzeug „${name}“`);
}

/** incl. the split verb: "Lade mir … herunter" */
const DOWNLOAD_WORDS = /herunterlad|runterlad|\blad(e|en)?\b[^.?!]*\b(he)?runter\b|download|speicher/i;

/** record words in a navigation request → open_in_app target */
const OPEN_WORDS: [RegExp, Target][] = [
  [/serienrechnung/, "recurring_invoice"],
  [/gutschrift/, "credit_note"],
  [/rechnung/, "invoice"],
  [/angebot/, "offer"],
  [/mahnung/, "reminder"],
  [/ausgabe|beleg/, "expense"],
  [/kunde|kundin/, "client"],
  [/anlage/, "asset"],
];

/**
 * Deterministic fixes for frequent 4B slips, applied to a call before it is stored and run:
 * - the user said "herunterladen" (often next to "Vorschau") and the model picked open_pdf → download_pdf;
 * - in a short pure navigation request naming a record type ("Öffne die Ausgabe von A1") the model searches and
 *   then only describes the hit → the search becomes open_in_app {what, query}, which opens a unique hit or
 *   returns the candidates.
 */
export function nudgeUiCall(name: string, args: Record<string, unknown>, userText: string): { name: string; arguments: Record<string, unknown> } {
  if (name === "open_pdf" && DOWNLOAD_WORDS.test(userText)) return { name: "download_pdf", arguments: args };
  if (name === "search" && typeof args.query === "string" && isOpenRequest(userText)) {
    const what = OPEN_WORDS.find(([re]) => re.test(userText.toLowerCase()))?.[1];
    if (what) return { name: "open_in_app", arguments: { what, query: args.query } };
  }
  return { name, arguments: args };
}

/** The assistant's host: the MCP tools plus the UI tools. */
export function withUiTools(host: ToolHost, db: DbOrTx): ToolHost {
  const names = new Set(UI_TOOLS.map((t) => t.name));
  return {
    tools: [...host.tools.filter((t) => !names.has(t.name)), ...UI_TOOLS],
    call: (name, args) => (names.has(name) ? callUiTool(host, db, name, args) : host.call(name, args)),
  };
}
