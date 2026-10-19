import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// nesev as a per-user background service that starts at login and restarts when it exits:
//   macOS: launchd LaunchAgent ~/Library/LaunchAgents/at.nesev.plist (logs in ~/Library/Logs/nesev/)
//   Linux: systemd user unit ~/.config/systemd/user/nesev.service (logs: journalctl --user -u nesev)
// Used by the release binary (`nesev service install`: runs `<binary> start`) and by scripts/service.ts for checkouts
// (runs `bun src/server/index.ts` from the repo). Both use the same label/unit, so installing one replaces the other.
// NESEV_SERVICE=1 tells the app that it runs under a supervisor that restarts it when it exits.

export const LABEL = "at.nesev";
export const SYSTEMD_UNIT = "nesev.service";

type Env = Record<string, string | undefined>;

export interface ServiceSpec {
  programArgs: string[];
  workingDir?: string;
  env: Record<string, string>;
  /** macOS: stdout/stderr go to files here (Linux: journald) */
  logDir: string;
}

export interface ServiceLocation {
  platform: NodeJS.Platform;
  plistPath: string;
  unitPath: string;
  logDir: string;
}

export function serviceLocation(platform = process.platform, home = homedir(), env: Env = process.env): ServiceLocation {
  return {
    platform,
    plistPath: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    unitPath: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", SYSTEMD_UNIT),
    logDir: join(home, "Library", "Logs", "nesev"),
  };
}

/** PATH for the service: the program's directory, Homebrew (llama-server, pdftoppm, tesseract) and the system dirs. */
export function servicePath(programDir: string, platform = process.platform, home = homedir()): string {
  const dirs =
    platform === "darwin"
      ? [programDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
      : [programDir, join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

interface SpecOptions {
  port: number;
  dataDir?: string;
  location?: ServiceLocation;
}

/** The release binary: `<binary> start` (production mode is built in). */
export function binaryServiceSpec(o: SpecOptions & { execPath: string }): ServiceSpec {
  const env: Record<string, string> = { PORT: String(o.port), PATH: servicePath(dirname(o.execPath)), NESEV_SERVICE: "1" };
  if (o.dataDir) env.NESEV_DATA_DIR = o.dataDir;
  return { programArgs: [o.execPath, "start"], env, logDir: (o.location ?? serviceLocation()).logDir };
}

/** A checkout: the production server (`bun start`) from the repo; the SPA must be built (dist/web). */
export function checkoutServiceSpec(o: SpecOptions & { bunPath: string; root: string; path?: string }): ServiceSpec {
  const env: Record<string, string> = {
    NODE_ENV: "production",
    PORT: String(o.port),
    PATH: o.path ?? servicePath(dirname(o.bunPath)),
    NESEV_SERVICE: "1",
  };
  if (o.dataDir) env.NESEV_DATA_DIR = o.dataDir;
  return { programArgs: [o.bunPath, "src/server/index.ts"], workingDir: o.root, env, logDir: (o.location ?? serviceLocation()).logDir };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildPlist(spec: ServiceSpec): string {
  const args = spec.programArgs.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const envXml = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const cwd = spec.workingDir ? `  <key>WorkingDirectory</key>\n  <string>${xml(spec.workingDir)}</string>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${cwd}  <key>EnvironmentVariables</key>
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
  <string>${xml(join(spec.logDir, "nesev.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(spec.logDir, "nesev.err.log"))}</string>
</dict>
</plist>
`;
}

/** One systemd word: quoted when needed; `%` (specifiers) and `$` (variable expansion) escaped. */
function systemdWord(s: string): string {
  const escaped = s.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildSystemdUnit(spec: ServiceSpec): string {
  const lines = [
    "[Unit]",
    "Description=nesev (Rechnungen und Buchhaltung)",
    "After=network.target",
    "",
    "[Service]",
    `ExecStart=${spec.programArgs.map(systemdWord).join(" ")}`,
    ...(spec.workingDir ? [`WorkingDirectory=${systemdWord(spec.workingDir)}`] : []),
    ...Object.entries(spec.env).map(([k, v]) => `Environment=${systemdWord(`${k}=${v}`)}`),
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
}

const launchdTarget = () => `gui/${userInfo().uid}/${LABEL}`;
const launchdDomain = () => `gui/${userInfo().uid}`;

function requireSupported(platform: NodeJS.Platform) {
  if (platform !== "darwin" && platform !== "linux") throw new Error("Hintergrunddienst: nur unter macOS (launchd) und Linux (systemd).");
}

function requireSystemctl() {
  if (!Bun.which("systemctl")) throw new Error("systemctl nicht gefunden: ohne systemd nesev selbst starten (nesev start).");
}

export function isServiceInstalled(loc = serviceLocation()): boolean {
  if (loc.platform === "darwin") return existsSync(loc.plistPath);
  if (loc.platform === "linux") return existsSync(loc.unitPath);
  return false;
}

export interface InstallResult {
  file: string;
  /** dry run: the file content and the commands it would run */
  content?: string;
  commands: string[];
}

/** Writes the plist/unit and (re)starts the service. Dry run: writes the file to a temp dir only (plutil -lint on macOS). */
export function installService(spec: ServiceSpec, o: { dryRun?: boolean; location?: ServiceLocation } = {}): InstallResult {
  const loc = o.location ?? serviceLocation();
  requireSupported(loc.platform);
  if (loc.platform === "darwin") {
    const commands = [`launchctl bootout ${launchdTarget()} (falls geladen)`, `launchctl bootstrap ${launchdDomain()} ${loc.plistPath}`];
    const content = buildPlist(spec);
    if (o.dryRun) {
      const file = join(mkdtempSync(join(tmpdir(), "nesev-service-")), `${LABEL}.plist`);
      writeFileSync(file, content);
      const lint = run("plutil", ["-lint", file]);
      if (!lint.ok) throw new Error(`plutil -lint: ${lint.out}`);
      return { file, content, commands };
    }
    mkdirSync(spec.logDir, { recursive: true });
    mkdirSync(dirname(loc.plistPath), { recursive: true });
    // replace a running instance (bootstrap fails while the label is loaded)
    if (run("launchctl", ["print", launchdTarget()]).ok) run("launchctl", ["bootout", launchdTarget()]);
    writeFileSync(loc.plistPath, content);
    const lint = run("plutil", ["-lint", loc.plistPath]);
    if (!lint.ok) throw new Error(lint.out);
    const boot = run("launchctl", ["bootstrap", launchdDomain(), loc.plistPath]);
    if (!boot.ok) throw new Error(`launchctl bootstrap fehlgeschlagen:\n${boot.out}`);
    return { file: loc.plistPath, commands };
  }
  const commands = ["systemctl --user daemon-reload", `systemctl --user enable ${SYSTEMD_UNIT}`, `systemctl --user restart ${SYSTEMD_UNIT}`];
  const content = buildSystemdUnit(spec);
  if (o.dryRun) {
    const file = join(mkdtempSync(join(tmpdir(), "nesev-service-")), SYSTEMD_UNIT);
    writeFileSync(file, content);
    return { file, content, commands };
  }
  requireSystemctl();
  mkdirSync(dirname(loc.unitPath), { recursive: true });
  writeFileSync(loc.unitPath, content);
  for (const args of [["daemon-reload"], ["enable", SYSTEMD_UNIT], ["restart", SYSTEMD_UNIT]]) {
    const r = run("systemctl", ["--user", ...args]);
    if (!r.ok) throw new Error(`systemctl --user ${args.join(" ")} fehlgeschlagen:\n${r.out}`);
  }
  return { file: loc.unitPath, commands };
}

/** Stops the service and removes its plist/unit (logs stay). Returns the commands (dry run: without running them). */
export function uninstallService(o: { dryRun?: boolean; location?: ServiceLocation } = {}): string[] {
  const loc = o.location ?? serviceLocation();
  requireSupported(loc.platform);
  if (loc.platform === "darwin") {
    const commands = [`launchctl bootout ${launchdTarget()}`, `rm ${loc.plistPath}`];
    if (o.dryRun) return commands;
    if (run("launchctl", ["print", launchdTarget()]).ok) {
      const r = run("launchctl", ["bootout", launchdTarget()]);
      if (!r.ok) throw new Error(`launchctl bootout fehlgeschlagen:\n${r.out}`);
    }
    rmSync(loc.plistPath, { force: true });
    return commands;
  }
  const commands = [`systemctl --user disable --now ${SYSTEMD_UNIT}`, `rm ${loc.unitPath}`, "systemctl --user daemon-reload"];
  if (o.dryRun) return commands;
  if (existsSync(loc.unitPath)) {
    requireSystemctl();
    run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    rmSync(loc.unitPath, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
  }
  return commands;
}

/** Restarts an installed service (after an update). False if none is installed. */
export function restartService(loc = serviceLocation()): boolean {
  if (!isServiceInstalled(loc)) return false;
  const r =
    loc.platform === "darwin"
      ? run("launchctl", ["kickstart", "-k", launchdTarget()])
      : run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  if (!r.ok) throw new Error(`Neustart des Dienstes fehlgeschlagen:\n${r.out}`);
  return true;
}

/** The PORT an installed service runs on (from its plist/unit), if any. */
export function installedServicePort(loc = serviceLocation()): number | null {
  const file = loc.platform === "darwin" ? loc.plistPath : loc.unitPath;
  try {
    const text = readFileSync(file, "utf8");
    const m = text.match(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/) ?? text.match(/^Environment="?PORT=(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Human-readable status lines (German). */
export function serviceStatusLines(loc = serviceLocation()): string[] {
  requireSupported(loc.platform);
  if (!isServiceInstalled(loc)) return ["Hintergrunddienst: nicht installiert."];
  if (loc.platform === "darwin") {
    const r = run("launchctl", ["print", launchdTarget()]);
    if (!r.ok) return [`Hintergrunddienst: installiert (${loc.plistPath}), aber nicht geladen.`];
    const field = (name: string) => r.out.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1];
    return [
      `Hintergrunddienst: ${LABEL} (${loc.plistPath})`,
      `  Zustand: ${field("state") ?? "?"}, PID: ${field("pid") ?? "–"}, letzter Exit: ${field("last exit code") ?? "–"}`,
      `  Logs: ${loc.logDir}`,
    ];
  }
  const r = run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
  return [`Hintergrunddienst: ${SYSTEMD_UNIT} (${loc.unitPath})`, `  Zustand: ${r.out || "?"}`, `  Logs: journalctl --user -u nesev`];
}
