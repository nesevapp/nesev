// nesev as a macOS background service (launchd LaunchAgent): starts at login, restarts when it exits.
//
//   bun run service:install [--port 3998] [--dry-run] [--skip-build]
//   bun run service:uninstall [--dry-run]
//   bun run service:status
//
// install builds the SPA (`bun run build`), writes ~/Library/LaunchAgents/at.nesev.plist running the production
// server (NODE_ENV=production bun src/server/index.ts = `bun start`) from this repo, and loads it via launchctl.
// Logs go to ~/Library/Logs/nesev/. NESEV_DATA_DIR, if set at install time, is passed on to the service.
// --dry-run writes the plist to a temp dir, checks it with `plutil -lint` and changes nothing else.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LABEL = "at.nesev";
export const DEFAULT_PORT = 3998;
const ROOT = resolve(import.meta.dir, "..");
const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(homedir(), "Library/Logs/nesev");
const domain = () => `gui/${userInfo().uid}`;

export interface PlistOptions {
  bunPath: string;
  root: string;
  port: number;
  logDir: string;
  path: string;
  dataDir?: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildPlist(o: PlistOptions): string {
  const env: Record<string, string> = { NODE_ENV: "production", PORT: String(o.port), PATH: o.path };
  if (o.dataDir) env.NESEV_DATA_DIR = o.dataDir;
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.bunPath)}</string>
    <string>src/server/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(join(o.logDir, "nesev.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(o.logDir, "nesev.err.log"))}</string>
</dict>
</plist>
`;
}

/** PATH for the service: bun's directory, Homebrew (llama-server, pdftoppm) and the system dirs. */
export function servicePath(bunPath: string): string {
  const dirs = [dirname(bunPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const flag = (name: string) => argv.includes(name);
  const portIdx = argv.indexOf("--port");
  const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Ungültiger Port: ${argv[portIdx + 1] ?? process.env.PORT}`);
  return { command: argv[0], port, dryRun: flag("--dry-run"), skipBuild: flag("--skip-build") };
}

const isLoaded = () => run("launchctl", ["print", `${domain()}/${LABEL}`], { quiet: true }).ok;

function install(o: { port: number; dryRun: boolean; skipBuild: boolean }) {
  const bunPath = process.execPath;
  const target = o.dryRun ? join(mkdtempSync(join(tmpdir(), "nesev-service-")), `${LABEL}.plist`) : PLIST_PATH;
  const plist = buildPlist({
    bunPath,
    root: ROOT,
    port: o.port,
    logDir: LOG_DIR,
    path: servicePath(bunPath),
    dataDir: process.env.NESEV_DATA_DIR ? resolve(process.env.NESEV_DATA_DIR) : undefined,
  });

  if (o.dryRun) {
    writeFileSync(target, plist);
    const lint = run("plutil", ["-lint", target], { quiet: true });
    console.log(plist);
    console.log(lint.out.trim());
    console.log(`\nDry run: nichts gebaut, nichts geladen. Würde ausführen:\n  bun run build\n  launchctl bootstrap ${domain()} ${PLIST_PATH}`);
    if (!lint.ok) process.exit(1);
    return;
  }

  if (!o.skipBuild) {
    console.log("Baue die Web-App (bun run build) …");
    if (!run(bunPath, ["run", "build"], { cwd: ROOT }).ok) fail("Build fehlgeschlagen – Dienst nicht installiert.");
  } else if (!existsSync(join(ROOT, "dist/web/index.html"))) {
    fail("dist/web fehlt – ohne --skip-build installieren.");
  }

  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  // replace a running instance (bootstrap fails while the label is loaded)
  if (isLoaded()) run("launchctl", ["bootout", `${domain()}/${LABEL}`], { quiet: true });
  writeFileSync(PLIST_PATH, plist);
  const lint = run("plutil", ["-lint", PLIST_PATH], { quiet: true });
  if (!lint.ok) fail(lint.out);
  const boot = run("launchctl", ["bootstrap", domain(), PLIST_PATH], { quiet: true });
  if (!boot.ok) fail(`launchctl bootstrap fehlgeschlagen:\n${boot.out}`);
  console.log(`Installiert: ${PLIST_PATH}\nnesev läuft auf http://localhost:${o.port} (Logs: ${LOG_DIR})`);
}

function uninstall(o: { dryRun: boolean }) {
  if (o.dryRun) {
    console.log(`Dry run: würde ausführen:\n  launchctl bootout ${domain()}/${LABEL}\n  rm ${PLIST_PATH}`);
    return;
  }
  if (isLoaded()) {
    const r = run("launchctl", ["bootout", `${domain()}/${LABEL}`], { quiet: true });
    if (!r.ok) fail(`launchctl bootout fehlgeschlagen:\n${r.out}`);
  }
  if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH);
  console.log("Dienst entfernt (Logs bleiben in " + LOG_DIR + ").");
}

async function status() {
  if (!existsSync(PLIST_PATH)) {
    console.log("Nicht installiert (bun run service:install).");
    return;
  }
  const r = run("launchctl", ["print", `${domain()}/${LABEL}`], { quiet: true });
  if (!r.ok) {
    console.log(`Installiert (${PLIST_PATH}), aber nicht geladen.`);
    return;
  }
  const field = (name: string) => r.out.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1];
  const port = r.out.match(/PORT => (\d+)/)?.[1] ?? String(DEFAULT_PORT);
  console.log(`Geladen: ${LABEL}\n  Zustand: ${field("state") ?? "?"}\n  PID: ${field("pid") ?? "–"}\n  Letzter Exit: ${field("last exit code") ?? "–"}`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, { signal: AbortSignal.timeout(3000) });
    console.log(`  http://localhost:${port}: ${res.ok ? "antwortet" : `HTTP ${res.status}`}`);
  } catch {
    console.log(`  http://localhost:${port}: keine Antwort`);
  }
  console.log(`  Logs: ${LOG_DIR}`);
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") fail("launchd gibt es nur unter macOS.");
  if (args.command === "install") install(args);
  else if (args.command === "uninstall") uninstall(args);
  else if (args.command === "status") await status();
  else fail("Verwendung: bun scripts/service.ts install|uninstall|status [--port N] [--dry-run] [--skip-build]");
}
