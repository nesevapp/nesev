import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { binaryServiceSpec, installedServicePort, installService, isServiceInstalled, restartService, serviceLocation, serviceStatusLines, uninstallService } from "./service";
import { updateBinary } from "./update";
import { compareVersions, isCompiled, VERSION } from "./version";

// The `nesev` command (entry of the release binary via build/entry.ts, from source: `bun src/cli/main.ts`).
// Server modules are imported lazily: they read APP_ROOT/the data dir on import, and `nesev mcp` must install the
// stdout guard before anything else loads. Output is German (end users), kept short.

const DEFAULT_PORT = 3998;

const HELP = `nesev ${VERSION} – Rechnungen und Buchhaltung, lokal auf diesem Computer

Verwendung:
  nesev                    startet nesev und öffnet es im Browser (läuft es schon: nur den Browser)
  nesev start              startet nur den Server (so läuft der Hintergrunddienst)
  nesev service install    Hintergrunddienst einrichten: nesev startet mit der Anmeldung
  nesev service uninstall  Hintergrunddienst entfernen
  nesev service status     Zustand des Hintergrunddienstes
  nesev update [--check]   auf die neueste Version aktualisieren
  nesev mcp                MCP-Server (stdio) für KI-Assistenten wie Claude
  nesev uninstall          Dienst und Programm entfernen (deine Daten bleiben)
  nesev --version          Version anzeigen

Optionen: --port N (sonst PORT oder ${DEFAULT_PORT}), --dry-run (service, uninstall: nur anzeigen)
Mehr: https://github.com/nesevapp/nesev`;

class UsageError extends Error {}

/** --port, else PORT, else the installed service's port, else 3998 */
function parsePort(args: string[]): number {
  const i = args.indexOf("--port");
  const raw = i >= 0 ? args[i + 1] : process.env.PORT;
  const port = raw === undefined ? (installedServicePort() ?? DEFAULT_PORT) : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`Ungültiger Port: ${raw}`);
  return port;
}

const urlFor = (port: number) => `http://localhost:${port}`;

/** Is nesev (setup or app) answering on this port? "other" = something else holds the port. */
async function probe(port: number): Promise<"nesev" | "other" | "none"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json().catch(() => null)) as { configured?: unknown } | null;
    return body && typeof body.configured === "boolean" ? "nesev" : "other";
  } catch {
    return "none";
  }
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

async function startServer(port: number) {
  process.env.PORT = String(port);
  const state = await probe(port);
  if (state !== "none") {
    throw new Error(
      state === "nesev" ? `nesev läuft bereits auf ${urlFor(port)}.` : `Port ${port} ist schon belegt (anderes Programm). Anderer Port: --port N`,
    );
  }
  const { default: options } = await import("../server/index");
  Bun.serve(options);
}

async function open(port: number) {
  const url = urlFor(port);
  const state = await probe(port);
  if (state === "nesev") {
    console.log(`nesev läuft bereits: ${url}`);
    openBrowser(url);
    return;
  }
  await startServer(port);
  console.log(`\nnesev ist bereit: ${url}  (beenden mit Strg+C)`);
  openBrowser(url);
}

function service(sub: string | undefined, args: string[]) {
  const dryRun = args.includes("--dry-run");
  if (sub === "install") {
    if (!isCompiled()) throw new UsageError("Aus dem Quellcode: bun run service:install");
    const port = parsePort(args);
    const spec = binaryServiceSpec({ execPath: process.execPath, port, dataDir: process.env.NESEV_DATA_DIR });
    const r = installService(spec, { dryRun });
    if (dryRun) {
      console.log(`${r.content}\nProbelauf: geschrieben nach ${r.file}, nichts installiert. Würde ausführen:\n  ${r.commands.join("\n  ")}`);
      return;
    }
    console.log(`Hintergrunddienst eingerichtet (${r.file}).\nnesev läuft auf ${urlFor(port)} und startet mit jeder Anmeldung.`);
  } else if (sub === "uninstall") {
    const commands = uninstallService({ dryRun });
    console.log(dryRun ? `Probelauf, würde ausführen:\n  ${commands.join("\n  ")}` : "Hintergrunddienst entfernt.");
  } else if (sub === "status") {
    for (const line of serviceStatusLines()) console.log(line);
  } else {
    throw new UsageError("Verwendung: nesev service install|uninstall|status [--port N] [--dry-run]");
  }
}

async function update(args: string[]) {
  if (!isCompiled()) throw new UsageError("Aus dem Quellcode aktualisieren: git pull && bun install");
  const r = await updateBinary({
    current: VERSION,
    binaryPath: process.execPath,
    force: args.includes("--force"),
    checkOnly: args.includes("--check"),
    log: (m) => console.log(m),
  });
  if (!r.updated) {
    console.log(compareVersions(r.to, r.from) <= 0 ? `nesev ${r.from} ist aktuell.` : `Neue Version verfügbar: ${r.to} (installiert: ${r.from}). Aktualisieren: nesev update`);
    return;
  }
  console.log(`nesev ${r.from} → ${r.to} aktualisiert (${process.execPath}).`);
  if (restartService()) console.log("Hintergrunddienst neu gestartet.");
  else console.log("Läuft nesev gerade, bitte neu starten.");
}

async function uninstall(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const { configFile, resolveDataDir } = await import("../server/lib/data-location");
  const { cacheDir } = await import("./embedded");
  const loc = serviceLocation();
  if (isServiceInstalled(loc)) {
    uninstallService({ dryRun });
    console.log(dryRun ? "Würde den Hintergrunddienst entfernen." : "Hintergrunddienst entfernt.");
  }
  if (isCompiled()) {
    if (!dryRun) {
      rmSync(process.execPath, { force: true });
      rmSync(cacheDir(), { recursive: true, force: true });
    }
    console.log(`${dryRun ? "Würde entfernen" : "Entfernt"}: ${process.execPath} und ${cacheDir()}`);
  }
  const data = resolveDataDir();
  console.log(
    `\nDeine Daten wurden NICHT gelöscht${data ? `: ${data.dir}` : ""}.\nEinstellung des Datenordners: ${configFile()}\nWer alles entfernen will, löscht diese selbst (vorher ein Backup aufheben!).`,
  );
}

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "open":
      return open(parsePort(rest));
    case "start":
      return startServer(parsePort(rest));
    case "service":
      return service(rest[0], rest.slice(1));
    case "update":
      return update(rest);
    case "mcp": {
      await import("../mcp/stdout-guard"); // first, see src/mcp/stdout-guard.ts
      const { startStdio } = await import("../mcp/server");
      return startStdio();
    }
    case "uninstall":
      return uninstall(rest);
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      if (cmd.startsWith("--port")) return open(parsePort(argv));
      throw new UsageError(`Unbekannter Befehl: ${cmd}\n\n${HELP}`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  try {
    await main(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}

if (import.meta.main) await run();
