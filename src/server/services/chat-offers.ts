import { namedRefs } from "./chat-context";

// "Offered instead of acting": in a turn where the user asked for a change, the small model sometimes looks the
// record up and then asks "Möchten Sie jetzt eine Zahlungserinnerung für diese Rechnung erstellen?" although the
// lookup left exactly one candidate (measured: "Schick eine Mahnung für die überfällige Rechnung" → list_reminders_due
// with one invoice → offer, in about 1 of 4 runs). The confirmation card asks anyway, so the offer only costs the
// user a round trip. Nudge: such an answer is discarded and the call retried once with a reminder that the user
// already asked; a second offer goes through. Table-driven: per tool, the request and offer words and the record
// slots it needs, each of which must have exactly one plausible candidate in this turn's lookups. Only tools whose
// other arguments have defaults are listed (an amount or date the user didn't give is never assumed).

/** a record from this turn's tool results */
export interface Candidate {
  kind: string;
  id: number;
  /** the result line it came from (status, names, numbers) */
  line: string;
}

interface Slot {
  kinds: string[];
  /** the line's status must match (open invoice, open booking, draft, …) */
  status: RegExp;
}

export interface OfferRule {
  tool: string;
  /** the user's message asks for it */
  request: RegExp;
  /** the answer's offer is about it */
  offer: RegExp;
  slots: Slot[];
}

const OPEN_DOC = /überfällig|\boffen\b|teilweise|teilbezahlt/i;

export const OFFER_RULES: OfferRule[] = [
  { tool: "create_reminder", request: /mahnung|mahne\b|zahlungserinnerung/, offer: /mahnung|zahlungserinnerung|erinnerung/, slots: [{ kinds: ["invoice"], status: OPEN_DOC }] },
  {
    tool: "match_bank_transaction",
    request: /\bordne\b|zuordnen|zuzuordnen|verbuche/,
    offer: /zuordn|zuzuordnen|\bordne\b|verbuch|verknüpf/,
    slots: [
      { kinds: ["bank_transaction"], status: /\boffen\b|teilweise/i },
      { kinds: ["invoice", "expense", "credit_note"], status: OPEN_DOC },
    ],
  },
  { tool: "mark_expense_paid", request: /(ausgabe|beleg|eingangsrechnung|lieferant)[^.?!]*bezahlt|bezahlt[^.?!]*(ausgabe|beleg)/, offer: /bezahlt/, slots: [{ kinds: ["expense"], status: /\boffen\b/i }] },
  { tool: "mark_invoice_paid", request: /^(?![^.?!]*(ausgabe|beleg))[^.?!]*rechnung[^.?!]*bezahlt/, offer: /bezahlt/, slots: [{ kinds: ["invoice"], status: OPEN_DOC }] },
  { tool: "finalize_document", request: /finalisier/, offer: /finalisier/, slots: [{ kinds: ["invoice", "offer", "credit_note"], status: /entwurf/i }] },
  {
    tool: "convert_offer_to_invoice",
    request: /umwandel|\bwandle\b|angebot[^.?!]*(in|zu) (eine|einer) rechnung/,
    offer: /umwandel|umzuwandeln|rechnung (daraus |)(erstellen|machen)/,
    slots: [{ kinds: ["offer"], status: /finalisiert|versendet|angenommen/i }],
  },
];

/** "- RE-2026-0001 (invoice id 1) · …", "- 13.10.2026 € 1.140,00 · Alpen · Offen · id 1", "Rechnung RE-… (id 1) · Überfällig" */
export function candidates(toolName: string, text: string): Candidate[] {
  const out: Candidate[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const m of line.matchAll(/\b(invoice|expense|offer|credit_note) id (\d+)\b/g)) out.push({ kind: m[1]!, id: Number(m[2]), line });
    if (toolName === "list_bank_transactions") {
      const m = /· id (\d+)\s*$/.exec(line);
      if (m) out.push({ kind: "bank_transaction", id: Number(m[1]), line });
    }
    // detail tools: the header line names the record
    if (i === 0 && toolName === "get_bank_transaction") {
      const m = /^Bankbuchung \(id (\d+)\)/.exec(line);
      if (m) out.push({ kind: "bank_transaction", id: Number(m[1]), line: lines.slice(0, 4).join(" · ") });
    }
    if (i === 0 && toolName === "get_document") {
      const m = /^(Rechnung|Angebot|Gutschrift)\b.*\(id (\d+)\)/.exec(line);
      if (m) out.push({ kind: m[1] === "Rechnung" ? "invoice" : m[1] === "Angebot" ? "offer" : "credit_note", id: Number(m[2]), line });
    }
  }
  return out;
}

/** a tool row of the current turn */
export interface OfferToolRow {
  toolName: string | null;
  status: string;
  content: string;
}

const OFFER_PHRASE = /\b(möchten sie|möchtest du|soll ich|sollen wir|wollen sie|willst du|darf ich)\b/;
/** the request itself is a question about the app or the data, not an order ("Kann man …?", "Wie …?") */
const QUESTION_REQUEST = /^\s*(kann man|können wir|ist es möglich|geht (es|das)|wie|was|warum|wieso|weshalb|wo|wann|welche[rsnm]?|wer)\b/;

/** the offer sentences (questions with an offer phrase) of an answer, lower-cased */
function offers(answer: string): string[] {
  return answer
    .replace(/[*_`]+/g, "")
    .split(/(?<=(?<!\d)[.!?])\s+|\n+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.endsWith("?") && OFFER_PHRASE.test(s));
}

/** the one plausible record per slot, or null; narrowed to what the user named (numbers, names) when that leaves any */
function single(slot: Slot, found: Candidate[], userText: string): Candidate | null {
  const byId = new Map<string, Candidate>();
  for (const c of found) if (slot.kinds.includes(c.kind) && slot.status.test(c.line)) byId.set(`${c.kind}:${c.id}`, c);
  let list = [...byId.values()];
  const refs = namedRefs(userText);
  const tokens = [...refs.numbers, ...refs.names].map((t) => t.toLowerCase());
  if (tokens.length) {
    const named = list.filter((c) => tokens.some((t) => c.line.toLowerCase().includes(t)));
    if (named.length) list = named;
  }
  return list.length === 1 ? list[0]! : null;
}

/**
 * The rule whose action the answer offers instead of doing it, when this turn's lookups left exactly one candidate
 * per slot and the tool hasn't run in this turn; null otherwise. `isWriteRequest` must have passed.
 */
export function offerInsteadOfAction(answer: string, userText: string, toolRows: OfferToolRow[]): OfferRule | null {
  const request = userText.toLowerCase();
  if (QUESTION_REQUEST.test(request)) return null;
  const asked = offers(answer);
  if (!asked.length) return null;
  const found = toolRows.filter((r) => r.toolName && r.status === "done").flatMap((r) => candidates(r.toolName!, r.content));
  for (const rule of OFFER_RULES) {
    if (!rule.request.test(request) || !asked.some((s) => rule.offer.test(s))) continue;
    if (toolRows.some((r) => r.toolName === rule.tool)) continue;
    if (rule.slots.every((slot) => single(slot, found, userText))) return rule;
  }
  return null;
}

/** what the model reads before its one retry */
export const OFFER_NUDGE =
  "Der Nutzer hat diese Aktion bereits verlangt – ruf jetzt das passende Werkzeug auf (die Bestätigung im Chat folgt automatisch); frag nur nach, wenn wirklich etwas mehrdeutig ist.";
