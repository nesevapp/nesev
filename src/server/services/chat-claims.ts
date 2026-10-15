// "Claimed but not done": in a turn where the user asked for a change, the small model sometimes answers
// "zugeordnet" / "Entwurf erstellt" (with invented figures) without having called any write tool. Guard: in such
// turns the final answer is held back and checked here before it's emitted. A claim is a claim word in own-action
// phrasing ("habe … zugeordnet", "ich ordne … zu", "wurde erfolgreich erstellt", "ist jetzt markiert", "erledigt");
// negations, questions, offers and conditionals don't count, and neither do data descriptions ("Die Rechnung wurde
// am 3.10. erstellt", "bereits zugeordnet"). Each claim word maps to the tools that would back it; evidence is a
// successful (or pending) call of one of them in this turn. Deliberately narrow and table-driven: a missed claim
// costs what it cost before, a false hit costs a retry. Claims that contradict tool data ("bereits zugeordnet"
// while the booking is open) are not checked.

/** word boundary that knows umlauts (JS's \b is ASCII-only: "\bändere" never matches) */
const WB = String.raw`(?:(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_]))`;
/** a pattern with Unicode-aware \b */
const re = (src: RegExp | string, flags = "") => new RegExp((typeof src === "string" ? src : src.source).replaceAll(String.raw`\b`, WB), `${flags}u`);

/** what a claim says was done */
export type ClaimKind = "assign" | "create" | "update" | "mark" | "finalize" | "link" | "apply" | "recurring" | "convert" | "send" | "any";

/** tools whose successful call changes data (any of them backs a generic "erledigt") */
const WRITE_TOOL = /^(create_|update_|mark_|finalize_|convert_|match_|unmatch_|set_|generate_|apply_|link_|queue_)/;

/** kind → tools that back it */
export const CLAIM_EVIDENCE: Record<ClaimKind, RegExp> = {
  assign: /^(match_bank_transaction|link_expense_to_fixed_cost)$/,
  create: /^(create_\w+|generate_recurring_invoice|convert_offer_to_invoice)$/,
  update: /^(update_\w+|apply_receipt_analysis|mark_\w+|set_\w+)$/,
  mark: /^(mark_\w+|set_bank_transaction_ignored|match_bank_transaction)$/,
  finalize: /^(finalize_document|create_reminder|generate_recurring_invoice)$/,
  link: /^(link_expense_to_fixed_cost|match_bank_transaction)$/,
  apply: /^apply_receipt_analysis$/,
  recurring: /^set_recurring_invoice_active$/,
  convert: /^convert_offer_to_invoice$/,
  send: /^(mark_document_sent|create_reminder)$/,
  any: WRITE_TOOL,
};

/** past participles that claim an action → kind */
const CLAIM_WORDS: [RegExp, ClaimKind][] = [
  [/^zugeordnet$/, "assign"],
  [/^(erstellt|angelegt|erfasst|eingetragen|generiert|ausgestellt|storniert)$/, "create"],
  [/^(geändert|aktualisiert|korrigiert|angepasst)$/, "update"],
  [/^markiert$/, "mark"],
  [/^finalisiert$/, "finalize"],
  [/^verknüpft$/, "link"],
  [/^übernommen$/, "apply"],
  [/^(pausiert|fortgesetzt|reaktiviert|deaktiviert)$/, "recurring"],
  [/^umgewandelt$/, "convert"],
  [/^(versendet|verschickt)$/, "send"],
];
const PARTICIPLE =
  "zugeordnet|erstellt|angelegt|erfasst|eingetragen|generiert|ausgestellt|storniert|geändert|aktualisiert|korrigiert|angepasst|markiert|finalisiert|verknüpft|übernommen|pausiert|fortgesetzt|reaktiviert|deaktiviert|umgewandelt|versendet|verschickt";

/** present tense, first person ("ich ordne … zu", "jetzt lege ich … an") → kind */
const PRESENT: Record<string, ClaimKind> = {
  ordne: "assign",
  erstelle: "create",
  lege: "create",
  trage: "create",
  erfasse: "create",
  ändere: "update",
  aktualisiere: "update",
  korrigiere: "update",
  markiere: "mark",
  finalisiere: "finalize",
  verknüpfe: "link",
  übernehme: "apply",
  pausiere: "recurring",
  wandle: "convert",
};
const PRESENT_VERBS = Object.keys(PRESENT).join("|");

// own-action phrasings (on a lower-cased sentence; the gap never crosses a colon)
const HABE = re(`\\b(habe|hab)\\b([^:]{0,100}?)\\b(${PARTICIPLE})\\b`, "g");
const WURDE = re(`\\b(wurden?)\\b([^:]{0,60}?)\\b(${PARTICIPLE})\\b`, "g");
/** "ist jetzt (vollständig) bezahlt" claims a payment; elsewhere "bezahlt" is a status */
const IST_JETZT = re(`\\b(ist|sind)\\s+(jetzt|nun|soeben|erfolgreich)\\b([^:]{0,50}?)\\b(${PARTICIPLE}|bezahlt(?!\\s+markiert))\\b`, "g");
const ICH_PRESENT = re(`\\b(?:ich\\s+(${PRESENT_VERBS})|(${PRESENT_VERBS})\\s+ich)\\b`, "g");
const COORDINATED = re(`\\b(und|sowie)\\b([^:,]{0,60}?)\\b(${PARTICIPLE})\\b`, "g");
const ERLEDIGT = re(/(^|\b(ist|sind|wurde|wurden|habe|hab|alles|das)\b[^:]{0,30}?)\berledigt\b/);

/** "wurde erfolgreich / jetzt … erstellt" */
const DONE_ADVERB = re(/\b(erfolgreich|jetzt|soeben|nun|gerade|eben)\b/);
/** a gap that describes data, not an action just taken: dates, amounts, "am 3.10.", "bereits", "von Ihnen" */
const DATA_GAP = re(/\d{1,2}\.\d{1,2}\.|\d{4}-\d\d-\d\d|€|\d,\d\d|\b(am|im|vor|seit|bereits|schon|von|durch|ursprünglich|damals|automatisch|ebenfalls|zuvor|früher|jänner|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|\d{4})\b/);
/** record numbers and ids in a gap ("der Rechnung RE-2026-0001 (id 1)") are one word, not data */
const REFS = re(/\(?\b(id\s*\d+|[a-z]{1,3}-\d{4}-\d{3,5}|[a-z]-\d{3,5})\b\)?/g);
const NEGATION = re(/\b(nicht|nichts|kein|keine|keinen|keinem|keiner|nie|niemals)\b/);
/** questions, offers and conditionals: the sentence doesn't claim anything */
const NOT_A_CLAIM =
  re(/\b(soll ich|sollen wir|kann ich|könnte|würde|würden|möchten sie|möchtest du|wollen sie|willst du|wenn|falls|sobald|nachdem sie|bitte bestätig|bestätigen sie|nach (ihrer |deiner )?bestätigung)\b/);
/** a relative or passive clause after the participle ("…, die erstellt wurden") describes records */
/** "bereits zugeordnet" describes data */
const BEREITS = re(/\b(bereits|schon)\b/);
const RELATIVE_AFTER = re(/^\s+(wurden?|worden|sind|ist|hat|haben|hatte)\b/);
const RELATIVE_IN_GAP = re(/,\s*(die|der|das|den|dem|welche|welcher|welches)\b/);

export interface Claim {
  kind: ClaimKind;
  /** the claim word as written ("zugeordnet", "ordne", "erledigt") */
  word: string;
  sentence: string;
}

const kindOf = (participle: string): ClaimKind => CLAIM_WORDS.find(([re]) => re.test(participle))![1];

/** sentences of an answer, without Markdown emphasis and list markers */
function sentences(text: string): string[] {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .split(/\n+|(?<=[.!?;])\s+(?=[A-ZÄÖÜ„"\d-])/)
    .map((s) => s.replace(/^\s*(?:[-•]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

/** Claims of an own action in an answer (see the header). */
export function detectClaims(text: string): Claim[] {
  const out: Claim[] = [];
  for (const sentence of sentences(text)) {
    const s = sentence.toLowerCase();
    if (s.endsWith("?") || NOT_A_CLAIM.test(s)) continue;
    const add = (kind: ClaimKind, word: string) => out.push({ kind, word, sentence });
    const after = (m: RegExpExecArray) => s.slice(m.index + m[0].length);
    for (const m of s.matchAll(HABE)) {
      const gap = m[2]!;
      if (NEGATION.test(gap) || BEREITS.test(gap) || RELATIVE_IN_GAP.test(gap) || RELATIVE_AFTER.test(after(m))) continue;
      add(kindOf(m[3]!), m[3]!);
      // "habe … zugeordnet und den Entwurf erstellt"
      for (const c of after(m).matchAll(COORDINATED)) if (!NEGATION.test(c[2]!)) add(kindOf(c[3]!), c[3]!);
    }
    for (const m of s.matchAll(WURDE)) {
      const gap = m[2]!;
      if (NEGATION.test(gap) || RELATIVE_IN_GAP.test(gap)) continue;
      // "wurde erfolgreich/jetzt … erstellt"; a bare "wurde erstellt" only with a short gap that isn't a date or other data
      const adverb = DONE_ADVERB.test(gap);
      const bare = gap.replace(REFS, "ref");
      if (!adverb && (DATA_GAP.test(bare) || bare.trim().split(/\s+/).filter(Boolean).length > 5)) continue;
      add(kindOf(m[3]!), m[3]!);
    }
    for (const m of s.matchAll(IST_JETZT)) {
      if (NEGATION.test(m[3]!)) continue;
      add(m[4] === "bezahlt" ? "mark" : kindOf(m[4]!), m[4]!);
    }
    for (const m of s.matchAll(ICH_PRESENT)) {
      if (NEGATION.test(after(m).split(/[,;]/)[0]!)) continue;
      const verb = (m[1] ?? m[2])!;
      add(PRESENT[verb]!, verb);
    }
    const e = ERLEDIGT.exec(s);
    if (e && !NEGATION.test(e[0])) add("any", "erledigt");
  }
  return out;
}

/** a tool row of the current turn (since the last user message) */
export interface TurnToolRow {
  toolName: string | null;
  status: string;
}

/** claims no successful (or pending) call of this turn backs */
export function unbackedClaims(claims: Claim[], toolRows: TurnToolRow[]): Claim[] {
  const done = toolRows.filter((r) => r.toolName && (r.status === "done" || r.status === "pending")).map((r) => r.toolName!);
  return claims.filter((c) => !done.some((name) => CLAIM_EVIDENCE[c.kind].test(name)));
}

// --- write intent ---------------------------------------------------------------------------------------------------

/** the user asks for a change: imperative/infinitive write verbs, not participles ("Welche sind zugeordnet?") */
const WRITE_VERBS: RegExp[] = [
  re(/\bordne\b|\bzuordnen\b|\bzuzuordnen\b/),
  re(/\berstell(e|en)?\b/),
  re(/\banlegen\b|\banzulegen\b|\bleg(e)?\b[^.?!]{0,60}\ban\b/),
  re(/\b(ändere|ändern|aendere|aendern|änder|korrigier(e|en)?|aktualisier(e|en)?|bearbeite|bearbeiten)\b/),
  re(/\bmarkier(e|en)?\b/),
  re(/\bfinalisier(e|en)?\b/),
  re(/\bverknüpf(e|en)?\b/),
  re(/\bübernimm\b|\bübernehmen\b/),
  re(/\bpausier(e|en)?\b|\bstopp(e)?\b|\bsetz(e)?\b[^.?!]{0,40}\bfort\b|\bfortsetzen\b|\breaktivier(e|en)?\b/),
  re(/\berfass(e|en)?\b|\btrag(e)?\b[^.?!]{0,60}\bein\b|\beintragen\b|\b(ver)?buche(n)?\b/),
  re(/\bgenerier(e|en)?\b|\bwandle\b|\bumwandeln\b|\bstornier(e|en)?\b|\bignorier(e|en)?\b/),
  re(/\b(schick|send|verschick)(e|en)?\b[^.?!]{0,40}\bmahnung|\bmahne\b/),
  re(/\bmach(e)?\b[^.?!]{0,40}\b(bezahlt|fertig|entwurf|rechnung|angebot|gutschrift|mahnung|zuordnung)/),
];
/** a short yes to the assistant's offer ("Soll ich sie zuordnen?" → "Ja, bitte") */
const AFFIRMATION = re(/^\s*(ja|jep|jo|ok|okay|bitte|gerne|gern|genau|passt|mach( das| es| nur)?|tu das|los)\b/);
const OFFER = re(/\b(soll ich|sollen wir|möchten sie, dass ich|willst du, dass ich)\b/);

/** The user asked for a change in this message (or said yes to the assistant's offer of one). */
export function isWriteRequest(text: string, previousAssistant?: string | null): boolean {
  const t = text.toLowerCase();
  if (WRITE_VERBS.some((re) => re.test(t))) return true;
  return t.length <= 40 && AFFIRMATION.test(t) && !!previousAssistant && OFFER.test(previousAssistant.toLowerCase());
}

// --- texts ----------------------------------------------------------------------------------------------------------

const WHAT: Record<ClaimKind, { what: string; reply: string }> = {
  assign: { what: "die Zuordnung", reply: "Die Zuordnung wurde nicht ausgeführt. Soll ich sie jetzt vorbereiten?" },
  create: { what: "das Anlegen", reply: "Es wurde noch nichts angelegt. Soll ich es jetzt anlegen?" },
  update: { what: "die Änderung", reply: "Es wurde noch nichts geändert. Soll ich die Änderung jetzt vorbereiten?" },
  mark: { what: "die Markierung", reply: "Es wurde noch nichts markiert. Soll ich das jetzt vorbereiten?" },
  finalize: { what: "das Finalisieren", reply: "Es wurde noch nichts finalisiert. Soll ich das Finalisieren jetzt vorbereiten?" },
  link: { what: "die Verknüpfung", reply: "Die Verknüpfung wurde nicht ausgeführt. Soll ich sie jetzt vorbereiten?" },
  apply: { what: "die Übernahme der Belegerkennung", reply: "Die Belegerkennung wurde nicht übernommen. Soll ich das jetzt vorbereiten?" },
  recurring: { what: "die Änderung der Serienrechnung", reply: "Die Serienrechnung wurde nicht geändert. Soll ich das jetzt vorbereiten?" },
  convert: { what: "die Umwandlung", reply: "Das Angebot wurde nicht umgewandelt. Soll ich das jetzt vorbereiten?" },
  send: { what: "das Versenden", reply: "Es wurde nichts versendet oder als versendet markiert. Soll ich das jetzt vorbereiten?" },
  any: { what: "die Aktion", reply: "In dieser Runde wurde keine Aktion ausgeführt. Soll ich sie jetzt vorbereiten?" },
};

/** tool names for the corrective message ("match_bank_transaction oder link_expense_to_fixed_cost") */
const TOOL_HINT: Record<ClaimKind, string> = {
  assign: "match_bank_transaction bzw. link_expense_to_fixed_cost",
  create: "create_… bzw. generate_recurring_invoice / convert_offer_to_invoice",
  update: "update_… bzw. apply_receipt_analysis",
  mark: "mark_…",
  finalize: "finalize_document",
  link: "link_expense_to_fixed_cost bzw. match_bank_transaction",
  apply: "apply_receipt_analysis",
  recurring: "set_recurring_invoice_active",
  convert: "convert_offer_to_invoice",
  send: "mark_document_sent bzw. create_reminder",
  any: "das passende Werkzeug",
};

/** what the model reads before its one retry */
export function claimRetryMessage(claims: Claim[]): string {
  const c = claims[0]!;
  return `Du hast behauptet, ${WHAT[c.kind].what} sei erledigt („${c.word}“), aber in dieser Runde wurde kein passendes Tool ausgeführt (${TOOL_HINT[c.kind]}). Ruf jetzt das passende Tool auf (vorher nachschlagen, ids nicht raten) oder sag ehrlich, dass es noch nicht erledigt ist.`;
}

/** the fixed reply when the retry claims again: "Das ist noch nicht erledigt: Die Zuordnung wurde nicht ausgeführt. Soll ich …?" */
export function honestReply(claims: Claim[]): string {
  return `Das ist noch nicht erledigt: ${WHAT[claims[0]!.kind].reply}`;
}
