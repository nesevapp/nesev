import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appPath, parseInline, parseMarkdown, safeHref } from "./markdown";
import { MarkdownView } from "./markdown-view";

const html = (source: string) => renderToStaticMarkup(createElement(MarkdownView, { source }));

describe("markdown renderer escaping", () => {
  test("raw HTML is rendered as text", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror="alert(2)"> **<b>fett</b>**');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain('<strong class="font-semibold">&lt;b&gt;fett&lt;/b&gt;</strong>');
  });

  test("dangerous link targets become plain text", () => {
    for (const href of ["/tmp/nesev/pdfs/RE-1.pdf", "/Users/x/a.pdf", "javascript:alert(1)", "data:text/html,<script>", "//evil.example/x", "vbscript:x"]) {
      expect(safeHref(href)).toBeNull();
      const out = html(`[klick](${href})`);
      expect(out).not.toContain("<a");
      expect(out).toContain("klick");
    }
  });

  test("code spans and blocks are escaped, not interpreted", () => {
    expect(html("`<em>x</em>`")).toContain("&lt;em&gt;x&lt;/em&gt;");
    expect(html("```\n<div>**nicht fett**</div>\n```")).toContain("&lt;div&gt;**nicht fett**&lt;/div&gt;");
  });

  test("table cells are escaped", () => {
    const out = html("| a | b |\n|---|---|\n| <i>x</i> | **y** |");
    expect(out).toContain("<table");
    expect(out).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(out).toContain("<strong");
  });
});

describe("parseMarkdown", () => {
  test("blocks: heading, lists, paragraph", () => {
    const blocks = parseMarkdown("## Offen\n\n- RE-1: **100 €**\n- RE-2\n\n1. eins\n2. zwei\n\nText\nzweite Zeile");
    expect(blocks.map((b) => b.type)).toEqual(["h", "ul", "ol", "p"]);
    expect(blocks[1]).toMatchObject({ type: "ul", items: [[{ type: "text", text: "RE-1: " }, { type: "strong" }], [{ type: "text", text: "RE-2" }]] });
    expect(blocks[3]).toMatchObject({ type: "p", children: [{ text: "Text" }, { type: "br" }, { text: "zweite Zeile" }] });
  });

  test("unclosed fence while streaming", () => {
    expect(parseMarkdown("```\nabc")).toEqual([{ type: "code", text: "abc" }]);
  });

  test("inline links and emphasis", () => {
    expect(parseInline("[RE-2026-0004](/invoices/4) und *kursiv*")).toEqual([
      { type: "link", href: "/invoices/4", children: [{ type: "text", text: "RE-2026-0004" }] },
      { type: "text", text: " und " },
      { type: "em", children: [{ type: "text", text: "kursiv" }] },
    ]);
    // a lone asterisk (e.g. "5 * 3") is not emphasis
    expect(parseInline("5 * 3 * 2")).toEqual([{ type: "text", text: "5 * 3 * 2" }]);
  });

  test("appPath maps local URLs to router paths", () => {
    expect(appPath("/invoices/1")).toBe("/invoices/1");
    expect(appPath("http://localhost:5174/invoices/1?x=1")).toBe("/invoices/1?x=1");
    expect(appPath("https://example.com/a")).toBeNull();
    expect(appPath("/api/files/pdfs/RE-1.pdf")).toBe("/api/files/pdfs/RE-1.pdf");
    expect(appPath("/tmp/nesev/pdfs/RE-1.pdf")).toBeNull();
    expect(appPath("http://localhost:5174/")).toBe("/");
  });
});
