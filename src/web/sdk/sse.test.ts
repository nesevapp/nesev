import { describe, expect, test } from "bun:test";
import { createSseParser, readSse } from "./sse";

const stream = (chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });

async function collect(chunks: (string | Uint8Array)[]) {
  const out: string[] = [];
  await readSse(stream(chunks), (d) => out.push(d));
  return out;
}

describe("createSseParser", () => {
  test("parses complete events, ignores event/id/comment lines", () => {
    const p = createSseParser();
    expect(p.push('event: delta\ndata: {"a":1}\n\n: keepalive\n\nid: 3\ndata:{"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("joins multi-line data and normalizes CRLF", () => {
    const p = createSseParser();
    expect(p.push("data: line1\r\ndata: line2\r\n\r\n")).toEqual(["line1\nline2"]);
  });

  test("keeps incomplete events until the blank line arrives", () => {
    const p = createSseParser();
    expect(p.push('data: {"type":"del')).toEqual([]);
    expect(p.push('ta"}\n')).toEqual([]);
    expect(p.push('\ndata: {"x":1}\n\n')).toEqual(['{"type":"delta"}', '{"x":1}']);
  });

  test("flush returns a trailing event without blank line", () => {
    const p = createSseParser();
    expect(p.push("data: last")).toEqual([]);
    expect(p.flush()).toEqual(["last"]);
    expect(p.flush()).toEqual([]);
  });
});

describe("readSse", () => {
  test("events split across arbitrary chunk boundaries", async () => {
    const text = 'data: {"type":"delta","text":"Hallo"}\n\ndata: {"type":"done"}\n\n';
    for (let size = 1; size <= text.length; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(await collect(chunks)).toEqual(['{"type":"delta","text":"Hallo"}', '{"type":"done"}']);
    }
  });

  test("multi-byte UTF-8 characters split between chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"text":"Prüfung €"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside "ü"
    expect(await collect([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(['{"text":"Prüfung €"}']);
  });

  test("blank line split between chunks (\\n | \\n)", async () => {
    expect(await collect(["data: a\n", "\ndata: b\n", "\n"])).toEqual(["a", "b"]);
  });
});
