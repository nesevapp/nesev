import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { WEB_DIST_DIR } from "./paths";

/**
 * Types a browser runs as a document of their own (scripts, links, forms) when a file is opened directly. Files from
 * data/ (logos, receipts, PDFs) are user content: served like this they would run in nesev's origin with full API
 * access, so they get a sandboxing CSP (no scripts, no requests, opaque origin). The built SPA (WEB_DIST_DIR) is ours.
 */
const ACTIVE_EXTS = new Set([".svg", ".svgz", ".xml", ".xsl", ".xslt", ".html", ".htm", ".xhtml", ".shtml", ".mht", ".mhtml"]);
export const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/** Serve a regular file from `dir` by a request-relative path; null if missing or outside `dir`. */
export async function serveFile(dir: string, relPath: string): Promise<Response | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(relPath);
  } catch {
    return null;
  }
  const full = normalize(join(dir, rel));
  if (!full.startsWith(dir + sep)) return null;
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) return null;
  const file = Bun.file(full);
  const headers = new Headers({ "X-Content-Type-Options": "nosniff" });
  // Bun.file's type from the extension; unknown types must not be sniffed into HTML
  headers.set("Content-Type", file.type || "application/octet-stream");
  if (dir !== WEB_DIST_DIR && ACTIVE_EXTS.has(extname(full).toLowerCase())) headers.set("Content-Security-Policy", SANDBOX_CSP);
  return new Response(file, { headers });
}
