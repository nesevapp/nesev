// Assistant eval (bun run eval:chat): the pure parts. Case and turn types, SSE and server-log parsing, judging a
// turn against its case, the result table and totals. No process, network or DB access here (unit-tested in
// chat-eval.test.ts); the runner is run.ts, the cases are chat-eval.cases.ts.

export type Verdict = "pass" | "partial" | "fail";

/** what the eval sees of one turn (the last one of a case) */
export interface TurnRecord {
  calls: { name: string; arguments: Record<string, unknown> }[];
  results: { name: string; ok: boolean; status: string; summary: string; content: string; action: UiAction | null; card: string | null }[];
  /** the pending confirmation at the end of the turn (it is rejected afterwards) */
  confirm: { name: string; arguments: Record<string, unknown>; summary: string } | null;
  answer: string;
  error: string | null;
}

export type UiAction = { kind: "navigate"; path: string } | { kind: "download"; url: string; fileName: string } | { kind: "open_tab"; url: string };

/** a fact the answer must contain: text, a pattern, or one derived from the turn (e.g. a figure from a tool result) */
export type Fact = string | RegExp | ((t: TurnRecord) => string | RegExp | null);

export interface Expectation {
  /** tools that must have been called (any order unless `ordered`) */
  tools?: string[];
  ordered?: boolean;
  /** at least one of these */
  anyTool?: string[];
  forbidden?: string[];
  /** successful calls whose arguments must contain this subset */
  callArgs?: { tool: string; args: Record<string, unknown> }[];
  /** the UI action of the turn; "none" = no action at all */
  action?: "none" | { kind: UiAction["kind"]; path?: string; url?: string; fileName?: string };
  /** a confirmation is expected (always rejected) – the tool and a subset of its arguments; false = none allowed */
  confirm?: false | { tool: string; args?: Record<string, unknown>; exact?: boolean };
  /** the answer must contain these (missing → partial) */
  facts?: Fact[];
  /** the answer must not contain these (e.g. an invented draft number → partial) */
  notInAnswer?: RegExp[];
}

export interface EvalTurn {
  text: string;
  contextPath?: string;
  contextTitle?: string;
}

export interface EvalCase {
  id: string;
  /** one or more user messages; the expectation applies to the last turn */
  turns: EvalTurn[];
  expect: Expectation;
  tags: string[];
  /** human summary of the expectation for the table/report */
  description: string;
}

// --- SSE and server log -------------------------------------------------------------------------------------------

/** `data:` lines of a text/event-stream → parsed events (comment/ping lines are ignored) */
export function parseSse(text: string): any[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l.slice(5))];
      } catch {
        return [];
      }
    });
}

export interface StepStat {
  tools: number;
  groups: string;
  promptTokens: number | null;
  firstTokenMs: number;
  totalMs: number;
  serverStartMs: number | null;
}

/** "[chat] conv 3 step 1: 21 tools (core+ui+documents), prompt 10154 tok, first token 590 ms, total 1400 ms[, server start 760 ms]" */
export function parseStepLine(line: string): StepStat | null {
  const m = /step \d+: (\d+) tools \(([^)]*)\), prompt (\S+) tok, first token (\d+) ms, total (\d+) ms(?:.*server start (\d+) ms)?/.exec(line);
  if (!m) return null;
  return {
    tools: Number(m[1]),
    groups: m[2]!,
    promptTokens: m[3] === "?" ? null : Number(m[3]),
    firstTokenMs: Number(m[4]),
    totalMs: Number(m[5]),
    serverStartMs: m[6] ? Number(m[6]) : null,
  };
}

/** guard interventions visible in the server log */
const LOG_GUARDS: [RegExp, string][] = [
  [/forced tool call answered with text/, "forced retry"],
  [/not looked up – rejected/, "provenance"],
  [/nudged (\S+) → (\S+)/, "nudge"],
  [/claim-guard .*retrying once/, "claim retry"],
  [/claim-guard .*fixed reply/, "claim reply"],
  [/offer-nudge /, "offer nudge"],
  [/repetition loop cut/, "repetition"],
];
/** guard interventions visible as tool results */
const RESULT_GUARDS: [RegExp, string][] = [
  [/^Anderer Datensatz als auf der Seite gemeint/, "context"],
  [/^Wiederholter fehlerhafter Aufruf/, "repeated call"],
];

export function guardHits(logLines: string[], turn: TurnRecord): string[] {
  const hits: string[] = [];
  for (const l of logLines) for (const [re, name] of LOG_GUARDS) if (re.test(l)) hits.push(name);
  for (const r of turn.results) for (const [re, name] of RESULT_GUARDS) if (re.test(r.summary)) hits.push(name);
  return hits;
}

// --- judging ------------------------------------------------------------------------------------------------------

const norm = (s: string) => s.replace(/ /g, " ");

/** a ⊇ b for plain values, objects (keys of b) and arrays (every element of b matches some element of a) */
export function containsSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e) => actual.some((a) => containsSubset(a, e)));
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => containsSubset((actual as Record<string, unknown>)[k], v));
  }
  if (typeof expected === "number" && typeof actual === "string") return Number(actual.replace(",", ".")) === expected;
  return actual === expected;
}

function factHolds(answer: string, fact: Fact, turn: TurnRecord): [boolean, string] {
  const f = typeof fact === "function" ? fact(turn) : fact;
  if (f === null) return [false, "fact source missing in the tool results"];
  return typeof f === "string" ? [answer.includes(f), `„${f}“`] : [f.test(answer), String(f)];
}

const LOOKUP = /^(search|list_|get_)/;

export interface Judgement {
  verdict: Verdict;
  /** why it isn't a pass */
  notes: string[];
}

/** Judges the last turn of a case: fail = wrong path/action/confirm, partial = right path but facts or details off. */
export function judge(c: EvalCase, t: TurnRecord, earlierCalls: string[] = []): Judgement {
  const e = c.expect;
  const fails: string[] = [];
  const partials: string[] = [];
  const called = t.calls.map((x) => x.name);
  const answer = norm(t.answer);

  if (t.error) fails.push(`error: ${t.error}`);
  if (e.tools?.length) {
    const missing = e.tools.filter((n) => !called.includes(n));
    if (missing.length) fails.push(`missing tools: ${missing.join(", ")}`);
    else if (e.ordered) {
      let at = -1;
      for (const n of e.tools) {
        const i = called.indexOf(n, at + 1);
        if (i < 0) {
          fails.push(`tools out of order: ${called.join(" → ")}`);
          break;
        }
        at = i;
      }
    }
  }
  if (e.anyTool?.length && !e.anyTool.some((n) => called.includes(n))) fails.push(`none of: ${e.anyTool.join(", ")}`);
  const forbidden = (e.forbidden ?? []).filter((n) => called.includes(n));
  if (forbidden.length) fails.push(`forbidden tools: ${forbidden.join(", ")}`);
  for (const ca of e.callArgs ?? []) {
    const ok = t.calls.some((x) => x.name === ca.tool && containsSubset(x.arguments, ca.args) && t.results.some((r) => r.name === ca.tool && r.ok));
    if (!ok) (called.includes(ca.tool) ? partials : fails).push(`${ca.tool} without ${JSON.stringify(ca.args)}`);
  }

  const action = t.results.map((r) => r.action).find(Boolean) ?? null;
  if (e.action === "none") {
    if (action) fails.push(`unexpected action ${JSON.stringify(action)}`);
  } else if (e.action) {
    const want = e.action;
    const got = action as Record<string, unknown> | null;
    if (!got) fails.push(`no ${want.kind} action`);
    else {
      const same = (k: "path" | "url" | "fileName") => want[k] === undefined || got[k] === want[k];
      if (got.kind !== want.kind) {
        // the right record, the wrong way (open vs. download) is a partial
        const sameTarget = typeof got.url === "string" && want.url && got.url.split("?")[0] === want.url.split("?")[0];
        (sameTarget ? partials : fails).push(`action ${String(got.kind)} instead of ${want.kind}`);
      } else if (!same("path") || !same("url") || !same("fileName")) fails.push(`action target ${JSON.stringify(got)}`);
    }
  }

  if (e.confirm === false && t.confirm) fails.push(`unexpected confirm ${t.confirm.name}`);
  else if (e.confirm) {
    if (!t.confirm) fails.push(`no confirm (${e.confirm.tool} expected)`);
    else if (t.confirm.name !== e.confirm.tool) fails.push(`confirm ${t.confirm.name} instead of ${e.confirm.tool}`);
    else {
      if (e.confirm.args && !containsSubset(t.confirm.arguments, e.confirm.args)) partials.push(`confirm args ${JSON.stringify(t.confirm.arguments)}`);
      else if (e.confirm.exact && e.confirm.args && Object.keys(t.confirm.arguments).length !== Object.keys(e.confirm.args).length) {
        partials.push(`extra confirm args ${JSON.stringify(t.confirm.arguments)}`);
      }
      if (![...earlierCalls, ...called.slice(0, -1)].some((n) => LOOKUP.test(n))) partials.push("ids not looked up before the confirm");
    }
  }

  for (const fact of e.facts ?? []) {
    const [ok, label] = factHolds(answer, fact, t);
    if (!ok) partials.push(`answer lacks ${label}`);
  }
  for (const re of e.notInAnswer ?? []) if (re.test(answer)) partials.push(`answer contains ${re}`);

  if (fails.length) return { verdict: "fail", notes: [...fails, ...partials] };
  if (partials.length) return { verdict: "partial", notes: partials };
  return { verdict: "pass", notes: [] };
}

// --- results ------------------------------------------------------------------------------------------------------

export interface CaseResult {
  id: string;
  run: number;
  tags: string[];
  verdict: Verdict;
  notes: string[];
  toolPath: string[];
  guards: string[];
  /** max prompt tokens of the last turn's model calls */
  promptTokens: number | null;
  /** first model call of the last turn */
  firstTokenMs: number | null;
  modelCalls: number;
  turnMs: number;
  answer: string;
  confirm: TurnRecord["confirm"];
}

const sec = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(1));
const SYMBOL: Record<Verdict, string> = { pass: "pass", partial: "PART", fail: "FAIL" };

export function quantile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** plain-text table, one row per case run */
export function formatTable(rows: CaseResult[]): string {
  const head = ["case", "run", "result", "calls", "tools", "guards", "prompt tok", "1st token s", "turn s"];
  const body = rows.map((r) => [
    r.id,
    String(r.run),
    SYMBOL[r.verdict],
    String(r.modelCalls),
    r.toolPath.join(" → ") || "–",
    r.guards.join(", ") || "–",
    r.promptTokens === null ? "–" : String(r.promptTokens),
    sec(r.firstTokenMs),
    sec(r.turnMs),
  ]);
  const widths = head.map((h, i) => Math.min(i === 4 ? 60 : 40, Math.max(h.length, ...body.map((b) => b[i]!.length))));
  const cell = (s: string, i: number) => (s.length > widths[i]! ? `${s.slice(0, widths[i]! - 1)}…` : s.padEnd(widths[i]!));
  return [head, head.map((_, i) => "-".repeat(widths[i]!)), ...body].map((r) => r.map(cell).join("  ").trimEnd()).join("\n");
}

export interface Totals {
  runs: number;
  pass: number;
  partial: number;
  fail: number;
  /** pass / runs in % */
  passRate: number;
  /** (pass + partial / 2) / runs in % */
  weighted: number;
  turnMedianMs: number | null;
  turnP90Ms: number | null;
  firstTokenMedianMs: number | null;
  guards: Record<string, number>;
}

export function totals(rows: CaseResult[]): Totals {
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const n = rows.length || 1;
  const turns = rows.map((r) => r.turnMs);
  const guards: Record<string, number> = {};
  for (const g of rows.flatMap((r) => r.guards)) guards[g] = (guards[g] ?? 0) + 1;
  return {
    runs: rows.length,
    pass: count("pass"),
    partial: count("partial"),
    fail: count("fail"),
    passRate: Math.round((count("pass") / n) * 1000) / 10,
    weighted: Math.round(((count("pass") + count("partial") / 2) / n) * 1000) / 10,
    turnMedianMs: quantile(turns, 50),
    turnP90Ms: quantile(turns, 90),
    firstTokenMedianMs: quantile(rows.flatMap((r) => (r.firstTokenMs === null ? [] : [r.firstTokenMs])), 50),
    guards,
  };
}

export function formatTotals(t: Totals): string {
  const guards = Object.entries(t.guards).map(([k, v]) => `${k} ×${v}`).join(", ") || "none";
  return [
    `pass ${t.pass} · partial ${t.partial} · fail ${t.fail} of ${t.runs} → pass rate ${t.passRate} % (weighted ${t.weighted} %)`,
    `turn time median ${sec(t.turnMedianMs)} s · p90 ${sec(t.turnP90Ms)} s · first token median ${sec(t.firstTokenMedianMs)} s`,
    `guard hits: ${guards}`,
  ].join("\n");
}

/** failed and partial runs with their reasons and the answer */
export function formatFailures(rows: CaseResult[]): string {
  const bad = rows.filter((r) => r.verdict !== "pass");
  if (!bad.length) return "all passed";
  return bad
    .map((r) => {
      const answer = r.answer.replace(/\s+/g, " ").trim();
      return `${r.verdict === "fail" ? "FAIL" : "PART"} ${r.id} #${r.run}: ${r.notes.join("; ")}\n  tools: ${r.toolPath.join(" → ") || "–"}${r.confirm ? `\n  confirm: ${r.confirm.summary}` : ""}\n  answer: ${answer.length > 300 ? `${answer.slice(0, 299)}…` : answer || "(none)"}`;
    })
    .join("\n");
}

/** --filter: a case id or a tag */
export const matchesFilter = (c: EvalCase, filter: string | undefined) => !filter || filter.split(",").some((f) => c.id === f || c.tags.includes(f));
