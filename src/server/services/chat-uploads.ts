import { type ChatUpload, type ChatUploads, messageUploads } from "../../shared/chat";

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

/**
 * The model's text for an upload message: the line per receipt plus how to use them. Stored as the message content
 * (so the id guard and the number guard see it like user text).
 */
export function uploadsContent(uploads: (ChatUpload & { incomplete?: boolean })[]): string {
  const lines = uploads.map(uploadLine);
  const hint =
    uploads.length === 1
      ? "(Beschreibt der Nutzer diesen Beleg, ändere genau diese Ausgabe mit ihrer id: update_expense – Kategorie bzw. Betrag nur mit lines –, bezahlt → mark_expense_paid.)"
      : "(Beschreibt der Nutzer einen dieser Belege, ändere genau diese Ausgabe mit ihrer id: update_expense – Kategorie bzw. Betrag nur mit lines –, bezahlt → mark_expense_paid. Ist unklar, welcher gemeint ist, frag nach.)";
  return [...lines, hint].join("\n");
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
