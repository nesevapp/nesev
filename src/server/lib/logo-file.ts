// Logo uploads: the file type comes from the content (never from the client's MIME type), and SVGs must pass a
// strict allow-list check. SVG is active content: opened directly from /api/files it runs in nesev's origin, with
// full API access. Rejecting anything beyond plain vector graphics is simpler and more robust than rewriting the
// SVG (a sanitizer's output would have to be trusted); a logo exported from Illustrator / Inkscape / Figma passes.
// serveFile() additionally serves SVGs with a sandboxing CSP (defence in depth), and the PDF renderer gets the
// checked text unchanged.

export type LogoExt = "png" | "jpg" | "webp" | "svg";

/** Detects PNG, JPEG, WebP or SVG from the bytes; null for anything else. */
export function sniffLogo(bytes: Uint8Array): LogoExt | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^﻿/, "");
  // optional XML declaration, comments and a DOCTYPE, then the <svg> root
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*>\s*)*<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** SVG elements a logo may use (lower-cased local names). No script, foreignObject, a, iframe, embed, object, animate … */
const SVG_ELEMENTS = new Set(
  [
    "svg", "g", "defs", "symbol", "use", "title", "desc", "metadata", "style", "switch",
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "textpath",
    "lineargradient", "radialgradient", "stop", "pattern", "clippath", "mask", "marker", "image",
    "filter", "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix", "fediffuselighting",
    "fedisplacementmap", "fedistantlight", "fedropshadow", "feflood", "fefunca", "fefuncb", "fefuncg", "fefuncr",
    "fegaussianblur", "femerge", "femergenode", "femorphology", "feoffset", "fepointlight", "fespecularlighting",
    "fespotlight", "fetile", "feturbulence",
  ],
);
/** editor metadata prefixes (Inkscape, Sodipodi, RDF/Dublin Core in <metadata>); inert in an SVG document */
const META_PREFIXES = new Set(["sodipodi", "inkscape", "rdf", "cc", "dc", "svg", "x", "i", "sketch", "serif", "figma"]);
/** elements that are never allowed, whatever their prefix */
const FORBIDDEN = new Set(["script", "foreignobject", "iframe", "embed", "object", "a", "animate", "animatemotion", "animatetransform", "set", "handler", "listener", "html", "body", "link", "meta", "base", "form", "input", "button"]);

const TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/y;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** numeric character references decoded (so &#106;avascript: is seen), invalid ones dropped */
function decodeRefs(s: string): string {
  return s.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, e: string) => {
    const code = e[0] === "x" || e[0] === "X" ? parseInt(e.slice(1), 16) : Number(e);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

const LOCAL_HREF = /^#[\w.:-]*$/;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;

/**
 * German reason why the SVG is refused, or null when it is a plain vector graphic: only known SVG elements (plus
 * editor metadata), no event handlers, no scripts or javascript: URLs, no references outside the file (links,
 * external images, CSS url()/@import, xml-stylesheet), no XHTML/MathML content, no DTD with an internal subset.
 */
export function svgProblem(svg: string): string | null {
  const text = svg.replace(/^﻿/, "");
  // what a browser may still read as a scheme after decoding references and dropping whitespace/control characters
  const flat = decodeRefs(text).replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
  if (/javascript:|vbscript:|data:text\/|data:application\//.test(flat)) return "SVG enthält Skript-Links";
  if (/http:\/\/www\.w3\.org\/1999\/xhtml|http:\/\/www\.w3\.org\/1998\/math\/mathml/.test(flat)) return "SVG enthält HTML-Inhalte";
  if (/@import|expression\(|-moz-binding|behavior:/.test(flat)) return "SVG enthält unzulässiges CSS";
  if (/url\((?!['"]?#)/.test(flat)) return "SVG verweist auf externe Dateien";
  if (/<!entity|<!doctype[^>]*\[/.test(flat)) return "SVG enthält eine DTD";
  for (const m of text.matchAll(/<\?([^\s?]*)/g)) if (m.index !== 0 || m[1]!.toLowerCase() !== "xml") return "SVG enthält Verarbeitungsanweisungen";

  let sawRoot = false;
  for (let i = text.indexOf("<"); i !== -1; i = text.indexOf("<", i + 1)) {
    const rest = text.slice(i, i + 9);
    if (rest.startsWith("<!--")) {
      const end = text.indexOf("-->", i);
      if (end === -1) return "SVG ist unvollständig";
      i = end;
      continue;
    }
    if (rest.startsWith("<![CDATA[")) {
      const end = text.indexOf("]]>", i);
      if (end === -1) return "SVG ist unvollständig";
      // CDATA is only text, but nothing that looks like markup may hide in it
      if (/<\s*\/?\s*[a-z]/i.test(text.slice(i + 9, end))) return "SVG enthält unzulässige Elemente";
      i = end;
      continue;
    }
    if (rest.startsWith("<!") || rest.startsWith("<?") || rest.startsWith("</")) continue;
    TAG.lastIndex = i;
    const m = TAG.exec(text);
    if (!m) return "SVG ist fehlerhaft";
    const qname = m[1]!.toLowerCase();
    const colon = qname.indexOf(":");
    const prefix = colon === -1 ? "" : qname.slice(0, colon);
    const local = qname.slice(colon + 1);
    if (FORBIDDEN.has(local)) return `SVG enthält unzulässige Elemente (<${m[1]}>)`;
    if (prefix ? !META_PREFIXES.has(prefix) : !SVG_ELEMENTS.has(local)) return `SVG enthält unzulässige Elemente (<${m[1]}>)`;
    if (!sawRoot && local !== "svg") return "SVG ist fehlerhaft";
    sawRoot = true;
    for (const a of m[2]!.matchAll(ATTR)) {
      const name = a[1]!.toLowerCase();
      const value = decodeRefs(a[2] ?? a[3] ?? "").trim();
      const localAttr = name.slice(name.indexOf(":") + 1);
      if (localAttr.startsWith("on")) return "SVG enthält Ereignis-Handler";
      if (localAttr === "href" || localAttr === "src") {
        if (!(LOCAL_HREF.test(value) || (local === "image" && DATA_IMAGE.test(value)))) return "SVG verweist auf externe Dateien";
      }
      if (name === "xml:base") return "SVG verweist auf externe Dateien";
    }
    i += m[0].length - 1;
  }
  return sawRoot ? null : "SVG ist fehlerhaft";
}
