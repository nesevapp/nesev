// Try nesev without your own data: a demo data dir seeded with a fictional sole trader, served by the production
// server.
//
//   bun run demo                  # seeds demo-data/ if it's missing, builds the SPA if needed, serves on :3999
//   bun run demo -- --reset       # deletes demo-data/ and seeds it again (dates are relative to the seed day)
//   bun run demo -- --port 4100
//
// The demo data (scripts/demo-seed.ts) lives in demo-data/ in the repo (gitignored), never in data/. The server
// listens on 127.0.0.1 only, unless NESEV_HOST is set. Ctrl-C stops it.

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_DEMO_PORT = 3999;
const ROOT = resolve(import.meta.dir, "..");
const DEMO_DIR = join(ROOT, "demo-data");
const DIST_INDEX = join(ROOT, "dist/web/index.html");
/** what the SPA build depends on */
const BUILD_INPUTS = ["src/web", "src/shared", "vite.config.ts", "package.json", "bun.lock", "tsconfig.json"];

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    reset: { type: "boolean", default: false },
    port: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log("bun run demo [-- --reset] [-- --port 3999]");
  process.exit(0);
}

const port = Number(flags.port ?? process.env.DEMO_PORT ?? DEFAULT_DEMO_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Ungültiger Port: ${flags.port}`);
  process.exit(2);
}

/** newest mtime of a file or directory tree */
function newestMtime(path: string): number {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    newest = Math.max(newest, newestMtime(join(path, e.name)));
  }
  return newest;
}

function run(cmd: string[], env: Record<string, string> = {}, stdout: "inherit" | "ignore" = "inherit") {
  const res = Bun.spawnSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout, stderr: "inherit" });
  if (res.exitCode !== 0) {
    console.error(`\n${cmd.join(" ")} ist fehlgeschlagen (Code ${res.exitCode}).`);
    process.exit(1);
  }
}

// 1. demo data
const MARKER = join(DEMO_DIR, ".demo-seeded");
if (flags.reset) rmSync(DEMO_DIR, { recursive: true, force: true });
if (!existsSync(join(DEMO_DIR, "nesev.db")) || !existsSync(MARKER)) {
  rmSync(DEMO_DIR, { recursive: true, force: true }); // a half-seeded dir from an aborted run
  console.log("Lege Demodaten in demo-data/ an …");
  // NESEV_API_URL points nowhere: the seed must never reach a running nesev server
  run([process.execPath, "scripts/demo-seed.ts"], { NESEV_DATA_DIR: DEMO_DIR, NESEV_API_URL: "http://127.0.0.1:9" }, "ignore"); // stdout: the created ids
  writeFileSync(MARKER, `${new Date().toISOString().slice(0, 10)}\n`);
} else {
  const seeded = (await Bun.file(MARKER).text()).trim();
  console.log(`Demodaten vom ${seeded.split("-").reverse().join(".")} (neu anlegen: bun run demo -- --reset)`);
}

// 2. SPA build
const builtAt = existsSync(DIST_INDEX) ? statSync(DIST_INDEX).mtimeMs : 0;
if (Math.max(...BUILD_INPUTS.map((p) => newestMtime(join(ROOT, p)))) > builtAt) {
  console.log("Baue die Weboberfläche (dist/web) …");
  run([process.execPath, "run", "build"]);
}

// 3. production server on the demo data
const host = process.env.NESEV_HOST ?? "127.0.0.1";
const server = Bun.spawn([process.execPath, "src/server/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), NESEV_HOST: host, NESEV_DATA_DIR: DEMO_DIR, NESEV_API_URL: `http://127.0.0.1:${port}` },
  stdout: "inherit",
  stderr: "inherit",
});
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    server.kill("SIGTERM");
  });
}

const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
for (let i = 0; i < 100 && server.exitCode === null; i++) {
  if (await fetch(`${url}/api/settings`).then((r) => r.ok, () => false)) {
    console.log(`\nnesev-Demo läuft: ${url}\n(Beenden mit Ctrl-C)`);
    break;
  }
  await Bun.sleep(100);
}
const code = await server.exited;
process.exit(stopping ? 0 : code);
