import type { ChatToolCall } from "../../shared/chat";
import type { ToolHost } from "./chat-tools";

// The page context ("Der Nutzer sieht gerade Rechnung id 1") may only resolve deictic references ("diese
// Rechnung", "davon", "hier"). A small model tends to use the context id for anything, e.g. "Lade mir die Vorschau
// vom Entwurf für Alpen herunter" on /invoices/1 became download_pdf {id: 1}. Guard: when a tool call uses the
// context record's id, the message has no deictic word, and it names something the context record isn't (another
// number, "Entwurf" for a finalized document, a name that isn't its client/supplier), the call is not executed;
// the model gets an error telling it to search for the named record. Once per record and turn, so a model that
// searched and still means the context record isn't blocked twice.

type Kind = "document" | "client" | "expense";

const CONTEXT_PATHS: [RegExp, Kind][] = [
  [/^\/(invoices|offers|credit-notes)\/(\d+)/, "document"],
  [/^\/clients\/(\d+)/, "client"],
  [/^\/expenses\/(\d+)/, "expense"],
];

/** the record the user is looking at, from the page path */
export function contextRecord(path: string | null | undefined): { kind: Kind; id: number } | null {
  if (!path) return null;
  for (const [re, kind] of CONTEXT_PATHS) {
    const m = re.exec(path);
    if (m) return { kind, id: Number(m.at(-1)) };
  }
  return null;
}

/** tool → [id argument, kind of record it points at] */
const ID_ARGS: Record<string, [string, Kind]> = {
  get_document: ["id", "document"],
  update_document_draft: ["id", "document"],
  finalize_document: ["id", "document"],
  mark_document_sent: ["id", "document"],
  mark_invoice_paid: ["id", "document"],
  convert_offer_to_invoice: ["offerId", "document"],
  create_credit_note: ["invoiceId", "document"],
  create_reminder: ["invoiceId", "document"],
  get_client: ["id", "client"],
  update_client: ["id", "client"],
  get_expense: ["id", "expense"],
  update_expense: ["id", "expense"],
  mark_expense_paid: ["id", "expense"],
  apply_receipt_analysis: ["expenseId", "expense"],
  link_expense_to_fixed_cost: ["expenseId", "expense"],
};
const OPEN_KINDS: Record<string, Kind> = { document: "document", invoice: "document", offer: "document", credit_note: "document", client: "client", expense: "expense" };

/** which record (kind + id) a tool call points at, if any */
export function callTarget(call: Pick<ChatToolCall, "name" | "arguments">): { kind: Kind; id: number } | null {
  const a = call.arguments;
  let spec: [string, Kind] | undefined = ID_ARGS[call.name];
  if (call.name === "open_pdf" || call.name === "download_pdf") spec = a.type === "reminder" ? undefined : ["id", "document"];
  if (call.name === "open_in_app") {
    const kind = typeof a.what === "string" ? OPEN_KINDS[a.what] : undefined;
    spec = kind ? ["id", kind] : undefined;
  }
  if (!spec) return null;
  const id = Number(a[spec[0]]);
  return Number.isInteger(id) && id > 0 ? { kind: spec[1], id } : null;
}

export const DEICTIC = /\b(diese[rnms]?|dies|davon|dazu|hier|aktuelle[nrms]?|geöffnete[nrms]?|offene[nrms]? seite|selbe[nrms]?|ebendiese[rnms]?)\b/i;

const NUMBER_RE = /\b(re|an|gs|ma|er)-?\s?\d{4}-\d{1,4}\b|\bk-?\s?\d{1,4}\b/gi;
const IS_NUMBER = new RegExp(`^(?:${NUMBER_RE.source})$`, "i");
/** "für Alpen", "von A1", "bei Berlin Digital" → the name; skips common nouns that follow these prepositions */
const NAME_RE = /\b(?:für|von|vom|bei|an)\s+(?:(?:den|die|der|dem|das|kunden|kundin|firma|lieferanten?)\s+)?([A-ZÄÖÜ0-9][\wÄÖÜäöüß&.-]*)/g;
const NOT_NAMES = new Set(
  "Rechnung Rechnungen Angebot Angebote Gutschrift Entwurf Ausgabe Ausgaben Beleg Kunde Kunden Mahnung Monat Jahr Quartal Woche Heute Gestern Morgen Jänner Januar Februar März April Mai Juni Juli August September Oktober November Dezember PDF Vorschau Seite App Euro".split(" "),
);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, "");

export interface NamedRefs {
  numbers: string[];
  names: string[];
  draft: boolean;
}

/** what a message names explicitly (record numbers, names after für/von/bei, "Entwurf") */
export function namedRefs(text: string): NamedRefs {
  const numbers = [...text.matchAll(NUMBER_RE)].map((m) => m[0].toUpperCase().replace(/\s+/g, ""));
  const names = [...text.matchAll(NAME_RE)].map((m) => m[1]!).filter((n) => !NOT_NAMES.has(n) && !IS_NUMBER.test(n));
  return { numbers, names, draft: /entwurf|entwürf/i.test(text) };
}

interface RecordFacts {
  number: string | null;
  /** client (documents, clients) or supplier (expenses) */
  name: string;
  draft: boolean | null;
  label: string;
}

async function facts(host: ToolHost, kind: Kind, id: number): Promise<RecordFacts | null> {
  const tool = kind === "document" ? "get_document" : kind === "client" ? "get_client" : "get_expense";
  const res = await host.call(tool, { id }).catch(() => null);
  const d = res && !res.isError ? (res.structured as Record<string, any> | null) : null;
  if (!d) return null;
  if (kind === "document") {
    return {
      number: d.number ?? null,
      name: d.client?.name ?? "",
      draft: d.status === "draft",
      label: d.number ? `${d.typeLabel} ${d.number}` : `${d.typeLabel} (Entwurf, id ${id})`,
    };
  }
  if (kind === "client") return { number: d.number ?? null, name: d.name ?? "", draft: null, label: `Kunde ${d.name}` };
  return { number: d.number ?? null, name: d.supplier ?? "", draft: null, label: `Ausgabe ${d.number ?? id}` };
}

/** German reasons why the context record is not what the message names; empty = it may be meant */
export function mismatches(refs: NamedRefs, f: RecordFacts): string[] {
  const out: string[] = [];
  const number = f.number ? norm(f.number) : null;
  const otherNumbers = refs.numbers.filter((n) => norm(n) !== number);
  if (otherNumbers.length) out.push(`die Nachricht nennt die Nummer ${otherNumbers.join(", ")}`);
  if (refs.draft && f.draft === false) out.push("die Nachricht meint einen Entwurf, dieser Beleg ist finalisiert");
  const name = norm(f.name);
  const otherNames = refs.names.filter((n) => !name.includes(norm(n)));
  if (otherNames.length) out.push(`die Nachricht nennt „${otherNames.join("“, „")}“`);
  return out;
}

/**
 * null = run the call; otherwise the error text for the model. `warned` holds "kind:id" of records already
 * flagged in this turn (the second attempt passes).
 */
export async function checkContextUse(
  call: Pick<ChatToolCall, "name" | "arguments">,
  o: { contextPath: string | null | undefined; userText: string; host: ToolHost; warned: Set<string> },
): Promise<string | null> {
  const ctx = contextRecord(o.contextPath);
  const target = callTarget(call);
  if (!ctx || !target || ctx.kind !== target.kind || ctx.id !== target.id) return null;
  if (DEICTIC.test(o.userText)) return null;
  const key = `${target.kind}:${target.id}`;
  if (o.warned.has(key)) return null;
  const refs = namedRefs(o.userText);
  if (!refs.numbers.length && !refs.names.length && !refs.draft) return null;
  const f = await facts(o.host, target.kind, target.id);
  if (!f) return null;
  const why = mismatches(refs, f);
  if (!why.length) return null;
  o.warned.add(key);
  return (
    `Fehler: id ${target.id} ist ${f.label}, der Datensatz, den der Nutzer gerade ansieht – aber ${why.join("; ")}. ` +
    "Der Seitenkontext gilt nur für „diese/hier/davon“. Such den genannten Datensatz zuerst (search, list_documents …) und ruf das Werkzeug dann mit dessen id auf."
  );
}
