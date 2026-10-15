// Tiny XML writer for the e-invoice generators: build a tree with h(), serialize with toXml().
// Empty optional values are dropped, so callers can pass "" / null / undefined / false freely.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: (XmlElement | string)[];
}

type Child = XmlElement | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | null | undefined>;

function flatten(children: Child[], out: (XmlElement | string)[] = []): (XmlElement | string)[] {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === "") continue;
    if (Array.isArray(c)) flatten(c, out);
    else out.push(typeof c === "number" ? String(c) : c);
  }
  return out;
}

/** An element; null/undefined attributes are omitted. */
export function h(name: string, attrs: Attrs | null, ...children: Child[]): XmlElement {
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) a[k] = String(v);
  return { name, attrs: a, children: flatten(children) };
}

/** An element with text content, or null when the text is empty (= optional element left out). */
export function leaf(name: string, text: string | number | null | undefined, attrs?: Attrs): XmlElement | null {
  if (text === null || text === undefined || text === "") return null;
  return h(name, attrs ?? null, String(text));
}

/** An element only if it has children; an empty container is left out. */
export function group(name: string, attrs: Attrs | null, ...children: Child[]): XmlElement | null {
  const el = h(name, attrs, ...children);
  return el.children.length ? el : null;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // characters not allowed in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function serialize(el: XmlElement, indent: string, out: string[]) {
  const attrs = Object.entries(el.attrs)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  if (el.children.length === 0) {
    out.push(`${indent}<${el.name}${attrs}/>`);
  } else if (el.children.every((c) => typeof c === "string")) {
    out.push(`${indent}<${el.name}${attrs}>${escapeXml(el.children.join(""))}</${el.name}>`);
  } else {
    out.push(`${indent}<${el.name}${attrs}>`);
    for (const c of el.children) {
      if (typeof c === "string") out.push(`${indent}  ${escapeXml(c)}`);
      else serialize(c, `${indent}  `, out);
    }
    out.push(`${indent}</${el.name}>`);
  }
}

/** UTF-8 XML document with declaration, two-space indentation. */
export function toXml(root: XmlElement): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  serialize(root, "", out);
  return `${out.join("\n")}\n`;
}
