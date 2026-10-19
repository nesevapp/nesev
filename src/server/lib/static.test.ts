import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOX_CSP, serveFile } from "./static";

const dir = mkdtempSync(join(tmpdir(), "nesev-static-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
writeFileSync(join(dir, "a.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(dir, "page.html"), "<script>alert(1)</script>");
writeFileSync(join(dir, "blob"), "<html><script>alert(1)</script>");

describe("serveFile", () => {
  test("nosniff on every file; active types (svg/xml/html) sandboxed", async () => {
    const svg = (await serveFile(dir, "logo.svg"))!;
    expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
    expect(svg.headers.get("content-security-policy")).toBe(SANDBOX_CSP);
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect((await serveFile(dir, "page.html"))!.headers.get("content-security-policy")).toBe(SANDBOX_CSP);
    const png = (await serveFile(dir, "a.png"))!;
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect(png.headers.get("content-security-policy")).toBeNull();
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await serveFile(dir, "blob"))!.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("paths outside the directory and broken escapes are not served", async () => {
    expect(await serveFile(dir, "../etc/passwd")).toBeNull();
    expect(await serveFile(dir, "%2e%2e/x")).toBeNull();
    expect(await serveFile(dir, "%E0%A4%A")).toBeNull();
    expect(await serveFile(dir, "missing.svg")).toBeNull();
  });
});
