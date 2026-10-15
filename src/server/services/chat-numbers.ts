// Invented record numbers: the small model sometimes names numbers that don't exist, typically "RE-2026-0004" for a
// draft it just created (drafts get their number only when finalized). Guard: every record number in an answer
// must appear in this conversation – in a tool result (text, links, cards) or in the user's own words (incl. the page
// title sent with the message). Streamed text passes through a NumberGate, which holds back a number until it's
// complete and stops at the first unknown one, so a fake is never shown. A final answer with an unknown number is
// retried once with a correction; if the retry invents again (or the text came with tool calls), the number is
// replaced by neutral wording ("der Entwurf", or just the noun in front of it) instead of showing a fake.

/** "RE-2026-0004" (documents, reminders, expenses) or "K-0001" / "AV-0001" (clients, assets) */
const NUMBER = /(?<![\p{L}\p{N}-])(?:(RE|AN|GS|MA|ER)-(\d{4})-(\d{1,6})|(K|AV)-(\d{1,6}))(?![\p{L}\p{N}])/giu;

export interface FoundNumber {
  /** as written */
  raw: string;
  /** canonical: upper case, sequence without zero padding ("RE-2026-4") */
  key: string;
  /** "RE", "K", … */
  prefix: string;
  index: number;
  end: number;
}

export function numbersIn(text: string): FoundNumber[] {
  return [...text.matchAll(NUMBER)].map((m) => {
    const prefix = (m[1] ?? m[4])!.toUpperCase();
    const key = m[1] ? `${prefix}-${m[2]}-${Number(m[3])}` : `${prefix}-${Number(m[5])}`;
    return { raw: m[0], key, prefix, index: m.index, end: m.index + m[0].length };
  });
}

export interface NumberSourceRow {
  role: "user" | "assistant" | "tool";
  content: string;
  /** stored ChatToolResult (cards and links carry numbers too) */
  toolResult?: unknown;
}

/** Numbers the conversation established: tool results and the user's messages (never the model's own text). */
export function knownNumbers(rows: NumberSourceRow[], extra: (string | undefined | null)[] = []): Set<string> {
  const known = new Set<string>();
  const add = (text: string) => {
    for (const n of numbersIn(text)) known.add(n.key);
  };
  for (const r of rows) {
    if (r.role === "user") add(r.content);
    if (r.role === "tool") {
      add(r.content);
      if (r.toolResult) add(JSON.stringify(r.toolResult));
    }
  }
  for (const e of extra) if (e) add(e);
  return known;
}

/** numbers in `text` the conversation never showed, as written (deduplicated) */
export function unknownNumbers(text: string, known: Set<string>): string[] {
  return [...new Set(numbersIn(text).filter((n) => !known.has(n.key)).map((n) => n.raw))];
}

/** what the model reads before its one retry */
export function numberRetryMessage(unknown: string[]): string {
  const list = unknown.map((n) => `„${n}“`).join(", ");
  return `${unknown.length > 1 ? `Die Nummern ${list} stehen` : `Die Nummer ${list} steht`} in keinem Werkzeug-Ergebnis dieser Unterhaltung – erfinde keine Nummern. Entwürfe haben noch keine Nummer (die gibt es erst beim Finalisieren): nenn sie „Entwurf“ und verlinke den Pfad aus dem Werkzeug-Ergebnis. Schreib die Antwort noch einmal, nur mit Nummern aus Werkzeug-Ergebnissen.`;
}

// --- neutral wording ------------------------------------------------------------------------------------------------

/** what stands in for an unknown number with no noun in front of it */
const STAND_IN: Record<string, string> = {
  RE: "der Entwurf",
  AN: "der Entwurf",
  GS: "der Entwurf",
  MA: "die Mahnung",
  ER: "die Ausgabe",
  K: "der Kunde",
  AV: "die Anlage",
};
/** label of a Markdown link whose label was the number */
const LINK_LABEL: Record<string, string> = { RE: "Rechnung", AN: "Angebot", GS: "Gutschrift", MA: "Mahnung", ER: "Ausgabe", K: "Kunde", AV: "Anlage" };
/** a noun right before the number ("Rechnungsentwurf Nr. RE-…", "die Rechnung RE-…"): the number can just go */
const NOUN_BEFORE = /([\p{L}]*(?:rechnung|entwurf|angebot|gutschrift|mahnung|ausgabe|beleg|kunde|kunden|kundin|anlage))(\s*(?:nr\.?|nummer)?\s*:?\s*)$/iu;
const SENTENCE_START = /(?:^|[.!?:]\s+|\n\s*(?:[-*•]\s+|\d+\.\s+)?)$/;

/**
 * The text with each unknown number replaced by neutral wording: dropped after a noun ("die Rechnung RE-… für
 * Alpen" → "die Rechnung für Alpen"), dropped with its parentheses, a link label becomes the noun ("[Entwurf](/invoices/4)"
 * when that path is a known draft), anything else becomes "der Entwurf" / "die Ausgabe" ….
 */
export function neutralizeNumbers(text: string, known: Set<string>, draftPaths: Set<string> = new Set()): string {
  const unknown = numbersIn(text).filter((x) => !known.has(x.key));
  if (!unknown.length) return text;
  let out = text;
  for (const n of unknown.reverse()) {
    let start = n.index;
    let end = n.end;
    // **RE-…** / `RE-…`
    for (const w of ["**", "`", "*"]) {
      if (out.slice(start - w.length, start) === w && out.slice(end, end + w.length) === w) {
        start -= w.length;
        end += w.length;
        break;
      }
    }
    const before = out.slice(0, start);
    const after = out.slice(end);
    const link = before.endsWith("[") ? /^\]\(([^)\s]+)\)/.exec(after) : null;
    if (link) {
      const path = link[1]!;
      const head = before.slice(0, -1);
      const noun = NOUN_BEFORE.exec(head);
      if (noun) {
        // "der Entwurf [RE-…](/invoices/4)" → "der [Entwurf](/invoices/4)"
        out = `${head.slice(0, head.length - noun[0].length)}[${noun[1]}](${path})${after.slice(link[0].length)}`;
      } else {
        out = `${before}${draftPaths.has(path) ? "Entwurf" : (LINK_LABEL[n.prefix] ?? "öffnen")}${after}`;
      }
      continue;
    }
    const paren = /\(\s*(?:nr\.?|nummer)?\s*$/i.exec(before);
    if (paren && /^\s*\)/.test(after)) {
      out = `${before.slice(0, paren.index).trimEnd()}${after.replace(/^\s*\)/, "")}`;
      continue;
    }
    const noun = NOUN_BEFORE.exec(before);
    if (noun) {
      out = `${before.slice(0, before.length - noun[2]!.length)}${after}`;
      continue;
    }
    const standIn = STAND_IN[n.prefix] ?? "der Beleg";
    out = `${before}${SENTENCE_START.test(before) ? standIn[0]!.toUpperCase() + standIn.slice(1) : standIn}${after}`;
  }
  return out
    .replace(/(?<=\S)[ \t]{2,}(?=\S)/g, " ")
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/\(\s*\)/g, "");
}

// --- streaming ------------------------------------------------------------------------------------------------------

/** the end of the text may still grow into a number ("… RE-2026-00"): held back until the next chunk */
const PARTIAL_TAIL = /(?<![\p{L}\p{N}])[a-z]{1,2}(?:-[\d-]*)?$/iu;

/**
 * Streams text through, holding back what could still become a number and stopping for good at the first unknown
 * one (`blocked`). push() returns what may be shown now; flush() at the end returns the held rest (empty once
 * blocked, or when the rest ends in an unknown number).
 */
export class NumberGate {
  private text = "";
  private emitted = 0;
  blocked = false;

  constructor(private readonly known: Set<string>) {}

  push(delta: string): string {
    this.text += delta;
    return this.release(false);
  }

  flush(): string {
    return this.release(true);
  }

  private release(final: boolean): string {
    if (this.blocked) return "";
    let safe = this.text.length;
    if (!final) {
      const tail = PARTIAL_TAIL.exec(this.text);
      if (tail) safe = tail.index;
    }
    for (const n of numbersIn(this.text)) {
      if (n.end > safe && !final) break;
      if (!this.known.has(n.key)) {
        this.blocked = true;
        safe = Math.min(safe, n.index);
        break;
      }
    }
    if (safe <= this.emitted) return "";
    const out = this.text.slice(this.emitted, safe);
    this.emitted = safe;
    return out;
  }
}
