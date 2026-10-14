// Safe Markdown subset for assistant messages: paragraphs, headings, bullet/numbered lists, fenced code,
// tables, and inline **bold**, *italic*, `code` and [links](…). The parser only produces an AST of text
// nodes; the renderer (markdown-view.tsx) turns it into React elements, so raw HTML is never interpreted.

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "br" };

export type Block =
  | { type: "p"; children: Inline[] }
  | { type: "h"; level: 1 | 2 | 3; children: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][]; start?: number }
  | { type: "code"; text: string }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming message)
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "h", level: Math.min(heading[1].length, 3) as 1 | 2 | 3, children: parseInline(heading[2]) });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      const start = ordered ? Number(NUMBERED.exec(line)![1]) : undefined;
      let current: string[] | null = null;
      while (i < lines.length && lines[i].trim()) {
        const m = re.exec(lines[i]);
        if (m) {
          if (current) items.push(parseInline(current.join("\n")));
          current = [ordered ? m[2] : m[1]];
        } else if (current && /^\s+/.test(lines[i])) {
          current.push(lines[i].trim()); // continuation line of an item
        } else break;
        i++;
      }
      if (current) items.push(parseInline(current.join("\n")));
      blocks.push(ordered ? { type: "ol", items, start } : { type: "ul", items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    blocks.push({ type: "p", children: parseInline(para.join("\n")) });
  }
  return blocks;
}

// Inline tokens, tried in order at each position.
const INLINE = /`([^`\n]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)|(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)|\n/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.type === "text") prev.text += t;
    else out.push({ type: "text", text: t });
  };
  for (const m of text.matchAll(INLINE)) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0] === "\n") out.push({ type: "br" });
    else if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ type: "strong", children: parseInline(m[2] ?? m[3]) });
    else if (m[4] !== undefined) {
      const href = safeHref(m[5]);
      if (href) out.push({ type: "link", href, children: parseInline(m[4]) });
      else pushText(m[4]);
    } else out.push({ type: "em", children: parseInline(m[6] ?? m[7]) });
  }
  pushText(text.slice(last));
  return out;
}

// First path segments the app serves: its pages and stored files (/api/files/…). Anything else that starts with
// "/" is most likely a file-system path the model picked up from a tool result, not a link.
const APP_SECTIONS = new Set([
  "",
  "offers",
  "invoices",
  "credit-notes",
  "reminders",
  "recurring",
  "expenses",
  "fixed-costs",
  "assets",
  "bank",
  "tax",
  "clients",
  "articles",
  "templates",
  "export",
  "settings",
  "forecast",
]);

const isAppPath = (path: string) => /^\/api\/files\//.test(path) || APP_SECTIONS.has(path.split(/[/?#]/)[1] ?? "");

/** App paths ("/invoices/12") and http(s) URLs only; javascript:, data:, file-system paths etc. become plain text. */
export function safeHref(href: string): string | null {
  if (/^\/(?!\/)/.test(href)) return isAppPath(href) ? href : null;
  if (/^https?:\/\//i.test(href)) return href;
  return null;
}

/** An app path, or an http(s) link pointing at a local nesev instance (the MCP tools link to http://localhost:<port>/…), as a path. */
export function appPath(href: string, origin?: string): string | null {
  if (href.startsWith("/")) return isAppPath(href) ? href : null;
  try {
    const url = new URL(href);
    if ((origin && url.origin === origin) || url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      const path = `${url.pathname}${url.search}${url.hash}`;
      return isAppPath(path) ? path : null;
    }
  } catch {
    // not a URL
  }
  return null;
}

/** Stored files (PDFs, receipts) are served by the API: open them as documents, not through the router. */
export const isFilePath = (path: string) => path.startsWith("/api/");
