import { type ChatUpload, type ChatUploads, messageUploads } from "../../shared/chat";
import { formatCents, parseMoneyToCents } from "../../shared/money";

// Receipts uploaded in the assistant chat (paperclip / drop on the panel). The web app creates one draft expense per
// file through the normal quick capture (POST /api/expenses/drafts, nothing is analysed) and then records them in the
// conversation (POST /api/chat/conversations/:id/uploads → recordUploads in chat.ts): a user message whose
// `tool_result` JSON holds the uploads (`kind: "uploads"`) and whose content is what the model reads – one German
// line per receipt with the expense id. That content goes to the model in front of the next user message (not as a
// message of its own, buildHistory), so "Bewirtung mit Kunde Huber, bar bezahlt" can be applied to the right draft;
// the id counts as established for the id-provenance guard (user text), and the number for the number guard.

/** what a stored row needs to be recognised as an upload record */
export interface UploadRowLike {
  role: string;
  toolResult?: unknown;
}

export const isUploadRow = (r: UploadRowLike): boolean => messageUploads(r.role, r.toolResult) !== null;

/** 'Hochgeladener Beleg: Ausgabe ER-2026-0005 (id 42), Entwurf ohne Lieferant und Positionen, Datei „rechnung.pdf“.' */
export function uploadLine(u: ChatUpload & { incomplete?: boolean }): string {
  const what = u.number ? `Ausgabe ${u.number} (id ${u.expenseId})` : `Ausgabe id ${u.expenseId}`;
  const state = u.incomplete === false ? "bereits erfasst" : "Entwurf ohne Lieferant und Positionen";
  const name = u.fileName.replace(/[\r\n“”"]+/g, " ").trim().slice(0, 120) || "Beleg";
  return `Hochgeladener Beleg: ${what}, ${state}, Datei „${name}“.`;
}

/** The stored content of an upload message: one line per receipt (the id/number guards read it like user text). */
export function uploadsContent(uploads: (ChatUpload & { incomplete?: boolean })[]): string {
  return uploads.map(uploadLine).join("\n");
}

/**
 * How to use the uploaded receipts; added after their lines when the history is built (not stored, so it can be
 * tuned for old conversations too). The amount is never in the line: the 4B otherwise made one up for `lines`.
 */
export function uploadsHint(count: number): string {
  const which = count === 1 ? "diesen Beleg" : "einen dieser Belege";
  const ask = count === 1 ? "" : " Ist unklar, welcher gemeint ist, frag nach.";
  return (
    `(Beschreibt der Nutzer ${which}, ändere genau diese Ausgabe mit ihrer id: update_expense, bezahlt → mark_expense_paid. ` +
    `Den Betrag kennst du nicht: lines bzw. category nur mit einem Betrag vom Nutzer oder aus get_receipt_analysis, sonst frag danach.${ask})`
  );
}

/** "Beleg hochgeladen: rechnung.pdf" / "3 Belege hochgeladen" (conversation preview) */
export function uploadsPreview(u: ChatUploads): string {
  if (u.uploads.length === 1) return `Beleg hochgeladen: ${u.uploads[0]!.fileName}`;
  return `${u.uploads.length} Belege hochgeladen`;
}

/** user messages that are not upload records */
export const isTextUser = (r: UploadRowLike) => r.role === "user" && !isUploadRow(r);

/**
 * Receipts were uploaded recently: at most `turns` user messages came after the last upload. Such a
 * conversation always gets the expense tools, so follow-ups that don't name an expense word ("Bewirtung mit Kunde
 * Huber, bar bezahlt", "das war Büromaterial") still reach update_expense.
 */
export function hasRecentUploads(rows: UploadRowLike[], turns = 3): boolean {
  let users = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (isUploadRow(r)) return true;
    if (r.role === "user" && ++users > turns) return false;
  }
  return false;
}

// --- guessed amounts on uploaded receipts -------------------------------------------------------------------------

/** stored rows as the amount guard reads them */
export interface AmountSourceRow extends UploadRowLike {
  content: string;
  status?: string;
}

/** euro amount as the expense tools take it (number or "1.234,56") → cents */
function inputCents(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100);
  return typeof v === "string" ? parseMoneyToCents(v) : null;
}

/** every amount a text mentions, in cents ("4,30", "€ 1.234,56", "48.60", "25") – both readings of "1.234" */
export function amountsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d+(?:[.\s]\d{3})*(?:[.,]\d{1,2})?/g)) {
    const raw = m[0].replace(/\s/g, "");
    const de = parseMoneyToCents(raw);
    if (de !== null) out.add(Math.abs(de));
    const en = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(en)) out.add(Math.round(en * 100));
  }
  return out;
}

/** amounts the conversation established: the user's messages, tool results (text and cards, which carry cents) */
export function knownAmounts(rows: AmountSourceRow[]): Set<number> {
  const known = new Set<number>();
  for (const r of rows) {
    if (isUploadRow(r)) continue;
    if (r.role !== "user" && !(r.role === "tool" && r.status !== "error" && r.status !== "pending")) continue;
    for (const c of amountsIn(r.content)) known.add(c);
    if (r.role === "tool" && r.toolResult) for (const m of JSON.stringify(r.toolResult).matchAll(/"cents":(-?\d+)/g)) known.add(Math.abs(Number(m[1])));
  }
  return known;
}

/** expense ids uploaded in the conversation */
export function uploadedExpenseIds(rows: UploadRowLike[]): Set<number> {
  const ids = new Set<number>();
  for (const r of rows) for (const u of messageUploads(r.role, r.toolResult)?.uploads ?? []) ids.add(u.expenseId);
  return ids;
}

/**
 * An uploaded receipt's draft has no amount yet, and the small model tends to make one up for `lines` ("Bewirtung,
 * bar bezahlt" → a line over € 54,60). An update_expense on such a draft may only use amounts the user typed or a
 * tool result showed (e.g. get_receipt_analysis); otherwise the call isn't run and the model gets this error.
 */
export function guessedAmountError(call: { name: string; arguments: Record<string, unknown> }, rows: AmountSourceRow[]): string | null {
  if (call.name !== "update_expense" || !Array.isArray(call.arguments.lines)) return null;
  if (!uploadedExpenseIds(rows).has(Number(call.arguments.id))) return null;
  const known = knownAmounts(rows);
  const guessed: number[] = [];
  for (const l of call.arguments.lines as Record<string, unknown>[]) {
    for (const v of [l?.gross, l?.net]) {
      const c = inputCents(v);
      if (c !== null && c !== 0 && !known.has(Math.abs(c))) guessed.push(c);
    }
  }
  if (!guessed.length) return null;
  return (
    `Fehler: Den Betrag ${guessed.map(formatCents).join(", ")} hat der Nutzer nicht genannt und kein Werkzeug-Ergebnis zeigt ihn – nicht raten. ` +
    "Frag den Nutzer nach dem Betrag oder lies die Erkennung (get_receipt_analysis); Lieferant, Beschreibung oder Datum kannst du ohne lines ändern."
  );
}
