// nesev from this checkout as a background service (macOS launchd LaunchAgent, Linux systemd user unit): starts at
// login, restarts when it exits. The release binary has the same as `nesev service …` (src/cli/service.ts).
//
//   bun run service:install [--port 3998] [--dry-run] [--skip-build]
//   bun run service:uninstall [--dry-run]
//   bun run service:status
//
// install builds the SPA (`bun run build`) and runs the production server (NODE_ENV=production bun
// src/server/index.ts = `bun start`) from this repo. Logs: ~/Library/Logs/nesev/ (macOS), journalctl --user -u nesev
// (Linux). NESEV_DATA_DIR, if set at install time, is passed on to the service.
// --dry-run writes the plist/unit to a temp dir (macOS: checks it with `plutil -lint`) and changes nothing else.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildPlist as buildServicePlist,
  checkoutServiceSpec,
  installService,
  installedServicePort,
  LABEL,
  serviceLocation,
  servicePath as programServicePath,
  serviceStatusLines,
  uninstallService,
} from "../src/cli/service";
import { DEFAULT_PORT } from "../src/server/lib/app-files";

export { DEFAULT_PORT, LABEL };

/** PATH for the service: bun's directory, Homebrew (llama-server, pdftoppm) and the system dirs. */
export const servicePath = (bunPath: string, platform = process.platform) => programServicePath(dirname(bunPath), platform);
const ROOT = resolve(import.meta.dir, "..");

export interface PlistOptions {
  bunPath: string;
  root: string;
  port: number;
  logDir: string;
  path: string;
  dataDir?: string;
}

export function buildPlist(o: PlistOptions): string {
  return buildServicePlist({ ...checkoutServiceSpec(o), logDir: o.logDir });
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

function install(o: { port: number; dryRun: boolean; skipBuild: boolean }) {
  const spec = checkoutServiceSpec({
    bunPath: process.execPath,
    root: ROOT,
    port: o.port,
    dataDir: process.env.NESEV_DATA_DIR ? resolve(process.env.NESEV_DATA_DIR) : undefined,
  });
  if (o.dryRun) {
    const r = installService(spec, { dryRun: true });
    console.log(r.content);
    console.log(`Dry run: ${r.file} geschrieben, nichts gebaut, nichts geladen. Würde ausführen:\n  bun run build\n  ${r.commands.join("\n  ")}`);
    return;
  }
  if (!o.skipBuild) {
    console.log("Baue die Web-App (bun run build) …");
    if (spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, stdio: "inherit" }).status !== 0) fail("Build fehlgeschlagen – Dienst nicht installiert.");
  } else if (!existsSync(join(ROOT, "dist/web/index.html"))) {
    fail("dist/web fehlt – ohne --skip-build installieren.");
  }
  const r = installService(spec);
  const logs = process.platform === "darwin" ? serviceLocation().logDir : "journalctl --user -u nesev";
  console.log(`Installiert: ${r.file}\nnesev läuft auf http://localhost:${o.port} (Logs: ${logs})`);
}

async function status() {
  for (const line of serviceStatusLines()) console.log(line);
  const port = installedServicePort();
  if (port === null) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`, { signal: AbortSignal.timeout(3000) });
    console.log(`  http://localhost:${port}: ${res.ok ? "antwortet" : `HTTP ${res.status}`}`);
  } catch {
    console.log(`  http://localhost:${port}: keine Antwort`);
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.command === "install") install(args);
    else if (args.command === "uninstall") {
      const commands = uninstallService({ dryRun: args.dryRun });
      console.log(args.dryRun ? `Dry run: würde ausführen:\n  ${commands.join("\n  ")}` : "Dienst entfernt.");
    } else if (args.command === "status") await status();
    else fail("Verwendung: bun scripts/service.ts install|uninstall|status [--port N] [--dry-run] [--skip-build]");
  } catch (err) {
    fail((err as Error).message);
  }
}
