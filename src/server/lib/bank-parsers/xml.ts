// Minimal, tolerant XML reader for bank statements (camt.05x). No DTDs, no mixed content semantics:
// elements keep their children and concatenated text. Namespace prefixes are stripped ("ns2:Ntry" → "Ntry").

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const localName = (n: string) => n.slice(n.indexOf(":") + 1);

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    if (lt > i) stack.at(-1)!.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      stack.at(-1)!.text += src.slice(lt + 9, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 3;
    } else if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      const end = src.indexOf(">", lt);
      i = end === -1 ? src.length : end + 1;
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      const name = localName(src.slice(lt + 2, end).trim());
      // pop up to the matching element (tolerates unclosed children)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = end === -1 ? src.length : end + 1;
    } else {
      const end = findTagEnd(src, lt);
      let body = src.slice(lt + 1, end);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)\s*([\s\S]*)$/.exec(body.trim());
      const node: XmlNode = { name: localName(m?.[1] ?? ""), attrs: parseAttrs(m?.[2] ?? ""), children: [], text: "" };
      stack.at(-1)!.children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  return root;
}

function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let i = from + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return src.length;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[localName(m[1]!)] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return out;
}

/** First descendant along a path of element names: child(ntry, "BookgDt", "Dt"). */
export function child(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = node;
  for (const name of path) {
    cur = cur?.children.find((c) => c.name === name);
    if (!cur) return undefined;
  }
  return cur;
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Trimmed text of the node at `path` ("" if missing). */
export function textAt(node: XmlNode | undefined, ...path: string[]): string {
  return (child(node, ...path)?.text ?? "").trim();
}

/** All descendants (depth-first) with the given name. */
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}
