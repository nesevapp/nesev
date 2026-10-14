import { describe, expect, test } from "bun:test";
import { type FetchFn, extractFields, jsonBody, strictSchema } from "./receipt-llm";

const BASE = "http://127.0.0.1:40001/v1";
const KEY = "per-process-key";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** fetch mock: routes by path, records calls; unknown path = connection refused */
function mockFetch(routes: Record<string, (body: Record<string, unknown> | null) => Response>, calls: Call[] = []): FetchFn {
  return async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    const route = routes[new URL(url).pathname];
    if (!route) throw new TypeError("fetch failed");
    return route(body);
  };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const completion = (content: string, finish_reason = "stop") => json({ choices: [{ index: 0, finish_reason, message: { role: "assistant", content } }] });

const LLM_ANSWER = {
  supplierName: "Elektro Gruber GmbH",
  supplierUid: "ATU 37675002",
  supplierCountry: "AT",
  supplierInvoiceNumber: "R-2026/0815",
  issueDate: "2026-09-12",
  dueDate: "2026-09-26",
  currency: "EUR",
  grossTotal: 480,
  taxLines: [{ ratePercent: 20, net: 400, tax: 80, gross: 480 }],
  iban: "AT48 3200 0000 1234 5864",
  description: "Elektroinstallation",
  category: "instandhaltung",
  vatTreatment: "domestic",
  confidence: { supplierName: 1, grossTotal: 0.95, taxLines: 0.9, category: 0.6 },
};

const TEXT = `Elektro Gruber GmbH
UID: ATU00000000
Rechnungsnr.: R-2026/0815
Rechnungsdatum: 12.09.2026
Summe netto 400,00
zzgl. 20% USt 80,00
Gesamtbetrag EUR 480,00
IBAN: AT48 3200 0000 1234 5864`;

describe("llama-server client", () => {
  test("json_schema request (temperature 0, no thinking, key header) and mapped fields", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch({ "/v1/chat/completions": () => completion(JSON.stringify(LLM_ANSWER)) }, calls);
    const res = await extractFields({ baseUrl: BASE, apiKey: KEY, model: "Qwen3.5-4B", text: TEXT, fetchFn, context: { ownName: "Mustermann" } });
    expect(calls).toHaveLength(1);
    const { body, headers, url } = calls[0]!;
    expect(url).toBe(`${BASE}/chat/completions`);
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(body!.model).toBe("Qwen3.5-4B");
    expect(body!.temperature).toBe(0);
    expect(body!.stream).toBe(false);
    expect(body!.chat_template_kwargs).toEqual({ enable_thinking: false });
    const format = body!.response_format as { type: string; json_schema: { name: string; schema: Record<string, unknown> } };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("receipt");
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    const messages = body!.messages as { role: string; content: unknown }[];
    expect(messages[0]!.role).toBe("system");
    expect(JSON.stringify(messages)).toContain("Mustermann");
    expect(typeof messages[1]!.content).toBe("string");

    const f = res.fields;
    expect(f.supplierUid?.value).toBe("ATU00000000");
    expect(f.iban?.value).toBe("AT483200000012345864");
    expect(f.grossCents?.value).toBe(48000);
    expect(f.taxLines?.value).toEqual([{ taxRateBp: 2000, netCents: 40000, taxCents: 8000, grossCents: 48000 }]);
    expect(f.category?.value).toBe("instandhaltung");
    // model confidences are capped
    expect(f.supplierName?.confidence).toBe(0.9);
    expect(f.category?.confidence).toBe(0.6);
  });

  test("answer JSON is extracted from fences or a think block", () => {
    expect(JSON.parse(jsonBody('<think>hmm {x}</think>\n```json\n{"a":1}\n```'))).toEqual({ a: 1 });
    expect(jsonBody('{"a":{"b":2}}')).toBe('{"a":{"b":2}}');
  });

  test("strictSchema closes nested objects", () => {
    const s = strictSchema({ type: "object", properties: { a: { type: "object", properties: {} }, b: { type: "array", items: { type: "object" } } } });
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.a!.additionalProperties).toBe(false);
    expect((props.b!.items as Record<string, unknown>).additionalProperties).toBe(false);
  });

  test("vision: images as image_url data URLs", async () => {
    const calls: Call[] = [];
    const fetchFn = mockFetch({ "/v1/chat/completions": () => completion(JSON.stringify(LLM_ANSWER)) }, calls);
    await extractFields({ baseUrl: BASE, apiKey: KEY, model: "m", text: "", images: ["aW1n"], fetchFn });
    const content = (calls[0]!.body!.messages as { content: { type: string; image_url?: { url: string } }[] }[])[1]!.content;
    expect(content[0]!.type).toBe("text");
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } });
  });

  test("server without projector → German vision hint", async () => {
    const fetchFn = mockFetch({
      "/v1/chat/completions": () =>
        json({ error: { code: 500, message: "image input is not supported - hint: if this is unexpected, you may need to provide the mmproj" } }, 500),
    });
    await expect(extractFields({ baseUrl: BASE, apiKey: KEY, model: "m", text: "", images: ["aW1n"], fetchFn })).rejects.toThrow(
      "Das Modell kann keine Bilder lesen",
    );
  });

  test("server gone / error / invalid JSON → German LlmError", async () => {
    await expect(extractFields({ baseUrl: BASE, apiKey: KEY, model: "m", text: TEXT, fetchFn: mockFetch({}) })).rejects.toMatchObject({
      kind: "unreachable",
      message: "llama-server nicht erreichbar (abgestürzt?)",
    });
    const failing = mockFetch({ "/v1/chat/completions": () => json({ error: { message: "context overflow" } }, 400) });
    await expect(extractFields({ baseUrl: BASE, apiKey: KEY, model: "m", text: TEXT, fetchFn: failing })).rejects.toThrow("Modell-Fehler: context overflow");
    const garbage = mockFetch({ "/v1/chat/completions": () => completion("{ abgeschnitten", "length") });
    await expect(extractFields({ baseUrl: BASE, apiKey: KEY, model: "m", text: TEXT, fetchFn: garbage })).rejects.toThrow(
      "Modell lieferte kein gültiges JSON (Antwort abgeschnitten",
    );
  });
});
