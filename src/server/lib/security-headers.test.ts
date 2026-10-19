import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { documentCsp, inlineScriptHashes, securityHeaders } from "./security-headers";
import { SANDBOX_CSP } from "./static";

const app = new Hono()
  .use("*", securityHeaders({ csp: () => documentCsp(["sha256-abc"]) }))
  .get("/", (c) => c.html("<!doctype html><p>x</p>"))
  .get("/api/x", (c) => c.json({ ok: true }))
  .get("/svg", () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml", "Content-Security-Policy": SANDBOX_CSP } }))
  .get("/boom", () => {
    throw new Error("boom");
  });

describe("securityHeaders", () => {
  test("HTML gets the document CSP, everything nosniff / no-referrer / same-origin framing", async () => {
    const html = await app.request("/");
    expect(html.headers.get("content-security-policy")).toContain("script-src 'self' 'wasm-unsafe-eval' blob: 'sha256-abc'");
    expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(html.headers.get("content-security-policy")).toContain("object-src 'none'");
    for (const res of [html, await app.request("/api/x"), await app.request("/svg"), await app.request("/boom")]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    }
    expect((await app.request("/api/x")).headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    // a response's own policy (serveFile's sandbox) wins
    expect((await app.request("/svg")).headers.get("content-security-policy")).toBe(SANDBOX_CSP);
  });

  test("hashes of inline scripts only", () => {
    const body = '\n  try { document.documentElement.classList.add("dark"); } catch (e) {}\n';
    const hash = `sha256-${createHash("sha256").update(body).digest("base64")}`;
    expect(inlineScriptHashes(`<script>${body}</script><script type="module" src="/a.js"></script>`)).toEqual([hash]);
  });
});
