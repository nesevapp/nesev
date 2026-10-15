import { type ChatToolCall, type ChatToolResult, resultCards } from "../../shared/chat";
import { contextRecord, DEICTIC, namedRefs } from "./chat-context";
import { appPath, type ToolHost } from "./chat-tools";

// Id provenance: a state-changing call (or a create that references existing records) may only use record ids that
// appeared in this conversation: in a tool result, in the user's text ("id 4"), as the page record of a message
// that refers to it, or behind a record number the user named (resolved via search). Small models otherwise guess
// ids ("match_bank_transaction {id: 1, targets: [{invoice 1}]}" without any lookup). Tool results are read from what
// is persisted (the text the model saw, links and card rows), so provenance spans the whole conversation.

export type RefKind =
  | "document"
  | "client"
  | "expense"
  | "article"
  | "bank_transaction"
  | "bank_match"
  | "recurring"
  | "receipt_analysis"
  | "fixed_cost"
  | "asset"
  | "reminder";

/** argument path → record kind; `[]` walks an array, a function picks the kind from the array element */
type IdArg = [path: string, kind: RefKind | ((item: Record<string, unknown>) => RefKind)];

/** state-changing tools and creates that reference existing records (read tools are free to probe ids) */
export const ID_ARGS: Record<string, IdArg[]> = {
  update_document_draft: [["id", "document"]],
  finalize_document: [["id", "document"]],
  mark_document_sent: [["id", "document"]],
  mark_invoice_paid: [["id", "document"]],
  convert_offer_to_invoice: [["offerId", "document"]],
  create_credit_note: [["invoiceId", "document"]],
  create_reminder: [["invoiceId", "document"]],
  create_invoice_draft: [["clientId", "client"], ["items[].articleId", "article"]],
  create_offer_draft: [["clientId", "client"], ["items[].articleId", "article"]],
  match_bank_transaction: [["id", "bank_transaction"], ["targets[].id", (t) => (t.kind === "expense" ? "expense" : "document")]],
  unmatch_bank_transaction: [["id", "bank_transaction"], ["matchId", "bank_match"]],
  set_bank_transaction_ignored: [["id", "bank_transaction"]],
  set_recurring_invoice_active: [["id", "recurring"]],
  generate_recurring_invoice: [["id", "recurring"]],
  update_client: [["id", "client"]],
  update_expense: [["id", "expense"]],
  mark_expense_paid: [["id", "expense"]],
  apply_receipt_analysis: [["expenseId", "expense"], ["analysisId", "receipt_analysis"]],
  link_expense_to_fixed_cost: [["expenseId", "expense"], ["fixedCostId", "fixed_cost"]],
  create_asset: [["expenseId", "expense"]],
  create_expense: [["fixedCostId", "fixed_cost"]],
  queue_receipt_analysis: [["expenseIds[]", "expense"]],
};

/** the record ids a call uses: [kind, id] */
export function callRefs(call: Pick<ChatToolCall, "name" | "arguments">): [RefKind, number][] {
  const out: [RefKind, number][] = [];
  for (const [path, kind] of ID_ARGS[call.name] ?? []) {
    const [head, rest] = path.split("[]") as [string, string | undefined];
    const add = (v: unknown, item: Record<string, unknown>) => {
      const id = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
      if (typeof id === "number" && Number.isInteger(id) && id > 0) out.push([typeof kind === "function" ? kind(item) : kind, id]);
    };
    if (rest === undefined) add(call.arguments[head], call.arguments);
    else {
      const list = call.arguments[head];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!rest) add(item, call.arguments);
        else if (item && typeof item === "object") add((item as Record<string, unknown>)[rest.replace(/^\./, "")], item as Record<string, unknown>);
      }
    }
  }
  return out;
}

/** "kind:id", or "any:id" when the source doesn't say which kind */
export type Provenance = Set<string>;

const TEXT_KINDS: Record<string, RefKind> = {
  invoice: "document",
  offer: "document",
  credit_note: "document",
  document: "document",
  client: "client",
  expense: "expense",
  "fixed cost": "fixed_cost",
  fixed_cost: "fixed_cost",
  asset: "asset",
  reminder: "reminder",
  article: "article",
  recurring: "recurring",
};
const PATH_KINDS: [RegExp, RefKind][] = [
  [/^\/(invoices|offers|credit-notes)\/(\d+)/, "document"],
  [/^\/clients\/(\d+)/, "client"],
  [/^\/expenses\/(\d+)/, "expense"],
  [/^\/recurring\/(\d+)/, "recurring"],
  [/^\/assets\/(\d+)/, "asset"],
  [/^\/reminders\/(\d+)/, "reminder"],
];

/** ids in a tool's text: "(invoice id 1)", "expense id 2 …", "(fixed cost id 3)", "Bankbuchung (id 5)" */
export function addTextRefs(p: Provenance, text: string): void {
  for (const m of text.matchAll(/\b(invoice|offer|credit_note|document|client|expense|fixed cost|asset|reminder|article|recurring) id (\d+)\b/g)) {
    p.add(`${TEXT_KINDS[m[1]!]}:${m[2]}`);
  }
  for (const m of text.matchAll(/\bmatchId (\d+)\b/g)) p.add(`bank_match:${m[1]}`);
  // a bare "id 5" (bank bookings, recurring invoices, document details) doesn't say the kind
  for (const m of text.matchAll(/(?<!\b(?:invoice|offer|credit_note|document|client|expense|cost|asset|reminder|article|recurring) )\bid:? (\d+)\b/gi)) p.add(`any:${m[1]}`);
}

export function addPathRefs(p: Provenance, link: string): void {
  const path = appPath(link);
  if (!path) return;
  for (const [re, kind] of PATH_KINDS) {
    const m = re.exec(path);
    if (m) p.add(`${kind}:${m.at(-1)}`);
  }
}

function addResultRefs(p: Provenance, result: ChatToolResult | null | undefined): void {
  for (const l of result?.links ?? []) addPathRefs(p, l.path);
  for (const card of resultCards(result)) {
    if (card.kind === "table") for (const r of card.rows) if (r.path) addPathRefs(p, r.path);
    if (card.kind === "document") addPathRefs(p, card.path);
  }
}

export interface ProvenanceRow {
  role: "user" | "assistant" | "tool";
  content: string;
  status: string;
  contextPath: string | null;
  /** stored JSON (ChatToolResult) */
  toolResult?: unknown;
}

/** everything the conversation established so far */
export function conversationProvenance(rows: ProvenanceRow[]): Provenance {
  const p: Provenance = new Set();
  for (const r of rows) {
    if (r.role === "tool" && r.status === "done") {
      addTextRefs(p, r.content);
      addResultRefs(p, r.toolResult as ChatToolResult | null);
    }
    if (r.role === "user") {
      for (const m of r.content.matchAll(/\bid:?\s*(\d+)\b/gi)) p.add(`any:${m[1]}`);
      // the page record counts when the message refers to it, or names nothing else
      const ctx = contextRecord(r.contextPath);
      if (ctx) {
        const refs = namedRefs(r.content);
        if (DEICTIC.test(r.content) || (!refs.numbers.length && !refs.names.length)) p.add(`${ctx.kind}:${ctx.id}`);
      }
    }
  }
  return p;
}

const known = (p: Provenance, [kind, id]: [RefKind, number]) => p.has(`${kind}:${id}`) || p.has(`any:${id}`);

/** the call's ids that are not established (empty = fine) */
export function unknownRefs(call: Pick<ChatToolCall, "name" | "arguments">, p: Provenance): [RefKind, number][] {
  return callRefs(call).filter((r) => !known(p, r));
}

const KIND_LABELS: Record<RefKind, string> = {
  document: "Beleg",
  client: "Kunde",
  expense: "Ausgabe",
  article: "Artikel",
  bank_transaction: "Bankbuchung",
  bank_match: "Zuordnung",
  recurring: "Serienrechnung",
  receipt_analysis: "Belegerkennung",
  fixed_cost: "Fixkosten",
  asset: "Anlage",
  reminder: "Mahnung",
};
const LOOKUP_HINT: Record<RefKind, string> = {
  document: "search oder list_documents",
  client: "search oder list_clients",
  expense: "search oder list_expenses",
  article: "list_articles",
  bank_transaction: "list_bank_transactions",
  bank_match: "get_bank_transaction",
  recurring: "list_recurring_invoices",
  receipt_analysis: "get_receipt_analysis",
  fixed_cost: "list_fixed_costs",
  asset: "list_assets",
  reminder: "search",
};

/**
 * null = the call may run (after resolving record numbers the user named, via search, if needed); otherwise the
 * error text for the model.
 */
export async function checkProvenance(
  call: Pick<ChatToolCall, "name" | "arguments">,
  o: { rows: ProvenanceRow[]; host: ToolHost },
): Promise<string | null> {
  if (!ID_ARGS[call.name]) return null;
  const p = conversationProvenance(o.rows);
  let missing = unknownRefs(call, p);
  if (!missing.length) return null;
  // record numbers the user typed ("RE-2026-0001", "ER-2026-0002", "K-0001") count once resolved via search
  const numbers = [...new Set(o.rows.filter((r) => r.role === "user").flatMap((r) => namedRefs(r.content).numbers))].slice(0, 3);
  for (const n of numbers) {
    const res = await o.host.call("search", { query: n, limit: 5 }).catch(() => null);
    if (res && !res.isError) addTextRefs(p, res.text);
  }
  missing = unknownRefs(call, p);
  if (!missing.length) return null;
  const list = missing.map(([kind, id]) => `${KIND_LABELS[kind]} id ${id}`).join(", ");
  const how = [...new Set(missing.map(([kind]) => LOOKUP_HINT[kind]))].join(" bzw. ");
  return `Fehler: ${list} ${missing.length > 1 ? "wurden" : "wurde"} in dieser Unterhaltung nicht nachgeschlagen – die id nicht raten. Zuerst suchen/auflisten (${how}) und dann mit der id aus dem Ergebnis aufrufen.`;
}
