import { describe, expect, test } from "bun:test";
import { CASES } from "./chat-eval.cases";
import {
  type CaseResult,
  containsSubset,
  type EvalCase,
  formatFailures,
  formatTable,
  guardHits,
  judge,
  matchesFilter,
  parseSse,
  parseStepLine,
  totals,
  type TurnRecord,
} from "./chat-eval";

// The eval's pure parts with fake turns (the runner itself needs the real model: bun run eval:chat).

const turn = (o: Partial<TurnRecord> = {}): TurnRecord => ({ calls: [], results: [], confirm: null, answer: "", error: null, ...o });
const result = (name: string, o: Partial<TurnRecord["results"][number]> = {}) => ({ name, ok: true, status: "done", summary: "ok", content: "", action: null, card: null, ...o });
const kase = (expect: EvalCase["expect"], tags = ["x"]): EvalCase => ({ id: "c", turns: [{ text: "?" }], expect, tags, description: "" });

describe("eval: parsing", () => {
  test("SSE data lines and server log step lines", () => {
    expect(parseSse(': ping\n\nevent: delta\ndata: {"type":"delta","text":"a"}\n\ndata: {broken\n\ndata: {"type":"done"}\n')).toEqual([{ type: "delta", text: "a" }, { type: "done" }]);
    expect(parseStepLine("[chat] conv 3 step 1: 21 tools (core+ui+documents), prompt 10154 tok, first token 5909 ms, total 6769 ms, server start 762 ms")).toEqual({
      tools: 21,
      groups: "core+ui+documents",
      promptTokens: 10154,
      firstTokenMs: 5909,
      totalMs: 6769,
      serverStartMs: 762,
    });
    expect(parseStepLine("[chat] conv 3 step 2: 22 tools (core+ui +read), prompt ? tok, first token 90 ms, total 400 ms")).toMatchObject({ groups: "core+ui +read", promptTokens: null, serverStartMs: null });
    expect(parseStepLine("[chat] conv 3: nudged search → open_in_app")).toBeNull();
  });

  test("guard hits from the log and from tool results", () => {
    const lines = [
      "[chat] conv 1: forced tool call answered with text – retrying once",
      "[chat] conv 1: nudged search → open_in_app",
      "[chat] conv 1: match_bank_transaction with ids not looked up – rejected",
    ];
    const t = turn({ results: [result("download_pdf", { ok: false, status: "error", summary: "Anderer Datensatz als auf der Seite gemeint" })] });
    expect(guardHits(lines, t)).toEqual(["forced retry", "nudge", "provenance", "context"]);
  });
});

describe("eval: judging", () => {
  test("subset matching for confirm and call arguments", () => {
    expect(containsSubset({ id: 1, targets: [{ kind: "invoice", id: 1 }] }, { id: 1, targets: [{ id: 1 }] })).toBe(true);
    expect(containsSubset({ id: 1, targets: [{ id: 2 }] }, { targets: [{ id: 1 }] })).toBe(false);
    expect(containsSubset({ items: [{ quantity: "3", unitPrice: "120,00" }] }, { items: [{ quantity: 3, unitPrice: 120 }] })).toBe(true);
  });

  test("tools, forbidden tools, facts → pass / partial / fail", () => {
    const c = kase({ tools: ["search", "get_document"], ordered: true, forbidden: ["finalize_document"], facts: ["1.140,00", /alpen/i] });
    const calls = [{ name: "search", arguments: {} }, { name: "get_document", arguments: { id: 1 } }];
    expect(judge(c, turn({ calls, answer: "Alpen schuldet € 1.140,00" }))).toEqual({ verdict: "pass", notes: [] });
    expect(judge(c, turn({ calls, answer: "Alpen schuldet etwas" }))).toEqual({ verdict: "partial", notes: ["answer lacks „1.140,00“"] });
    expect(judge(c, turn({ calls: [...calls].reverse(), answer: "Alpen 1.140,00" })).verdict).toBe("fail");
    expect(judge(c, turn({ calls: [calls[0]!], answer: "" })).notes[0]).toBe("missing tools: get_document");
    expect(judge(c, turn({ calls: [...calls, { name: "finalize_document", arguments: {} }], answer: "Alpen 1.140,00" })).notes).toEqual(["forbidden tools: finalize_document"]);
    // a no-break space in amounts (formatCents) still matches
    expect(judge(kase({ facts: ["€ 600,00"] }), turn({ answer: "€ 600,00" })).verdict).toBe("pass");
  });

  test("facts derived from tool results", () => {
    const fromDash = (t: TurnRecord) => /Okt (?:-?€ [\d.,]+) \/ €? ?([\d.,]+)/.exec(t.results[0]?.content ?? "")?.[1] ?? null;
    const c = kase({ facts: [fromDash] });
    const dash = result("get_dashboard", { content: "Monate: Okt -€ 120,00 / € 176,66 / -€ 296,66" });
    expect(judge(c, turn({ results: [dash], answer: "Ausgaben € 176,66" })).verdict).toBe("pass");
    expect(judge(c, turn({ results: [], answer: "x" })).notes).toEqual(["answer lacks fact source missing in the tool results"]);
  });

  test("actions: right target, wrong kind on the same record = partial, other record = fail, none expected", () => {
    const c = kase({ action: { kind: "download", url: "/api/pdf/documents/4?download=1", fileName: "Entwurf-4.pdf" } });
    const act = (action: any) => turn({ results: [result("x", { action })] });
    expect(judge(c, act({ kind: "download", url: "/api/pdf/documents/4?download=1", fileName: "Entwurf-4.pdf" })).verdict).toBe("pass");
    expect(judge(c, act({ kind: "open_tab", url: "/api/pdf/documents/4" }))).toEqual({ verdict: "partial", notes: ["action open_tab instead of download"] });
    expect(judge(c, act({ kind: "download", url: "/api/pdf/documents/1?download=1", fileName: "RE-1.pdf" })).verdict).toBe("fail");
    expect(judge(c, turn()).notes).toEqual(["no download action"]);
    expect(judge(kase({ action: "none" }), act({ kind: "navigate", path: "/invoices/1" })).verdict).toBe("fail");
    expect(judge(kase({ action: "none" }), turn({ answer: "Welche?" })).verdict).toBe("pass");
  });

  test("confirms: tool, argument subset, exact arguments, lookup first", () => {
    const c = kase({ confirm: { tool: "update_client", args: { id: 1, email: "office@alpen.at" }, exact: true } });
    const confirm = (args: Record<string, unknown>) => ({ name: "update_client", arguments: args, summary: "" });
    const looked = [{ name: "search", arguments: {} }, { name: "update_client", arguments: {} }];
    expect(judge(c, turn({ calls: looked, confirm: confirm({ id: 1, email: "office@alpen.at" }) })).verdict).toBe("pass");
    expect(judge(c, turn({ calls: looked, confirm: confirm({ id: 1, email: "office@alpen.at", city: "Wien" }) })).notes[0]).toMatch(/^extra confirm args/);
    expect(judge(c, turn({ calls: looked, confirm: confirm({ id: 2, email: "office@alpen.at" }) })).verdict).toBe("partial");
    expect(judge(c, turn({ calls: [{ name: "update_client", arguments: {} }], confirm: confirm({ id: 1, email: "office@alpen.at" }) })).notes).toEqual(["ids not looked up before the confirm"]);
    // a lookup in an earlier turn of the case counts
    expect(judge(c, turn({ calls: [{ name: "update_client", arguments: {} }], confirm: confirm({ id: 1, email: "office@alpen.at" }) }), ["list_clients"]).verdict).toBe("pass");
    expect(judge(c, turn({ calls: looked })).notes).toEqual(["no confirm (update_client expected)"]);
    expect(judge(kase({ confirm: false }), turn({ confirm: confirm({}) })).verdict).toBe("fail");
  });
});

describe("eval: output", () => {
  const row = (o: Partial<CaseResult>): CaseResult => ({
    id: "c",
    run: 1,
    tags: [],
    verdict: "pass",
    notes: [],
    toolPath: ["search"],
    guards: [],
    promptTokens: 8000,
    firstTokenMs: 500,
    modelCalls: 2,
    turnMs: 3000,
    answer: "ok",
    confirm: null,
    ...o,
  });

  test("table, totals, failures", () => {
    const rows = [
      row({ id: "a", turnMs: 2000 }),
      row({ id: "b", verdict: "partial", notes: ["answer lacks „432,00“"], turnMs: 4000, guards: ["nudge"] }),
      row({ id: "c", verdict: "fail", notes: ["no confirm"], turnMs: 10000, toolPath: [], promptTokens: null, firstTokenMs: null, answer: "Ich frage nach." }),
    ];
    const table = formatTable(rows).split("\n");
    expect(table[0]).toBe("case  run  result  calls  tools   guards  prompt tok  1st token s  turn s");
    expect(table[3]).toBe("b     1    PART    2      search  nudge   8000        0.5          4.0");
    expect(table[4]).toBe("c     1    FAIL    2      –       –       –           –            10.0");
    expect(totals(rows)).toMatchObject({ runs: 3, pass: 1, partial: 1, fail: 1, passRate: 33.3, weighted: 50, turnMedianMs: 4000, turnP90Ms: 10000, guards: { nudge: 1 } });
    expect(formatFailures(rows)).toBe("PART b #1: answer lacks „432,00“\n  tools: search\n  answer: ok\nFAIL c #1: no confirm\n  tools: –\n  answer: Ich frage nach.");
  });

  test("the case set: unique ids, a filter by id or tag, every case has an expectation", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    for (const c of CASES) expect(Object.keys(c.expect).length).toBeGreaterThan(0);
    expect(CASES.filter((c) => matchesFilter(c, "confirm")).map((c) => c.id)).toEqual(["bank-match", "update-client", "expense-paid", "reminder"]);
    expect(CASES.filter((c) => matchesFilter(c, "draft,nav")).length).toBe(6);
  });
});
