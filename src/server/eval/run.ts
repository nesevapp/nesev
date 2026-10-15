import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PROJECT_ROOT } from "../lib/paths";
import { CASES } from "./chat-eval.cases";
import {
  type CaseResult,
  type EvalCase,
  formatFailures,
  formatTable,
  formatTotals,
  guardHits,
  judge,
  matchesFilter,
  parseSse,
  parseStepLine,
  totals,
  type TurnRecord,
} from "./chat-eval";

// bun run eval:chat – runs the assistant against the real local model on demo data and scores each case
// (chat-eval.cases.ts). Its own temp data dir (seeded once, restored from that copy whenever a case changed data),
// its own API on a free port with NESEV_API_URL pointing nowhere, its own llama-server (a child of that API).
// Everything it starts is stopped by PID, also on Ctrl-C and errors. Never touches data/ or ports 3998/5174.

const { values: flags } = parseArgs({
  options: {
    model: { type: "string", default: "auto" },
    runs: { type: "string", default: "1" },
    filter: { type: "string" },
    reasoning: { type: "boolean", default: false },
    context: { type: "string" },
    temperature: { type: "string" },
    json: { type: "string" },
    min: { type: "string" },
    timeout: { type: "string", default: "240" },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`bun run eval:chat [--model <gguf>|auto] [--runs N] [--filter <id|tag>[,…]] [--reasoning] [--context N] [--temperature T] [--json <file>] [--min <pass %>] [--timeout <s per turn>]`);
  process.exit(0);
}

const RESERVED_PORTS = new Set([3998, 5174, 3001, 5173]);
/** tools whose successful call changes the demo data: the next case gets a fresh copy */
const WRITES = /^(create_|update_|mark_|finalize_|convert_|match_|unmatch_|set_|generate_|apply_|link_|queue_)/;

const cases = CASES.filter((c) => matchesFilter(c, flags.filter));
if (!cases.length) {
  console.error(`No case matches --filter ${flags.filter}. Ids: ${CASES.map((c) => c.id).join(", ")}`);
  process.exit(2);
}
const runs = Math.max(1, Number(flags.runs) || 1);
const turnTimeoutMs = Math.max(30, Number(flags.timeout) || 240) * 1000;

// --- processes ----------------------------------------------------------------------------------------------------

const tempDirs: string[] = [];
let logOffset = 0;
let api: { proc: ReturnType<typeof Bun.spawn>; port: number; dir: string; log: string } | null = null;

function llamaChild(pid: number): number | null {
  const out = Bun.spawnSync(["pgrep", "-P", String(pid), "llama-server"]).stdout.toString().trim();
  return out ? Number(out.split("\n")[0]) : null;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopApi() {
  if (!api) return;
  const { proc } = api;
  api = null;
  const llama = llamaChild(proc.pid);
  proc.kill("SIGTERM"); // the API stops its llama-server on SIGTERM
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (alive(proc.pid) || (llama && alive(llama)))) await Bun.sleep(100);
  if (alive(proc.pid)) proc.kill("SIGKILL");
  if (llama && alive(llama)) process.kill(llama, "SIGKILL");
}

function cleanupSync() {
  if (api) {
    const llama = llamaChild(api.proc.pid);
    api.proc.kill("SIGKILL");
    if (llama && alive(llama)) process.kill(llama, "SIGKILL");
    api = null;
  }
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.error(`\n${sig}: stopping the eval's API and llama-server`);
    cleanupSync();
    process.exit(130);
  });
}
process.on("exit", cleanupSync);

async function freePort(): Promise<number> {
  for (;;) {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = s.port!;
    s.stop(true);
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

/** seeds a template data dir once (src/mcp/test/seed.ts refuses the real data dir) */
function seedTemplate(): string {
  const dir = mkdtempSync(join(tmpdir(), "nesev-eval-seed-"));
  tempDirs.push(dir);
  const res = Bun.spawnSync([process.execPath, "src/mcp/test/seed.ts"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NESEV_DATA_DIR: dir, NESEV_API_URL: "http://127.0.0.1:9" },
  });
  if (res.exitCode !== 0) throw new Error(`seed failed: ${res.stderr.toString()}`);
  return dir;
}

async function startApi(template: string) {
  await stopApi();
  const dir = mkdtempSync(join(tmpdir(), "nesev-eval-"));
  tempDirs.push(dir);
  cpSync(template, dir, { recursive: true });
  const port = await freePort();
  const log = join(dir, "api.log");
  const proc = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NESEV_DATA_DIR: dir,
      NESEV_API_URL: "http://127.0.0.1:9",
      PORT: String(port),
      NODE_ENV: "development",
      ...(flags.temperature ? { NESEV_CHAT_TEMPERATURE: flags.temperature } : {}),
    },
    stdout: Bun.file(log),
    stderr: "inherit",
  });
  api = { proc, port, dir, log };
  logOffset = 0;
  const base = `http://127.0.0.1:${port}/api/chat`;
  for (let i = 0; ; i++) {
    if (i > 100) throw new Error("API did not start");
    if (await fetch(`${base}/status`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(100);
  }
  const current = await (await fetch(`${base}/settings`)).json();
  const settings = {
    ...current,
    enabled: true,
    modelPath: flags.model === "auto" ? "" : flags.model,
    reasoning: flags.reasoning,
    ...(flags.context ? { contextSize: Number(flags.context) } : {}),
  };
  const put = await fetch(`${base}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
  if (!put.ok) throw new Error(`settings: ${await put.text()}`);
  const status = await (await fetch(`${base}/status`)).json();
  if (!status.ready) throw new Error(`model not ready: ${status.problem}`);
  return { base, model: status.model?.label as string };
}

// --- one case -------------------------------------------------------------------------------------------------------

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(turnTimeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return parseSse(await res.text());
}

function newLogLines(): string[] {
  if (!api) return [];
  const text = readFileSync(api.log, "utf8");
  const lines = text.slice(logOffset).split("\n").filter((l) => l.includes("[chat]"));
  logOffset = text.length;
  return lines;
}

async function runCase(base: string, c: EvalCase, run: number): Promise<{ result: CaseResult; dirty: boolean }> {
  const conv = (await (await fetch(`${base}/conversations`, { method: "POST" })).json()).id as number;
  const earlierCalls: string[] = [];
  let turn: TurnRecord | null = null;
  let lines: string[] = [];
  let turnMs = 0;
  let dirty = false;
  for (const [i, t] of c.turns.entries()) {
    newLogLines();
    const t0 = performance.now();
    let events: any[] = [];
    let error: string | null = null;
    try {
      events = await post(`${base}/conversations/${conv}/messages`, { text: t.text, ...(t.contextPath ? { context: { path: t.contextPath, title: t.contextTitle } } : {}) });
    } catch (err) {
      error = (err as Error).message;
    }
    turnMs = Math.round(performance.now() - t0);
    const detail = await (await fetch(`${base}/conversations/${conv}`)).json();
    const msgs = detail.messages.slice(detail.messages.findLastIndex((m: any) => m.role === "user") + 1);
    const record: TurnRecord = {
      calls: events.filter((e) => e.type === "tool_call").map((e) => e.toolCall),
      results: msgs
        .filter((m: any) => m.role === "tool")
        .map((m: any) => ({
          name: m.toolName,
          ok: !!m.toolResult?.ok,
          status: m.status,
          summary: m.toolResult?.summary ?? m.content,
          content: m.content,
          action: m.toolResult?.action ?? null,
          card: m.toolResult?.card?.kind ?? null,
        })),
      confirm: detail.pending ? { name: detail.pending.toolCall.name, arguments: detail.pending.toolCall.arguments, summary: detail.pending.summary } : null,
      answer: msgs.filter((m: any) => m.role === "assistant" && m.content).map((m: any) => m.content).join("\n"),
      error: error ?? events.find((e) => e.type === "error")?.message ?? null,
    };
    if (record.results.some((r) => r.status === "done" && WRITES.test(r.name))) dirty = true;
    lines = newLogLines();
    if (detail.pending) {
      await post(`${base}/conversations/${conv}/confirm`, { messageId: detail.pending.messageId, approve: false }).catch(() => []);
      newLogLines();
    }
    if (i < c.turns.length - 1) earlierCalls.push(...record.calls.map((x) => x.name));
    turn = record;
  }
  const t = turn!;
  const steps = lines.map(parseStepLine).filter((s) => s !== null);
  const j = judge(c, t, earlierCalls);
  const prompts = steps.flatMap((s) => (s.promptTokens === null ? [] : [s.promptTokens]));
  return {
    dirty,
    result: {
      id: c.id,
      run,
      tags: c.tags,
      verdict: j.verdict,
      notes: j.notes,
      toolPath: t.calls.map((x) => x.name),
      guards: guardHits(lines, t),
      promptTokens: prompts.length ? Math.max(...prompts) : null,
      firstTokenMs: steps[0]?.firstTokenMs ?? null,
      modelCalls: steps.length,
      turnMs,
      answer: t.answer,
      confirm: t.confirm,
    },
  };
}

// --- main -----------------------------------------------------------------------------------------------------------

const results: CaseResult[] = [];
let exitCode = 0;
try {
  console.log(`Seeding demo data …`);
  const template = seedTemplate();
  let { base, model } = await startApi(template);
  console.log(`Model ${model}${flags.reasoning ? " (reasoning on)" : ""}${flags.temperature ? `, temperature ${flags.temperature}` : ""}, ${cases.length} case(s) × ${runs} run(s), API :${api!.port}\n`);
  let dirty = false;
  for (let run = 1; run <= runs; run++) {
    for (const c of cases) {
      if (dirty) ({ base } = await startApi(template));
      const { result, dirty: changed } = await runCase(base, c, run);
      dirty = changed;
      results.push(result);
      const mark = result.verdict === "pass" ? "pass" : result.verdict === "partial" ? "PART" : "FAIL";
      console.log(`${mark}  ${c.id} #${run}  ${(result.turnMs / 1000).toFixed(1)} s  ${result.toolPath.join(" → ") || "–"}${result.notes.length ? `  (${result.notes.join("; ")})` : ""}`);
    }
  }
} catch (err) {
  console.error(`eval aborted: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  await stopApi();
}

if (results.length) {
  const t = totals(results);
  console.log(`\n${formatTable(results)}\n\n${formatTotals(t)}\n\n${formatFailures(results)}`);
  if (flags.json) {
    await Bun.write(flags.json, JSON.stringify({ model: flags.model, reasoning: flags.reasoning, context: flags.context ?? null, temperature: flags.temperature ?? null, date: new Date().toISOString(), totals: t, results }, null, 2));
    console.log(`\nJSON: ${flags.json}`);
  }
  if (flags.min && t.passRate < Number(flags.min)) {
    console.error(`\npass rate ${t.passRate} % < --min ${flags.min} %`);
    exitCode = exitCode || 1;
  }
}
cleanupSync();
process.exit(exitCode);
