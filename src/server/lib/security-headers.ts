import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { WEB_DIST_DIR } from "./paths";

// Security headers on everything Hono serves (API, files, and the built SPA in production; in dev Vite serves the
// SPA). Every response: nosniff, no referrer, framing only by nesev itself. HTML documents get a CSP the SPA works
// with (checked against the production build incl. the pdfme designer):
//   script-src  'self' + hashes of index.html's inline scripts (theme before first paint), 'wasm-unsafe-eval' for
//               the PDF engine's WebAssembly (pdfium in a module worker), blob: for the voice recorder's AudioWorklet
//   style-src   'unsafe-inline' (React style props, pdfme, Radix)
//   img/font/connect/media/frame/worker: 'self' plus data:/blob: (receipt previews, PDF blobs in iframes, fonts)
// Responses that already carry a CSP keep it (serveFile's sandbox for SVG/HTML files from data/).

const DIRECTIVES = (scriptHashes: string[]) =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' blob:${scriptHashes.map((h) => ` '${h}'`).join("")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");

/** sha256 hashes ("sha256-…") of the inline <script> elements of an HTML page */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]!)) continue;
    out.push(`sha256-${createHash("sha256").update(m[2]!, "utf8").digest("base64")}`);
  }
  return out;
}

export function documentCsp(scriptHashes: string[]): string {
  return DIRECTIVES(scriptHashes);
}

let cached: string | null = null;
/** the CSP for HTML documents, with the hashes of the built index.html (read once; none in dev / before a build) */
function spaCsp(): string {
  if (cached === null) {
    let html = "";
    try {
      html = readFileSync(join(WEB_DIST_DIR, "index.html"), "utf8");
    } catch {
      // no build: no inline scripts to allow
    }
    cached = documentCsp(inlineScriptHashes(html));
  }
  return cached;
}

export function securityHeaders(opts: { csp?: () => string } = {}): MiddlewareHandler {
  const csp = opts.csp ?? spaCsp;
  return async (c, next) => {
    await next();
    const set = (h: Headers) => {
      if (!h.has("X-Content-Type-Options")) h.set("X-Content-Type-Options", "nosniff");
      h.set("Referrer-Policy", "no-referrer");
      if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "SAMEORIGIN");
      if (h.has("Content-Security-Policy")) return;
      const type = h.get("Content-Type") ?? "";
      // documents get the full policy; other responses (JSON, PDFs shown in the app's iframes, images) only the framing rule
      h.set("Content-Security-Policy", /^\s*(text\/html|application\/xhtml)/i.test(type) ? csp() : "frame-ancestors 'self'");
    };
    try {
      set(c.res.headers);
    } catch {
      // immutable headers (a Response passed through from fetch): copy it
      c.res = new Response(c.res.body, c.res);
      set(c.res.headers);
    }
  };
}
